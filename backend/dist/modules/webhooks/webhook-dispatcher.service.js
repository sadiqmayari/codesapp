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
var WebhookDispatcherService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookDispatcherService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const cache_service_1 = require("../../common/services/cache.service");
const company_status_service_1 = require("../../common/services/company-status.service");
const job_queue_service_1 = require("../../common/services/job-queue.service");
const CACHE_TTL_SEC = 60;
let WebhookDispatcherService = WebhookDispatcherService_1 = class WebhookDispatcherService {
    constructor(prisma, cache, jobQueue, companyStatus) {
        this.prisma = prisma;
        this.cache = cache;
        this.jobQueue = jobQueue;
        this.companyStatus = companyStatus;
        this.logger = new common_1.Logger(WebhookDispatcherService_1.name);
    }
    static cacheKey(companyId) {
        return `webhook-endpoints:${companyId}`;
    }
    static featureKey(companyId) {
        return `webhook-feature:${companyId}`;
    }
    invalidate(companyId) {
        this.cache.del(WebhookDispatcherService_1.cacheKey(companyId));
    }
    async isWebhookFeatureEnabled(companyId) {
        const key = WebhookDispatcherService_1.featureKey(companyId);
        const cached = this.cache.get(key);
        if (cached !== undefined)
            return cached;
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { subscription: { select: { webhook_enabled: true } } },
        });
        const enabled = company?.subscription?.webhook_enabled ?? false;
        this.cache.set(key, enabled, 300);
        return enabled;
    }
    async dispatch(companyId, event, data) {
        try {
            if (!(await this.companyStatus.isActive(companyId)))
                return;
            if (!(await this.isWebhookFeatureEnabled(companyId)))
                return;
            const endpoints = await this.loadActiveEndpoints(companyId);
            const matching = endpoints.filter((e) => e.events.includes(event));
            for (const ep of matching) {
                const payload = {
                    webhookEndpointId: ep.id,
                    event,
                    companyId,
                    data,
                    enqueuedAt: new Date().toISOString(),
                };
                await this.jobQueue.enqueue('webhook', payload);
            }
        }
        catch (err) {
            this.logger.warn(`dispatch(${event}) for company ${companyId} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    async loadActiveEndpoints(companyId) {
        const key = WebhookDispatcherService_1.cacheKey(companyId);
        const cached = this.cache.get(key);
        if (cached)
            return cached;
        const rows = await this.prisma.webhookEndpoint.findMany({
            where: { company_id: companyId, status: 'active' },
            select: { id: true, events: true },
        });
        const endpoints = rows.map((r) => ({
            id: r.id,
            events: Array.isArray(r.events) ? r.events : [],
        }));
        this.cache.set(key, endpoints, CACHE_TTL_SEC);
        return endpoints;
    }
};
exports.WebhookDispatcherService = WebhookDispatcherService;
exports.WebhookDispatcherService = WebhookDispatcherService = WebhookDispatcherService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        cache_service_1.CacheService,
        job_queue_service_1.JobQueueService,
        company_status_service_1.CompanyStatusService])
], WebhookDispatcherService);
//# sourceMappingURL=webhook-dispatcher.service.js.map