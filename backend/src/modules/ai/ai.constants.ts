/**
 * AI Copilot model + pricing config — provider-agnostic.
 *
 * The active provider (Anthropic or OpenAI) is a platform setting
 * (`platform_settings.ai_provider`, default 'anthropic'), super-admin
 * controlled. Each provider exposes two tiers: `fast` for high-volume cheap
 * tasks (suggest/rewrite/translate/auto-reply) and `smart` for higher-quality
 * reasoning (summaries). Picked per feature in AiService.
 *
 * Pricing is MICRO-dollars per token (millionths of USD). Conveniently
 * $X per million tokens == X micro-dollars per token, so the numbers below
 * are the published per-MTok USD prices. This file is the single source of
 * truth — adjust here if provider pricing changes.
 *
 * Cache multipliers (Anthropic explicit / OpenAI auto): a cache READ costs
 * 0.1x the input rate; an Anthropic 5-minute cache WRITE costs 1.25x.
 */
export type AiProviderName = 'anthropic' | 'openai';
export type ModelTier = 'fast' | 'smart';

export interface ModelConfig {
  /** Provider model id. */
  id: string;
  /** Micro-dollars per input token (== USD per MTok). */
  inMicros: number;
  /** Micro-dollars per output token. */
  outMicros: number;
}

export const PROVIDER_MODELS: Record<
  AiProviderName,
  Record<ModelTier, ModelConfig>
> = {
  anthropic: {
    // Claude Haiku 4.5 — $1 / $5 per MTok.
    fast: { id: 'claude-haiku-4-5-20251001', inMicros: 1, outMicros: 5 },
    // Claude Sonnet 4.6 — $3 / $15 per MTok.
    smart: { id: 'claude-sonnet-4-6', inMicros: 3, outMicros: 15 },
  },
  openai: {
    // GPT-4o mini — $0.15 / $0.60 per MTok.
    fast: { id: 'gpt-4o-mini', inMicros: 0.15, outMicros: 0.6 },
    // GPT-4o — $2.50 / $10.00 per MTok.
    smart: { id: 'gpt-4o', inMicros: 2.5, outMicros: 10 },
  },
};

/** Cache-read tokens are billed at 0.1x the base input rate. */
export const CACHE_READ_MULTIPLIER = 0.1;
/** Anthropic 5-minute cache-write tokens are billed at 1.25x the input rate. */
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** AI feature identifiers (logged in ai_usage_log.feature). */
export type AiFeature =
  | 'suggest_reply'
  | 'rewrite'
  | 'translate'
  | 'summarize'
  | 'autoreply'
  | 'triage'
  | 'draft_order'
  | 'transcription'
  | 'embedding';

/**
 * RAG embeddings (OpenAI). Used independently of the active TEXT provider
 * (Anthropic has no embeddings API), so the embedding service reads
 * OPENAI_API_KEY directly. 1536-dim; $0.02 / MTok == 0.02 micro-dollars/token.
 */
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM = 1536;
export const EMBEDDING_MICROS_PER_TOKEN = 0.02;
/** Rough token estimate for cheap metering (≈4 chars/token). */
export const CHARS_PER_TOKEN = 4;

/** Retrieval: how many top chunks to inject, and their combined char budget. */
export const RAG_TOP_K = 8;
export const RAG_CHAR_BUDGET = 14000;
/**
 * Relevance gate so weakly-related products (other brands, unrelated items) are
 * not injected and then recommended. RELATIVE to the best hit (so short/informal
 * product names still match their top product), plus a low absolute floor. The
 * single best hit is always kept.
 */
export const RAG_REL_FLOOR = 0.6;
export const RAG_ABS_FLOOR = 0.15;

/** Platform-setting key for the active provider. */
export const AI_PROVIDER_KEY = 'ai_provider';
export const AI_PROVIDER_DEFAULT: AiProviderName = 'anthropic';

/**
 * Phase 2 tool-calling agent rollout flag. CSV of company ids the agent is
 * enabled for (e.g. "3,7"), or "*" for all. Empty = off everywhere (the
 * hardened two-brain flow runs instead). Lets us enable the agent per-tenant.
 */
export const AI_AGENT_COMPANY_IDS_KEY = 'ai_agent_company_ids';
/** Max tool calls the agent may make per customer message (bounded for shared hosting). */
export const AI_AGENT_MAX_STEPS = 4;

/**
 * Platform-setting key for the model tier used by the AUTONOMOUS features
 * (auto-reply decision + order draft/auto-order). Super-admin controlled,
 * platform-wide. 'fast' = cheaper Haiku/GPT-4o-mini; 'smart' = Sonnet/GPT-4o
 * for better judgment. Interactive agent features (suggest/rewrite/translate/
 * summarize) keep their own fixed tiers.
 */
export const AI_AUTONOMOUS_TIER_KEY = 'ai_autonomous_tier';
export const AI_AUTONOMOUS_TIER_DEFAULT: ModelTier = 'fast';

/** Platform-setting key for the billing markup (billed = raw x multiplier). */
export const AI_PRICE_MULTIPLIER_KEY = 'ai_price_multiplier';
export const AI_PRICE_MULTIPLIER_DEFAULT = '1.5';

/**
 * Platform-setting key for the default monthly spend cap (BILLED cents) applied
 * to tenants with no `companies.ai_monthly_cap_cents` of their own. This is the
 * safety net that makes tenant self-service (smart tier / vision / voice) safe —
 * default is a sane non-zero ceiling ($20/mo billed), NOT unlimited. A tenant
 * may raise their own cap; an explicit 0 on a company = unlimited for that tenant.
 */
export const AI_DEFAULT_CAP_KEY = 'ai_default_monthly_cap_cents';
export const AI_DEFAULT_CAP_DEFAULT = '2000';

/**
 * Representative token counts for the tenant-facing COST ESTIMATE only (Settings
 * → AI). Sourced from real production usage (an auto-reply averages ~1,650 input
 * + ~60 output tokens). Used to show "≈ $X per 1,000 AI replies" per tier and a
 * per-image / per-minute figure — display estimates, never billed.
 */
export const EST_REPLY_IN_TOKENS = 1650;
export const EST_REPLY_OUT_TOKENS = 60;
/** Approx tokens a single inbound image adds to a vision call. */
export const EST_IMAGE_TOKENS = 1100;

/** How many recent messages to feed the model for grounding. */
export const CONTEXT_MESSAGE_LIMIT = 25;
/** Hard cap on knowledge-base characters injected (keeps the prompt bounded).
 *  Sized to fit a synced Shopify product catalogue plus manual FAQ/policy
 *  entries; the KB block is prompt-cached so repeat calls stay cheap. */
export const KB_CHAR_BUDGET = 35000;
