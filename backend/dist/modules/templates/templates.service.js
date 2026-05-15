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
exports.TemplatesService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const usage_metering_service_1 = require("../usage-metering/usage-metering.service");
const meta_template_sync_service_1 = require("./meta-template-sync.service");
let TemplatesService = class TemplatesService {
    constructor(prisma, metering, metaSync) {
        this.prisma = prisma;
        this.metering = metering;
        this.metaSync = metaSync;
    }
    list(companyId, dto) {
        const where = {
            company_id: companyId,
            deleted_at: null,
        };
        if (dto.status)
            where.status = dto.status;
        if (dto.category)
            where.category = dto.category;
        return this.prisma.template.findMany({
            where,
            orderBy: { created_at: 'desc' },
        });
    }
    async get(companyId, id) {
        const tpl = await this.prisma.template.findFirst({
            where: { id, company_id: companyId, deleted_at: null },
        });
        if (!tpl)
            throw new common_1.NotFoundException('Template not found');
        return tpl;
    }
    async create(companyId, dto) {
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { waba_id: true },
        });
        if (!company?.waba_id) {
            throw new common_1.ForbiddenException('WhatsApp Business Account not configured');
        }
        const tpl = await this.prisma.template.create({
            data: {
                company_id: companyId,
                meta_template_id: null,
                name: dto.name,
                category: dto.category,
                status: 'pending',
                content: {
                    language: dto.language,
                    components: dto.components,
                },
            },
        });
        const result = await this.metaSync.submitToMeta(companyId, company.waba_id, {
            name: dto.name,
            category: dto.category,
            language: dto.language,
            components: dto.components,
        });
        if (result.id) {
            const updated = await this.prisma.template.update({
                where: { id: tpl.id },
                data: { meta_template_id: result.id },
            });
            await this.metering.incrementTemplates(companyId);
            return updated;
        }
        return this.prisma.template.update({
            where: { id: tpl.id },
            data: {
                status: 'rejected',
                rejection_reason: result.error ?? 'Meta API rejected template',
            },
        });
    }
    async softDelete(companyId, id) {
        await this.get(companyId, id);
        await this.prisma.template.update({
            where: { id },
            data: { deleted_at: new Date() },
        });
        return { ok: true };
    }
    sync(companyId) {
        return this.metaSync.syncFromMeta(companyId);
    }
};
exports.TemplatesService = TemplatesService;
exports.TemplatesService = TemplatesService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        usage_metering_service_1.UsageMeteringService,
        meta_template_sync_service_1.MetaTemplateSyncService])
], TemplatesService);
//# sourceMappingURL=templates.service.js.map