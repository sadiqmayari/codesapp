"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BillingModule = void 0;
const common_1 = require("@nestjs/common");
const auth_module_1 = require("../auth/auth.module");
const webhooks_module_1 = require("../webhooks/webhooks.module");
const ai_module_1 = require("../ai/ai.module");
const billing_controller_1 = require("./billing.controller");
const billing_super_admin_controller_1 = require("./billing-super-admin.controller");
const billing_cron_controller_1 = require("./billing-cron.controller");
const billing_account_controller_1 = require("./billing-account.controller");
const billing_service_1 = require("./billing.service");
const invoice_generator_service_1 = require("./invoice-generator.service");
const limit_warning_service_1 = require("./limit-warning.service");
const limit_notifier_service_1 = require("./limit-notifier.service");
let BillingModule = class BillingModule {
};
exports.BillingModule = BillingModule;
exports.BillingModule = BillingModule = __decorate([
    (0, common_1.Module)({
        imports: [
            auth_module_1.AuthModule,
            webhooks_module_1.WebhooksModule,
            ai_module_1.AiModule,
            (0, common_1.forwardRef)(() => require('../inbox/inbox.module').InboxModule),
        ],
        controllers: [
            billing_controller_1.BillingController,
            billing_super_admin_controller_1.BillingSuperAdminController,
            billing_cron_controller_1.BillingCronController,
            billing_account_controller_1.BillingAccountController,
        ],
        providers: [
            billing_service_1.BillingService,
            invoice_generator_service_1.InvoiceGeneratorService,
            limit_warning_service_1.LimitWarningService,
            limit_notifier_service_1.LimitNotifierService,
        ],
        exports: [limit_warning_service_1.LimitWarningService, limit_notifier_service_1.LimitNotifierService],
    })
], BillingModule);
//# sourceMappingURL=billing.module.js.map