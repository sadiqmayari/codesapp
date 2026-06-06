import { ModelTier } from '../../modules/ai/ai.constants';
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
export declare function resolveAiCapabilities(company: CompanyAiFlags, platformDefaultTier: ModelTier): EffectiveAiCapabilities;
