import { Controller, Get, Param, Query } from '@nestjs/common';
import { PublicTrackingService } from './public-tracking.service';

/**
 * PUBLIC — no guards. Sits under the global /api prefix:
 *   GET /api/public/track/:slug/:orderId?k=<token>
 * where :orderId is the long numeric Shopify Order id (from the gid) and k is
 * the per-order secret. Any mismatch → 404 (no existence leak). Safe to expose
 * anonymously — the service returns a sanitized DTO only.
 */
@Controller('public/track')
export class PublicTrackingController {
  constructor(private readonly service: PublicTrackingService) {}

  /** Public brand (name + logo) by slug — powers the tracking-page favicon. */
  @Get(':slug/brand')
  getBrand(@Param('slug') slug: string) {
    return this.service.getBrand(slug);
  }

  @Get(':slug/:orderId')
  getOrder(
    @Param('slug') slug: string,
    @Param('orderId') orderId: string,
    @Query('k') k?: string,
  ) {
    return this.service.getOrder(slug, orderId, k);
  }
}
