export interface SubscriptionDefaults {
    contact_limit: number;
    template_limit: number;
    user_limit: number;
}
export interface CompanyOverrides {
    contact_limit_override?: number | null;
    template_limit_override?: number | null;
    user_limit_override?: number | null;
}
export interface EffectiveLimits {
    contact_limit: number;
    template_limit: number;
    user_limit: number;
}
export declare function resolveEffectiveLimits(sub: SubscriptionDefaults, overrides: CompanyOverrides): EffectiveLimits;
