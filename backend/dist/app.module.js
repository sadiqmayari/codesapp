"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const prisma_module_1 = require("./prisma/prisma.module");
const common_module_1 = require("./common/common.module");
const auth_module_1 = require("./modules/auth/auth.module");
const super_admin_module_1 = require("./modules/super-admin/super-admin.module");
const usage_metering_module_1 = require("./modules/usage-metering/usage-metering.module");
const shopify_module_1 = require("./modules/integrations/shopify/shopify.module");
const inbox_module_1 = require("./modules/inbox/inbox.module");
const team_module_1 = require("./modules/team/team.module");
const contacts_module_1 = require("./modules/contacts/contacts.module");
const templates_module_1 = require("./modules/templates/templates.module");
const broadcasts_module_1 = require("./modules/broadcasts/broadcasts.module");
const bots_module_1 = require("./modules/bots/bots.module");
const webhooks_module_1 = require("./modules/webhooks/webhooks.module");
const analytics_module_1 = require("./modules/analytics/analytics.module");
const billing_module_1 = require("./modules/billing/billing.module");
const onboarding_module_1 = require("./modules/onboarding/onboarding.module");
const cron_module_1 = require("./modules/cron/cron.module");
const settings_module_1 = require("./modules/settings/settings.module");
const og_module_1 = require("./modules/og/og.module");
const canned_replies_module_1 = require("./modules/canned-replies/canned-replies.module");
const public_module_1 = require("./modules/public/public.module");
const ai_module_1 = require("./modules/ai/ai.module");
const app_controller_1 = require("./app.controller");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({
                isGlobal: true,
                envFilePath: '.env',
            }),
            prisma_module_1.PrismaModule,
            common_module_1.CommonModule,
            auth_module_1.AuthModule,
            super_admin_module_1.SuperAdminModule,
            usage_metering_module_1.UsageMeteringModule,
            shopify_module_1.ShopifyModule,
            webhooks_module_1.WebhooksModule,
            billing_module_1.BillingModule,
            analytics_module_1.AnalyticsModule,
            bots_module_1.BotsModule,
            inbox_module_1.InboxModule,
            contacts_module_1.ContactsModule,
            templates_module_1.TemplatesModule,
            broadcasts_module_1.BroadcastsModule,
            onboarding_module_1.OnboardingModule,
            team_module_1.TeamModule,
            cron_module_1.CronModule,
            settings_module_1.SettingsModule,
            og_module_1.OgModule,
            canned_replies_module_1.CannedRepliesModule,
            public_module_1.PublicModule,
            ai_module_1.AiModule,
        ],
        controllers: [app_controller_1.AppController],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map