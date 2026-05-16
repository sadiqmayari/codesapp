import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { UsageMeteringService } from './usage-metering.service';

@Module({
  imports: [BillingModule],
  providers: [UsageMeteringService],
  exports: [UsageMeteringService],
})
export class UsageMeteringModule {}
