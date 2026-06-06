import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { AiCostEstimates, AiMeteringService } from './ai-metering.service';
import { UpdateAiSettingsDto } from './dto/ai-settings.dto';

export interface AiSettingsView {
  aiEnabled: boolean;
  autoReplyEnabled: boolean;
  autoOrderEnabled: boolean;
  autoOrderAllEnabled: boolean;
  brandTone: string | null;
  defaultLanguage: string | null;
  monthlyCapCents: number | null;
  /** Tenant-selectable autonomous AI quality. null = follow platform default. */
  aiTier: 'fast' | 'smart' | null;
  visionEnabled: boolean;
  voiceEnabled: boolean;
  /** Super-admin per-tenant kill-switch (read-only here; disables the controls). */
  premiumLocked: boolean;
  /** Whether the company's plan includes AI (read-only). */
  planAiEnabled: boolean;
  /** USD cost estimates for the quality / vision / voice selectors. */
  estimates: AiCostEstimates;
}

@Injectable()
export class AiSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly metering: AiMeteringService,
  ) {}

  async get(companyId: number): Promise<AiSettingsView> {
    const [c, estimates] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: {
          ai_enabled: true,
          ai_autoreply_enabled: true,
          ai_auto_order_enabled: true,
          ai_auto_order_all_enabled: true,
          ai_brand_tone: true,
          ai_default_language: true,
          ai_monthly_cap_cents: true,
          ai_autonomous_tier: true,
          ai_vision_enabled: true,
          ai_voice_enabled: true,
          ai_premium_locked: true,
          subscription: { select: { ai_enabled: true } },
        },
      }),
      this.metering.getCostEstimates(),
    ]);
    if (!c) throw new NotFoundException('Company not found');
    const tier =
      c.ai_autonomous_tier === 'smart'
        ? 'smart'
        : c.ai_autonomous_tier === 'fast'
          ? 'fast'
          : null;
    return {
      aiEnabled: c.ai_enabled,
      autoReplyEnabled: c.ai_autoreply_enabled,
      autoOrderEnabled: c.ai_auto_order_enabled,
      autoOrderAllEnabled: c.ai_auto_order_all_enabled,
      brandTone: c.ai_brand_tone,
      defaultLanguage: c.ai_default_language,
      monthlyCapCents: c.ai_monthly_cap_cents,
      aiTier: tier,
      visionEnabled: c.ai_vision_enabled,
      voiceEnabled: c.ai_voice_enabled,
      premiumLocked: c.ai_premium_locked,
      planAiEnabled: !!c.subscription?.ai_enabled,
      estimates,
    };
  }

  async update(
    companyId: number,
    dto: UpdateAiSettingsDto,
  ): Promise<AiSettingsView> {
    const data: Record<string, unknown> = {};
    if (dto.aiEnabled !== undefined) data.ai_enabled = dto.aiEnabled;
    if (dto.autoReplyEnabled !== undefined) {
      data.ai_autoreply_enabled = dto.autoReplyEnabled;
    }
    if (dto.autoOrderEnabled !== undefined) {
      data.ai_auto_order_enabled = dto.autoOrderEnabled;
    }
    if (dto.autoOrderAllEnabled !== undefined) {
      data.ai_auto_order_all_enabled = dto.autoOrderAllEnabled;
    }
    if (dto.brandTone !== undefined) {
      data.ai_brand_tone = dto.brandTone ? dto.brandTone : null;
    }
    if (dto.defaultLanguage !== undefined) {
      data.ai_default_language = dto.defaultLanguage
        ? dto.defaultLanguage
        : null;
    }
    if (dto.monthlyCapCents !== undefined) {
      data.ai_monthly_cap_cents = dto.monthlyCapCents;
    }

    // Premium capabilities (tier / vision / voice) are tenant-owned BUT the
    // super-admin kill-switch wins: when locked, silently ignore attempts to
    // enable them so a locked tenant can never re-grant itself premium AI.
    const locked = await this.isPremiumLocked(companyId);
    if (!locked) {
      if (dto.aiTier !== undefined) data.ai_autonomous_tier = dto.aiTier;
      if (dto.visionEnabled !== undefined) {
        data.ai_vision_enabled = dto.visionEnabled;
      }
      if (dto.voiceEnabled !== undefined) {
        data.ai_voice_enabled = dto.voiceEnabled;
      }
    }

    await this.prisma.company.update({ where: { id: companyId }, data });
    // Subscription/usage flags are cached by PlanGuard; AI gate reads the
    // company row live, so no cache key to bust here beyond the sub cache.
    this.cache.del(this.cache.subscriptionKey(companyId));
    return this.get(companyId);
  }

  private async isPremiumLocked(companyId: number): Promise<boolean> {
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { ai_premium_locked: true },
    });
    return c?.ai_premium_locked === true;
  }
}
