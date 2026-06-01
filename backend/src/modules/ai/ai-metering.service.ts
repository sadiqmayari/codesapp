import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingService } from '../../common/services/platform-setting.service';
import {
  AI_DEFAULT_CAP_DEFAULT,
  AI_DEFAULT_CAP_KEY,
  AI_PRICE_MULTIPLIER_DEFAULT,
  AI_PRICE_MULTIPLIER_KEY,
  AiFeature,
  AiProviderName,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  PROVIDER_MODELS,
  ModelTier,
} from './ai.constants';
import { NormalizedUsage } from './providers/llm-provider.interface';

export interface AiMonthlyUsage {
  period: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Raw provider cost in micro-dollars (pre-markup). */
  costMicros: number;
  /** Tenant-billed amount in cents (cost x markup). */
  billedCents: number;
  /** Effective monthly cap in cents (0 = unlimited). */
  capCents: number;
  multiplier: number;
}

/**
 * AI usage metering + billing/gating. Writes the authoritative per-call
 * ledger (ai_usage_log) AND a fast monthly rollup (usage_metering). Enforces
 * the plan/company AI gate and the monthly spend cap. Cost is stored RAW
 * (micro-dollars); the markup multiplier is applied at billing/display.
 */
@Injectable()
export class AiMeteringService {
  private readonly logger = new Logger(AiMeteringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformSetting: PlatformSettingService,
  ) {}

  private currentPeriod(): string {
    return new Date().toISOString().slice(0, 7);
  }

  /** Raw provider cost (micro-dollars) for a usage record on a model tier. */
  computeCostMicros(
    provider: AiProviderName,
    tier: ModelTier,
    usage: NormalizedUsage,
  ): number {
    const m = PROVIDER_MODELS[provider][tier];
    const cost =
      usage.inputTokens * m.inMicros +
      usage.outputTokens * m.outMicros +
      usage.cacheReadTokens * m.inMicros * CACHE_READ_MULTIPLIER +
      usage.cacheWriteTokens * m.inMicros * CACHE_WRITE_MULTIPLIER;
    return Math.round(cost);
  }

  private async getMultiplier(): Promise<number> {
    const v = await this.platformSetting.get(
      AI_PRICE_MULTIPLIER_KEY,
      AI_PRICE_MULTIPLIER_DEFAULT,
    );
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 1.5;
  }

  /** micro-dollars (raw) → billed cents (after markup), rounded up. */
  private toBilledCents(costMicros: number, multiplier: number): number {
    return Math.ceil((costMicros * multiplier) / 10000);
  }

  /** Effective monthly cap (cents): company override ?? platform default. */
  private async getCapCents(companyOverride: number | null): Promise<number> {
    if (companyOverride !== null && companyOverride !== undefined) {
      return companyOverride;
    }
    const v = await this.platformSetting.get(
      AI_DEFAULT_CAP_KEY,
      AI_DEFAULT_CAP_DEFAULT,
    );
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  /**
   * Gate check before any AI call. Throws 403 when AI is not in the plan,
   * disabled for the company, or the monthly spend cap is reached.
   */
  async assertAllowed(companyId: number): Promise<void> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        ai_enabled: true,
        ai_monthly_cap_cents: true,
        subscription: { select: { ai_enabled: true } },
      },
    });
    if (!company) throw new ForbiddenException('Company not found.');
    if (!company.subscription?.ai_enabled) {
      throw new ForbiddenException('AI is not included in your plan.');
    }
    if (!company.ai_enabled) {
      throw new ForbiddenException('AI is disabled for your account.');
    }

    const cap = await this.getCapCents(company.ai_monthly_cap_cents);
    if (cap > 0) {
      const usage = await this.getMonthlyUsage(companyId, company.ai_monthly_cap_cents);
      if (usage.billedCents >= cap) {
        throw new ForbiddenException(
          'Monthly AI usage limit reached. Contact your administrator.',
        );
      }
    }
  }

  /**
   * Record one AI call: append to the ledger and bump the monthly rollup.
   * Best-effort — a metering write failure must not fail the user request
   * (the model call already succeeded), but it is logged loudly since it
   * affects billing accuracy.
   */
  async recordUsage(
    companyId: number,
    userId: number | null,
    feature: AiFeature,
    provider: AiProviderName,
    tier: ModelTier,
    usage: NormalizedUsage,
  ): Promise<void> {
    const period = this.currentPeriod();
    const modelId = PROVIDER_MODELS[provider][tier].id;
    const costMicros = this.computeCostMicros(provider, tier, usage);
    const totalInput =
      usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

    try {
      await this.prisma.aiUsageLog.create({
        data: {
          company_id: companyId,
          user_id: userId ?? undefined,
          period,
          feature,
          model: modelId,
          input_tokens: totalInput,
          output_tokens: usage.outputTokens,
          cost_micros: BigInt(costMicros),
        },
      });

      await this.prisma.$executeRawUnsafe(
        `INSERT INTO usage_metering
           (company_id, period, ai_requests, ai_input_tokens, ai_output_tokens, ai_cost_micros, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           ai_requests = ai_requests + 1,
           ai_input_tokens = ai_input_tokens + ?,
           ai_output_tokens = ai_output_tokens + ?,
           ai_cost_micros = ai_cost_micros + ?,
           updated_at = NOW()`,
        companyId,
        period,
        totalInput,
        usage.outputTokens,
        costMicros,
        totalInput,
        usage.outputTokens,
        costMicros,
      );
    } catch (e) {
      this.logger.error(
        `AI usage metering failed for company ${companyId} (${feature}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /** Current-month AI usage for a company (billed amount + cap). */
  async getMonthlyUsage(
    companyId: number,
    capOverride?: number | null,
  ): Promise<AiMonthlyUsage> {
    const period = this.currentPeriod();
    const [row, multiplier] = await Promise.all([
      this.prisma.usageMetering.findUnique({
        where: { company_id_period: { company_id: companyId, period } },
        select: {
          ai_requests: true,
          ai_input_tokens: true,
          ai_output_tokens: true,
          ai_cost_micros: true,
        },
      }),
      this.getMultiplier(),
    ]);

    const costMicros = Number(row?.ai_cost_micros ?? 0n);
    const cap =
      capOverride !== undefined
        ? await this.getCapCents(capOverride)
        : await this.resolveCapForCompany(companyId);

    return {
      period,
      requests: row?.ai_requests ?? 0,
      inputTokens: row?.ai_input_tokens ?? 0,
      outputTokens: row?.ai_output_tokens ?? 0,
      costMicros,
      billedCents: this.toBilledCents(costMicros, multiplier),
      capCents: cap,
      multiplier,
    };
  }

  private async resolveCapForCompany(companyId: number): Promise<number> {
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { ai_monthly_cap_cents: true },
    });
    return this.getCapCents(c?.ai_monthly_cap_cents ?? null);
  }

  /**
   * Sum RAW cost (micro-dollars) over an arbitrary window from the per-call
   * ledger — used by the invoice generator to bill a billing-cycle window.
   */
  async sumCostMicros(
    companyId: number,
    from: Date,
    to: Date,
  ): Promise<number> {
    const agg = await this.prisma.aiUsageLog.aggregate({
      where: { company_id: companyId, created_at: { gte: from, lt: to } },
      _sum: { cost_micros: true },
    });
    return Number(agg._sum.cost_micros ?? 0n);
  }

  /** Convert raw micros → billed cents using the current platform markup. */
  async billedCentsFor(costMicros: number): Promise<number> {
    const multiplier = await this.getMultiplier();
    return this.toBilledCents(costMicros, multiplier);
  }
}
