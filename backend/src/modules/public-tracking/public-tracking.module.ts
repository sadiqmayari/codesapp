import { Module } from '@nestjs/common';
import { CouriersModule } from '../couriers/couriers.module';
import { ShopifyModule } from '../integrations/shopify/shopify.module';
import { WorkspaceModule } from '../workspace/workspace.module';
import { PublicTrackingController } from './public-tracking.controller';
import { PublicTrackingService } from './public-tracking.service';

/**
 * Branded public per-order tracking page (no auth; token-gated). Imports
 * CouriersModule for ShipmentService (tracking timeline), ShopifyModule for
 * product thumbnails (getVariantImages), and WorkspaceModule for the tenant's
 * WhatsApp display number (contact/call buttons). CacheService + PrismaService
 * come from the @Global CommonModule. Nothing imports this module (it's a leaf)
 * so these one-way imports introduce no DI cycle.
 */
@Module({
  imports: [CouriersModule, ShopifyModule, WorkspaceModule],
  controllers: [PublicTrackingController],
  providers: [PublicTrackingService],
})
export class PublicTrackingModule {}
