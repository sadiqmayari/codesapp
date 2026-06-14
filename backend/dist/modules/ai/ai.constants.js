"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ORDER_CONFIDENCE_MIN = exports.TOPIC_OVERRIDE_CONFIDENCE = exports.ANTI_REPEAT_HISTORY = exports.TRACKING_TOPIC_TTL_MS = exports.INTENT_TO_TOPIC = exports.ACTIVE_TOPICS = exports.KB_CHAR_BUDGET = exports.CONTEXT_WINDOW_HOURS = exports.CONTEXT_MESSAGE_LIMIT = exports.EST_IMAGE_TOKENS = exports.EST_REPLY_OUT_TOKENS = exports.EST_REPLY_IN_TOKENS = exports.AI_DEFAULT_CAP_DEFAULT = exports.AI_DEFAULT_CAP_KEY = exports.AI_PRICE_MULTIPLIER_DEFAULT = exports.AI_PRICE_MULTIPLIER_KEY = exports.AI_AUTONOMOUS_TIER_DEFAULT = exports.AI_AUTONOMOUS_TIER_KEY = exports.AI_AGENT_MAX_STEPS = exports.ENGAGEMENT_ENGINE_COMPANY_IDS_KEY = exports.AI_AGENT_COMPANY_IDS_KEY = exports.AI_PROVIDER_DEFAULT = exports.AI_PROVIDER_KEY = exports.RAG_ABS_FLOOR = exports.RAG_REL_FLOOR = exports.RAG_CHAR_BUDGET = exports.RAG_TOP_K = exports.CHARS_PER_TOKEN = exports.EMBEDDING_MICROS_PER_TOKEN = exports.EMBEDDING_DIM = exports.EMBEDDING_MODEL = exports.CACHE_WRITE_MULTIPLIER = exports.CACHE_READ_MULTIPLIER = exports.PROVIDER_MODELS = void 0;
exports.PROVIDER_MODELS = {
    anthropic: {
        fast: { id: 'claude-haiku-4-5-20251001', inMicros: 1, outMicros: 5 },
        smart: { id: 'claude-sonnet-4-6', inMicros: 3, outMicros: 15 },
    },
    openai: {
        fast: { id: 'gpt-4o-mini', inMicros: 0.15, outMicros: 0.6 },
        smart: { id: 'gpt-4o', inMicros: 2.5, outMicros: 10 },
    },
};
exports.CACHE_READ_MULTIPLIER = 0.1;
exports.CACHE_WRITE_MULTIPLIER = 1.25;
exports.EMBEDDING_MODEL = 'text-embedding-3-small';
exports.EMBEDDING_DIM = 1536;
exports.EMBEDDING_MICROS_PER_TOKEN = 0.02;
exports.CHARS_PER_TOKEN = 4;
exports.RAG_TOP_K = 8;
exports.RAG_CHAR_BUDGET = 14000;
exports.RAG_REL_FLOOR = 0.6;
exports.RAG_ABS_FLOOR = 0.15;
exports.AI_PROVIDER_KEY = 'ai_provider';
exports.AI_PROVIDER_DEFAULT = 'anthropic';
exports.AI_AGENT_COMPANY_IDS_KEY = 'ai_agent_company_ids';
exports.ENGAGEMENT_ENGINE_COMPANY_IDS_KEY = 'engagement_engine_company_ids';
exports.AI_AGENT_MAX_STEPS = 4;
exports.AI_AUTONOMOUS_TIER_KEY = 'ai_autonomous_tier';
exports.AI_AUTONOMOUS_TIER_DEFAULT = 'fast';
exports.AI_PRICE_MULTIPLIER_KEY = 'ai_price_multiplier';
exports.AI_PRICE_MULTIPLIER_DEFAULT = '1.5';
exports.AI_DEFAULT_CAP_KEY = 'ai_default_monthly_cap_cents';
exports.AI_DEFAULT_CAP_DEFAULT = '2000';
exports.EST_REPLY_IN_TOKENS = 1650;
exports.EST_REPLY_OUT_TOKENS = 60;
exports.EST_IMAGE_TOKENS = 1100;
exports.CONTEXT_MESSAGE_LIMIT = 25;
exports.CONTEXT_WINDOW_HOURS = 24;
exports.KB_CHAR_BUDGET = 35000;
exports.ACTIVE_TOPICS = [
    'NONE',
    'SALES',
    'ORDER_CREATION',
    'ORDER_TRACKING',
    'DISPUTE',
    'SUPPORT',
    'HUMAN_HANDOFF',
];
exports.INTENT_TO_TOPIC = {
    sales: 'SALES',
    order: 'ORDER_CREATION',
    logistics: 'ORDER_TRACKING',
    resolution: 'DISPUTE',
    general: 'SUPPORT',
    escalate: 'HUMAN_HANDOFF',
};
exports.TRACKING_TOPIC_TTL_MS = 30 * 60 * 1000;
exports.ANTI_REPEAT_HISTORY = 10;
exports.TOPIC_OVERRIDE_CONFIDENCE = 85;
exports.ORDER_CONFIDENCE_MIN = 80;
//# sourceMappingURL=ai.constants.js.map