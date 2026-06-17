export type PlatformFeature = 'ai_copilot' | 'ai_agent' | 'engagement_engine' | 'proactive_notifications';
export type FeatureOverride = 'on' | 'off';
export interface FeatureDef {
    key: PlatformFeature;
    label: string;
    description: string;
    planFlag?: 'ai_enabled' | 'proactive_notifications';
    tenantFlag?: 'ai_enabled' | 'proactive_notifications_enabled';
    platformGated?: boolean;
}
export declare const FEATURE_REGISTRY: Record<PlatformFeature, FeatureDef>;
