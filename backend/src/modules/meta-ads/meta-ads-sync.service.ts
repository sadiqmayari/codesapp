import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import {
  MetaMarketingClientService,
  MetaAdsAuthError,
} from './meta-marketing-client.service';

const QUEUE = 'meta-ads';
// Default refresh window on the daily sync: re-pull the last 3 days so a day's
// spend (which Meta keeps adjusting for a short while) firms up.
const DEFAULT_WINDOW_DAYS = 3;
const MAX_BACKFILL_DAYS = 90;

interface SyncJob {
  companyId: number;
  sinceDays?: number; // how many days back to pull (default DEFAULT_WINDOW_DAYS)
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class MetaAdsSyncService implements OnModuleInit {
  private readonly logger = new Logger(MetaAdsSyncService.name);

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
  }

  /**
   * Resolve the token for ads calls. Default = reuse the tenant's existing
   * onboarding/primary Meta token (one token for WhatsApp + Ads); the encrypted
   * override column wins when set. Mirrors the lookup order in
   * inbox/meta-client.service.ts getAccessToken().
   */
  async resolveAdsToken(companyId: number): Promise<string | null> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { meta_ads_token_encrypted: true, onboarding_status: true },
    });
    if (!company) return null;

    // 1. Explicit ads override token.
    if (company.meta_ads_token_encrypted) {
      try {
        return this.encryption.decrypt(company.meta_ads_token_encrypted);
      } catch {
        this.logger.error(`Failed to decrypt ads override token (company ${companyId})`);
      }
    }

    // 2. Onboarding token (Phase 3 canonical key, then Phase 2 fallback).
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

    // 3. Primary WhatsApp number token.
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
   * Pull campaign spend for a company over the given window and upsert into
   * ad_spend_daily. Returns the row count pulled. Throws MetaAdsAuthError on a
   * token/permission problem so the connect endpoint can surface it inline.
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
            campaign_name: r.campaignName.slice(0, 512),
            spend: r.spend,
            impressions: r.impressions,
            clicks: r.clicks,
            currency: company.meta_ads_currency ?? null,
          },
          update: {
            campaign_name: r.campaignName.slice(0, 512),
            spend: r.spend,
            impressions: r.impressions,
            clicks: r.clicks,
            currency: company.meta_ads_currency ?? null,
            synced_at: new Date(),
          },
        });
      } catch (e) {
        this.logger.warn(
          `upsert ad_spend_daily failed (company ${companyId}, campaign ${r.campaignId}): ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }

    await this.prisma.company.update({
      where: { id: companyId },
      data: { meta_ads_sync_last_at: new Date() },
    });
    return rows.length;
  }

  private async handle(job: SyncJob): Promise<void> {
    const sinceDays = Math.min(
      Math.max(job.sinceDays ?? DEFAULT_WINDOW_DAYS, 1),
      MAX_BACKFILL_DAYS,
    );
    await this.pull(job.companyId, sinceDays);
  }

  /** Enqueue a daily refresh for every company that has an ad account connected. */
  async syncAllCompanies(): Promise<{ enqueued: number }> {
    const companies = await this.prisma.company.findMany({
      where: { meta_ad_account_id: { not: null } },
      select: { id: true },
    });
    const today = ymd(new Date());
    let enqueued = 0;
    for (const c of companies) {
      const id = await this.jobs.enqueue(
        QUEUE,
        { companyId: c.id } as SyncJob,
        { dedupKey: `meta-ads:sync:${c.id}:${today}`, maxAttempts: 2 },
      );
      if (id) enqueued++;
    }
    return { enqueued };
  }

  /** Kick a backfill (last N days) for one company — used right after connect. */
  async backfill(companyId: number, days = 30): Promise<void> {
    await this.jobs.enqueue(
      QUEUE,
      { companyId, sinceDays: Math.min(days, MAX_BACKFILL_DAYS) } as SyncJob,
      { maxAttempts: 2 },
    );
  }
}
