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
exports.CannedRepliesService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let CannedRepliesService = class CannedRepliesService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    list(companyId) {
        return this.prisma.cannedReply.findMany({
            where: { company_id: companyId },
            orderBy: { title: 'asc' },
        });
    }
    async get(companyId, id) {
        const reply = await this.prisma.cannedReply.findFirst({
            where: { id, company_id: companyId },
        });
        if (!reply)
            throw new common_1.NotFoundException('Canned reply not found');
        return reply;
    }
    create(companyId, dto) {
        return this.prisma.cannedReply.create({
            data: {
                company_id: companyId,
                title: dto.title.trim(),
                body: dto.body,
            },
        });
    }
    async update(companyId, id, dto) {
        await this.get(companyId, id);
        const data = {};
        if (dto.title !== undefined)
            data.title = dto.title.trim();
        if (dto.body !== undefined)
            data.body = dto.body;
        return this.prisma.cannedReply.update({ where: { id }, data });
    }
    async remove(companyId, id) {
        await this.get(companyId, id);
        await this.prisma.cannedReply.delete({ where: { id } });
        return { ok: true };
    }
};
exports.CannedRepliesService = CannedRepliesService;
exports.CannedRepliesService = CannedRepliesService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], CannedRepliesService);
//# sourceMappingURL=canned-replies.service.js.map