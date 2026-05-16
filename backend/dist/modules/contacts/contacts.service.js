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
exports.ContactsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const usage_metering_service_1 = require("../usage-metering/usage-metering.service");
const segments_service_1 = require("./segments.service");
const webhook_dispatcher_service_1 = require("../webhooks/webhook-dispatcher.service");
const DEFAULT_PAGE_SIZE = 50;
let ContactsService = class ContactsService {
    constructor(prisma, metering, segmentsService, webhookDispatcher) {
        this.prisma = prisma;
        this.metering = metering;
        this.segmentsService = segmentsService;
        this.webhookDispatcher = webhookDispatcher;
    }
    async list(companyId, dto) {
        const page = dto.page ?? 1;
        const limit = dto.limit ?? DEFAULT_PAGE_SIZE;
        const skip = (page - 1) * limit;
        const where = {
            company_id: companyId,
            deleted_at: null,
        };
        if (dto.status)
            where.status = dto.status;
        if (dto.search) {
            where.OR = [
                { name: { contains: dto.search } },
                { phone: { contains: dto.search } },
                { email: { contains: dto.search } },
            ];
        }
        let idFilter;
        if (dto.segmentId) {
            const seg = await this.segmentsService.get(companyId, dto.segmentId);
            idFilter = await this.segmentsService.resolveContacts(companyId, seg.filter);
            where.id = { in: idFilter };
        }
        const [total, rows] = await Promise.all([
            this.prisma.contact.count({ where }),
            this.prisma.contact.findMany({
                where,
                orderBy: { id: 'desc' },
                skip,
                take: limit,
            }),
        ]);
        let filtered = rows;
        if (dto.tag) {
            const want = dto.tag.toLowerCase();
            filtered = rows.filter((r) => {
                const tags = Array.isArray(r.tags) ? r.tags : [];
                return tags.map((t) => t.toLowerCase()).includes(want);
            });
        }
        return {
            success: true,
            data: filtered,
            message: 'OK',
            meta: { page, limit, total },
        };
    }
    async get(companyId, id) {
        const contact = await this.prisma.contact.findFirst({
            where: { id, company_id: companyId, deleted_at: null },
        });
        if (!contact)
            throw new common_1.NotFoundException('Contact not found');
        return contact;
    }
    async create(companyId, dto) {
        const existing = await this.prisma.contact.findFirst({
            where: {
                company_id: companyId,
                phone: dto.phone,
                deleted_at: null,
            },
        });
        if (existing) {
            throw new common_1.ForbiddenException('Contact with this phone already exists');
        }
        const contact = await this.prisma.contact.create({
            data: {
                company_id: companyId,
                name: dto.name,
                phone: dto.phone,
                email: dto.email ?? null,
                tags: dto.tags ?? [],
                custom_fields: (dto.customFields ?? {}),
            },
        });
        await this.metering.incrementContacts(companyId);
        await this.webhookDispatcher.dispatch(companyId, 'contact.created', {
            contactId: contact.id,
            phone: contact.phone,
            name: contact.name,
        });
        return contact;
    }
    async update(companyId, id, dto) {
        await this.get(companyId, id);
        const data = {};
        if (dto.name !== undefined)
            data.name = dto.name;
        if (dto.email !== undefined)
            data.email = dto.email;
        if (dto.tags !== undefined)
            data.tags = dto.tags;
        if (dto.customFields !== undefined) {
            data.custom_fields = dto.customFields;
        }
        if (dto.status !== undefined)
            data.status = dto.status;
        const updated = await this.prisma.contact.update({
            where: { id },
            data,
        });
        await this.webhookDispatcher.dispatch(companyId, 'contact.updated', {
            contactId: id,
            phone: updated.phone,
            name: updated.name,
        });
        return updated;
    }
    async softDelete(companyId, id) {
        await this.get(companyId, id);
        await this.prisma.contact.update({
            where: { id },
            data: { deleted_at: new Date() },
        });
        return { ok: true };
    }
    async distinctTags(companyId) {
        const rows = await this.prisma.contact.findMany({
            where: { company_id: companyId, deleted_at: null },
            select: { tags: true },
            take: 5000,
        });
        const counts = new Map();
        for (const r of rows) {
            const tags = Array.isArray(r.tags) ? r.tags : [];
            for (const t of tags) {
                counts.set(t, (counts.get(t) ?? 0) + 1);
            }
        }
        return [...counts.entries()]
            .sort(([, a], [, b]) => b - a)
            .slice(0, 200)
            .map(([t]) => t);
    }
};
exports.ContactsService = ContactsService;
exports.ContactsService = ContactsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        usage_metering_service_1.UsageMeteringService,
        segments_service_1.SegmentsService,
        webhook_dispatcher_service_1.WebhookDispatcherService])
], ContactsService);
//# sourceMappingURL=contacts.service.js.map