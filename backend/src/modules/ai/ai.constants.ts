/**
 * AI Copilot model + pricing config.
 *
 * Two model tiers: `fast` (Haiku) for high-volume cheap tasks
 * (suggest/rewrite/translate) and `smart` (Sonnet) for higher-quality
 * reasoning (summaries). Picked per feature in AiService.
 *
 * Pricing is expressed in MICRO-dollars per token (millionths of USD).
 * Conveniently, $X per million tokens == X micro-dollars per token, so the
 * numbers below are just the published per-MTok USD prices. Adjust here if
 * Anthropic pricing changes — this is the single source of truth.
 *
 * Cache multipliers: a cache READ costs 0.1x the input rate; a 5-minute
 * cache WRITE costs 1.25x. Applied to the respective usage token buckets.
 */
export type ModelTier = 'fast' | 'smart';

export interface ModelConfig {
  /** Anthropic model id. */
  id: string;
  /** Micro-dollars per input token (== USD per MTok). */
  inMicros: number;
  /** Micro-dollars per output token. */
  outMicros: number;
}

export const MODELS: Record<ModelTier, ModelConfig> = {
  // Claude Haiku 4.5 — $1 / $5 per MTok.
  fast: { id: 'claude-haiku-4-5-20251001', inMicros: 1, outMicros: 5 },
  // Claude Sonnet 4.6 — $3 / $15 per MTok.
  smart: { id: 'claude-sonnet-4-6', inMicros: 3, outMicros: 15 },
};

/** Cache-read tokens are billed at 0.1x the base input rate. */
export const CACHE_READ_MULTIPLIER = 0.1;
/** 5-minute cache-write tokens are billed at 1.25x the base input rate. */
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** AI feature identifiers (logged in ai_usage_log.feature). */
export type AiFeature =
  | 'suggest_reply'
  | 'rewrite'
  | 'translate'
  | 'summarize';

/** Platform-setting key for the billing markup (billed = raw x multiplier). */
export const AI_PRICE_MULTIPLIER_KEY = 'ai_price_multiplier';
export const AI_PRICE_MULTIPLIER_DEFAULT = '1.5';

/** Platform-setting key for the default monthly spend cap (cents; 0 = none). */
export const AI_DEFAULT_CAP_KEY = 'ai_default_monthly_cap_cents';
export const AI_DEFAULT_CAP_DEFAULT = '0';

/** How many recent messages to feed the model for grounding. */
export const CONTEXT_MESSAGE_LIMIT = 25;
/** Hard cap on knowledge-base characters injected (keeps the prompt bounded). */
export const KB_CHAR_BUDGET = 12000;
