import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from './cache.service';
import { PlatformSettingService } from './platform-setting.service';

/**
 * Global Kill Switches (enterprise hardening — increment 3).
 *
 * WHY THIS EXISTS
 * ---------------
 * When a subsystem misbehaves in production (a model regression spams customers,
 * an auto-order bug starts placing bad orders, a specialist hallucinates) the
 * operator needs to stop it IMMEDIATELY — without a deploy, without code, and
 * without touching unrelated tenants. These switches are runtime feature flags
 * that gate the AI's most consequential capabilities. They are deliberately
 * SEPARATE from the FeatureService capability flags: those answer "is this tier
 * allowed to use X"; these answer "is X currently safe to run AT ALL".
 *
 * DESIGN
 * ------
 * - DEFAULT ON. Absence of any config = enabled, so existing behavior is fully
 *   preserved (no migration, no seed). A switch is only ever OFF when an operator
 *   explicitly engages the kill.
 * - TWO LAYERS, no new schema:
 *     • GLOBAL   — platform_settings key `kill.<switch>` ('off' kills everywhere).
 *     • PER-TENANT— companies.feature_overrides['kill.<switch>'] = 'on' | 'off'
 *       (a tenant override WINS, so one tenant can be paused or exempted).
 *   Both are settable through the EXISTING super-admin settings / override
 *   surfaces — no new API contract.
 * - CACHED WITH REFRESH. The resolved 7-switch snapshot is cached per company for
 *   30s (node-cache), so the hot inbound path costs at most one cheap read every
 *   30s and a toggle propagates within that window.
 * - FAIL-CLOSED where it matters. On a resolution ERROR each switch returns its
 *   `failClosedDefault`: the money-moving AUTO_ORDER fails to OFF (never auto-place
 *   an order when state is unknown), while reply/specialist switches fail to ON
 *   (a transient flag read must not silently mute the assistant for every tenant
 *   and break existing behavior). This is the deliberate reconciliation of the
 *   spec's "fail closed" with the platform rule "never break existing tenants":
 *   fail closed on irreversible/costly actions, fail safe-open on reversible ones.
 */

export type KillSwitch =
  | 'auto_reply'
  | 'auto_order'
  | 'sales_specialist'
  | 'order_specialist'
  | 'logistics_specialist'
  | 'resolution_specialist'
  | 'general_specialist';

export type KillSwitchSnapshot = Record<KillSwitch, boolean>;

interface SwitchDef {
  key: KillSwitch;
  /** True → on an unresolvable error, default to OFF (disabled). */
  failClosed: boolean;
}

/** The registry. AUTO_ORDER fails closed (money); everything else fails open. */
const SWITCHES: SwitchDef[] = [
  { key: 'auto_reply', failClosed: false },
  { key: 'auto_order', failClosed: true },
  { key: 'sales_specialist', failClosed: false },
  { key: 'order_specialist', failClosed: false },
  { key: 'logistics_specialist', failClosed: false },
  { key: 'resolution_specialist', failClosed: false },
  { key: 'general_specialist', failClosed: false },
];

/** Map a specialist intent to its kill switch (general = the front-desk fallback). */
const INTENT_SWITCH: Record<string, KillSwitch> = {
  sales: 'sales_specialist',
  order: 'order_specialist',
  logistics: 'logistics_specialist',
  resolution: 'resolution_specialist',
  general: 'general_specialist',
};

const CACHE_TTL_SEC = 30;
const settingKey = (k: KillSwitch): string => `kill.${k}`;

@Injectable()
export class KillSwitchService {
  private readonly logger = new Logger(KillSwitchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly platformSetting: PlatformSettingService,
  ) {}

  private cacheKey(companyId: number): string {
    return `killswitches:${companyId}`;
  }

  /**
   * Resolve all switches for a company (cached 30s). Never throws — a hard
   * failure yields each switch's fail-closed/open default so message processing
   * is never taken down by a flag read.
   */
  async resolveAll(companyId: number): Promise<KillSwitchSnapshot> {
    const ck = this.cacheKey(companyId);
    const cached = this.cache.get<KillSwitchSnapshot>(ck);
    if (cached) return cached;

    let overrides: Record<string, unknown> = {};
    try {
      const company = await this.prisma.company.findUnique({
        where: { id: companyId },
        select: { feature_overrides: true },
      });
      overrides = (company?.feature_overrides ?? {}) as Record<string, unknown>;
    } catch {
      overrides = {}; // fall through to global/default resolution
    }

    const out = {} as KillSwitchSnapshot;
    for (const def of SWITCHES) {
      try {
        out[def.key] = await this.resolveOne(def.key, overrides);
      } catch {
        out[def.key] = !def.failClosed; // failClosed → OFF, else ON
      }
    }
    this.cache.set(ck, out, CACHE_TTL_SEC);
    return out;
  }

  /** Convenience single-switch read (uses the cached snapshot). */
  async isEnabled(companyId: number, sw: KillSwitch): Promise<boolean> {
    const snap = await this.resolveAll(companyId);
    return snap[sw];
  }

  /** Whether the specialist for an intent is enabled. Unknown intent → allowed. */
  static specialistEnabled(snap: KillSwitchSnapshot, intent: string): boolean {
    const sw = INTENT_SWITCH[intent];
    return sw ? snap[sw] : true;
  }

  /** Drop the cached snapshot so an operator toggle takes effect immediately. */
  invalidate(companyId: number): void {
    this.cache.del(this.cacheKey(companyId));
  }

  /**
   * override ('on'|'off') wins → else global platform_settings → else DEFAULT ON.
   * The global default 'on' means: with nothing configured, every capability runs
   * exactly as it does today.
   */
  private async resolveOne(
    sw: KillSwitch,
    overrides: Record<string, unknown>,
  ): Promise<boolean> {
    const ov = overrides[settingKey(sw)];
    if (ov === 'on') return true;
    if (ov === 'off') return false;
    const global = await this.platformSetting.get(settingKey(sw), 'on');
    return !(global === 'off' || global === 'false' || global === '0');
  }
}
