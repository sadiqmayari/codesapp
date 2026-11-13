import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { JobQueueService } from '../../../common/services/job-queue.service';
import { canonContactPhone } from '../../../common/utils/contact-phone';
import { AdAccountsService } from './ad-accounts.service';
import { httpJson } from '../platforms/http';

export const CAPI_QUEUE = 'growth-capi';
export const CAPI_EVENT = 'DeliveredPurchase';

interface CapiJob {
  companyId: number;
  gids: string[];
}

const sha = (v: string) => createHash('sha256').update(v.trim().toLowerCase()).digest('hex');

/**
 * Delivered-purchase Conversions API. When an order flips to DELIVERED, send a
 * custom `DeliveredPurchase` event (realized value) to the tenant's Meta
 * dataset, so Meta can optimise for buyers who actually receive and pay — not
 * placed COD orders. A custom event name never double-counts the pixel's own
 * Purchase. Opt-in per ad account; each order is sent at most once.
 */
@Injectable()
export class CapiService implements OnModuleInit {
  private readonly logger = new Logger(CapiService.name);
  private readonly version: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobQueueService,
    private readonly accounts: AdAccountsService,
    config: ConfigService,
  ) {
    this.version = config.get<string>('META_GRAPH_VERSION') ?? 'v19.0';
  }

  onModuleInit() {
    this.jobs.registerWorker(CAPI_QUEUE, (p) => this.handle(p as CapiJob), 1, 300);
  }

  enqueue(companyId: number, gids: string[]) {
    if (!gids.length) return Promise.resolve(0);
    return this.jobs.enqueue(CAPI_QUEUE, { companyId, gids } satisfies CapiJob, { maxAttempts: 3 });
  }

  private async handle(job: CapiJob) {
    const acc = await this.prisma.adAccount.findFirst({
      where: { company_id: job.companyId, platform: 'meta', status: 'active', capi_enabled: true, capi_dataset_id: { not: null } },
    });
    if (!acc?.capi_dataset_id) return;
    const token = await this.accounts.resolveToken(acc);
    if (!token) return;
    const orders = await this.prisma.$queryRawUnsafe<
      Array<{ gid: string; phone: string | null; email: string | null; city: string | null; country_code: string | null;
        landing_site: string | null; net: unknown; currency: string | null; order_name: string | null; customer_key: string | null }>
    >(
      `SELECT f.order_gid gid, o.phone, o.email, o.city, o.country_code, o.landing_site, f.net, o.currency, o.order_name, f.customer_key
         FROM growth_order_facts f
         JOIN shopify_orders o ON o.company_id = f.company_id
          AND o.shopify_order_gid COLLATE utf8mb4_general_ci = f.order_gid COLLATE utf8mb4_general_ci
        WHERE f.company_id = ? AND f.lifecycle = 'delivered' AND f.capi_sent_at IS NULL
          AND f.order_gid IN (${job.gids.map(() => '?').join(',')})`,
      job.companyId,
      ...job.gids,
    );
    if (!orders.length) return;
    const now = Math.floor(Date.now() / 1000);
    const data = orders.map((o) => {
      const user: Record<string, unknown> = {};
      const ph = canonContactPhone(o.phone);
      if (ph) user.ph = [sha(ph)];
      if (o.email) user.em = [sha(o.email)];
      if (o.city) user.ct = [sha(o.city.replace(/\s+/g, ''))];
      if (o.country_code) user.country = [sha(o.country_code)];
      if (o.customer_key) user.external_id = [sha(o.customer_key)];
      const fbclid = /[?&]fbclid=([^&#]+)/.exec(o.landing_site ?? '')?.[1];
      if (fbclid) user.fbc = `fb.1.${now * 1000}.${fbclid}`;
      return {
        event_name: CAPI_EVENT,
        event_time: now,
        event_id: `delivered:${o.gid}`,
        action_source: 'system_generated',
        user_data: user,
        custom_data: { value: Number(o.net) || 0, currency: o.currency ?? 'PKR', order_id: o.order_name ?? o.gid },
      };
    });
    const res = await httpJson<{ events_received?: number; error?: { message?: string } }>(
      'POST',
      `https://graph.facebook.com/${this.version}/${encodeURIComponent(acc.capi_dataset_id)}/events`,
      { Authorization: `Bearer ${token}` },
      { data },
    );
    if (res.status >= 400 || res.body.error) {
      this.logger.warn(`CAPI send failed (company ${job.companyId}): ${res.body.error?.message ?? res.status}`);
      throw new Error(res.body.error?.message ?? `CAPI ${res.status}`);
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE growth_order_facts SET capi_sent_at = NOW(3)
        WHERE company_id = ? AND order_gid IN (${orders.map(() => '?').join(',')})`,
      job.companyId,
      ...orders.map((o) => o.gid),
    );
    this.logger.log(`CAPI: ${res.body.events_received ?? data.length} delivered events (company ${job.companyId})`);
  }
}
