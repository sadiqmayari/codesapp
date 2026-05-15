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
var SegmentsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SegmentsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let SegmentsService = SegmentsService_1 = class SegmentsService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    list(companyId) {
        return this.prisma.segment.findMany({
            where: { company_id: companyId },
            orderBy: { created_at: 'desc' },
        });
    }
    async get(companyId, id) {
        const seg = await this.prisma.segment.findFirst({
            where: { id, company_id: companyId },
        });
        if (!seg)
            throw new common_1.NotFoundException('Segment not found');
        return seg;
    }
    create(companyId, dto) {
        return this.prisma.segment.create({
            data: {
                company_id: companyId,
                name: dto.name,
                filter: dto.filter,
            },
        });
    }
    async update(companyId, id, dto) {
        await this.get(companyId, id);
        const data = {};
        if (dto.name !== undefined)
            data.name = dto.name;
        if (dto.filter !== undefined)
            data.filter = dto.filter;
        return this.prisma.segment.update({ where: { id }, data });
    }
    async delete(companyId, id) {
        await this.get(companyId, id);
        await this.prisma.segment.delete({ where: { id } });
        return { ok: true };
    }
    static buildContactWhere(companyId, filter) {
        const where = {
            company_id: companyId,
            deleted_at: null,
        };
        if (filter.status) {
            where.status = filter.status;
        }
        if (filter.hasEmail === true) {
            where.email = { not: null };
        }
        else if (filter.hasEmail === false) {
            where.email = null;
        }
        if (filter.lastMessageAfter || filter.lastMessageBefore) {
            const range = {};
            if (filter.lastMessageAfter)
                range.gte = new Date(filter.lastMessageAfter);
            if (filter.lastMessageBefore)
                range.lte = new Date(filter.lastMessageBefore);
            where.last_message_at = range;
        }
        return where;
    }
    async resolveContacts(companyId, filter, limit) {
        const where = SegmentsService_1.buildContactWhere(companyId, filter);
        const rows = await this.prisma.contact.findMany({
            where,
            select: { id: true, tags: true },
            take: limit ?? 10_000,
        });
        if (!filter.tags || filter.tags.length === 0) {
            return rows.map((r) => r.id);
        }
        const requiredTags = filter.tags.map((t) => t.toLowerCase());
        return rows
            .filter((r) => {
            const contactTags = Array.isArray(r.tags)
                ? r.tags.map((t) => t.toLowerCase())
                : [];
            return requiredTags.every((t) => contactTags.includes(t));
        })
            .map((r) => r.id);
    }
    async preview(companyId, id, limit = 20) {
        const seg = await this.get(companyId, id);
        const filter = seg.filter;
        const ids = await this.resolveContacts(companyId, filter, limit);
        const contacts = await this.prisma.contact.findMany({
            where: { id: { in: ids }, company_id: companyId },
            take: limit,
            select: { id: true, name: true, phone: true, email: true, tags: true },
        });
        return contacts;
    }
};
exports.SegmentsService = SegmentsService;
exports.SegmentsService = SegmentsService = SegmentsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], SegmentsService);
//# sourceMappingURL=segments.service.js.map