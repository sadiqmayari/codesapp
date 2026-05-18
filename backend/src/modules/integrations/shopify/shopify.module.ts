import { Module } from '@nestjs/common';
import { InboxModule } from '../../inbox/inbox.module';
import { UsageMeteringModule } from '../../usage-metering/usage-metering.module';
import { ShopifyService } from './shopify.service';
import { ShopifyController } from './shopify.controller';
import { SettingsShopifyController } from './settings-shopify.controller';
import { ShopifyTenantWebhookController } from './shopify-tenant-webhook.controller';

@Module({
  imports: [InboxModule, UsageMeteringModule],
  providers: [ShopifyService],
  controllers: [
    ShopifyController,
    SettingsShopifyController,
    ShopifyTenantWebhookController,
  ],
})
export class ShopifyModule {}
