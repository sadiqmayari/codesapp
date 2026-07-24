import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
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
import { LoadsheetService } from './loadsheet.service';
import { ShipmentsController } from './shipments.controller';
import { SettingsCouriersController } from './settings-couriers.controller';
import { CourierWebhookController } from './courier-webhook.controller';

@Module({
  imports: [AiModule],
  providers: [
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
    LoadsheetService,
  ],
  controllers: [
    ShipmentsController,
    SettingsCouriersController,
    CourierWebhookController,
  ],
})
export class CouriersModule {}
