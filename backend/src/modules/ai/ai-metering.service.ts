import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingService } from '../../common/services/platform-setting.service';
import {
  AI_DEFAULT_CAP_DEFAULT,
  AI_DEFAULT_CAP_KEY,
  AI_KILL_SWITCH_KEY,
  AI_MODEL_KEY,
  AI_PRICE_MULTIPLIER_DEFAULT,
  AI_PRICE_MULTIPLIER_KEY,
  AI_PROVIDER_DEFAULT,
  AI_PROVIDER_KEY,
  AiFeature,
  AiProviderName,
  CACHE_WRITE_MULTIPLIER,
  DEFAULT_TIER_MODELS,
  EST_IMAGE_TOKENS,
  EST_REPLY_IN_TOKENS,
  EST_REPLY_OUT_TOKENS,
  ModelTier,
  modelSpec,
} from './ai.constants';
import { WHISPER_MICROS_PER_SEC } from './audio-transcription.service';
import { NormalizedUsage } from './providers/llm-provider.interface';

/** Tenant-facing cost estimates (USD, billed) for the Settings → AI selectors. */
export interface AiCostEstimates {
  provider: AiProviderName;
  standardPer1kRepliesUsd: number;
  highAccuracyPer1kRepliesUsd: number;
  visionPer100PhotosUsd: number;
  voicePerMinuteUsd: number;
}

/** Optional per-call context written on the ledger row (v2). */
export interface UsageContext {
  /** Exact model id used (falls back to the tier default). */
  modelId?: string;
  conversationId?: number | null;
  latencyMs?: number;
  promptVersion?: string;
  success?: boolean;
}

/** Why AI is currently unavailable for a tenant (null = available). */
export type AiBlockReason =
  | 'platform_off'
  | 'plan'
  | 'admin_disabled'
  | 'tenant_disabled'
  | 'cap_reached'
  | null;

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

const BLOCK_MESSAGES: Record<Exclude<AiBlockReason, null>, string> = {
  platform_off: 'AI is temporarily paused by the platform.',
  plan: 'AI is not included in your plan.',
  admin_disabled: 'AI has been disabled for your account by the platform.',
  tenant_disabled: 'AI is disabled for your account.',
  cap_reached: 'Monthly AI usage limit reached. Contact your administrator.',
};

