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
exports.ShopifyTenantWebhookController = void 0;
const common_1 = require("@nestjs/common");
const shopify_service_1 = require("./shopify.service");
let ShopifyTenantWebhookController = class ShopifyTenantWebhookController {
    constructor(shopifyService) {
        this.shopifyService = shopifyService;
    }
    async receive(key, req) {
        const hmac = req.headers['x-shopify-hmac-sha256'] || '';
        const topic = req.headers['x-shopify-topic'] || '';
        const rawBody = req.rawBody ?? Buffer.from('');
        return this.shopifyService.handleTenantOrderWebhook(key, topic, hmac, rawBody);
    }
};
exports.ShopifyTenantWebhookController = ShopifyTenantWebhookController;
__decorate([
    (0, common_1.Post)(':key'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, common_1.Param)('key')),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], ShopifyTenantWebhookController.prototype, "receive", null);
exports.ShopifyTenantWebhookController = ShopifyTenantWebhookController = __decorate([
    (0, common_1.Controller)('webhooks/shopify'),
    __metadata("design:paramtypes", [shopify_service_1.ShopifyService])
], ShopifyTenantWebhookController);
//# sourceMappingURL=shopify-tenant-webhook.controller.js.map