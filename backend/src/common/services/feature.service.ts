import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingService } from './platform-setting.service';
import {
  FeatureOverride,
  PlatformFeature,
} from '../features/feature.constants';
import { EngagementMode } from '../../modules/ai/ai.constants';

/**
 * Unified resolver for the 4-layer feature governance model
 * (see common/features/feature.constants.ts). New features resolve their
 * effective enabled-state here so plan / super-admin / tenant precedence is
 * consistent everywhere — instead of each feature re-implementing the logic.
 *
 * Existing AI gates (PlanGuard, PlatformSettingService.isAiAgentEnabled, the
 * billing `features` flags) keep working as-is; they can be migrated to delegate
 * here over time. This service is purely additive.
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
   * Engagement-engine mode for a tenant, resolved across the layers:
   *   - platform allow-list must include the company (else 'off');
   *   - super-admin force-off override → 'off';
   *   - per-company companies.engagement_mode wins ('shadow' | 'on');
   *   - else the platform default (platform_settings engagement_engine_mode).
   * This is what makes the rollout staged + per-tenant: one tenant can be 'on'
   * while every other stays shadow/off.
   */
  async engagementModeFor(
    companyId: number,
  ): Promise<'off' | EngagementMode> {
    const override = await this.getOverride(companyId, 'engagement_engine');
    if (override === 'off') return 'off';

    const allowed =
      override === 'on' ||
      (await this.platformSetting.isEngagementEngineEnabled(companyId));
    if (!allowed) return 'off';

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { engagement_mode: true },
    });
    const per = company?.engagement_mode;
    if (per === 'on' || per === 'shadow') return per;
    return this.platformSetting.getEngagementMode();
  }
}
