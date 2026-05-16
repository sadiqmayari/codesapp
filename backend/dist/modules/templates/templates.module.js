"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TemplatesModule = void 0;
const common_1 = require("@nestjs/common");
const auth_module_1 = require("../auth/auth.module");
const usage_metering_module_1 = require("../usage-metering/usage-metering.module");
const inbox_module_1 = require("../inbox/inbox.module");
const webhooks_module_1 = require("../webhooks/webhooks.module");
const templates_controller_1 = require("./templates.controller");
const templates_service_1 = require("./templates.service");
const meta_template_sync_service_1 = require("./meta-template-sync.service");
let TemplatesModule = class TemplatesModule {
};
exports.TemplatesModule = TemplatesModule;
exports.TemplatesModule = TemplatesModule = __decorate([
    (0, common_1.Module)({
        imports: [auth_module_1.AuthModule, usage_metering_module_1.UsageMeteringModule, inbox_module_1.InboxModule, webhooks_module_1.WebhooksModule],
        controllers: [templates_controller_1.TemplatesController],
        providers: [templates_service_1.TemplatesService, meta_template_sync_service_1.MetaTemplateSyncService],
        exports: [templates_service_1.TemplatesService],
    })
], TemplatesModule);
//# sourceMappingURL=templates.module.js.map