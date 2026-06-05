export type AiProviderName = 'anthropic' | 'openai';
export type ModelTier = 'fast' | 'smart';
export interface ModelConfig {
    id: string;
    inMicros: number;
    outMicros: number;
}
export declare const PROVIDER_MODELS: Record<AiProviderName, Record<ModelTier, ModelConfig>>;
export declare const CACHE_READ_MULTIPLIER = 0.1;
export declare const CACHE_WRITE_MULTIPLIER = 1.25;
export type AiFeature = 'suggest_reply' | 'rewrite' | 'translate' | 'summarize' | 'autoreply' | 'draft_order' | 'transcription';
export declare const AI_PROVIDER_KEY = "ai_provider";
export declare const AI_PROVIDER_DEFAULT: AiProviderName;
export declare const AI_AUTONOMOUS_TIER_KEY = "ai_autonomous_tier";
export declare const AI_AUTONOMOUS_TIER_DEFAULT: ModelTier;
export declare const AI_PRICE_MULTIPLIER_KEY = "ai_price_multiplier";
export declare const AI_PRICE_MULTIPLIER_DEFAULT = "1.5";
export declare const AI_DEFAULT_CAP_KEY = "ai_default_monthly_cap_cents";
export declare const AI_DEFAULT_CAP_DEFAULT = "0";
export declare const CONTEXT_MESSAGE_LIMIT = 25;
export declare const KB_CHAR_BUDGET = 12000;
