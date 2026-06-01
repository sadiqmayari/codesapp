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
exports.PlanGuard = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const prisma_service_1 = require("../../prisma/prisma.service");
const cache_service_1 = require("../services/cache.service");
const platform_setting_service_1 = require("../services/platform-setting.service");
const plan_limit_decorator_1 = require("../decorators/plan-limit.decorator");
const usage_counts_1 = require("../utils/usage-counts");
let PlanGuard = class PlanGuard {
    constructor(reflector, prisma, cache, platformSetting) {
        this.reflector = reflector;
        this.prisma = prisma;
        this.cache = cache;
        this.platformSetting = platformSetting;
    }
    async canActivate(context) {
        const limitField = this.reflector.get(plan_limit_decorator_1.PLAN_LIMIT_KEY, context.getHandler());
        if (!limitField)
            return true;
        const req = context.switchToHttp().getRequest();
        const companyId = req.companyId;
        if (!companyId)
            return true;
        const subscription = await this.getSubscription(companyId);
        const usage = await (0, usage_counts_1.getStoredUsage)(this.prisma, companyId);
        const { limit, current } = this.getLimit(limitField, subscription, usage);
        if (current >= limit) {
            const action = await this.resolveAction(companyId);
            if (action === 'block') {
                throw new common_1.ForbiddenException(`Plan limit reached: ${limitField} (${current}/${limit})`);
            }
        }
        return true;
    }
    async resolveAction(companyId) {
        const cacheKey = `usage-action:${companyId}`;
        const cached = this.cache.get(cacheKey);
        if (cached)
            return cached;
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { usage_limit_action: true },
        });
        const action = company?.usage_limit_action ??
            (await this.platformSetting.getUsageLimitAction());
        this.cache.set(cacheKey, action, 300);
        return action;
    }
    async getSubscription(companyId) {
        const cacheKey = this.cache.subscriptionKey(companyId);
        const cached = this.cache.get(cacheKey);
        if (cached)
            return cached;
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: {
                contact_limit_override: true,
                template_limit_override: true,
                user_limit_override: true,
                subscription: {
                    select: {
                        contact_limit: true,
                        template_limit: true,
                        user_limit: true,
                    },
                },
            },
        });
        const sub = company.subscription;
        const effective = {
            contact_limit: company.contact_limit_override ?? sub.contact_limit,
            template_limit: company.template_limit_override ?? sub.template_limit,
            user_limit: company.user_limit_override ?? sub.user_limit,
        };
        this.cache.set(cacheKey, effective, 300);
        return effective;
    }
    getLimit(field, sub, usage) {
        switch (field) {
            case 'contacts':
                return { limit: sub.contact_limit, current: usage.contacts };
            case 'templates':
                return { limit: sub.template_limit, current: usage.templates };
            case 'users':
                return { limit: sub.user_limit, current: usage.users };
        }
    }
};
exports.PlanGuard = PlanGuard;
exports.PlanGuard = PlanGuard = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [core_1.Reflector,
        prisma_service_1.PrismaService,
        cache_service_1.CacheService,
        platform_setting_service_1.PlatformSettingService])
], PlanGuard);
//# sourceMappingURL=plan.guard.js.map