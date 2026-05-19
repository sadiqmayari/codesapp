import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from './cache.service';

export type UsageLimitAction = 'block' | 'warn_only';

const USAGE_LIMIT_ACTION_KEY = 'usage_limit_action';
const CACHE_TTL_SEC = 300;

/**
 * Super-admin controlled platform-wide settings (key/value). Currently the
 * platform default for usage-limit behavior; a per-company override on
 * `companies.usage_limit_action` takes precedence (resolved in PlanGuard).
 */
@Injectable()
export class PlatformSettingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  private cacheKey(key: string): string {
    return `platform-setting:${key}`;
  }

  async get(key: string, fallback: string): Promise<string> {
    const ck = this.cacheKey(key);
    const cached = this.cache.get<string>(ck);
    if (cached !== undefined && cached !== null) return cached;

    const row = await this.prisma.platformSetting.findUnique({
      where: { key },
    });
    const value = row?.value ?? fallback;
    this.cache.set(ck, value, CACHE_TTL_SEC);
    return value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.prisma.platformSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    this.cache.set(this.cacheKey(key), value, CACHE_TTL_SEC);
  }

  async getUsageLimitAction(): Promise<UsageLimitAction> {
    const v = await this.get(USAGE_LIMIT_ACTION_KEY, 'block');
    return v === 'warn_only' ? 'warn_only' : 'block';
  }

  async setUsageLimitAction(action: UsageLimitAction): Promise<void> {
    await this.set(USAGE_LIMIT_ACTION_KEY, action);
  }
}
