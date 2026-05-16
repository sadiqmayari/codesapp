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
exports.WebhooksService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const encryption_service_1 = require("../../common/services/encryption.service");
const job_queue_service_1 = require("../../common/services/job-queue.service");
const webhook_dispatcher_service_1 = require("./webhook-dispatcher.service");
const DEFAULT_PAGE_SIZE = 20;
let WebhooksService = class WebhooksService {
    constructor(prisma, encryption, jobQueue, dispatcher) {
        this.prisma = prisma;
        this.encryption = encryption;
        this.jobQueue = jobQueue;
        this.dispatcher = dispatcher;
    }
    sanitize(ep) {
        return {
            id: ep.id,
            company_id: ep.company_id,
            endpoint_url: ep.endpoint_url,
            events: ep.events,
            status: ep.status,
            secret: '(set)',
            created_at: ep.created_at,
        };
    }
    async listEndpoints(companyId, page = 1, limit = DEFAULT_PAGE_SIZE) {
        const skip = (page - 1) * limit;
        const [total, rows] = await Promise.all([
            this.prisma.webhookEndpoint.count({ where: { company_id: companyId } }),
            this.prisma.webhookEndpoint.findMany({
                where: { company_id: companyId },
                orderBy: { id: 'desc' },
                skip,
                take: limit,
            }),
        ]);
        return {
            success: true,
            data: rows.map((r) => this.sanitize(r)),
            message: 'OK',
            meta: { page, limit, total },
        };
    }
    async getEndpoint(companyId, id) {
        const ep = await this.requireEndpoint(companyId, id);
        return this.sanitize(ep);
    }
    async createEndpoint(companyId, dto) {
        if (!/^https:\/\//i.test(dto.endpointUrl)) {
            throw new common_1.BadRequestException('endpointUrl must be https');
        }
        const ep = await this.prisma.webhookEndpoint.create({
            data: {
                company_id: companyId,
                endpoint_url: dto.endpointUrl,
                secret_key_encrypted: this.encryption.encrypt(dto.secret),
                events: dto.events,
                status: dto.status === 'inactive' ? 'inactive' : 'active',
            },
        });
        this.dispatcher.invalidate(companyId);
        return this.sanitize(ep);
    }
    async updateEndpoint(companyId, id, dto) {
        await this.requireEndpoint(companyId, id);
        if (dto.endpointUrl && !/^https:\/\//i.test(dto.endpointUrl)) {
            throw new common_1.BadRequestException('endpointUrl must be https');
        }
        const data = {};
        if (dto.endpointUrl !== undefined)
            data.endpoint_url = dto.endpointUrl;
        if (dto.secret !== undefined) {
            data.secret_key_encrypted = this.encryption.encrypt(dto.secret);
        }
        if (dto.events !== undefined) {
            data.events = dto.events;
        }
        if (dto.status !== undefined)
            data.status = dto.status;
        const ep = await this.prisma.webhookEndpoint.update({
            where: { id },
            data,
        });
        this.dispatcher.invalidate(companyId);
        return this.sanitize(ep);
    }
    async deleteEndpoint(companyId, id) {
        await this.requireEndpoint(companyId, id);
        await this.prisma.webhookEndpoint.delete({ where: { id } });
        this.dispatcher.invalidate(companyId);
        return { ok: true };
    }
    async toggleEndpoint(companyId, id) {
        const ep = await this.requireEndpoint(companyId, id);
        const next = ep.status === 'active' ? 'inactive' : 'active';
        const updated = await this.prisma.webhookEndpoint.update({
            where: { id },
            data: { status: next },
        });
        this.dispatcher.invalidate(companyId);
        return this.sanitize(updated);
    }
    async testEndpoint(companyId, id) {
        const ep = await this.requireEndpoint(companyId, id);
        const payload = {
            webhookEndpointId: ep.id,
            event: 'test',
            companyId,
            data: { message: 'CodesApp webhook test event', endpointId: ep.id },
            enqueuedAt: new Date().toISOString(),
        };
        const jobId = await this.jobQueue.enqueue('webhook', payload);
        return { enqueued: true, jobId };
    }
    async listLogs(companyId, dto) {
        const page = dto.page ?? 1;
        const limit = dto.limit ?? DEFAULT_PAGE_SIZE;
        const skip = (page - 1) * limit;
        const where = { company_id: companyId };
        if (dto.endpointId)
            where.webhook_id = dto.endpointId;
        if (dto.event)
            where.event_name = dto.event;
        if (dto.status)
            where.delivery_status = dto.status;
        if (dto.from || dto.to) {
            where.created_at = {};
            if (dto.from)
                where.created_at.gte = new Date(dto.from);
            if (dto.to)
                where.created_at.lte = new Date(dto.to);
        }
        const [total, rows] = await Promise.all([
            this.prisma.webhookLog.count({ where }),
            this.prisma.webhookLog.findMany({
                where,
                orderBy: { id: 'desc' },
                skip,
                take: limit,
            }),
        ]);
        return {
            success: true,
            data: rows,
            message: 'OK',
            meta: { page, limit, total },
        };
    }
    async retryLog(companyId, logId) {
        const log = await this.prisma.webhookLog.findFirst({
            where: { id: logId, company_id: companyId },
        });
        if (!log)
            throw new common_1.NotFoundException('Webhook log not found');
        const stored = (log.payload ?? {});
        const data = stored.payload?.data ?? {};
        const payload = {
            webhookEndpointId: log.webhook_id,
            event: log.event_name,
            companyId,
            data,
            enqueuedAt: new Date().toISOString(),
        };
        const jobId = await this.jobQueue.enqueue('webhook', payload);
        return { reEnqueued: true, jobId };
    }
    async requireEndpoint(companyId, id) {
        const ep = await this.prisma.webhookEndpoint.findFirst({
            where: { id, company_id: companyId },
        });
        if (!ep)
            throw new common_1.NotFoundException('Webhook endpoint not found');
        return ep;
    }
};
exports.WebhooksService = WebhooksService;
exports.WebhooksService = WebhooksService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        encryption_service_1.EncryptionService,
        job_queue_service_1.JobQueueService,
        webhook_dispatcher_service_1.WebhookDispatcherService])
], WebhooksService);
//# sourceMappingURL=webhooks.service.js.map