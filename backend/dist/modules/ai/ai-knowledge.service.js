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
exports.AiKnowledgeService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let AiKnowledgeService = class AiKnowledgeService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    list(companyId) {
        return this.prisma.aiKnowledgeBase.findMany({
            where: { company_id: companyId },
            orderBy: { title: 'asc' },
        });
    }
    async get(companyId, id) {
        const entry = await this.prisma.aiKnowledgeBase.findFirst({
            where: { id, company_id: companyId },
        });
        if (!entry)
            throw new common_1.NotFoundException('Knowledge entry not found');
        return entry;
    }
    create(companyId, dto) {
        return this.prisma.aiKnowledgeBase.create({
            data: {
                company_id: companyId,
                title: dto.title.trim(),
                content: dto.content,
                enabled: dto.enabled ?? true,
            },
        });
    }
    async update(companyId, id, dto) {
        await this.get(companyId, id);
        const data = {};
        if (dto.title !== undefined)
            data.title = dto.title.trim();
        if (dto.content !== undefined)
            data.content = dto.content;
        if (dto.enabled !== undefined)
            data.enabled = dto.enabled;
        return this.prisma.aiKnowledgeBase.update({ where: { id }, data });
    }
    async remove(companyId, id) {
        await this.get(companyId, id);
        await this.prisma.aiKnowledgeBase.delete({ where: { id } });
        return { ok: true };
    }
    async upsertByTitle(companyId, title, content) {
        const t = title.trim();
        const existing = await this.prisma.aiKnowledgeBase.findFirst({
            where: { company_id: companyId, title: t },
            select: { id: true },
        });
        if (existing) {
            return this.prisma.aiKnowledgeBase.update({
                where: { id: existing.id },
                data: { content, enabled: true },
            });
        }
        return this.prisma.aiKnowledgeBase.create({
            data: { company_id: companyId, title: t, content, enabled: true },
        });
    }
    async deleteByTitle(companyId, title) {
        await this.prisma.aiKnowledgeBase.deleteMany({
            where: { company_id: companyId, title: title.trim() },
        });
    }
};
exports.AiKnowledgeService = AiKnowledgeService;
exports.AiKnowledgeService = AiKnowledgeService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], AiKnowledgeService);
//# sourceMappingURL=ai-knowledge.service.js.map