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
const inbox_module_1 = require("../../inbox/inbox.module");
const usage_metering_module_1 = require("../../usage-metering/usage-metering.module");
const ai_module_1 = require("../../ai/ai.module");
const tickets_module_1 = require("../../tickets/tickets.module");
const shopify_service_1 = require("./shopify.service");
const ai_auto_order_service_1 = require("./ai-auto-order.service");
const ai_agent_service_1 = require("./ai-agent.service");
const shopify_controller_1 = require("./shopify.controller");
const settings_shopify_controller_1 = require("./settings-shopify.controller");
const shopify_tenant_webhook_controller_1 = require("./shopify-tenant-webhook.controller");
const shopify_orders_controller_1 = require("./shopify-orders.controller");
let ShopifyModule = class ShopifyModule {
};
exports.ShopifyModule = ShopifyModule;
exports.ShopifyModule = ShopifyModule = __decorate([
    (0, common_1.Module)({
        imports: [inbox_module_1.InboxModule, usage_metering_module_1.UsageMeteringModule, ai_module_1.AiModule, tickets_module_1.TicketsModule],
        providers: [shopify_service_1.ShopifyService, ai_auto_order_service_1.AiAutoOrderService, ai_agent_service_1.AiAgentService],
        controllers: [
            shopify_controller_1.ShopifyController,
            settings_shopify_controller_1.SettingsShopifyController,
            shopify_tenant_webhook_controller_1.ShopifyTenantWebhookController,
            shopify_orders_controller_1.ShopifyOrdersController,
        ],
    })
], ShopifyModule);
//# sourceMappingURL=shopify.module.js.map