/**
 * Resolves the EFFECTIVE plan limit for a tenant.
 *
 * Rule (Phase 4): per-company override (`companies.*_limit_override`) takes
 * precedence over the subscription's value. NULL on an override = use the
 * subscription default for that dimension.
 *
 * Used by:
 *  - `PlanGuard` (enforces the cap at 100%)
 *  - `LimitNotifierService` (fires 90/99/100 notifications)
 *  - `LimitWarningService` (the legacy 80% webhook)
 *  - `SuperAdminService.getClientDetail` (UI display)
 *
 * Keep the signature stable — every caller above expects the same shape.
 */
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

export function resolveEffectiveLimits(
  sub: SubscriptionDefaults,
  overrides: CompanyOverrides,
): EffectiveLimits {
  return {
    contact_limit:
      overrides.contact_limit_override ?? sub.contact_limit,
    template_limit:
      overrides.template_limit_override ?? sub.template_limit,
    user_limit:
      overrides.user_limit_override ?? sub.user_limit,
  };
}
