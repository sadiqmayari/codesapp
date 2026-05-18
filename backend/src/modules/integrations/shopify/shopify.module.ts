import { Module } from '@nestjs/common';
import { ShopifyService } from './shopify.service';
import { ShopifyController } from './shopify.controller';
import { SettingsShopifyController } from './settings-shopify.controller';
import { ShopifyTenantWebhookController } from './shopify-tenant-webhook.controller';

@Module({
  providers: [ShopifyService],
  controllers: [
    ShopifyController,
    SettingsShopifyController,
    ShopifyTenantWebhookController,
  ],
})
export class ShopifyModule {}
