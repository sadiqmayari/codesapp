"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveEffectiveLimits = resolveEffectiveLimits;
function resolveEffectiveLimits(sub, overrides) {
    return {
        contact_limit: overrides.contact_limit_override ?? sub.contact_limit,
        template_limit: overrides.template_limit_override ?? sub.template_limit,
        user_limit: overrides.user_limit_override ?? sub.user_limit,
    };
}
//# sourceMappingURL=effective-limits.js.map