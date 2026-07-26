import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ShopifyModule } from '../integrations/shopify/shopify.module';
import { AddressIssueNotifier } from './address-issue-notifier.service';
import { TraxAdapter } from './adapters/trax.adapter';
import { LeopardsAdapter } from './adapters/leopards.adapter';
import { PostexAdapter } from './adapters/postex.adapter';
import { RocketAdapter } from './adapters/rocket.adapter';
import { CourierRegistryService } from './courier-registry.service';
import { CityMappingService } from './city-mapping.service';
import { ShopifyFulfillmentClient } from './shopify-fulfillment-client.service';
import { AddressQualityService } from './address-quality.service';
import { ShipmentService } from './shipment.service';
import { ShipmentTrackingService } from './shipment-tracking.service';
import { CourierStatusSyncService } from './courier-status-sync.service';
import { CourierOpsService } from './courier-ops.service';
import { LoadsheetService } from './loadsheet.service';
import { ShipmentsController } from './shipments.controller';
import { SettingsCouriersController } from './settings-couriers.controller';
import { CourierWebhookController } from './courier-webhook.controller';
import { CourierCronController } from './courier-cron.controller';

@Module({
  imports: [AiModule, ShopifyModule],
  providers: [
    AddressIssueNotifier,
    TraxAdapter,
    LeopardsAdapter,
    PostexAdapter,
    RocketAdapter,
    CourierRegistryService,
    CityMappingService,
    ShopifyFulfillmentClient,
    AddressQualityService,
    ShipmentService,
    ShipmentTrackingService,
    CourierStatusSyncService,
    CourierOpsService,
    LoadsheetService,
  ],
  controllers: [
    ShipmentsController,
    SettingsCouriersController,
    CourierWebhookController,
    CourierCronController,
  ],
})
export class CouriersModule {}
