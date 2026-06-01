"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KB_CHAR_BUDGET = exports.CONTEXT_MESSAGE_LIMIT = exports.AI_DEFAULT_CAP_DEFAULT = exports.AI_DEFAULT_CAP_KEY = exports.AI_PRICE_MULTIPLIER_DEFAULT = exports.AI_PRICE_MULTIPLIER_KEY = exports.CACHE_WRITE_MULTIPLIER = exports.CACHE_READ_MULTIPLIER = exports.MODELS = void 0;
exports.MODELS = {
    fast: { id: 'claude-haiku-4-5-20251001', inMicros: 1, outMicros: 5 },
    smart: { id: 'claude-sonnet-4-6', inMicros: 3, outMicros: 15 },
};
exports.CACHE_READ_MULTIPLIER = 0.1;
exports.CACHE_WRITE_MULTIPLIER = 1.25;
exports.AI_PRICE_MULTIPLIER_KEY = 'ai_price_multiplier';
exports.AI_PRICE_MULTIPLIER_DEFAULT = '1.5';
exports.AI_DEFAULT_CAP_KEY = 'ai_default_monthly_cap_cents';
exports.AI_DEFAULT_CAP_DEFAULT = '0';
exports.CONTEXT_MESSAGE_LIMIT = 25;
exports.KB_CHAR_BUDGET = 12000;
//# sourceMappingURL=ai.constants.js.map