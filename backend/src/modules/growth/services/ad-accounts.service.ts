import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { EncryptionService } from '../../../common/services/encryption.service';
import { CacheService } from '../../../common/services/cache.service';
import { PlatformRegistry } from '../platforms/platform-registry';
import { AD_PLATFORMS, AdPlatform, AdPlatformAuthError, PLATFORM_LABEL } from '../platforms/ad-platform.types';
import { zoneOffset } from '../growth.util';

export interface ConnectAccountInput {
  platform: AdPlatform;
  externalId: string;
  token?: string;
  storeId?: number | null;
}

/** Ad account connections (any platform) + token resolution + base currency. */
@Injectable()
export class AdAccountsService {
  private readonly logger = new Logger(AdAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly cache: CacheService,
    private readonly registry: PlatformRegistry,
  ) {}

  /** The tenant's reporting currency = the currency most of its orders are in. */
  async baseCurrency(companyId: number): Promise<string | null> {
    const key = `growth:basecur:${companyId}`;
    const hit = this.cache.get<string | null>(key);
    if (hit !== undefined) return hit;
    const rows = await this.prisma.$queryRawUnsafe<Array<{ currency: string | null; c: bigint }>>(
      `SELECT currency, COUNT(*) c FROM (
         SELECT currency FROM shopify_orders WHERE company_id = ? AND currency IS NOT NULL
         ORDER BY id DESC LIMIT 2000) t GROUP BY currency ORDER BY c DESC LIMIT 1`,
      companyId,
    );
    let cur = rows[0]?.currency ?? null;
    if (!cur) {
      const acc = await this.prisma.adAccount.findFirst({
        where: { company_id: companyId, currency: { not: null } },
        select: { currency: true },
      });
      cur = acc?.currency ?? null;
    }
    this.cache.set(key, cur, 3600);
    return cur;
  }

  /** Meta: override token → onboarding token → primary WhatsApp number token. */
  async resolveToken(account: { company_id: number; platform: string; token_encrypted: string | null }): Promise<string | null> {
    if (account.token_encrypted) {
      try {
        return this.encryption.decrypt(account.token_encrypted);
      } catch {
        this.logger.error(`Failed to decrypt ${account.platform} token (company ${account.company_id})`);
      }
    }
    if (account.platform !== 'meta') return null;
    return this.metaFallbackToken(account.company_id);
  }