/**
 * AI usage metering + billing/gating. Writes the authoritative per-call
 * ledger (ai_usage_log) AND a fast monthly rollup (usage_metering). Enforces
 * the platform kill switch, the plan/company/super-admin gates and the monthly
 * spend cap. Cost is stored RAW (micro-dollars); the markup multiplier is
 * applied at billing/display and snapshotted on every ledger row.
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

  /** Raw provider cost (micro-dollars) for a usage record. */
  computeCostMicros(
    provider: AiProviderName,
    tier: ModelTier,
    usage: NormalizedUsage,
    modelId?: string,
  ): number {
    const m = modelSpec(
      modelId ?? DEFAULT_TIER_MODELS[provider][tier],
      provider,
      tier,
    );
    const cost =
      usage.inputTokens * m.inMicros +
      usage.outputTokens * m.outMicros +
      usage.cacheReadTokens * m.cacheReadMicros +
      usage.cacheWriteTokens * m.inMicros * CACHE_WRITE_MULTIPLIER;
    return Math.round(cost);
  }

  async getMultiplier(): Promise<number> {
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

  /** Platform default monthly cap (billed cents; 0 = unlimited). */
  async getDefaultCapCents(): Promise<number> {
    const v = await this.platformSetting.get(
      AI_DEFAULT_CAP_KEY,
      AI_DEFAULT_CAP_DEFAULT,
    );
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  /**
   * Effective monthly cap (billed cents, 0 = unlimited). The super-admin
   * ceiling (per-tenant `ai_admin_cap_cents` ?? platform default) is HARD; the
   * tenant's own `ai_monthly_cap_cents` can only LOWER it. A tenant value of
   * 0/NULL means "use the ceiling" — it can no longer mean unlimited (that was
   * the cap-bypass bug).
   */
  async effectiveCapCents(c: {
    ai_monthly_cap_cents: number | null;
    ai_admin_cap_cents?: number | null;
  }): Promise<number> {
    const ceiling =
      c.ai_admin_cap_cents !== null && c.ai_admin_cap_cents !== undefined
        ? Math.max(0, c.ai_admin_cap_cents)
        : await this.getDefaultCapCents();
    const own =
      c.ai_monthly_cap_cents && c.ai_monthly_cap_cents > 0
        ? c.ai_monthly_cap_cents
        : 0;
    if (!own) return ceiling;
    if (ceiling === 0) return own;
    return Math.min(own, ceiling);
  }

  /** Is the platform-wide AI kill switch on (AI allowed)? */
  async platformEnabled(): Promise<boolean> {
    return (await this.platformSetting.get(AI_KILL_SWITCH_KEY, 'on')) !== 'off';
  }

  /**
   * Why AI is unavailable for a tenant right now (null = available). Never
   * throws — powers the inbox "AI paused" badge and the settings banner.
   */
  async blockReason(companyId: number): Promise<AiBlockReason> {
    if (!(await this.platformEnabled())) return 'platform_off';
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        ai_enabled: true,
        ai_admin_disabled: true,
        ai_monthly_cap_cents: true,
        ai_admin_cap_cents: true,
        subscription: { select: { ai_enabled: true } },
      },
    });
    if (!company || !company.subscription?.ai_enabled) return 'plan';
    if (company.ai_admin_disabled) return 'admin_disabled';
    if (!company.ai_enabled) return 'tenant_disabled';
    const cap = await this.effectiveCapCents(company);
    if (cap > 0) {
      const usage = await this.getMonthlyUsage(companyId, cap);
      if (usage.billedCents >= cap) return 'cap_reached';
    }
    return null;
  }

  /**
   * Gate check before ANY AI spend (model call, transcription, embedding).
   * Throws 403 with a tenant-readable message when blocked.
   */
  async assertAllowed(companyId: number): Promise<void> {
    const reason = await this.blockReason(companyId);
    if (reason) throw new ForbiddenException(BLOCK_MESSAGES[reason]);
  }

  /**
   * Shared monthly-rollup upsert. `countRequest` = true only for model
   * (chat/agent) calls — embeddings and transcriptions add cost/tokens but are
   * not "AI requests" (they inflated the Requests tile before).
   */
  private async bumpRollup(
    companyId: number,
    period: string,
    inputTokens: number,
    outputTokens: number,
    costMicros: number,
    countRequest: boolean,
  ): Promise<void> {
    const req = countRequest ? 1 : 0;
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO usage_metering
         (company_id, period, ai_requests, ai_input_tokens, ai_output_tokens, ai_cost_micros, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         ai_requests = ai_requests + ?,
         ai_input_tokens = ai_input_tokens + ?,
         ai_output_tokens = ai_output_tokens + ?,
         ai_cost_micros = ai_cost_micros + ?,
         updated_at = NOW()`,
      companyId,
      period,
      req,
      inputTokens,
      outputTokens,
      costMicros,
      req,
      inputTokens,
      outputTokens,
      costMicros,
    );
  }

  private async ledger(
    companyId: number,
    data: {
      userId?: number | null;
      feature: AiFeature;
      model: string;
      inputTokens: number;
      outputTokens: number;
      costMicros: number;
      ctx?: UsageContext;
    },
  ): Promise<void> {
    const multiplier = await this.getMultiplier();
    await this.prisma.aiUsageLog.create({
      data: {
        company_id: companyId,
        user_id: data.userId ?? undefined,
        period: this.currentPeriod(),
        feature: data.feature,
        model: data.model.slice(0, 64),
        input_tokens: data.inputTokens,
        output_tokens: data.outputTokens,
        cost_micros: BigInt(data.costMicros),
        conversation_id: data.ctx?.conversationId ?? undefined,
        latency_ms: data.ctx?.latencyMs ?? undefined,
        prompt_version: data.ctx?.promptVersion?.slice(0, 64),
        success: data.ctx?.success ?? true,
        multiplier_x1000: Math.round(multiplier * 1000),
      },
    });
  }

  /**
   * Record one model call: append to the ledger and bump the monthly rollup.
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
    ctx: UsageContext = {},
  ): Promise<void> {
    const modelId = ctx.modelId ?? DEFAULT_TIER_MODELS[provider][tier];
    const costMicros = this.computeCostMicros(provider, tier, usage, modelId);
    const totalInput =
      usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    try {
      await this.ledger(companyId, {
        userId,
        feature,
        model: modelId,
        inputTokens: totalInput,
        outputTokens: usage.outputTokens,
        costMicros,
        ctx,
      });
      await this.bumpRollup(
        companyId,
        this.currentPeriod(),
        totalInput,
        usage.outputTokens,
        costMicros,
        true,
      );
    } catch (e) {
      this.logger.error(
        `AI usage metering failed for company ${companyId} (${feature}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * Record a Whisper transcription cost (not token-based). Folds into the AI
   * bill but does not count as an AI request. Best-effort.
   */
  async recordTranscription(
    companyId: number,
    costMicros: number,
    conversationId?: number | null,
  ): Promise<void> {
    const micros = Math.max(0, Math.round(costMicros));
    try {
      await this.ledger(companyId, {
        feature: 'transcription',
        model: 'whisper-1',
        inputTokens: 0,
        outputTokens: 0,
        costMicros: micros,
        ctx: { conversationId },
      });
      await this.bumpRollup(companyId, this.currentPeriod(), 0, 0, micros, false);
    } catch (e) {
      this.logger.error(
        `AI transcription metering failed for company ${companyId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * Record an embedding cost (indexing OR a retrieval query). Token-based;
   * folds into the monthly AI bill, not a request. Best-effort.
   */
  async recordEmbedding(
    companyId: number,
    tokens: number,
    costMicros: number,
  ): Promise<void> {
    const micros = Math.max(0, Math.round(costMicros));
    const tok = Math.max(0, Math.round(tokens));
    try {
      await this.ledger(companyId, {
        feature: 'embedding',
        model: 'text-embedding-3-small',
        inputTokens: tok,
        outputTokens: 0,
        costMicros: micros,
      });
      await this.bumpRollup(companyId, this.currentPeriod(), tok, 0, micros, false);
    } catch (e) {
      this.logger.error(
        `AI embedding metering failed for company ${companyId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /** Current-month AI usage for a company (billed amount + cap). */
  async getMonthlyUsage(
    companyId: number,
    resolvedCap?: number,
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
      resolvedCap !== undefined
        ? resolvedCap
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

  async resolveCapForCompany(companyId: number): Promise<number> {
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { ai_monthly_cap_cents: true, ai_admin_cap_cents: true },
    });
    return this.effectiveCapCents({
      ai_monthly_cap_cents: c?.ai_monthly_cap_cents ?? null,
      ai_admin_cap_cents: c?.ai_admin_cap_cents ?? null,
    });
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

  /**
   * Tenant-facing cost estimates (USD, billed) for the AI quality / vision /
   * voice selectors. Priced against the ACTIVE provider's LIVE tier models and
   * the current markup. DISPLAY estimates only, never billed.
   */
  async getCostEstimates(): Promise<AiCostEstimates> {
    const [providerRaw, multiplier] = await Promise.all([
      this.platformSetting.get(AI_PROVIDER_KEY, AI_PROVIDER_DEFAULT),
      this.getMultiplier(),
    ]);
    const provider: AiProviderName =
      providerRaw === 'openai' ? 'openai' : 'anthropic';
    const live = async (t: ModelTier) =>
      modelSpec(
        await this.platformSetting.get(
          AI_MODEL_KEY(provider, t),
          DEFAULT_TIER_MODELS[provider][t],
        ),
        provider,
        t,
      );
    const models = { fast: await live('fast'), smart: await live('smart') };

    const replyMicros = (m: { inMicros: number; outMicros: number }): number =>
      EST_REPLY_IN_TOKENS * m.inMicros + EST_REPLY_OUT_TOKENS * m.outMicros;
    const usd = (micros: number): number =>
      Math.round((micros * multiplier) / 100) / 10000; // micros→USD, 4 dp

    return {
      provider,
      standardPer1kRepliesUsd: usd(replyMicros(models.fast) * 1000),
      highAccuracyPer1kRepliesUsd: usd(replyMicros(models.smart) * 1000),
      visionPer100PhotosUsd: usd(EST_IMAGE_TOKENS * models.fast.inMicros * 100),
      voicePerMinuteUsd: usd(WHISPER_MICROS_PER_SEC * 60),
    };
  }
}
