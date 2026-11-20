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
  | 'ai_agent' // tool-calling orchestrator (governed by per-tenant AI toggles)
  | 'proactive_notifications' // Shopify->WhatsApp delivery updates / cart recovery
  | 'content' // Content module: planning + Drive-backed media + approval pipeline
  | 'pr' // PR module: influencer submission links + 0-amount "PR" orders
  | 'inventory'; // Inventory module: Shopify catalogue mirror + custom fields + stock sync

/** Super-admin per-tenant force value stored in companies.feature_overrides. */
export type FeatureOverride = 'on' | 'off';

export interface FeatureDef {
  key: PlatformFeature;
  label: string;
  description: string;
  /** Subscription boolean column gating plan inclusion (undefined = not plan-gated). */
  planFlag?:
    | 'ai_enabled'
    | 'proactive_notifications'
    | 'content_enabled'
    | 'pr_enabled';
  /** Tenant boolean column (undefined = no merchant toggle / infra-only feature). */
  tenantFlag?:
    | 'ai_enabled'
    | 'proactive_notifications_enabled'
    | 'content_enabled'
    | 'pr_enabled'
    | 'inventory_enabled';
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
  proactive_notifications: {
    key: 'proactive_notifications',
    label: 'Proactive notifications',
    description:
      'Automatic Shopify->WhatsApp updates (order shipped/tracking, cart recovery).',
    planFlag: 'proactive_notifications',
    tenantFlag: 'proactive_notifications_enabled',
  },
  content: {
    key: 'content',
    label: 'Content module',
    description:
      'Content planning + Google-Drive-backed media + approval pipeline. ' +
      'Per-tenant: granted by super-admin on the client (not a plan tier).',
    tenantFlag: 'content_enabled',
  },
  pr: {
    key: 'pr',
    label: 'PR module',
    description:
      'Influencer submission links + 0-amount "PR" orders from the catalogue. ' +
      'Per-tenant: granted by super-admin on the client (not a plan tier).',
    tenantFlag: 'pr_enabled',
  },
  inventory: {
    key: 'inventory',
    label: 'Inventory module',
    description:
      'Shopify catalogue mirror with CodesApp-only fields (item code, alias, ' +
      'reorder level, cost) + two-way stock sync. Per-tenant: granted by ' +
      'super-admin on the client (not a plan tier).',
    tenantFlag: 'inventory_enabled',
  },
};

/**
 * Super-admin MODULE GRANTS (Nov-2026). Each is a per-tenant switch the
 * super-admin flips on the client page; stored in companies.feature_overrides
 * as 'on' | 'off' (absent = off). `parent` = a sub-switch that only applies
 * while its parent module is on. The tenant has no toggle of its own.
 *
 * Content / PR / Inventory keep their legacy companies.*_enabled columns
 * (resolved as override ?? column) and are listed here only for the UI.
 */
export type ModuleGrantKey =
  | 'growth'
  | 'growth_publish'
  | 'attendance'
  | 'payroll'
  | 'commissions'
  | 'pack'
  | 'calls'
  | 'leaderboard'
  | 'couriers'
  | 'tickets';

export type ModuleKey = ModuleGrantKey | 'content' | 'pr' | 'inventory';

export interface ModuleDef {
  key: ModuleKey;
  label: string;
  description: string;
  group: 'Commerce' | 'Growth' | 'Team' | 'Communication';
  parent?: ModuleKey;
  /** Legacy companies.<column> (content/pr/inventory). */
  legacyColumn?: 'content_enabled' | 'pr_enabled' | 'inventory_enabled';
}

export const MODULE_REGISTRY: ModuleDef[] = [
  { key: 'couriers', group: 'Commerce', label: 'Couriers & booking', description: 'Book, track, loadsheets, returns and courier settlements' },
  { key: 'pack', group: 'Commerce', label: 'Pack station', description: '/orders/pack scan-and-pack' },
  { key: 'inventory', group: 'Commerce', label: 'Inventory', description: 'Catalogue mirror, stock push, product analytics', legacyColumn: 'inventory_enabled' },
  { key: 'tickets', group: 'Commerce', label: 'Tickets', description: 'Support tickets and replacement parcels' },
  { key: 'growth', group: 'Growth', label: 'Growth', description: 'Ad sync, attribution, forecast, Growth AI' },
  { key: 'growth_publish', group: 'Growth', parent: 'growth', label: 'Allow publishing ads', description: 'Off = Growth is read-only (no budget edits, no new ads)' },
  { key: 'content', group: 'Growth', label: 'Content', description: 'Content planning, Drive media, approvals', legacyColumn: 'content_enabled' },
  { key: 'pr', group: 'Growth', label: 'PR', description: 'Influencer forms and PR orders', legacyColumn: 'pr_enabled' },
  { key: 'attendance', group: 'Team', label: 'Attendance', description: 'Check-in, leave, auto-checkout, daily sweep' },
  { key: 'payroll', group: 'Team', parent: 'attendance', label: 'Payroll', description: 'Payroll runs, salaries, payslips, adjustments' },
  { key: 'commissions', group: 'Team', label: 'Commissions', description: 'Commission plans, statements, earnings in payslips' },
  { key: 'leaderboard', group: 'Team', label: 'Leaderboard', description: 'Points, badges, contests, targets' },
  { key: 'calls', group: 'Communication', label: 'WhatsApp calling', description: 'Softphone, call logs, per-agent routing' },
];

export const MODULE_KEYS: ModuleKey[] = MODULE_REGISTRY.map((m) => m.key);

export function isModuleKey(k: string): k is ModuleKey {
  return (MODULE_KEYS as string[]).includes(k);
}
