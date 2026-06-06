"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveAiCapabilities = resolveAiCapabilities;
function resolveAiCapabilities(company, platformDefaultTier) {
    const locked = company.ai_premium_locked === true;
    if (locked) {
        return { tier: 'fast', vision: false, voice: false };
    }
    const chosen = company.ai_autonomous_tier;
    const tier = chosen === 'smart' ? 'smart' : chosen === 'fast' ? 'fast' : platformDefaultTier;
    return {
        tier,
        vision: company.ai_vision_enabled === true,
        voice: company.ai_voice_enabled === true,
    };
}
//# sourceMappingURL=ai-capabilities.js.map