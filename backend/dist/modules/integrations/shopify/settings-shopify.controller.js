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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettingsShopifyController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const shopify_service_1 = require("./shopify.service");
const tenant_guard_1 = require("../../../common/guards/tenant.guard");
const current_user_decorator_1 = require("../../../common/decorators/current-user.decorator");
const update_events_dto_1 = require("./dto/update-events.dto");
const set_webhook_secret_dto_1 = require("./dto/set-webhook-secret.dto");
const order_config_dto_1 = require("./dto/order-config.dto");
const set_admin_token_dto_1 = require("./dto/set-admin-token.dto");
let SettingsShopifyController = class SettingsShopifyController {
    constructor(shopifyService) {
        this.shopifyService = shopifyService;
    }
    async status(user) {
        const [integration, webhook] = await Promise.all([
            this.shopifyService.getIntegrationOrNull(user.companyId),
            this.shopifyService.getWebhookConfig(user.companyId),
        ]);
        return { integration, ...webhook };
    }
    setWebhookSecret(user, dto) {
        return this.shopifyService.setWebhookSecret(user.companyId, dto.secret);
    }
    connect(user) {
        return this.shopifyService.getOAuthUrl(user.companyId);
    }
    updateEvents(user, dto) {
        return this.shopifyService.updateEvents(user.companyId, dto.events);
    }
    setAdminToken(user, dto) {
        return this.shopifyService.setAdminToken(user.companyId, dto.token);
    }
    getOrderConfig(user) {
        return this.shopifyService.getOrderConfig(user.companyId);
    }
    putOrderConfig(user, dto) {
        return this.shopifyService.upsertOrderConfig(user.companyId, {
            enabled: dto.enabled,
            templateId: dto.templateId ?? null,
            variableMap: dto.variableMap,
            confirmTag: dto.confirmTag,
            cancelTag: dto.cancelTag,
            shopDomain: dto.shopDomain,
            apiVersion: dto.apiVersion,
        });
    }
    disconnect(user) {
        return this.shopifyService.disconnect(user.companyId);
    }
};
exports.SettingsShopifyController = SettingsShopifyController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], SettingsShopifyController.prototype, "status", null);
__decorate([
    (0, common_1.Patch)('webhook-secret'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, set_webhook_secret_dto_1.SetShopifyWebhookSecretDto]),
    __metadata("design:returntype", void 0)
], SettingsShopifyController.prototype, "setWebhookSecret", null);
__decorate([
    (0, common_1.Get)('connect'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], SettingsShopifyController.prototype, "connect", null);
__decorate([
    (0, common_1.Patch)('events'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, update_events_dto_1.UpdateShopifyEventsDto]),
    __metadata("design:returntype", void 0)
], SettingsShopifyController.prototype, "updateEvents", null);
__decorate([
    (0, common_1.Patch)('admin-token'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, set_admin_token_dto_1.SetShopifyAdminTokenDto]),
    __metadata("design:returntype", void 0)
], SettingsShopifyController.prototype, "setAdminToken", null);
__decorate([
    (0, common_1.Get)('order-config'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], SettingsShopifyController.prototype, "getOrderConfig", null);
__decorate([
    (0, common_1.Put)('order-config'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, order_config_dto_1.ShopifyOrderConfigDto]),
    __metadata("design:returntype", void 0)
], SettingsShopifyController.prototype, "putOrderConfig", null);
__decorate([
    (0, common_1.Delete)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], SettingsShopifyController.prototype, "disconnect", null);
exports.SettingsShopifyController = SettingsShopifyController = __decorate([
    (0, common_1.Controller)('settings/shopify'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), tenant_guard_1.TenantGuard),
    __metadata("design:paramtypes", [shopify_service_1.ShopifyService])
], SettingsShopifyController);
//# sourceMappingURL=settings-shopify.controller.js.map