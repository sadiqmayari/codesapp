import { Module } from '@nestjs/common';
import { ShopifyModule } from '../integrations/shopify/shopify.module';
import { PayfastSettlementParser } from './payfast/payfast-settlement.parser';
import { PayfastSettlementService } from './payfast/payfast-settlement.service';
import { PayfastSettlementController } from './payfast/payfast-settlement.controller';

/**
 * Payment-gateway settlement reconciliation (the prepaid/online counterpart of
 * the courier COD invoices). PayFast today; a second gateway is a new parser +
 * service alongside these. PrismaService / MediaService / JobQueueService come
 * from the global CommonModule; ShopifyService (order resolution + backfill)
 * from ShopifyModule.
 */
@Module({
  imports: [ShopifyModule],
  providers: [PayfastSettlementParser, PayfastSettlementService],
  controllers: [PayfastSettlementController],
})
export class PaymentsModule {}
