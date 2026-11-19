import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { runsBackground } from '../../common/utils/process-role';
import { ShopifyService } from '../integrations/shopify/shopify.service';
import { WooCommerceService } from '../integrations/commerce/woocommerce.service';

/** Check hourly; run the nightly knowledge refresh once per UTC day at ~21:00 UTC (02:00 PKT). */
const TICK_MS = 60 * 60 * 1000;
const RUN_HOUR_UTC = 21;

/**
 * AI knowledge freshness safety net: once a night, every store whose catalogue
 * is already indexed gets a full re-sync (product webhooks cover the day;
 * this catches anything missed). Worker process only (runsBackground) — a web
 * container must never run schedulers. Dedup keys make repeats free.
 */
@Injectable()
export class AgentMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentMaintenanceService.name);
  private timer: NodeJS.Timeout | null = null;
  private lastRunDay = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopify: ShopifyService,
    private readonly woo: WooCommerceService,
  ) {}

  onModuleInit(): void {
    if (!runsBackground()) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== RUN_HOUR_UTC || this.lastRunDay === day) return;
    this.lastRunDay = day;
    try {
      await this.resyncAll();
    } catch (e) {
      this.logger.warn(`nightly knowledge re-sync failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Enqueue a re-sync for every active store that already has indexed products. */
  async resyncAll(): Promise<{ stores: number }> {
    const rows = await this.prisma.$queryRaw<Array<{ company_id: number; store_id: number }>>`
      SELECT DISTINCT company_id, store_id FROM ai_knowledge_chunks
      WHERE source_type = 'product' AND store_id > 0`;
    let n = 0;
    for (const r of rows) {
      const store = await this.prisma.shopifyStore.findFirst({
        where: { id: r.store_id, company_id: r.company_id, status: 'active' },
        select: { id: true, provider: true },
      });
      if (!store) continue;
      try {
        if (store.provider === 'woocommerce') await this.woo.requestKnowledgeSync(r.company_id, store.id);
        else await this.shopify.requestKnowledgeSync(r.company_id, store.id);
        n++;
      } catch {
        /* disconnected store — skip */
      }
    }
    this.logger.log(`nightly knowledge re-sync enqueued for ${n} store(s)`);
    return { stores: n };
  }
}
