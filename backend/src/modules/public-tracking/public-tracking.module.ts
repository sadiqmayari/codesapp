import { Module } from '@nestjs/common';
import { CouriersModule } from '../couriers/couriers.module';
import { PublicTrackingController } from './public-tracking.controller';
import { PublicTrackingService } from './public-tracking.service';

/**
 * Branded public per-order tracking page (no auth; token-gated). Imports
 * CouriersModule for ShipmentService (tracking timeline). CacheService +
 * PrismaService come from the @Global CommonModule.
 */
@Module({
  imports: [CouriersModule],
  controllers: [PublicTrackingController],
  providers: [PublicTrackingService],
})
export class PublicTrackingModule {}
