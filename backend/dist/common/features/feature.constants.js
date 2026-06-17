"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FEATURE_REGISTRY = void 0;
exports.FEATURE_REGISTRY = {
    ai_copilot: {
        key: 'ai_copilot',
        label: 'AI Copilot',
        description: 'AI assistant: suggest/rewrite/translate/summarize + auto-reply.',
        planFlag: 'ai_enabled',
        tenantFlag: 'ai_enabled',
    },
    ai_agent: {
        key: 'ai_agent',
        label: 'AI Agent (orchestrator)',
        description: 'Tool-calling agent that handles sales/orders/tracking autonomously.',
        platformGated: true,
    },
    engagement_engine: {
        key: 'engagement_engine',
        label: 'Engagement Engine',
        description: 'Work-item state machine: deterministic routing, context isolation, ' +
            'reliable handoff. Per-company mode (shadow/on).',
        platformGated: true,
    },
    proactive_notifications: {
        key: 'proactive_notifications',
        label: 'Proactive notifications',
        description: 'Automatic Shopify->WhatsApp updates (order shipped/tracking, cart recovery).',
        planFlag: 'proactive_notifications',
        tenantFlag: 'proactive_notifications_enabled',
    },
};
//# sourceMappingURL=feature.constants.js.map