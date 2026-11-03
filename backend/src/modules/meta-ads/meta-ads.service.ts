import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { MetaAdsSyncService } from './meta-ads-sync.service';
import {
  MetaAdsAuthError,
  MetaMarketingClientService,
} from './meta-marketing-client.service';
import { ConnectMetaAdsDto } from './dtos/connect-meta-ads.dto';
import { SetTargetsDto } from './dtos/set-targets.dto';

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class MetaAdsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly sync: MetaAdsSyncService,
    private readonly client: MetaMarketingClientService,
  ) {}

  async getConnection(companyId: number) {
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        meta_ad_account_id: true,
        meta_ads_currency: true,
        meta_ads_connected_at: true,
        meta_ads_sync_last_at: true,
        meta_ads_token_encrypted: true,
      },
    });
    return {
      connected: !!c?.meta_ad_account_id,
      adAccountId: c?.meta_ad_account_id ?? null,
      currency: c?.meta_ads_currency ?? null,
      connectedAt: c?.meta_ads_connected_at ?? null,
      lastSyncAt: c?.meta_ads_sync_last_at ?? null,
      usingOverrideToken: !!c?.meta_ads_token_encrypted,
    };
  }

  async connect(companyId: number, dto: ConnectMetaAdsDto) {
    const numericAccount = dto.adAccountId.replace(/^act_/, '');

    // Storing an override secret requires a real encryption key.
    if (dto.token && this.encryption.isUsingPlaceholderKey()) {
      throw new ServiceUnavailableException(
        'Server encryption key is not configured; cannot store an ads token.',
      );
    }

    // Resolve the token we'll validate with: the provided override, else the
    // tenant's existing WhatsApp/onboarding token.
    const token = dto.token ?? (await this.sync.resolveAdsToken(companyId));
    if (!token) {
      throw new BadRequestException(
        'No Meta token found. Finish WhatsApp onboarding first, or paste an ads token with the ads_read permission.',
      );
    }

    // Validate against Meta with a cheap 1-day pull before we persist anything.
    const today = ymd(new Date());
    try {
      await this.client.getCampaignSpend(token, numericAccount, today, today);
    } catch (e) {
      if (e instanceof MetaAdsAuthError) {
        throw new BadRequestException(e.message);
      }
      throw new BadRequestException(
        `Could not reach the Meta Ads API: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        meta_ad_account_id: numericAccount,
        meta_ads_currency: dto.currency?.trim() || null,
        meta_ads_connected_at: new Date(),
        // Only overwrite the override token when one was provided (blank keeps
        // the current setting — null meaning "reuse the WhatsApp token").
        ...(dto.token
          ? { meta_ads_token_encrypted: this.encryption.encrypt(dto.token.trim()) }
          : {}),
      },
    });

    // Backfill the last 30 days so the report has history immediately.
    await this.sync.backfill(companyId, 30);
    return this.getConnection(companyId);
  }

  async disconnect(companyId: number) {
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        meta_ad_account_id: null,
        meta_ads_currency: null,
        meta_ads_connected_at: null,
        meta_ads_token_encrypted: null,
      },
    });
    return { success: true };
  }

  /** Clear only the override token (fall back to reusing the WhatsApp token). */
  async clearOverrideToken(companyId: number) {
    await this.prisma.company.update({
      where: { id: companyId },
      data: { meta_ads_token_encrypted: null },
    });
    return this.getConnection(companyId);
  }

  async getTargets(companyId: number, month: string) {
    const rows = await this.prisma.productTarget.findMany({
      where: { company_id: companyId, period_month: month },
      orderBy: { product_key: 'asc' },
    });
    return rows.map((r) => ({
      productKey: r.product_key,
      targetValue: Number(r.target_value),
      targetUnits: r.target_units,
    }));
  }

  async setTargets(companyId: number, dto: SetTargetsDto) {
    for (const item of dto.items) {
      const key = item.productKey.trim().slice(0, 255);
      if (!key) continue;
      await this.prisma.productTarget.upsert({
        where: {
          company_id_product_key_period_month: {
            company_id: companyId,
            product_key: key,
            period_month: dto.month,
          },
        },
        create: {
          company_id: companyId,
          product_key: key,
          period_month: dto.month,
          target_value: item.targetValue,
          target_units: Math.round(item.targetUnits),
        },
        update: {
          target_value: item.targetValue,
          target_units: Math.round(item.targetUnits),
        },
      });
    }
    return this.getTargets(companyId, dto.month);
  }
}
