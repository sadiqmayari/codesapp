import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { BillingController } from './billing.controller';
import { BillingSuperAdminController } from './billing-super-admin.controller';
import { BillingCronController } from './billing-cron.controller';
import { BillingService } from './billing.service';
import { InvoiceGeneratorService } from './invoice-generator.service';
import { LimitWarningService } from './limit-warning.service';

@Module({
  imports: [AuthModule, WebhooksModule],
  controllers: [
    BillingController,
    BillingSuperAdminController,
    BillingCronController,
  ],
  providers: [BillingService, InvoiceGeneratorService, LimitWarningService],
  exports: [LimitWarningService],
})
export class BillingModule {}
