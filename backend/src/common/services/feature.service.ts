import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingService } from './platform-setting.service';
import { CacheService } from './cache.service';
import {
  FeatureOverride,
  MODULE_REGISTRY,
  ModuleKey,
  PlatformFeature,
} from '../features/feature.constants';

const MODULES_TTL_S = 60;

/** Effective module map for a tenant + super-admin limits. */
export interface CompanyModules {
  modules: Record<ModuleKey, boolean>;
  /** Super-admin seat cap for WhatsApp calling (null = no cap). */
  callsMaxAgents: number | null;
}

/**
 * Unified resolver for the feature governance model
 * (see common/features/feature.constants.ts).
 *
 * MODULE GRANTS (super-admin authoritative, per tenant) resolve through
 * `modules()` / `enabled()` — ONE cached read of companies.feature_overrides
 * (+ the legacy content/pr/inventory columns). Workers use `companiesWith()`.
 * Call `invalidate(companyId)` after any write to those columns.
 */
@Injectable()
export class FeatureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly platformSetting: PlatformSettingService,
    private readonly cache: CacheService,
  ) {}

  private key(companyId: number) {
    return `features:${companyId}`;
  }

  invalidate(companyId: number): void {
    this.cache.del(this.key(companyId));
  }

  /** Pure resolution of one company row → effective module map. */
  static resolve(row: {
    feature_overrides: unknown;
    content_enabled?: boolean | null;
    pr_enabled?: boolean | null;
    inventory_enabled?: boolean | null;
  }): CompanyModules {
    const ov = (row.feature_overrides && typeof row.feature_overrides === 'object'
      ? row.feature_overrides
      : {}) as Record<string, unknown>;
    const modules = {} as Record<ModuleKey, boolean>;
    for (const def of MODULE_REGISTRY) {
      const v = ov[def.key];
      if (def.legacyColumn) {
        modules[def.key] =
          v === 'on' ? true : v === 'off' ? false : !!row[def.legacyColumn];
      } else {
        modules[def.key] = v === 'on';
      }
    }
    // A sub-switch is only on while its parent module is on.
    for (const def of MODULE_REGISTRY) {
      if (def.parent && !modules[def.parent]) modules[def.key] = false;
    }
    const cap = Number(ov['calls_max_agents']);
    return {
      modules,
      callsMaxAgents: Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : null,
    };
  }

  async companyModules(companyId: number): Promise<CompanyModules> {
    const hit = this.cache.get<CompanyModules>(this.key(companyId));
    if (hit) return hit;
    const row = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        feature_overrides: true,
        content_enabled: true,
        pr_enabled: true,
        inventory_enabled: true,
      },
    });
    const out = row
      ? FeatureService.resolve(row)
      : FeatureService.resolve({ feature_overrides: null });
    this.cache.set(this.key(companyId), out, MODULES_TTL_S);
    return out;
  }

  async modules(companyId: number): Promise<Record<ModuleKey, boolean>> {
    return (await this.companyModules(companyId)).modules;
  }

  async enabled(companyId: number, key: ModuleKey): Promise<boolean> {
    return (await this.modules(companyId))[key] === true;
  }

  /**
   * Company ids that have `key` granted — for background schedulers, so a
   * switched-off module's jobs stop. One query per tick.
   */
  async companiesWith(key: ModuleKey): Promise<Set<number>> {
    const rows = await this.prisma.company.findMany({
      select: {
        id: true,
        feature_overrides: true,
        content_enabled: true,
        pr_enabled: true,
        inventory_enabled: true,
      },
    });
    const out = new Set<number>();
    for (const r of rows) {
      if (FeatureService.resolve(r).modules[key]) out.add(r.id);
    }
    return out;
  }

  /**
   * Super-admin per-tenant force value (companies.feature_overrides[feature]).
   * Returns 'on' | 'off' to force, or null for normal resolution.
   */
  async getOverride(
    companyId: number,
    feature: PlatformFeature,
  ): Promise<FeatureOverride | null> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { feature_overrides: true },
    });
    const map = (company?.feature_overrides ?? null) as Record<
      string,
      unknown
    > | null;
    const v = map?.[feature];
    return v === 'on' || v === 'off' ? v : null;
  }

  /**
   * Effective on/off for proactive Shopify->WhatsApp notifications:
   *   override ?? (plan.proactive_notifications AND company.proactive_notifications_enabled).
   */
  async proactiveNotificationsEnabled(companyId: number): Promise<boolean> {
    const override = await this.getOverride(
      companyId,
      'proactive_notifications',
    );
    if (override) return override === 'on';

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        proactive_notifications_enabled: true,
        subscription: { select: { proactive_notifications: true } },
      },
    });
    if (!company) return false;
    const planOn = company.subscription?.proactive_notifications ?? false;
    const tenantOn = company.proactive_notifications_enabled;
    return planOn && tenantOn;
  }

  /** Content module: override ?? companies.content_enabled. */
  contentEnabled(companyId: number): Promise<boolean> {
    return this.enabled(companyId, 'content');
  }

  /** PR module: override ?? companies.pr_enabled. */
  prEnabled(companyId: number): Promise<boolean> {
    return this.enabled(companyId, 'pr');
  }

  /** Inventory module: override ?? companies.inventory_enabled. */
  inventoryEnabled(companyId: number): Promise<boolean> {
    return this.enabled(companyId, 'inventory');
  }
}
