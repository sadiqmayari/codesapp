import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { ShopifyOrderSyncService } from '../integrations/shopify/shopify-order-sync.service';
import { METRICS } from './metrics/catalog';
import { CHANNEL_LABEL, MODELS, WINDOWS } from './attribution/attribution';
import { AdAccountsService } from './services/ad-accounts.service';
import { AdSyncService } from './services/ad-sync.service';
import { GrowthFactsService } from './services/growth-facts.service';
import { GrowthQueryService } from './services/growth-query.service';
import { GrowthForecastService } from './services/growth-forecast.service';
import { GrowthOpportunityService } from './services/growth-opportunity.service';
import { GrowthAiService } from './services/growth-ai.service';
import { GrowthMirrorService } from './store/growth-mirror.service';
import { GrowthVersionService } from './services/growth-version.service';
import { ConnectAdAccountDto } from './dtos/growth.dto';

/** Thin facade the controller talks to; business logic lives in the services. */
@Injectable()
export class GrowthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobQueueService,
    private readonly orderSync: ShopifyOrderSyncService,
    private readonly facts: GrowthFactsService,
    private readonly mirror: GrowthMirrorService,
    private readonly version: GrowthVersionService,
    readonly accounts: AdAccountsService,
    readonly sync: AdSyncService,
    readonly query: GrowthQueryService,
    readonly forecast: GrowthForecastService,
    readonly opportunities: GrowthOpportunityService,
    readonly ai: GrowthAiService,
  ) {}

  catalog() {
    return { metrics: METRICS, models: MODELS, windows: WINDOWS, channels: CHANNEL_LABEL };
  }

  async status(companyId: number) {
    const [facts, touch, accounts] = await Promise.all([
      this.prisma.$queryRawUnsafe<Array<{ c: bigint; m: Date | null }>>(
        'SELECT COUNT(*) c, MAX(updated_at) m FROM growth_order_facts WHERE company_id = ?',
        companyId,
      ),
      this.prisma.orderTouchpoint.count({ where: { company_id: companyId } }),
      this.accounts.list(companyId),
    ]);
    return {
      store: this.mirror.storeFor(companyId),
      clickhouse: this.mirror.status(),
      dataVersion: this.version.get(companyId),
      facts: { orders: Number(facts[0]?.c ?? 0), lastBuiltAt: facts[0]?.m ?? null },
      touchpoints: touch,
      baseCurrency: accounts.baseCurrency,
      platforms: accounts.platforms,
      accounts: accounts.accounts,
    };
  }

  async connect(companyId: number, dto: ConnectAdAccountDto) {
    const acc = await this.accounts.connect(companyId, dto);
    await this.sync.request(acc.id, 90); // backfill 90 days of history right away
    return acc;
  }

  async disconnect(companyId: number, id: number) {
    const r = await this.accounts.disconnect(companyId, id);
    this.version.bump(companyId, 'spend');
    await this.mirror.enqueue(companyId, 'full');
    return r;
  }

  async rebuild(companyId: number) {
    await this.facts.enqueue(companyId, 'full');
    return { started: true };
  }

  backfillAttribution(companyId: number) {
    return this.orderSync.backfillAttribution(companyId, 90);
  }

  backfillFinancials(companyId: number) {
    return this.orderSync.backfillFinancials(companyId, 90);
  }

  /** Background catalogue sync (pulls Shopify cost per item → COGS). */
  async syncCogs(companyId: number) {
    await this.jobs.enqueue(
      'shopify',
      { kind: 'syncInventory', companyId, storeId: null },
      { dedupKey: `inv-sync:${companyId}:primary`, maxAttempts: 1 },
    );
    return { started: true };
  }
}
