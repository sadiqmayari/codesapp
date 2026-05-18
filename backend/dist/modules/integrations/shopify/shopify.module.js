"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShopifyModule = void 0;
const common_1 = require("@nestjs/common");
const shopify_service_1 = require("./shopify.service");
const shopify_controller_1 = require("./shopify.controller");
const settings_shopify_controller_1 = require("./settings-shopify.controller");
const shopify_tenant_webhook_controller_1 = require("./shopify-tenant-webhook.controller");
let ShopifyModule = class ShopifyModule {
};
exports.ShopifyModule = ShopifyModule;
exports.ShopifyModule = ShopifyModule = __decorate([
    (0, common_1.Module)({
        providers: [shopify_service_1.ShopifyService],
        controllers: [
            shopify_controller_1.ShopifyController,
            settings_shopify_controller_1.SettingsShopifyController,
            shopify_tenant_webhook_controller_1.ShopifyTenantWebhookController,
        ],
    })
], ShopifyModule);
//# sourceMappingURL=shopify.module.js.map