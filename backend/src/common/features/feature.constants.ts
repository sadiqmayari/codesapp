/**
 * Feature Governance Framework — the single registry of gated platform
 * capabilities, plus the 4-layer control model every feature obeys.
 *
 * Resolution order (see FeatureService):
 *   1. PLAN      — `subscriptions.<planFlag>` : what the tier includes.
 *   2. PLATFORM  — super-admin platform_settings (experimental allow-list gate).
 *   3. OVERRIDE  — `companies.feature_overrides[<key>]` = 'on' | 'off' : the
 *                  super-admin per-tenant authority that wins over the tenant flag.
 *   4. TENANT    — `companies.<companyFlag>` : the merchant's own on/off.
 *   (5. CONVERSATION — per-chat override, feature-specific, not modelled here.)
 *
 * Effective = override==='on' ? true
 *           : override==='off' ? false
 *           : (plan-includes AND platform-allowed AND tenant-on).
 *
 * Adding a feature = one entry here + the columns it needs + a FeatureService
 * resolver + a tenant toggle (Settings) + super-admin surfaces (Plans editor /
 * client detail). This file is the source of truth the super-admin UI renders.
 */

export type PlatformFeature =
  | 'ai_copilot' // AI assistant suite (plan.ai_enabled + company.ai_enabled)
  | 'ai_agent' // tool-calling orchestrator (platform ai_agent_company_ids)
  | 'engagement_engine' // work-item engine (platform allow-list + per-company mode)
  | 'proactive_notifications' // Shopify->WhatsApp delivery updates / cart recovery
  | 'compliance_guard'; // deterministic medical-safety gate before triage/LLM

/** Super-admin per-tenant force value stored in companies.feature_overrides. */
export type FeatureOverride = 'on' | 'off';

export interface FeatureDef {
  key: PlatformFeature;
  label: string;
  description: string;
  /** Subscription boolean column gating plan inclusion (undefined = not plan-gated). */
  planFlag?: 'ai_enabled' | 'proactive_notifications';
  /** Tenant boolean column (undefined = no merchant toggle / infra-only feature). */
  tenantFlag?: 'ai_enabled' | 'proactive_notifications_enabled';
  /** True when super-admin gates rollout via a platform allow-list (experimental). */
  platformGated?: boolean;
}

export const FEATURE_REGISTRY: Record<PlatformFeature, FeatureDef> = {
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
    description:
      'Work-item state machine: deterministic routing, context isolation, ' +
      'reliable handoff. Per-company mode (shadow/on).',
    platformGated: true,
  },
  proactive_notifications: {
    key: 'proactive_notifications',
    label: 'Proactive notifications',
    description:
      'Automatic Shopify->WhatsApp updates (order shipped/tracking, cart recovery).',
    planFlag: 'proactive_notifications',
    tenantFlag: 'proactive_notifications_enabled',
  },
  compliance_guard: {
    key: 'compliance_guard',
    label: 'Compliance Guard',
    description:
      'Deterministic medical-safety gate: intercepts medically sensitive ' +
      'messages before triage/LLM (safe response or human handoff). Default OFF.',
    // No plan/tenant column — resolved by platform default + per-tenant override
    // (companies.feature_overrides) so it needs no migration. Default OFF.
    platformGated: true,
  },
};
