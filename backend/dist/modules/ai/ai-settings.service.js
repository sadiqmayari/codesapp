"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiSettingsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const cache_service_1 = require("../../common/services/cache.service");
const ai_metering_service_1 = require("./ai-metering.service");
let AiSettingsService = class AiSettingsService {
    constructor(prisma, cache, metering) {
        this.prisma = prisma;
        this.cache = cache;
        this.metering = metering;
    }
    async get(companyId) {
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
        if (!c)
            throw new common_1.NotFoundException('Company not found');
        const tier = c.ai_autonomous_tier === 'smart'
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
    async update(companyId, dto) {
        const data = {};
        if (dto.aiEnabled !== undefined)
            data.ai_enabled = dto.aiEnabled;
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
        const locked = await this.isPremiumLocked(companyId);
        if (!locked) {
            if (dto.aiTier !== undefined)
                data.ai_autonomous_tier = dto.aiTier;
            if (dto.visionEnabled !== undefined) {
                data.ai_vision_enabled = dto.visionEnabled;
            }
            if (dto.voiceEnabled !== undefined) {
                data.ai_voice_enabled = dto.voiceEnabled;
            }
        }
        await this.prisma.company.update({ where: { id: companyId }, data });
        this.cache.del(this.cache.subscriptionKey(companyId));
        return this.get(companyId);
    }
    async isPremiumLocked(companyId) {
        const c = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { ai_premium_locked: true },
        });
        return c?.ai_premium_locked === true;
    }
};
exports.AiSettingsService = AiSettingsService;
exports.AiSettingsService = AiSettingsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        cache_service_1.CacheService,
        ai_metering_service_1.AiMeteringService])
], AiSettingsService);
//# sourceMappingURL=ai-settings.service.js.map