import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from './cache.service';
import {
  AI_AGENT_COMPANY_IDS_KEY,
  AI_AUTONOMOUS_TIER_DEFAULT,
  AI_AUTONOMOUS_TIER_KEY,
  ModelTier,
} from '../../modules/ai/ai.constants';

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

  /** Model tier for autonomous AI (auto-reply + auto-order). Platform-wide. */
  async getAutonomousTier(): Promise<ModelTier> {
    const v = await this.get(AI_AUTONOMOUS_TIER_KEY, AI_AUTONOMOUS_TIER_DEFAULT);
    return v === 'smart' ? 'smart' : 'fast';
  }

  async setAutonomousTier(tier: ModelTier): Promise<void> {
    await this.set(AI_AUTONOMOUS_TIER_KEY, tier);
  }

  /** Whether the Phase-2 tool-calling agent is enabled for this company. */
  async isAiAgentEnabled(companyId: number): Promise<boolean> {
    const csv = await this.get(AI_AGENT_COMPANY_IDS_KEY, '');
    const trimmed = csv.trim();
    if (trimmed === '*') return true;
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(String(companyId));
  }
}
