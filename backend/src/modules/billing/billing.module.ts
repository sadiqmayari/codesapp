import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { InboxModule } from '../inbox/inbox.module';
import { BillingController } from './billing.controller';
import { BillingSuperAdminController } from './billing-super-admin.controller';
import { BillingCronController } from './billing-cron.controller';
import { BillingAccountController } from './billing-account.controller';
import { BillingService } from './billing.service';
import { InvoiceGeneratorService } from './invoice-generator.service';
import { LimitWarningService } from './limit-warning.service';
import { LimitNotifierService } from './limit-notifier.service';

@Module({
  imports: [
    AuthModule,
    WebhooksModule,
    // forwardRef breaks the cycle:
    //   BillingModule → InboxModule → UsageMeteringModule → BillingModule.
    // We need InboxGateway here for LimitNotifierService's `usage.warning`
    // socket emit; the gateway has no compile-time dependency back into
    // BillingModule so the runtime resolution is safe.
    forwardRef(() => InboxModule),
  ],
  controllers: [
    BillingController,
    BillingSuperAdminController,
    BillingCronController,
    BillingAccountController,
  ],
  providers: [
    BillingService,
    InvoiceGeneratorService,
    LimitWarningService,
    LimitNotifierService,
  ],
  exports: [LimitWarningService, LimitNotifierService],
})
export class BillingModule {}
