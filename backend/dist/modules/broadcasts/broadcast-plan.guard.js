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
exports.BroadcastPlanGuard = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const cache_service_1 = require("../../common/services/cache.service");
const ALLOWED_PLANS = new Set(['growth', 'pro', 'enterprise']);
let BroadcastPlanGuard = class BroadcastPlanGuard {
    constructor(prisma, cache) {
        this.prisma = prisma;
        this.cache = cache;
    }
    async canActivate(context) {
        const req = context.switchToHttp().getRequest();
        const companyId = req.companyId;
        if (!companyId)
            throw new common_1.ForbiddenException('No company context');
        const cacheKey = `broadcast-plan:${companyId}`;
        const cached = this.cache.get(cacheKey);
        let planName = cached;
        if (!planName) {
            const company = await this.prisma.company.findUnique({
                where: { id: companyId },
                include: { subscription: { select: { plan_name: true } } },
            });
            planName = company?.subscription.plan_name.toLowerCase() ?? '';
            this.cache.set(cacheKey, planName, 300);
        }
        if (!ALLOWED_PLANS.has(planName)) {
            throw new common_1.ForbiddenException('Broadcasts require Growth, Pro, or Enterprise plan');
        }
        return true;
    }
};
exports.BroadcastPlanGuard = BroadcastPlanGuard;
exports.BroadcastPlanGuard = BroadcastPlanGuard = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        cache_service_1.CacheService])
], BroadcastPlanGuard);
//# sourceMappingURL=broadcast-plan.guard.js.map