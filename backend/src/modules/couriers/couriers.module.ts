import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ShopifyModule } from '../integrations/shopify/shopify.module';
import { AddressIssueNotifier } from './address-issue-notifier.service';
import { TraxAdapter } from './adapters/trax.adapter';
import { LeopardsAdapter } from './adapters/leopards.adapter';
import { PostexAdapter } from './adapters/postex.adapter';
import { RocketAdapter } from './adapters/rocket.adapter';
import { MnpAdapter } from './adapters/mnp.adapter';
import { CourierRegistryService } from './courier-registry.service';
import { CityMappingService } from './city-mapping.service';
import { CityCanonicalizerService } from './city-canonicalizer.service';
import { ShopifyFulfillmentClient } from './shopify-fulfillment-client.service';
import { AddressQualityService } from './address-quality.service';
import { ShipmentService } from './shipment.service';
import { ShipmentTrackingService } from './shipment-tracking.service';
import { CourierStatusSyncService } from './courier-status-sync.service';
import { CourierOpsService } from './courier-ops.service';
import { LoadsheetService } from './loadsheet.service';
import { RocketInvoiceParser } from './invoices/rocket-invoice.parser';
import { PostexInvoiceParser } from './invoices/postex-invoice.parser';
import { TraxInvoiceParser } from './invoices/trax-invoice.parser';
import { LeopardsInvoiceParser } from './invoices/leopards-invoice.parser';
import { CourierInvoiceRegistry } from './invoices/courier-invoice.registry';
import { CourierInvoiceService } from './invoices/courier-invoice.service';
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
    MnpAdapter,
    CourierRegistryService,
    CityMappingService,
    CityCanonicalizerService,
    ShopifyFulfillmentClient,
    AddressQualityService,
    ShipmentService,
    ShipmentTrackingService,
    CourierStatusSyncService,
    CourierOpsService,
    LoadsheetService,
    RocketInvoiceParser,
    PostexInvoiceParser,
    TraxInvoiceParser,
    LeopardsInvoiceParser,
    CourierInvoiceRegistry,
    CourierInvoiceService,
  ],
  controllers: [
    ShipmentsController,
    SettingsCouriersController,
    CourierWebhookController,
    CourierCronController,
  ],
  exports: [ShipmentService],
})
export class CouriersModule {}
