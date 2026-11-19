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

/**
 * Model catalogue — the SINGLE source of truth for per-model price + request
 * capabilities. The model id used for each tier is a super-admin platform
 * setting (`ai_model_<provider>_<tier>`, see AI_MODEL_KEY); an id not listed
 * here is still usable and is priced at its provider's tier default.
 *
 *  - `temperature`  false → the model rejects a non-default temperature (Claude
 *    Haiku 5.5 / Sonnet 5.5): the provider omits it.
 *  - `effort`       true → send `output_config.effort` (Claude 4.6+ / 5.x).
 *  - `thinkingOff`  how to switch thinking off for a plain (non-agentic) call:
 *    'disabled' = `{type:'disabled'}`, 'between_tools' = Sonnet 5.5's form,
 *    'none' = the model can't (omit and lower effort), 'n/a' = no thinking.
 *  - `thinkingReplay` true → assistant thinking blocks MUST be echoed back
 *    unchanged inside a tool loop (we keep the provider-native content).
 */
export interface ModelSpec extends ModelConfig {
  provider: AiProviderName;
  label: string;
  /** Micro-dollars per cached-read input token. */
  cacheReadMicros: number;
  temperature: boolean;
  effort: boolean;
  thinkingOff: 'disabled' | 'between_tools' | 'none' | 'n/a';
  thinkingReplay: boolean;
}

