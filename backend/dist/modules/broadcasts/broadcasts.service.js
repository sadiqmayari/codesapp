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
var BroadcastsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.BroadcastsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const job_queue_service_1 = require("../../common/services/job-queue.service");
const meta_client_service_1 = require("../inbox/meta-client.service");
const segments_service_1 = require("../contacts/segments.service");
const PROGRESS_EMIT_EVERY = 25;
const THROTTLE_SPACING_MS = 100;
let BroadcastsService = BroadcastsService_1 = class BroadcastsService {
    constructor(prisma, jobQueue, segmentsService, metaClient) {
        this.prisma = prisma;
        this.jobQueue = jobQueue;
        this.segmentsService = segmentsService;
        this.metaClient = metaClient;
        this.logger = new common_1.Logger(BroadcastsService_1.name);
    }
    list(companyId, dto) {
        const page = dto.page ?? 1;
        const limit = dto.limit ?? 20;
        const skip = (page - 1) * limit;
        const where = { company_id: companyId };
        if (dto.status)
            where.status = dto.status;
        return this.prisma.broadcast.findMany({
            where,
            orderBy: { created_at: 'desc' },
            skip,
            take: limit,
        });
    }
    async get(companyId, id) {
        const b = await this.prisma.broadcast.findFirst({
            where: { id, company_id: companyId },
        });
        if (!b)
            throw new common_1.NotFoundException('Broadcast not found');
        return b;
    }
    async create(companyId, dto) {
        const tpl = await this.prisma.template.findFirst({
            where: { id: dto.templateId, company_id: companyId, deleted_at: null },
        });
        if (!tpl)
            throw new common_1.NotFoundException('Template not found');
        const audience = {};
        if (dto.all)
            audience.all = true;
        if (dto.contactIds?.length)
            audience.contactIds = dto.contactIds;
        if (dto.filter)
            audience.filter = dto.filter;
        if (dto.segmentId)
            audience.segmentId = dto.segmentId;
        if (dto.variables)
            audience.variables = dto.variables;
        return this.prisma.broadcast.create({
            data: {
                company_id: companyId,
                template_id: dto.templateId,
                name: dto.name,
                audience_filter: audience,
                status: 'draft',
            },
        });
    }
    async update(companyId, id, dto) {
        const b = await this.get(companyId, id);
        if (b.status !== 'draft') {
            throw new common_1.BadRequestException('Only draft broadcasts can be edited');
        }
        const audience = {};
        if (dto.all)
            audience.all = true;
        if (dto.contactIds?.length)
            audience.contactIds = dto.contactIds;
        if (dto.filter)
            audience.filter = dto.filter;
        if (dto.segmentId)
            audience.segmentId = dto.segmentId;
        if (dto.variables)
            audience.variables = dto.variables;
        return this.prisma.broadcast.update({
            where: { id },
            data: {
                name: dto.name,
                template_id: dto.templateId,
                audience_filter: audience,
            },
        });
    }
    async sendNow(companyId, id) {
        const b = await this.get(companyId, id);
        if (b.status !== 'draft' && b.status !== 'scheduled') {
            throw new common_1.BadRequestException(`Cannot send broadcast in status ${b.status}`);
        }
        await this.dispatch(companyId, id);
        return { ok: true };
    }
    async schedule(companyId, id, dto) {
        const b = await this.get(companyId, id);
        if (b.status !== 'draft') {
            throw new common_1.BadRequestException('Only draft broadcasts can be scheduled');
        }
        const runAt = new Date(dto.runAt);
        if (runAt.getTime() <= Date.now()) {
            throw new common_1.BadRequestException('runAt must be in the future');
        }
        await this.prisma.broadcast.update({
            where: { id },
            data: { status: 'scheduled', scheduled_at: runAt },
        });
        await this.jobQueue.enqueue('broadcast', { kind: 'dispatch', broadcastId: id, companyId }, { delayMs: runAt.getTime() - Date.now() });
        return { ok: true, runAt };
    }
    async cancel(companyId, id) {
        const b = await this.get(companyId, id);
        if (!['draft', 'scheduled', 'sending'].includes(b.status)) {
            throw new common_1.BadRequestException(`Cannot cancel broadcast in status ${b.status}`);
        }
        await this.prisma.$executeRaw `
      DELETE FROM jobs
      WHERE queue_name = 'broadcast'
        AND status = 'pending'
        AND JSON_EXTRACT(payload, '$.broadcastId') = ${id}
    `;
        await this.prisma.broadcast.update({
            where: { id },
            data: { status: 'cancelled' },
        });
        return { ok: true };
    }
    async analytics(companyId, id) {
        const b = await this.get(companyId, id);
        const audience = b.audience_filter;
        const totalSeed = await this.resolveAudienceSize(companyId, audience);
        return {
            id: b.id,
            name: b.name,
            status: b.status,
            total: totalSeed,
            sent: b.sent_count,
            delivered: b.delivered_count,
            read: b.read_count,
            failed: b.failed_count,
            scheduledAt: b.scheduled_at,
            createdAt: b.created_at,
        };
    }
    async previewAudience(companyId, dto) {
        const audience = {};
        if (dto.all)
            audience.all = true;
        if (dto.contactIds?.length)
            audience.contactIds = dto.contactIds;
        if (dto.filter)
            audience.filter = dto.filter;
        if (dto.segmentId)
            audience.segmentId = dto.segmentId;
        const ids = await this.resolveAudience(companyId, audience);
        const sample = await this.prisma.contact.findMany({
            where: { id: { in: ids.slice(0, 10) }, company_id: companyId },
            select: { id: true, name: true, phone: true },
        });
        return { count: ids.length, sample };
    }
    async testSend(companyId, dto) {
        const [company, template] = await Promise.all([
            this.prisma.company.findUnique({
                where: { id: companyId },
                select: { phone_number_id: true },
            }),
            this.prisma.template.findFirst({
                where: { id: dto.templateId, company_id: companyId, deleted_at: null },
            }),
        ]);
        if (!company?.phone_number_id) {
            throw new common_1.BadRequestException('WhatsApp number is not configured yet');
        }
        if (!template?.meta_template_id) {
            throw new common_1.BadRequestException('Template not found or not yet approved by Meta');
        }
        await this.metaClient.assertOnboarded(companyId);
        const contact = await this.prisma.contact.findFirst({
            where: { phone: dto.phone, company_id: companyId, deleted_at: null },
            select: { name: true, phone: true, email: true, custom_fields: true },
        });
        const langCode = template.content?.language ?? 'en_US';
        const components = BroadcastsService_1.buildTemplateComponents(dto.variables ?? {}, contact ?? { name: null, phone: dto.phone, email: null, custom_fields: {} });
        await this.metaClient.sendTemplate(companyId, company.phone_number_id, dto.phone, template.name, langCode, components);
        return { ok: true };
    }
    async duplicate(companyId, id) {
        const b = await this.get(companyId, id);
        return this.prisma.broadcast.create({
            data: {
                company_id: companyId,
                template_id: b.template_id,
                name: `Copy of ${b.name}`.slice(0, 255),
                audience_filter: b.audience_filter,
                status: 'draft',
            },
        });
    }
    static resolveVariableValue(raw, contact) {
        const m = /^\{\{\s*contact\.([a-zA-Z0-9_.]+)\s*\}\}$/.exec(raw ?? '');
        if (!m)
            return raw ?? '';
        const path = m[1];
        if (path === 'name')
            return contact.name ?? '';
        if (path === 'phone')
            return contact.phone ?? '';
        if (path === 'email')
            return contact.email ?? '';
        if (path.startsWith('custom.')) {
            const key = path.slice('custom.'.length);
            const cf = (contact.custom_fields ?? {});
            const v = cf[key];
            return v == null ? '' : String(v);
        }
        return '';
    }
    static buildTemplateComponents(variables, contact) {
        const entries = Object.entries(variables);
        if (entries.length === 0)
            return [];
        return [
            {
                type: 'body',
                parameters: entries
                    .sort(([a], [b]) => Number(a) - Number(b))
                    .map(([, value]) => ({
                    type: 'text',
                    text: BroadcastsService_1.resolveVariableValue(value, contact),
                })),
            },
        ];
    }
    async dispatch(companyId, broadcastId) {
        const b = await this.prisma.broadcast.findFirst({
            where: { id: broadcastId, company_id: companyId },
        });
        if (!b)
            throw new common_1.NotFoundException('Broadcast not found');
        if (b.status === 'cancelled')
            return;
        const audience = b.audience_filter;
        const contactIds = await this.resolveAudience(companyId, audience);
        if (contactIds.length === 0) {
            await this.prisma.broadcast.update({
                where: { id: broadcastId },
                data: { status: 'completed' },
            });
            return;
        }
        await this.prisma.broadcast.update({
            where: { id: broadcastId },
            data: { status: 'sending' },
        });
        const variables = audience.variables ?? {};
        for (let i = 0; i < contactIds.length; i++) {
            await this.jobQueue.enqueue('broadcast', {
                kind: 'send',
                broadcastId,
                companyId,
                contactId: contactIds[i],
                templateId: b.template_id,
                variables,
                total: contactIds.length,
            }, { delayMs: i * THROTTLE_SPACING_MS });
        }
    }
    async resolveAudience(companyId, audience) {
        if (audience.all === true) {
            return this.segmentsService.resolveContacts(companyId, {
                status: 'active',
            });
        }
        if (Array.isArray(audience.contactIds) && audience.contactIds.length > 0) {
            const ids = audience.contactIds.filter(Number.isInteger);
            const verified = await this.prisma.contact.findMany({
                where: {
                    id: { in: ids },
                    company_id: companyId,
                    deleted_at: null,
                },
                select: { id: true },
            });
            return verified.map((c) => c.id);
        }
        if (audience.segmentId) {
            const seg = await this.segmentsService.get(companyId, audience.segmentId);
            return this.segmentsService.resolveContacts(companyId, seg.filter);
        }
        if (audience.filter) {
            return this.segmentsService.resolveContacts(companyId, audience.filter);
        }
        return [];
    }
    async resolveAudienceSize(companyId, audience) {
        const ids = await this.resolveAudience(companyId, audience);
        return ids.length;
    }
    async incrementCounters(broadcastId, field) {
        const updated = await this.prisma.broadcast.update({
            where: { id: broadcastId },
            data: { [field]: { increment: 1 } },
            select: { sent_count: true, failed_count: true, audience_filter: true },
        });
        const audience = updated.audience_filter;
        const total = Array.isArray(audience.contactIds)
            ? audience.contactIds.length
            : null;
        return {
            sent_count: updated.sent_count,
            failed_count: updated.failed_count,
            total,
        };
    }
    async markCompletedIfDone(broadcastId, total) {
        const b = await this.prisma.broadcast.findUnique({
            where: { id: broadcastId },
            select: { sent_count: true, failed_count: true, status: true },
        });
        if (!b)
            return false;
        if (b.sent_count + b.failed_count >= total && b.status === 'sending') {
            await this.prisma.broadcast.update({
                where: { id: broadcastId },
                data: { status: 'completed' },
            });
            return true;
        }
        return false;
    }
    static shouldEmitProgress(processed) {
        return processed > 0 && processed % PROGRESS_EMIT_EVERY === 0;
    }
};
exports.BroadcastsService = BroadcastsService;
exports.BroadcastsService = BroadcastsService = BroadcastsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        job_queue_service_1.JobQueueService,
        segments_service_1.SegmentsService,
        meta_client_service_1.MetaClientService])
], BroadcastsService);
//# sourceMappingURL=broadcasts.service.js.map