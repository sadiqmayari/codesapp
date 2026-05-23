import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
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
    // CYCLE WARNING — DO NOT change to a top-level `import { InboxModule }`.
    //
    // The dependency chain is:
    //   BillingModule → InboxModule → UsageMeteringModule → BillingModule
    //
    // forwardRef() defers the *Nest DI* resolution but NOT the JS `import`
    // statement. A top-level import here makes the file-load chain cycle:
    // when usage-metering.module.ts pulls billing.module.ts, which pulls
    // inbox.module.ts, which pulls usage-metering.module.ts mid-evaluation,
    // the latter's export is still `undefined` → boot fails with
    //   "module at index [1] of the InboxModule imports array is undefined"
    //   (see ERRORS.md).
    //
    // The require() below resolves lazily AFTER all module files have loaded,
    // breaking the file-eval cycle while still letting LimitNotifierService
    // inject InboxGateway through standard DI.
    forwardRef(() =>
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../inbox/inbox.module').InboxModule,
    ),
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
