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
exports.FeatureService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const platform_setting_service_1 = require("./platform-setting.service");
let FeatureService = class FeatureService {
    constructor(prisma, platformSetting) {
        this.prisma = prisma;
        this.platformSetting = platformSetting;
    }
    async getOverride(companyId, feature) {
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { feature_overrides: true },
        });
        const map = (company?.feature_overrides ?? null);
        const v = map?.[feature];
        return v === 'on' || v === 'off' ? v : null;
    }
    async proactiveNotificationsEnabled(companyId) {
        const override = await this.getOverride(companyId, 'proactive_notifications');
        if (override)
            return override === 'on';
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: {
                proactive_notifications_enabled: true,
                subscription: { select: { proactive_notifications: true } },
            },
        });
        if (!company)
            return false;
        const planOn = company.subscription?.proactive_notifications ?? false;
        const tenantOn = company.proactive_notifications_enabled;
        return planOn && tenantOn;
    }
    async engagementModeFor(companyId) {
        const override = await this.getOverride(companyId, 'engagement_engine');
        if (override === 'off')
            return 'off';
        const allowed = override === 'on' ||
            (await this.platformSetting.isEngagementEngineEnabled(companyId));
        if (!allowed)
            return 'off';
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { engagement_mode: true },
        });
        const per = company?.engagement_mode;
        if (per === 'on' || per === 'shadow')
            return per;
        return this.platformSetting.getEngagementMode();
    }
};
exports.FeatureService = FeatureService;
exports.FeatureService = FeatureService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        platform_setting_service_1.PlatformSettingService])
], FeatureService);
//# sourceMappingURL=feature.service.js.map