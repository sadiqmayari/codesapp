import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingService } from './platform-setting.service';
import {
  FeatureOverride,
  PlatformFeature,
} from '../features/feature.constants';

/**
 * Unified resolver for the 4-layer feature governance model
 * (see common/features/feature.constants.ts). New features resolve their
 * effective enabled-state here so plan / super-admin / tenant precedence is
 * consistent everywhere — instead of each feature re-implementing the logic.
 *
 * Existing AI gates (PlanGuard, the billing `features` flags, the per-tenant AI
 * toggles) keep working as-is; they can be migrated to delegate here over time.
 * This service is purely additive.
 */
@Injectable()
export class FeatureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly platformSetting: PlatformSettingService,
  ) {}

  /**
   * Super-admin per-tenant force value (companies.feature_overrides[feature]).
   * Returns 'on' | 'off' to force, or null for normal resolution. This is the
   * authority layer — it wins over the tenant's own toggle.
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

  /**
   * Effective on/off for the Content module. This is a PER-TENANT feature the
   * super-admin grants to individual clients (like invoice-import), NOT a plan
   * tier inclusion — so the gate is the company flag directly (with the
   * feature_overrides authority layer still winning if ever set):
   *   override ?? companies.content_enabled.
   */
  async contentEnabled(companyId: number): Promise<boolean> {
    const override = await this.getOverride(companyId, 'content');
    if (override) return override === 'on';
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { content_enabled: true },
    });
    return company?.content_enabled ?? false;
  }

  /**
   * Effective on/off for the PR module — per-tenant, same model as Content:
   *   override ?? companies.pr_enabled.
   */
  async prEnabled(companyId: number): Promise<boolean> {
    const override = await this.getOverride(companyId, 'pr');
    if (override) return override === 'on';
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { pr_enabled: true },
    });
    return company?.pr_enabled ?? false;
  }

  /**
   * Effective on/off for the Inventory module — per-tenant, same model as
   * Content/PR: override ?? companies.inventory_enabled.
   */
  async inventoryEnabled(companyId: number): Promise<boolean> {
    const override = await this.getOverride(companyId, 'inventory');
    if (override) return override === 'on';
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { inventory_enabled: true },
    });
    return company?.inventory_enabled ?? false;
  }
}
