import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { JobQueueService } from '../../../common/services/job-queue.service';
import { ClickHouseStore } from './clickhouse.store';
import { MariaDbStore } from './mariadb.store';
import { GrowthStore, Params, Row } from './growth-store';
import { chunk, n } from '../growth.util';

export const MIRROR_QUEUE = 'growth-ch';
const PAGE = 4000;

interface MirrorJob {
  companyId: number;
  kind: 'facts' | 'ads' | 'full';
}

const isoDay = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));
const isoTs = (d: unknown) => (d instanceof Date ? d.toISOString() : d);

/**
 * Copies MariaDB growth facts / attribution / ad insights into ClickHouse and
 * decides, per tenant, which store serves reads. A tenant is served from
 * ClickHouse only once its mirror matches MariaDB (row-count check on boot or a
 * completed full copy); any ClickHouse error falls back to MariaDB per query.
 */
@Injectable()
export class GrowthMirrorService implements OnModuleInit {
  private readonly logger = new Logger(GrowthMirrorService.name);
  private readonly ready = new Set<number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobQueueService,
    private readonly ch: ClickHouseStore,
    private readonly maria: MariaDbStore,
  ) {}

  onModuleInit() {
    if (!this.ch.enabled) return;
    this.jobs.registerWorker(MIRROR_QUEUE, (p) => this.handle(p as MirrorJob), 1, 3600);
    setTimeout(() => void this.verifyAll().catch((e) => this.logger.warn(`verify: ${e}`)), 150_000);
  }

  /** Read through the best available store. */
  async query<T extends Row = Row>(companyId: number, sql: string, params: Params): Promise<T[]> {
    if (this.ch.isHealthy && this.ready.has(companyId)) {
      try {
        return await this.ch.query<T>(sql, params);
      } catch (e) {
        this.logger.warn(`ClickHouse query failed, using MariaDB: ${(e as Error).message}`);
      }
    }
    return this.maria.query<T>(sql, params);
  }

  storeFor(companyId: number): GrowthStore['name'] {
    return this.ch.isHealthy && this.ready.has(companyId) ? 'clickhouse' : 'mariadb';
  }

  status() {
    return { enabled: this.ch.enabled, healthy: this.ch.isHealthy, mirroredCompanies: this.ready.size };
  }

  enqueue(companyId: number, kind: MirrorJob['kind']) {
    if (!this.ch.enabled) return Promise.resolve(0);
    return this.jobs.enqueue(MIRROR_QUEUE, { companyId, kind } satisfies MirrorJob, {
      dedupKey: `growth:ch:${companyId}:${kind}`,
      maxAttempts: 2,
      delayMs: kind === 'full' ? 0 : 5_000,
    });
  }

  private async verifyAll() {
    if (!this.ch.isHealthy) return;
    const companies = await this.prisma.$queryRawUnsafe<Array<{ company_id: number; c: bigint }>>(
      'SELECT company_id, COUNT(*) c FROM growth_order_facts GROUP BY company_id',
    );
    for (const c of companies) {
      const chCount = n(
        await this.ch.scalar('SELECT count() FROM growth_order_facts FINAL WHERE company_id = {co:Int32}', { co: c.company_id }),
      );
      if (chCount === n(c.c) && chCount > 0) this.ready.add(c.company_id);
      else await this.enqueue(c.company_id, 'full');
    }
  }

  private async handle(job: MirrorJob) {
    if (!this.ch.isHealthy) throw new Error('ClickHouse unavailable');
    if (job.kind === 'ads' || job.kind === 'full') await this.mirrorAds(job.companyId, job.kind === 'full');
    if (job.kind === 'facts' || job.kind === 'full') await this.mirrorFacts(job.companyId, job.kind === 'full');
    if (job.kind === 'full') this.ready.add(job.companyId);
  }

  private async mirrorFacts(companyId: number, full: boolean) {
    let since = new Date(0);
    if (full) {
      await this.ch.command('DELETE FROM growth_attribution WHERE company_id = {co:Int32}', { co: companyId });
    } else {
      const m = await this.ch.scalar(
        'SELECT max(updated_at) FROM growth_order_facts FINAL WHERE company_id = {co:Int32}',
        { co: companyId },
      );
      if (m && !String(m).startsWith('1970')) since = new Date(new Date(`${String(m).replace(' ', 'T')}Z`).getTime() - 1000);
    }
    for (;;) {
      const facts = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        'SELECT * FROM growth_order_facts WHERE company_id = ? AND updated_at >= ? ORDER BY updated_at, order_gid LIMIT ?',
        companyId,
        since,
        PAGE,
      );
      if (!facts.length) break;
      await this.ch.insert(
        'growth_order_facts',
        facts.map((f) => ({
          ...f,
          order_date: isoDay(f.order_date),
          created_at: isoTs(f.created_at),
          updated_at: isoTs(f.updated_at),
          version: String(f.version),
          ship_estimated: f.ship_estimated ? 1 : 0,
          has_breakdown: f.has_breakdown ? 1 : 0,
          is_new: f.is_new ? 1 : 0,
        })),
      );
      const gids = facts.map((f) => String(f.order_gid));
      for (const part of chunk(gids, 1000)) {
        if (!full) {
          await this.ch.command(
            'DELETE FROM growth_attribution WHERE company_id = {co:Int32} AND order_gid IN {g:Array(String)}',
            { co: companyId, g: part },
          );
        }
        const attr = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT company_id, order_gid, order_date, model, win, channel, platform, campaign_id, adset_id, ad_id,
                  credit, net, expected_net, delivered, is_new, version
             FROM growth_attribution WHERE company_id = ? AND order_gid IN (${part.map(() => '?').join(',')})`,
          companyId,
          ...part,
        );
        for (const a of chunk(attr, PAGE)) {
          await this.ch.insert(
            'growth_attribution',
            a.map((r) => ({ ...r, order_date: isoDay(r.order_date), version: String(r.version), is_new: r.is_new ? 1 : 0 })),
          );
        }
      }
      const last = facts[facts.length - 1].updated_at as Date;
      if (facts.length < PAGE) break;
      since = last;
    }
  }

  private async mirrorAds(companyId: number, full: boolean) {
    const since = full ? '1970-01-01' : new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10);
    await this.ch.command('DELETE FROM ad_insights_daily WHERE company_id = {co:Int32} AND date >= {s:Date}', {
      co: companyId,
      s: since,
    });
    let lastId = 0;
    for (;;) {
      const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT id, company_id, account_id, platform, date, campaign_id, adset_id, ad_id, spend, spend_base, impressions,
                reach, clicks, link_clicks, video_3s, thruplay, add_to_cart, checkouts, purchases, purchase_value_base,
                messaging_started
           FROM ad_insights_daily WHERE company_id = ? AND date >= ? AND id > ? ORDER BY id LIMIT ?`,
        companyId,
        since,
        lastId,
        PAGE,
      );
      if (!rows.length) break;
      await this.ch.insert(
        'ad_insights_daily',
        rows.map(({ id: _id, ...r }) => ({ ...r, date: isoDay(r.date) })),
      );
      lastId = Number(rows[rows.length - 1].id);
      if (rows.length < PAGE) break;
    }
  }
}
