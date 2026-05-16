"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhooksModule = void 0;
const common_1 = require("@nestjs/common");
const auth_module_1 = require("../auth/auth.module");
const webhooks_controller_1 = require("./webhooks.controller");
const webhooks_service_1 = require("./webhooks.service");
const webhook_delivery_service_1 = require("./webhook-delivery.service");
const webhook_dispatcher_service_1 = require("./webhook-dispatcher.service");
const webhook_worker_1 = require("./webhook.worker");
let WebhooksModule = class WebhooksModule {
};
exports.WebhooksModule = WebhooksModule;
exports.WebhooksModule = WebhooksModule = __decorate([
    (0, common_1.Module)({
        imports: [auth_module_1.AuthModule],
        controllers: [webhooks_controller_1.WebhooksController],
        providers: [
            webhooks_service_1.WebhooksService,
            webhook_delivery_service_1.WebhookDeliveryService,
            webhook_dispatcher_service_1.WebhookDispatcherService,
            webhook_worker_1.WebhookWorker,
        ],
        exports: [webhook_dispatcher_service_1.WebhookDispatcherService],
    })
], WebhooksModule);
//# sourceMappingURL=webhooks.module.js.map