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
exports.PlatformSettingService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const cache_service_1 = require("./cache.service");
const USAGE_LIMIT_ACTION_KEY = 'usage_limit_action';
const CACHE_TTL_SEC = 300;
let PlatformSettingService = class PlatformSettingService {
    constructor(prisma, cache) {
        this.prisma = prisma;
        this.cache = cache;
    }
    cacheKey(key) {
        return `platform-setting:${key}`;
    }
    async get(key, fallback) {
        const ck = this.cacheKey(key);
        const cached = this.cache.get(ck);
        if (cached !== undefined && cached !== null)
            return cached;
        const row = await this.prisma.platformSetting.findUnique({
            where: { key },
        });
        const value = row?.value ?? fallback;
        this.cache.set(ck, value, CACHE_TTL_SEC);
        return value;
    }
    async set(key, value) {
        await this.prisma.platformSetting.upsert({
            where: { key },
            create: { key, value },
            update: { value },
        });
        this.cache.set(this.cacheKey(key), value, CACHE_TTL_SEC);
    }
    async getUsageLimitAction() {
        const v = await this.get(USAGE_LIMIT_ACTION_KEY, 'block');
        return v === 'warn_only' ? 'warn_only' : 'block';
    }
    async setUsageLimitAction(action) {
        await this.set(USAGE_LIMIT_ACTION_KEY, action);
    }
};
exports.PlatformSettingService = PlatformSettingService;
exports.PlatformSettingService = PlatformSettingService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        cache_service_1.CacheService])
], PlatformSettingService);
//# sourceMappingURL=platform-setting.service.js.map