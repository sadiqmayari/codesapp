import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

/**
 * Inventory module — a local mirror of the Shopify catalogue enriched with
 * CodesApp-only fields (item code, alias, reorder level, cost) + two-way stock
 * sync. AuthModule provides the JWT strategy/guard; Prisma / FeatureService /
 * JobQueueService come from the @Global CommonModule. Shopify I/O (sync, push,
 * return-restock) runs on the `shopify` job queue in ShopifyService, so this is
 * a leaf module with no commerce-module import (no DI cycle).
 */
@Module({
  imports: [AuthModule],
  controllers: [InventoryController],
  providers: [InventoryService],
})
export class InventoryModule {}
