import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './modules/auth/auth.module';
import { SuperAdminModule } from './modules/super-admin/super-admin.module';
import { UsageMeteringModule } from './modules/usage-metering/usage-metering.module';
import { ShopifyModule } from './modules/integrations/shopify/shopify.module';
import { InboxModule } from './modules/inbox/inbox.module';
import { TeamModule } from './modules/team/team.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { BroadcastsModule } from './modules/broadcasts/broadcasts.module';
import { BotsModule } from './modules/bots/bots.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { BillingModule } from './modules/billing/billing.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { CronModule } from './modules/cron/cron.module';
import { SettingsModule } from './modules/settings/settings.module';
import { OgModule } from './modules/og/og.module';
import { CannedRepliesModule } from './modules/canned-replies/canned-replies.module';
import { PublicModule } from './modules/public/public.module';
import { AppController } from './app.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    PrismaModule,
    CommonModule,
    AuthModule,
    SuperAdminModule,
    UsageMeteringModule,
    ShopifyModule,
    WebhooksModule,
    BillingModule,
    AnalyticsModule,
    BotsModule,
    InboxModule,
    ContactsModule,
    TemplatesModule,
    BroadcastsModule,
    OnboardingModule,
    TeamModule,
    CronModule,
    SettingsModule,
    OgModule,
    CannedRepliesModule,
    PublicModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
