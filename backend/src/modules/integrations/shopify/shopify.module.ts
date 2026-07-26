import { Module } from '@nestjs/common';
import { InboxModule } from '../../inbox/inbox.module';
import { UsageMeteringModule } from '../../usage-metering/usage-metering.module';
import { AiModule } from '../../ai/ai.module';
import { TicketsModule } from '../../tickets/tickets.module';
import { EngagementModule } from '../../engagement/engagement.module';
import { ShopifyService } from './shopify.service';
import { ShopifyOrderSyncService } from './shopify-order-sync.service';
import { AiAutoOrderService } from './ai-auto-order.service';
import { AiAgentService } from './ai-agent.service';
import { ShopifyController } from './shopify.controller';
import { SettingsShopifyController } from './settings-shopify.controller';
import { ShopifyTenantWebhookController } from './shopify-tenant-webhook.controller';
import { ShopifyOrdersController } from './shopify-orders.controller';
import { ShopifyCronController } from './shopify-cron.controller';

// AiModule import is safe (it depends only on AuthModule — no path back to
// Shopify). The auto-order worker is reached from BotsModule via the `ai-order`
// job queue, NOT a module import, so no BotsModule↔InboxModule↔ShopifyModule
// cycle is created.
@Module({
  imports: [
    InboxModule,
    UsageMeteringModule,
    AiModule,
    TicketsModule,
    EngagementModule,
  ],
  providers: [
    ShopifyService,
    ShopifyOrderSyncService,
    AiAutoOrderService,
    AiAgentService,
  ],
  // CouriersModule consumes ShopifyService.processNotify to raise the
  // `address_issue` customer notification, and ShopifyOrderSyncService to read
  // the orders mirror for the fulfilment queue. One-directional — ShopifyModule
  // does not import CouriersModule, so no DI cycle.
  exports: [ShopifyService, ShopifyOrderSyncService],
  controllers: [
    ShopifyController,
    SettingsShopifyController,
    ShopifyTenantWebhookController,
    ShopifyOrdersController,
    ShopifyCronController,
  ],
})
export class ShopifyModule {}
