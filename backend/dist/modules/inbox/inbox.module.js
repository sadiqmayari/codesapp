"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InboxModule = void 0;
const common_1 = require("@nestjs/common");
const auth_module_1 = require("../auth/auth.module");
const usage_metering_module_1 = require("../usage-metering/usage-metering.module");
const bots_module_1 = require("../bots/bots.module");
const webhooks_module_1 = require("../webhooks/webhooks.module");
const inbox_controller_1 = require("./inbox.controller");
const inbox_service_1 = require("./inbox.service");
const inbox_gateway_1 = require("./inbox.gateway");
const meta_client_service_1 = require("./meta-client.service");
const meta_webhook_controller_1 = require("./meta-webhook.controller");
const meta_webhook_service_1 = require("./meta-webhook.service");
const outbox_sender_service_1 = require("./outbox-sender.service");
const ws_jwt_guard_1 = require("./ws-jwt.guard");
let InboxModule = class InboxModule {
};
exports.InboxModule = InboxModule;
exports.InboxModule = InboxModule = __decorate([
    (0, common_1.Module)({
        imports: [
            auth_module_1.AuthModule,
            usage_metering_module_1.UsageMeteringModule,
            webhooks_module_1.WebhooksModule,
            (0, common_1.forwardRef)(() => bots_module_1.BotsModule),
        ],
        controllers: [inbox_controller_1.InboxController, meta_webhook_controller_1.MetaWebhookController],
        providers: [
            inbox_service_1.InboxService,
            inbox_gateway_1.InboxGateway,
            meta_client_service_1.MetaClientService,
            meta_webhook_service_1.MetaWebhookService,
            outbox_sender_service_1.OutboxSenderService,
            ws_jwt_guard_1.WsJwtGuard,
        ],
        exports: [inbox_service_1.InboxService, inbox_gateway_1.InboxGateway, meta_client_service_1.MetaClientService],
    })
], InboxModule);
//# sourceMappingURL=inbox.module.js.map