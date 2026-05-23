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
var LimitWarningService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.LimitWarningService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const cache_service_1 = require("../../common/services/cache.service");
const webhook_dispatcher_service_1 = require("../webhooks/webhook-dispatcher.service");
const SUBSCRIPTION_TTL_SEC = 300;
let LimitWarningService = LimitWarningService_1 = class LimitWarningService {
    constructor(prisma, cache, dispatcher) {
        this.prisma = prisma;
        this.cache = cache;
        this.dispatcher = dispatcher;
        this.logger = new common_1.Logger(LimitWarningService_1.name);
    }
    static msUntilMonthEnd() {
        const now = new Date();
        const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        return Math.max(60_000, nextMonth.getTime() - now.getTime());
    }
    async loadSubAndUsage(companyId, period) {
        const key = this.cache.subscriptionKey(companyId);
        let limits = this.cache.get(key);
        if (!limits) {
            const company = await this.prisma.company.findUnique({
                where: { id: companyId },
                select: {
                    contact_limit_override: true,
                    template_limit_override: true,
                    subscription: {
                        select: { contact_limit: true, template_limit: true },
                    },
                },
            });
            if (!company?.subscription)
                return null;
            limits = {
                contacts: company.contact_limit_override ?? company.subscription.contact_limit,
                templates: company.template_limit_override ??
                    company.subscription.template_limit,
            };
            this.cache.set(key, limits, SUBSCRIPTION_TTL_SEC);
        }
        const usage = await this.prisma.usageMetering.findUnique({
            where: { company_id_period: { company_id: companyId, period } },
        });
        return {
            limits,
            usage: {
                contacts: usage?.contacts_stored ?? 0,
                templates: usage?.templates_used ?? 0,
            },
        };
    }
    async check(companyId, dimension) {
        const map = {
            contacts: 'contacts',
            contacts_stored: 'contacts',
            templates: 'templates',
            templates_used: 'templates',
        };
        const dim = map[dimension];
        if (!dim)
            return;
        try {
            const period = new Date().toISOString().slice(0, 7);
            const data = await this.loadSubAndUsage(companyId, period);
            if (!data)
                return;
            const limit = data.limits[dim];
            const current = data.usage[dim];
            if (!limit || limit <= 0)
                return;
            const ratio = current / limit;
            if (ratio < 0.8 || ratio >= 1.0)
                return;
            const flagKey = `warning:${companyId}:${period}:${dim}`;
            if (this.cache.get(flagKey))
                return;
            await this.dispatcher.dispatch(companyId, 'subscription.limit.warning', { dimension: dim, current, limit, period });
            this.cache.set(flagKey, true, Math.floor(LimitWarningService_1.msUntilMonthEnd() / 1000));
            this.logger.log(`subscription.limit.warning fired for company ${companyId} dim=${dim} (${current}/${limit})`);
        }
        catch (err) {
            this.logger.warn(`limit-warning check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
};
exports.LimitWarningService = LimitWarningService;
exports.LimitWarningService = LimitWarningService = LimitWarningService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        cache_service_1.CacheService,
        webhook_dispatcher_service_1.WebhookDispatcherService])
], LimitWarningService);
//# sourceMappingURL=limit-warning.service.js.map