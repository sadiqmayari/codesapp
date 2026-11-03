import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import {
  MetaMarketingClientService,
  MetaAdsAuthError,
} from './meta-marketing-client.service';

const QUEUE = 'meta-ads';
// Default refresh window on a sync: re-pull the last 3 days so a day's spend
// (which Meta keeps adjusting for a short while) firms up.
const DEFAULT_WINDOW_DAYS = 3;
const MAX_BACKFILL_DAYS = 90;

// Per-tenant auto-sync cadence (mirrors CourierStatusSyncService).
export const DEFAULT_SYNC_INTERVAL_MIN = 240; // 4h — pre-schedule behaviour
export const MIN_SYNC_INTERVAL_MIN = 30;
export const MAX_SYNC_INTERVAL_MIN = 1440; // 24h
const SCHEDULER_TICK_MS = 10 * 60 * 1000;

interface SyncJob {
  companyId: number;
  sinceDays?: number;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Extract a Shopify product handle from an ad destination URL (/products/<handle>). */
export function parseProductHandle(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const m = /\/products\/([^/?#]+)/.exec(u.pathname);
    if (!m) return null;
    return decodeURIComponent(m[1]).toLowerCase().slice(0, 255) || null;
  } catch {
    const m = /\/products\/([^/?#]+)/.exec(url);
    return m ? decodeURIComponent(m[1]).toLowerCase().slice(0, 255) : null;
  }
}

@Injectable()
export class MetaAdsSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetaAdsSyncService.name);
  private schedulerTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly jobs: JobQueueService,
    private readonly client: MetaMarketingClientService,
  ) {}

  onModuleInit() {
    // Slow external API round-trips → its own queue so it never holds a
    // `message`-worker slot. Low concurrency (external rate limits + one DB conn).
    this.jobs.registerWorker(
      QUEUE,
      (payload) => this.handle(payload as SyncJob),
      2,
      120,
    );
    // Per-tenant scheduler: every 10 min enqueue a pull for every tenant whose
    // cadence has elapsed (gated in syncAllCompanies). First tick a minute in.
    this.schedulerTimer = setInterval(() => {
      void this.syncAllCompanies().catch((e) =>
        this.logger.warn(`scheduler tick failed: ${(e as Error)?.message ?? e}`),
      );
    }, SCHEDULER_TICK_MS);
    setTimeout(() => void this.syncAllCompanies().catch(() => undefined), 60_000);
    this.logger.log('Registered meta-ads worker + per-tenant scheduler (tick 10m)');
  }

  onModuleDestroy() {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
  }

  /**
   * Resolve the token for ads calls. Default = reuse the tenant's existing
   * onboarding/primary Meta token (one token for WhatsApp + Ads); the encrypted
   * override column wins when set. Mirrors inbox/meta-client.service.ts.
   */
  async resolveAdsToken(companyId: number): Promise<string | null> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { meta_ads_token_encrypted: true, onboarding_status: true },
    });
    if (!company) return null;

    if (company.meta_ads_token_encrypted) {
      try {
        return this.encryption.decrypt(company.meta_ads_token_encrypted);
      } catch {
        this.logger.error(`Failed to decrypt ads override token (company ${companyId})`);
      }
    }
    const onboarding = company.onboarding_status as
      | { metaAccessTokenEncrypted?: string; metaAccessToken?: string }
      | null;
    const enc = onboarding?.metaAccessTokenEncrypted ?? onboarding?.metaAccessToken;
    if (enc) {
      try {
        return this.encryption.decrypt(enc);
      } catch {
        this.logger.error(`Failed to decrypt onboarding token (company ${companyId})`);
      }
    }
    const number = (
      await this.prisma.whatsAppNumber.findMany({
        where: { company_id: companyId, status: 'active' },
        orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
        select: { access_token_encrypted: true },
        take: 1,
      })
    )[0];
    if (number?.access_token_encrypted) {
      try {
        return this.encryption.decrypt(number.access_token_encrypted);
      } catch {
        this.logger.error(`Failed to decrypt primary number token (company ${companyId})`);
      }
    }
    return null;
  }

  /**
   * Pull campaign spend + Meta-native conversions for a window and upsert into
   * ad_spend_daily; also refresh the campaign→advertised-product map. Returns the
   * row count. Throws MetaAdsAuthError on a token/permission problem.
   */
  async pull(companyId: number, sinceDays: number): Promise<number> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { meta_ad_account_id: true, meta_ads_currency: true },
    });
    if (!company?.meta_ad_account_id) {
      this.logger.debug(`company ${companyId} has no ad account configured — skip`);
      return 0;
    }
    const token = await this.resolveAdsToken(companyId);
    if (!token) {
      throw new MetaAdsAuthError(
        'No Meta token available. Complete WhatsApp onboarding or set an ads override token.',
        'token',
      );
    }

    const until = new Date();
    const since = new Date(Date.now() - (sinceDays - 1) * 86_400_000);
    const rows = await this.client.getCampaignSpend(
      token,
      company.meta_ad_account_id,
      ymd(since),
      ymd(until),
    );

    for (const r of rows) {
      const spendDate = new Date(`${r.date}T00:00:00.000Z`);
      const common = {
        campaign_name: r.campaignName.slice(0, 512),
        spend: r.spend,
        impressions: r.impressions,
        clicks: r.clicks,
        meta_purchases: r.metaPurchases,
        meta_conversion_value: r.metaValue,
        currency: company.meta_ads_currency ?? null,
      };
      try {
        await this.prisma.adSpendDaily.upsert({
          where: {
            company_id_spend_date_campaign_id: {
              company_id: companyId,
              spend_date: spendDate,
              campaign_id: r.campaignId,
            },
          },
          create: {
            company_id: companyId,
            spend_date: spendDate,
            campaign_id: r.campaignId,
            ...common,
          },
          update: { ...common, synced_at: new Date() },
        });
      } catch (e) {
        this.logger.warn(
          `upsert ad_spend_daily failed (company ${companyId}, campaign ${r.campaignId}): ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }

    // Refresh the campaign → advertised-product map (best-effort, never throws).
    await this.syncAdCampaigns(companyId, token, company.meta_ad_account_id);

    await this.prisma.company.update({
      where: { id: companyId },
      data: { meta_ads_sync_last_at: new Date() },
    });
    return rows.length;
  }

  /** Read each campaign's ad destination URL → store the advertised product handle. */
  private async syncAdCampaigns(
    companyId: number,
    token: string,
    adAccountId: string,
  ): Promise<void> {
    try {
      const dests = await this.client.getAdDestinations(token, adAccountId);
      for (const d of dests) {
        const handle = parseProductHandle(d.url);
        try {
          await this.prisma.adCampaign.upsert({
            where: {
              company_id_campaign_id: {
                company_id: companyId,
                campaign_id: d.campaignId,
              },
            },
            create: {
              company_id: companyId,
              campaign_id: d.campaignId,
              campaign_name: d.campaignName?.slice(0, 512) || null,
              advertised_handle: handle,
            },
            update: {
              campaign_name: d.campaignName?.slice(0, 512) || undefined,
              advertised_handle: handle,
              synced_at: new Date(),
            },
          });
        } catch {
          /* per-row best-effort */
        }
      }
    } catch (e) {
      this.logger.warn(
        `syncAdCampaigns failed (company ${companyId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  private async handle(job: SyncJob): Promise<void> {
    const sinceDays = Math.min(
      Math.max(job.sinceDays ?? DEFAULT_WINDOW_DAYS, 1),
      MAX_BACKFILL_DAYS,
    );
    await this.pull(job.companyId, sinceDays);
  }

  /** Deduped single-flight enqueue (one live pull per tenant). */
  async requestSync(companyId: number, sinceDays?: number): Promise<{ started: true }> {
    await this.jobs.enqueue(
      QUEUE,
      { companyId, sinceDays } satisfies SyncJob,
      { dedupKey: `meta-ads:sync:${companyId}`, maxAttempts: 2 },
    );
    return { started: true };
  }

  /**
   * Enqueue a pull for every connected tenant whose per-tenant cadence elapsed.
   * Shared by the in-process scheduler AND the external /cron safety net.
   */
  async syncAllCompanies(): Promise<{ enqueued: number }> {
    const companies = await this.prisma.company.findMany({
      where: { meta_ad_account_id: { not: null } },
      select: {
        id: true,
        meta_ads_sync_interval_minutes: true,
        meta_ads_sync_last_at: true,
      },
    });
    const now = Date.now();
    let enqueued = 0;
    for (const c of companies) {
      const interval = Math.min(
        MAX_SYNC_INTERVAL_MIN,
        Math.max(
          MIN_SYNC_INTERVAL_MIN,
          c.meta_ads_sync_interval_minutes ?? DEFAULT_SYNC_INTERVAL_MIN,
        ),
      );
      const last = c.meta_ads_sync_last_at?.getTime() ?? 0;
      if (now - last < interval * 60_000) continue;
      await this.requestSync(c.id);
      // Stamp the enqueue time FIRST so a slow/failed run can't tight-loop.
      await this.prisma.company
        .update({ where: { id: c.id }, data: { meta_ads_sync_last_at: new Date() } })
        .catch(() => undefined);
      enqueued++;
    }
    return { enqueued };
  }

  /** Kick a backfill (last N days) for one company — used right after connect. */
  async backfill(companyId: number, days = 30): Promise<void> {
    await this.jobs.enqueue(
      QUEUE,
      { companyId, sinceDays: Math.min(days, MAX_BACKFILL_DAYS) } satisfies SyncJob,
      { maxAttempts: 2 },
    );
  }

  async getSchedule(companyId: number) {
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        meta_ads_sync_interval_minutes: true,
        meta_ads_sync_last_at: true,
      },
    });
    const intervalMinutes = c?.meta_ads_sync_interval_minutes ?? null;
    const effectiveMinutes = intervalMinutes ?? DEFAULT_SYNC_INTERVAL_MIN;
    const lastRunAt = c?.meta_ads_sync_last_at ?? null;
    const nextDueAt = lastRunAt
      ? new Date(lastRunAt.getTime() + effectiveMinutes * 60_000)
      : null;
    return {
      intervalMinutes,
      effectiveMinutes,
      defaultMinutes: DEFAULT_SYNC_INTERVAL_MIN,
      minMinutes: MIN_SYNC_INTERVAL_MIN,
      maxMinutes: MAX_SYNC_INTERVAL_MIN,
      lastRunAt,
      nextDueAt,
    };
  }

  async setSchedule(companyId: number, raw: number | null | undefined) {
    const intervalMinutes =
      raw == null
        ? null
        : Math.min(
            MAX_SYNC_INTERVAL_MIN,
            Math.max(MIN_SYNC_INTERVAL_MIN, Math.trunc(raw)),
          );
    await this.prisma.company.update({
      where: { id: companyId },
      data: { meta_ads_sync_interval_minutes: intervalMinutes },
    });
    return { intervalMinutes };
  }
}
