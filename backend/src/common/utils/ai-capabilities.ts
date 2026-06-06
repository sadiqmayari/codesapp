import { ModelTier } from '../../modules/ai/ai.constants';

/**
 * Resolves the EFFECTIVE AI capabilities for a tenant — the single source of
 * truth for the autonomous model tier + multimodal (vision/voice) gating.
 *
 * Rules:
 *  - `ai_premium_locked` (super-admin per-tenant kill-switch) forces baseline:
 *    Standard tier, no vision, no voice — regardless of the tenant's choices.
 *  - Otherwise the tenant's own `ai_autonomous_tier` wins; NULL falls back to
 *    the platform default (`platform_settings.ai_autonomous_tier`).
 *  - Vision/voice are the tenant's own flags, unless locked.
 *
 * Mirrors the `resolveEffectiveLimits` pattern (common/utils/effective-limits.ts).
 * Consumed by AiService (tier for draftOrder/autoReplyDecision, vision/voice in
 * loadTranscript). Keep ALL lock/tier/vision/voice gating here — never inline it.
 */
export interface CompanyAiFlags {
  ai_autonomous_tier?: string | null;
  ai_premium_locked?: boolean | null;
  ai_vision_enabled?: boolean | null;
  ai_voice_enabled?: boolean | null;
}

export interface EffectiveAiCapabilities {
  tier: ModelTier;
  vision: boolean;
  voice: boolean;
}

export function resolveAiCapabilities(
  company: CompanyAiFlags,
  platformDefaultTier: ModelTier,
): EffectiveAiCapabilities {
  const locked = company.ai_premium_locked === true;
  if (locked) {
    return { tier: 'fast', vision: false, voice: false };
  }
  const chosen = company.ai_autonomous_tier;
  const tier: ModelTier =
    chosen === 'smart' ? 'smart' : chosen === 'fast' ? 'fast' : platformDefaultTier;
  return {
    tier,
    vision: company.ai_vision_enabled === true,
    voice: company.ai_voice_enabled === true,
  };
}
