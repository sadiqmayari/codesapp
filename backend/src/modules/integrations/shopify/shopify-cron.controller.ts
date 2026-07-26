import { Controller, Get, UseGuards } from '@nestjs/common';
import { CronGuard } from '../../../common/guards/cron.guard';
import { ShopifyOrderSyncService } from './shopify-order-sync.service';

/**
 * Periodic Shopify-orders reconcile. Excluded from the /api prefix (like every
 * /cron route) and guarded by the X-Cron-Secret. Enqueues one background
 * reconcile per company with Shopify connected — closes the drift where an
 * order archived/cancelled directly in Shopify never reached the mirror
 * (the store only subscribes orders/create + fulfillments/*, not orders/updated).
 */
@Controller('cron/shopify')
@UseGuards(CronGuard)
export class ShopifyCronController {
  constructor(private readonly orderSync: ShopifyOrderSyncService) {}

  @Get('reconcile-orders')
  reconcileOrders() {
    return this.orderSync.reconcileAllCompanies();
  }
}