export const MODEL_CATALOG: ModelSpec[] = [
  // ── Anthropic — current generation (recommended) ──
  { provider: 'anthropic', id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', inMicros: 0.1, outMicros: 0.5, cacheReadMicros: 0.01, temperature: false, effort: true, thinkingOff: 'disabled', thinkingReplay: true },
  { provider: 'anthropic', id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', inMicros: 2, outMicros: 10, cacheReadMicros: 0.1, temperature: false, effort: true, thinkingOff: 'between_tools', thinkingReplay: true },
  { provider: 'anthropic', id: 'claude-opus-5-5', label: 'Claude Opus 5.5', inMicros: 4, outMicros: 20, cacheReadMicros: 0.2, temperature: false, effort: true, thinkingOff: 'none', thinkingReplay: true },
  // ── Anthropic — previous generation (kept so old ids still price correctly) ──
  { provider: 'anthropic', id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', inMicros: 1, outMicros: 5, cacheReadMicros: 0.1, temperature: true, effort: false, thinkingOff: 'n/a', thinkingReplay: false },
  { provider: 'anthropic', id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', inMicros: 1, outMicros: 5, cacheReadMicros: 0.1, temperature: true, effort: false, thinkingOff: 'n/a', thinkingReplay: false },
  { provider: 'anthropic', id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', inMicros: 3, outMicros: 15, cacheReadMicros: 0.3, temperature: true, effort: false, thinkingOff: 'n/a', thinkingReplay: false },
  // ── OpenAI ──
  { provider: 'openai', id: 'gpt-4o-mini', label: 'GPT-4o mini', inMicros: 0.15, outMicros: 0.6, cacheReadMicros: 0.075, temperature: true, effort: false, thinkingOff: 'n/a', thinkingReplay: false },
  { provider: 'openai', id: 'gpt-4o', label: 'GPT-4o', inMicros: 2.5, outMicros: 10, cacheReadMicros: 1.25, temperature: true, effort: false, thinkingOff: 'n/a', thinkingReplay: false },
];

/** Default model id per provider × tier (used until the super-admin changes it). */
export const DEFAULT_TIER_MODELS: Record<AiProviderName, Record<ModelTier, string>> = {
  anthropic: { fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5' },
  openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
};

/** Platform-setting key holding the model id for a provider tier. */
export const AI_MODEL_KEY = (p: AiProviderName, t: ModelTier): string =>
  `ai_model_${p}_${t}`;

/** Look up a model's spec; unknown ids inherit the provider tier default's price. */
export function modelSpec(
  id: string,
  provider: AiProviderName,
  tier: ModelTier,
): ModelSpec {
  const hit = MODEL_CATALOG.find((m) => m.id === id);
  if (hit) return hit;
  const base =
    MODEL_CATALOG.find((m) => m.id === DEFAULT_TIER_MODELS[provider][tier]) ??
    MODEL_CATALOG[0];
  // Unknown id: price like the tier default; assume the newest request rules
  // (no temperature, effort supported) for Anthropic, classic for OpenAI.
  return {
    ...base,
    id,
    label: id,
    provider,
  };
}

/**
 * Back-compat view of the DEFAULT tier models (older callers + cost
 * estimates). New code resolves the live model via LlmService.modelFor().
 */
export const PROVIDER_MODELS: Record<
  AiProviderName,
  Record<ModelTier, ModelConfig>
> = {
  anthropic: {
    fast: modelSpec(DEFAULT_TIER_MODELS.anthropic.fast, 'anthropic', 'fast'),
    smart: modelSpec(DEFAULT_TIER_MODELS.anthropic.smart, 'anthropic', 'smart'),
  },
  openai: {
    fast: modelSpec(DEFAULT_TIER_MODELS.openai.fast, 'openai', 'fast'),
    smart: modelSpec(DEFAULT_TIER_MODELS.openai.smart, 'openai', 'smart'),
  },
};

/** Optional second provider tried once when the active one errors / times out. */
export const AI_FALLBACK_PROVIDER_KEY = 'ai_fallback_provider';
/** Platform-wide AI kill switch ('off' = every AI feature paused). */
export const AI_KILL_SWITCH_KEY = 'ai_platform_enabled';

/** Per-request timeout (ms) for a single model call. */
export const LLM_CALL_TIMEOUT_MS = 45_000;

/** Cache-read tokens are billed at 0.1x the base input rate (fallback when a
 *  spec has no explicit cacheReadMicros). */
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
  | 'embedding'
  | 'address_quality'
  | 'growth'
  | 'agent'
  | 'shadow'
  | 'playground'
  | 'eval'
  | 'knowledge';

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
/**
 * Recency cap (hours) for the AUTONOMOUS transcript. The agent/auto-reply only
 * fires within WhatsApp's 24h reply window, so context older than this is stale
 * bleed (an old order resurfacing in a long-lived thread). Interactive copilot
 * features (suggest/summarize) do NOT pass this — they keep the message-cap only.
 */
export const CONTEXT_WINDOW_HOURS = 24;
/** Hard cap on knowledge-base characters injected (keeps the prompt bounded).
 *  Sized to fit a synced Shopify product catalogue plus manual FAQ/policy
 *  entries; the KB block is prompt-cached so repeat calls stay cheap. */
export const KB_CHAR_BUDGET = 35000;

// ── Topic-Aware Commerce Refactor ────────────────────────────────────────────

/**
 * Conversation TOPIC the AI is currently handling. Persisted on
 * `conversations.ai_active_topic`. Each inbound message is classified (triage)
 * and mapped to one of these; a confident change starts a new EPISODE so the
 * previous journey's replies stop bleeding into the new one.
 */
export type ActiveTopic =
  | 'NONE'
  | 'SALES'
  | 'ORDER_CREATION'
  | 'ORDER_TRACKING'
  | 'DISPUTE'
  | 'SUPPORT'
  | 'HUMAN_HANDOFF';

export const ACTIVE_TOPICS: ActiveTopic[] = [
  'NONE',
  'SALES',
  'ORDER_CREATION',
  'ORDER_TRACKING',
  'DISPUTE',
  'SUPPORT',
  'HUMAN_HANDOFF',
];

/** Single source of truth mapping the triage intent → conversation topic. */
export const INTENT_TO_TOPIC: Record<string, ActiveTopic> = {
  sales: 'SALES',
  order: 'ORDER_CREATION',
  logistics: 'ORDER_TRACKING',
  resolution: 'DISPUTE',
  general: 'SUPPORT',
  escalate: 'HUMAN_HANDOFF',
  // `closing` is special-cased by the orchestrator (closes, sets no topic).
};

/**
 * An ORDER_TRACKING topic is a short-lived session: after this idle window the
 * topic expires and the next inbound message is reclassified fresh (so a later
 * "I want 2 more" becomes a new order, not a continuation of tracking).
 */
export const TRACKING_TOPIC_TTL_MS = 30 * 60 * 1000;

/**
 * Anti-repetition: how many of the AI's own recent outbound messages a candidate
 * reply is compared against before it is suppressed as a near-duplicate.
 */
export const ANTI_REPEAT_HISTORY = 10;

/**
 * Topic-override confidence (0–100). The triage classifier emits a numeric
 * certainty `score`; a topic switch only INTERRUPTS an in-progress protected
 * topic (a live order or open dispute) when the score is at or above this. Below
 * it, a mid-flow chat stays on its current topic (a noisy classification must
 * not tear down a half-finished order). From NONE/expired/closed, any topic
 * switches freely.
 */
export const TOPIC_OVERRIDE_CONFIDENCE = 85;

/**
 * Minimum deterministic order-confidence (0–100) required before the system
 * auto-creates a Shopify order. Below this the AI asks for the weak/missing
 * fields instead of pushing an incomplete/garbage order.
 */
export const ORDER_CONFIDENCE_MIN = 80;
