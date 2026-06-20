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

  /**
   * Compliance Guard (increment 2) effective on/off for a tenant. Resolution:
   *   - super-admin per-tenant override (companies.feature_overrides) wins;
   *   - else the platform default (platform_settings `compliance_guard_enabled`),
   *     which is absent → 'false' → DEFAULT OFF.
   * No plan/tenant column → no migration. FAIL-OPEN: any resolution error returns
   * false so a flag/DB hiccup leaves the EXISTING pipeline unchanged (never blocks
   * conversations). The guard is a safety ADD-ON; its unavailability must not take
   * down message processing.
   */
  async complianceGuardEnabled(companyId: number): Promise<boolean> {
    try {
      const override = await this.getOverride(companyId, 'compliance_guard');
      if (override) return override === 'on';
      const def = await this.platformSetting.get(
        'compliance_guard_enabled',
        'false',
      );
      return def === 'true' || def === '1' || def === 'on';
    } catch {
      return false; // fail-open to existing behavior
    }
  }

  /**
   * Escalation Signals (increment 4) effective on/off. Same resolution + FAIL-OPEN
   * model as the compliance guard: per-tenant override (companies.feature_overrides)
   * wins, else platform default (`escalation_signals_enabled`), else DEFAULT OFF;
   * any error → false (existing pipeline unchanged). No migration.
   */
  async escalationSignalsEnabled(companyId: number): Promise<boolean> {
    try {
      const override = await this.getOverride(companyId, 'escalation_signals');
      if (override) return override === 'on';
      const def = await this.platformSetting.get(
        'escalation_signals_enabled',
        'false',
      );
      return def === 'true' || def === '1' || def === 'on';
    } catch {
      return false;
    }
  }

  /**
   * Tool Validation (increment 5) effective on/off. Same resolution + FAIL-OPEN
   * model: per-tenant override wins, else platform default (`tool_validation_enabled`),
   * else DEFAULT OFF; any error → false (raw tool formatting, i.e. existing
   * behavior). No migration.
   */
  async toolValidationEnabled(companyId: number): Promise<boolean> {
    try {
      const override = await this.getOverride(companyId, 'tool_validation');
      if (override) return override === 'on';
      const def = await this.platformSetting.get(
        'tool_validation_enabled',
        'false',
      );
      return def === 'true' || def === '1' || def === 'on';
    } catch {
      return false;
    }
  }

  /**
   * Multimodal image routing (increment 7) effective on/off. Same resolution +
   * FAIL-OPEN model as the other safety add-ons: per-tenant override wins, else
   * platform default (`multimodal_routing_enabled`), else DEFAULT OFF; any error
   * → false (existing pipeline unchanged). No migration.
   */
  async multimodalRoutingEnabled(companyId: number): Promise<boolean> {
    try {
      const override = await this.getOverride(companyId, 'multimodal_routing');
      if (override) return override === 'on';
      const def = await this.platformSetting.get(
        'multimodal_routing_enabled',
        'false',
      );
      return def === 'true' || def === '1' || def === 'on';
    } catch {
      return false;
    }
  }

  /**
   * Handoff SLA tracking (increment 8) effective on/off. Same resolution +
   * FAIL-OPEN-to-false model as the other add-ons; default OFF, no migration of
   * existing behavior. Gating recording here naturally scopes the sweep to
   * opted-in tenants (disabled tenants never create handoff rows).
   */
  async handoffSlaEnabled(companyId: number): Promise<boolean> {
    try {
      const override = await this.getOverride(companyId, 'handoff_sla');
      if (override) return override === 'on';
      const def = await this.platformSetting.get('handoff_sla_enabled', 'false');
      return def === 'true' || def === '1' || def === 'on';
    } catch {
      return false;
    }
  }
}
