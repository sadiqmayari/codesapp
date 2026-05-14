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
exports.ShopifyController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const shopify_service_1 = require("./shopify.service");
const tenant_guard_1 = require("../../../common/guards/tenant.guard");
const current_user_decorator_1 = require("../../../common/decorators/current-user.decorator");
let ShopifyController = class ShopifyController {
    constructor(shopifyService) {
        this.shopifyService = shopifyService;
    }
    connect(user) {
        return this.shopifyService.getOAuthUrl(user.companyId);
    }
    callback(req) {
        const { shop, code, state } = req.query;
        return this.shopifyService.handleCallback(shop, code, state);
    }
    async webhook(req) {
        const hmac = req.headers['x-shopify-hmac-sha256'];
        const topic = req.headers['x-shopify-topic'];
        const rawBody = req.rawBody;
        if (!rawBody) {
            return { received: true };
        }
        await this.shopifyService.handleWebhook(topic, hmac, rawBody);
        return { received: true };
    }
    getIntegration(user) {
        return this.shopifyService.getIntegration(user.companyId);
    }
    disconnect(user) {
        return this.shopifyService.disconnect(user.companyId);
    }
};
exports.ShopifyController = ShopifyController;
__decorate([
    (0, common_1.Get)('connect'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), tenant_guard_1.TenantGuard),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ShopifyController.prototype, "connect", null);
__decorate([
    (0, common_1.Get)('callback'),
    __param(0, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ShopifyController.prototype, "callback", null);
__decorate([
    (0, common_1.Post)('webhook'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], ShopifyController.prototype, "webhook", null);
__decorate([
    (0, common_1.Get)(),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), tenant_guard_1.TenantGuard),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ShopifyController.prototype, "getIntegration", null);
__decorate([
    (0, common_1.Delete)('disconnect'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), tenant_guard_1.TenantGuard),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ShopifyController.prototype, "disconnect", null);
exports.ShopifyController = ShopifyController = __decorate([
    (0, common_1.Controller)('integrations/shopify'),
    __metadata("design:paramtypes", [shopify_service_1.ShopifyService])
], ShopifyController);
//# sourceMappingURL=shopify.controller.js.map