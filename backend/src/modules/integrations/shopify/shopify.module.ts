import { Module } from '@nestjs/common';
import { ShopifyService } from './shopify.service';
import { ShopifyController } from './shopify.controller';
import { SettingsShopifyController } from './settings-shopify.controller';

@Module({
  providers: [ShopifyService],
  controllers: [ShopifyController, SettingsShopifyController],
})
export class ShopifyModule {}
