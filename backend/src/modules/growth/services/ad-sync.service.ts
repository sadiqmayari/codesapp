import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { JobQueueService } from '../../../common/services/job-queue.service';
import { PlatformRegistry } from '../platforms/platform-registry';
import { AdEntityRow, AdPlatformAuthError, AdPlatformRateLimitError } from '../platforms/ad-platform.types';
import { AdAccountsService } from './ad-accounts.service';
import { FxService } from './fx.service';
import { GrowthVersionService } from './growth-version.service';
import { GrowthMirrorService } from '../store/growth-mirror.service';
import { addDays, chunk } from '../growth.util';
import { runsBackground } from '../../../common/utils/process-role';

export const ADS_QUEUE = 'growth-ads';
export const DEFAULT_SYNC_INTERVAL_MIN = 240;
const DEFAULT_WINDOW_DAYS = 3;
const CHUNK_DAYS = 7; // per insights request (big windows time out on Meta) // a day's spend keeps firming up for ~72h
const MAX_WINDOW_DAYS = 90;
const TICK_MS = 10 * 60_000;

interface AdsJob {
  accountId: number;
  sinceDays?: number;
}

/** Extract a Shopify product handle from an ad destination URL (/products/<handle>). */
export function parseProductHandle(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /\/products\/([^/?#]+)/.exec(url);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).toLowerCase().slice(0, 255) || null;
  } catch {
    return m[1].toLowerCase().slice(0, 255);
  }
}

/**
 * Pulls ad hierarchy + ad-grain daily insights for every connected account on a
 * per-account cadence (in-process scheduler, mirrors CourierStatusSyncService).
 * Within the pulled window the account's rows are REPLACED (delete-then-insert)
 * so spend Meta later revises to zero / deleted ads never linger.
 */
@Injectable()
export class AdSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdSyncService.name);
  private timer?: ReturnType<typeof setInterval>;
  private lastFxDay = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobQueueService,
    private readonly registry: PlatformRegistry,
    private readonly accounts: AdAccountsService,
    private readonly fx: FxService,
    private readonly version: GrowthVersionService,
    private readonly mirror: GrowthMirrorService,
  ) {}

  onModuleInit() {
    this.jobs.registerWorker(ADS_QUEUE, (p) => this.handle(p as AdsJob), 2, 600);
    if (!runsBackground()) return; // APP_ROLE=web: the worker container schedules.
    this.timer = setInterval(() => void this.tick().catch((e) => this.logger.warn(`tick: ${e}`)), TICK_MS);
    setTimeout(() => void this.bootstrap().catch((e) => this.logger.warn(`bootstrap: ${e}`)), 90_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** First boot after the Growth migration: backfill 90 days at ad grain once. */
  private async bootstrap() {
    const accounts = await this.prisma.adAccount.findMany({ where: { status: 'active' }, select: { id: true } });
    for (const a of accounts) {
      const adGrain = await this.prisma.adInsightDaily.findFirst({
        where: { account_id: a.id, NOT: { ad_id: { startsWith: 'c:' } } },
        select: { id: true },
      });
      if (!adGrain) {
        await this.jobs.enqueue(ADS_QUEUE, { accountId: a.id, sinceDays: MAX_WINDOW_DAYS } satisfies AdsJob, {
          dedupKey: `growth:ads:backfill:${a.id}`,
          maxAttempts: 2,
        });
      }
    }
    await this.tick();
  }

  private async tick() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastFxDay) {
      this.lastFxDay = today;
      void this.fx.snapshotAll().catch(() => undefined);
    }
    await this.syncDue();
  }

  /** Enqueue a pull for every active account whose cadence elapsed. */
  async syncDue(): Promise<{ enqueued: number }> {
    const accounts = await this.prisma.adAccount.findMany({
      where: { status: 'active' },
      select: { id: true, sync_interval_min: true, last_attempt_at: true },
    });
    const now = Date.now();
    let enqueued = 0;
    for (const a of accounts) {
      const interval = Math.min(1440, Math.max(30, a.sync_interval_min ?? DEFAULT_SYNC_INTERVAL_MIN));
      if (now - (a.last_attempt_at?.getTime() ?? 0) < interval * 60_000) continue;
      await this.request(a.id);
      enqueued++;
    }
    return { enqueued };
  }

  async request(accountId: number, sinceDays?: number) {
    await this.jobs.enqueue(ADS_QUEUE, { accountId, sinceDays } satisfies AdsJob, {
      dedupKey: `growth:ads:${accountId}`,
      maxAttempts: 2,
    });
    // Stamp the attempt at enqueue so a slow/failed run can't tight-loop the scheduler.
    await this.prisma.adAccount
      .update({ where: { id: accountId }, data: { last_attempt_at: new Date() } })
      .catch(() => undefined);
    return { started: true as const };
  }

  async requestForCompany(companyId: number) {
    const accounts = await this.prisma.adAccount.findMany({
      where: { company_id: companyId, status: 'active' },
      select: { id: true },
    });
    for (const a of accounts) await this.request(a.id);
    return { started: true as const, accounts: accounts.length };
  }

  private async handle(job: AdsJob) {
    const days = Math.min(Math.max(job.sinceDays ?? DEFAULT_WINDOW_DAYS, 1), MAX_WINDOW_DAYS);
    try {
      await this.pull(job.accountId, days);
    } catch (e) {
      const msg =
        e instanceof AdPlatformAuthError || e instanceof AdPlatformRateLimitError
          ? e.message
          : `Sync failed: ${(e as Error).message}`;
      await this.prisma.adAccount
        .update({ where: { id: job.accountId }, data: { last_error: msg.slice(0, 500) } })
        .catch(() => undefined);
      if (e instanceof AdPlatformAuthError) return; // retrying a bad token is pointless
      throw e;
    }
  }

  async pull(accountId: number, days: number): Promise<number> {
    const acc = await this.prisma.adAccount.findUnique({ where: { id: accountId } });
    if (!acc || acc.status !== 'active') return 0;
    const adapter = this.registry.get(acc.platform);
    if (!adapter.available) return 0;
    const token = await this.accounts.resolveToken(acc);
    if (!token) throw new AdPlatformAuthError('No token available for this ad account. Reconnect it.', 'token');

    // Refresh account currency / timezone / name (no more hand-typed currency).
    const info = await adapter.getAccountInfo(token, acc.external_id).catch(() => null);
    const currency = info?.currency ?? acc.currency;
    if (info) {
      await this.prisma.adAccount.update({
        where: { id: acc.id },
        data: { name: info.name ?? acc.name, currency: info.currency ?? acc.currency, timezone: info.timezone ?? acc.timezone },
      });
    }

    // Hierarchy + creatives (best-effort: insights still land if this fails).
    let entities: AdEntityRow[] = [];
    try {
      entities = await adapter.listEntities(token, acc.external_id);
      await this.saveEntities(acc.company_id, acc.id, acc.platform, entities);
    } catch (e) {
      if (e instanceof AdPlatformAuthError && e.kind !== 'other') throw e;
      this.logger.warn(`entities failed (account ${acc.id}): ${(e as Error).message}`);
    }

    // `until` = tomorrow: spend is dated in the account timezone; +1 day always
    // covers the account's "today" (the platform clamps to the present).
    const until = addDays(new Date().toISOString().slice(0, 10), 1);
    const since = addDays(until, -days);

    // Fill campaign/adset ids the report omits (Snap) from the hierarchy.
    const adMap = new Map(
      (entities.length
        ? entities
        : (await this.prisma.adEntity.findMany({ where: { account_id: acc.id, level: 'ad' } })).map((e) => ({
            level: 'ad' as const,
            externalId: e.external_id,
            parentExternalId: e.parent_external_id,
            campaignId: e.campaign_id,
          }))
      )
        .filter((e) => e.level === 'ad')
        .map((e) => [e.externalId, e]),
    );
    const base = await this.accounts.baseCurrency(acc.company_id);
    const fxCache = new Map<string, number>();

    // Pull + save in 7-day chunks, NEWEST first: a 90-day ad-level request in
    // one call timed out on Meta. Each chunk replaces only its own days, so a
    // failure later in a backfill keeps everything already saved.
    let total = 0;
    for (let chunkEnd = until; chunkEnd > since; chunkEnd = addDays(chunkEnd, -CHUNK_DAYS)) {
      const chunkStart = addDays(chunkEnd, -(CHUNK_DAYS - 1)) < since ? since : addDays(chunkEnd, -(CHUNK_DAYS - 1));
      const rows = await adapter.fetchInsights(token, acc.external_id, chunkStart, chunkEnd);
      const data: Prisma.AdInsightDailyCreateManyInput[] = [];
      for (const r of rows) {
        let fx = fxCache.get(r.date);
        if (fx === undefined) {
          fx = await this.fx.rate(currency, base, r.date);
          fxCache.set(r.date, fx);
        }
        const ent = adMap.get(r.adId);
        data.push({
          company_id: acc.company_id,
          account_id: acc.id,
          platform: acc.platform,
          date: new Date(`${r.date}T00:00:00.000Z`),
          campaign_id: (r.campaignId || ent?.campaignId || 'unknown').slice(0, 64),
          adset_id: (r.adsetId ?? ent?.parentExternalId ?? null)?.slice(0, 64) ?? null,
          ad_id: r.adId.slice(0, 64),
          currency,
          spend: r.spend,
          spend_base: Math.round(r.spend * fx * 100) / 100,
          impressions: Math.round(r.impressions),
          reach: Math.round(r.reach),
          clicks: Math.round(r.clicks),
          link_clicks: Math.round(r.linkClicks),
          video_3s: Math.round(r.video3s),
          thruplay: Math.round(r.thruplay),
          add_to_cart: r.addToCart,
          checkouts: r.checkouts,
          purchases: r.purchases,
          purchase_value: r.purchaseValue,
          purchase_value_base: Math.round(r.purchaseValue * fx * 100) / 100,
          messaging_started: r.messagingStarted,
        });
      }
      const winStart = new Date(`${chunkStart}T00:00:00.000Z`);
      const winEnd = new Date(`${chunkEnd}T00:00:00.000Z`);
      await this.prisma.$transaction(async (tx) => {
        await tx.adInsightDaily.deleteMany({ where: { account_id: acc.id, date: { gte: winStart, lte: winEnd } } });
        for (const part of chunk(data, 500)) await tx.adInsightDaily.createMany({ data: part, skipDuplicates: true });
      }, { timeout: 120_000 });
      total += rows.length;
      // Clear a stale error as soon as fresh data lands (the UI shows progress).
      await this.prisma.adAccount
        .update({ where: { id: acc.id }, data: { last_success_at: new Date(), last_error: null } })
        .catch(() => undefined);
    }
    const rows = { length: total };

    await this.prisma.adAccount.update({
      where: { id: acc.id },
      data: { last_success_at: new Date(), last_error: null },
    });
    this.version.bump(acc.company_id, 'spend');
    await this.mirror.enqueue(acc.company_id, 'ads');
    this.logger.log(`account ${acc.id} (${acc.platform}): ${rows.length} insight rows, ${entities.length} entities`);
    return rows.length;
  }

  private async saveEntities(companyId: number, accountId: number, platform: string, rows: AdEntityRow[]) {
    for (const part of chunk(rows, 200)) {
      await this.prisma.$transaction(
        part.map((e) => {
          const data = {
            parent_external_id: e.parentExternalId?.slice(0, 64) ?? null,
            campaign_id: e.campaignId?.slice(0, 64) ?? null,
            name: e.name?.slice(0, 512) ?? null,
            status: e.status?.slice(0, 32) ?? null,
            objective: e.objective?.slice(0, 64) ?? null,
            daily_budget: e.dailyBudget,
            creative_thumb_url: e.creativeThumbUrl,
            destination_url: e.destinationUrl,
            advertised_handle: parseProductHandle(e.destinationUrl),
            updated_at: new Date(),
          };
          return this.prisma.adEntity.upsert({
            where: { account_id_level_external_id: { account_id: accountId, level: e.level, external_id: e.externalId.slice(0, 64) } },
            create: { company_id: companyId, account_id: accountId, platform, level: e.level, external_id: e.externalId.slice(0, 64), ...data },
            update: data,
          });
        }),
      );
    }
  }
}
