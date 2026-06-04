import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { UpdateAiSettingsDto } from './dto/ai-settings.dto';

export interface AiSettingsView {
  aiEnabled: boolean;
  autoReplyEnabled: boolean;
  autoOrderEnabled: boolean;
  brandTone: string | null;
  defaultLanguage: string | null;
  monthlyCapCents: number | null;
  /** Whether the company's plan includes AI (read-only). */
  planAiEnabled: boolean;
}

@Injectable()
export class AiSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async get(companyId: number): Promise<AiSettingsView> {
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        ai_enabled: true,
        ai_autoreply_enabled: true,
        ai_auto_order_enabled: true,
        ai_brand_tone: true,
        ai_default_language: true,
        ai_monthly_cap_cents: true,
        subscription: { select: { ai_enabled: true } },
      },
    });
    if (!c) throw new NotFoundException('Company not found');
    return {
      aiEnabled: c.ai_enabled,
      autoReplyEnabled: c.ai_autoreply_enabled,
      autoOrderEnabled: c.ai_auto_order_enabled,
      brandTone: c.ai_brand_tone,
      defaultLanguage: c.ai_default_language,
      monthlyCapCents: c.ai_monthly_cap_cents,
      planAiEnabled: !!c.subscription?.ai_enabled,
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
    await this.prisma.company.update({ where: { id: companyId }, data });
    // Subscription/usage flags are cached by PlanGuard; AI gate reads the
    // company row live, so no cache key to bust here beyond the sub cache.
    this.cache.del(this.cache.subscriptionKey(companyId));
    return this.get(companyId);
  }
}