  private async metaFallbackToken(companyId: number): Promise<string | null> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { onboarding_status: true },
    });
    const ob = company?.onboarding_status as { metaAccessTokenEncrypted?: string; metaAccessToken?: string } | null;
    const enc = ob?.metaAccessTokenEncrypted ?? ob?.metaAccessToken;
    if (enc) {
      try {
        return this.encryption.decrypt(enc);
      } catch {
        /* fall through */
      }
    }
    const num = await this.prisma.whatsAppNumber.findFirst({
      where: { company_id: companyId, status: 'active' },
      orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
      select: { access_token_encrypted: true },
    });
    if (num?.access_token_encrypted) {
      try {
        return this.encryption.decrypt(num.access_token_encrypted);
      } catch {
        /* none */
      }
    }
    return null;
  }

  async list(companyId: number) {
    const [accounts, tenant] = await Promise.all([
      this.prisma.adAccount.findMany({
        where: { company_id: companyId, status: { not: 'disconnected' } },
        orderBy: [{ platform: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } }),
    ]);
    const base = await this.baseCurrency(companyId);
    const avail = this.registry.availability();
    const tenantOff = zoneOffset(tenant?.timezone ?? null);
    return {
      baseCurrency: base,
      platforms: AD_PLATFORMS.map((p) => ({ platform: p, label: PLATFORM_LABEL[p], available: avail[p] })),
      accounts: accounts.map((a) => ({
        id: a.id,
        platform: a.platform,
        externalId: a.external_id,
        name: a.name,
        currency: a.currency,
        timezone: a.timezone,
        storeId: a.store_id,
        status: a.status,
        usingOverrideToken: !!a.token_encrypted,
        capiEnabled: a.capi_enabled,
        capiDatasetId: a.capi_dataset_id,
        syncIntervalMin: a.sync_interval_min,
        connectedAt: a.connected_at,
        lastAttemptAt: a.last_attempt_at,
        lastSuccessAt: a.last_success_at,
        lastError: a.last_error,
        health: a.last_error ? 'error' : a.last_success_at ? 'ok' : 'pending',
        currencyMismatch: !!(a.currency && base && a.currency !== base),
        timezoneMismatch: !!(a.timezone && tenant?.timezone && zoneOffset(a.timezone) !== tenantOff),
      })),
    };
  }

  async connect(companyId: number, input: ConnectAccountInput) {
    const adapter = this.registry.get(input.platform);
    if (!adapter.available) {
      throw new ServiceUnavailableException(
        `${PLATFORM_LABEL[input.platform]} is not enabled yet — its developer app is pending approval.`,
      );
    }
    const externalId = input.externalId.trim().replace(/^act_/, '');
    if (!/^[\w-]{3,64}$/.test(externalId)) throw new BadRequestException('Enter the numeric ad account id.');
    if (input.token && this.encryption.isUsingPlaceholderKey()) {
      throw new ServiceUnavailableException('Server encryption key is not configured; cannot store a token.');
    }
    const token =
      input.token?.trim() ||
      (input.platform === 'meta' ? await this.metaFallbackToken(companyId) : null);
    if (!token) {
      throw new BadRequestException(
        input.platform === 'meta'
          ? 'No Meta token found. Finish WhatsApp onboarding, or paste a System User token with ads_read.'
          : 'Paste the access / refresh token for this account.',
      );
    }
    let info;
    try {
      info = await adapter.getAccountInfo(token, externalId);
    } catch (e) {
      throw new BadRequestException(
        e instanceof AdPlatformAuthError ? e.message : `Could not reach ${PLATFORM_LABEL[input.platform]}: ${(e as Error).message}`,
      );
    }
    const data = {
      name: info.name,
      currency: info.currency,
      timezone: info.timezone,
      store_id: input.storeId ?? null,
      status: 'active',
      last_error: null,
      ...(input.token ? { token_encrypted: this.encryption.encrypt(input.token.trim()) } : {}),
    };
    const acc = await this.prisma.adAccount.upsert({
      where: { company_id_platform_external_id: { company_id: companyId, platform: input.platform, external_id: externalId } },
      create: { company_id: companyId, platform: input.platform, external_id: externalId, ...data },
      update: { ...data, connected_at: new Date() },
    });
    this.cache.del(`growth:basecur:${companyId}`);
    return acc;
  }

  async update(
    companyId: number,
    id: number,
    patch: {
      syncIntervalMin?: number | null;
      storeId?: number | null;
      token?: string | null;
      capiEnabled?: boolean;
      capiDatasetId?: string | null;
    },
  ) {
    const acc = await this.get(companyId, id);
    const data: Record<string, unknown> = {};
    if (patch.syncIntervalMin !== undefined) {
      data.sync_interval_min = patch.syncIntervalMin == null ? null : Math.min(1440, Math.max(30, Math.trunc(patch.syncIntervalMin)));
    }
    if (patch.storeId !== undefined) data.store_id = patch.storeId;
    if (patch.token !== undefined) {
      if (patch.token && this.encryption.isUsingPlaceholderKey()) {
        throw new ServiceUnavailableException('Server encryption key is not configured; cannot store a token.');
      }
      data.token_encrypted = patch.token ? this.encryption.encrypt(patch.token.trim()) : null;
    }
    if (patch.capiDatasetId !== undefined) data.capi_dataset_id = patch.capiDatasetId || null;
    if (patch.capiEnabled !== undefined) {
      const dataset = patch.capiDatasetId !== undefined ? patch.capiDatasetId : acc.capi_dataset_id;
      if (patch.capiEnabled && (acc.platform !== 'meta' || !dataset)) {
        throw new BadRequestException('Enter your Meta dataset (pixel) id to send delivered purchases.');
      }
      data.capi_enabled = patch.capiEnabled;
    }
    return this.prisma.adAccount.update({ where: { id: acc.id }, data });
  }

  /** Disconnect = remove the account and its pulled data (re-pullable on reconnect). */
  async disconnect(companyId: number, id: number) {
    const acc = await this.get(companyId, id);
    await this.prisma.$transaction([
      this.prisma.adInsightDaily.deleteMany({ where: { company_id: companyId, account_id: acc.id } }),
      this.prisma.adEntity.deleteMany({ where: { company_id: companyId, account_id: acc.id } }),
      this.prisma.adAccount.delete({ where: { id: acc.id } }),
    ]);
    return { success: true };
  }

  async get(companyId: number, id: number) {
    const acc = await this.prisma.adAccount.findFirst({ where: { id, company_id: companyId } });
    if (!acc) throw new NotFoundException('Ad account not found');
    return acc;
  }
}
