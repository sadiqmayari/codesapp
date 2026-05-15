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
exports.BotsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const cache_service_1 = require("../../common/services/cache.service");
let BotsService = class BotsService {
    constructor(prisma, cache) {
        this.prisma = prisma;
        this.cache = cache;
    }
    list(companyId) {
        return this.prisma.bot.findMany({
            where: { company_id: companyId },
            orderBy: { created_at: 'desc' },
        });
    }
    async get(companyId, id) {
        const bot = await this.prisma.bot.findFirst({
            where: { id, company_id: companyId },
        });
        if (!bot)
            throw new common_1.NotFoundException('Bot not found');
        return bot;
    }
    async create(companyId, dto) {
        const bot = await this.prisma.bot.create({
            data: {
                company_id: companyId,
                name: dto.name,
                trigger_type: dto.triggerType,
                keyword: dto.keyword,
                actions: dto.actions,
                status: 'active',
            },
        });
        this.invalidateCache(companyId);
        return bot;
    }
    async update(companyId, id, dto) {
        await this.get(companyId, id);
        const data = {};
        if (dto.name !== undefined)
            data.name = dto.name;
        if (dto.triggerType !== undefined)
            data.trigger_type = dto.triggerType;
        if (dto.keyword !== undefined)
            data.keyword = dto.keyword;
        if (dto.actions !== undefined)
            data.actions = dto.actions;
        const bot = await this.prisma.bot.update({
            where: { id },
            data,
        });
        this.invalidateCache(companyId);
        return bot;
    }
    async delete(companyId, id) {
        await this.get(companyId, id);
        await this.prisma.bot.delete({ where: { id } });
        this.invalidateCache(companyId);
        return { ok: true };
    }
    async toggle(companyId, id) {
        const bot = await this.get(companyId, id);
        const next = bot.status === 'active' ? 'inactive' : 'active';
        const updated = await this.prisma.bot.update({
            where: { id },
            data: { status: next },
        });
        this.invalidateCache(companyId);
        return updated;
    }
    invalidateCache(companyId) {
        this.cache.del(`bots:active:${companyId}`);
    }
};
exports.BotsService = BotsService;
exports.BotsService = BotsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        cache_service_1.CacheService])
], BotsService);
//# sourceMappingURL=bots.service.js.map