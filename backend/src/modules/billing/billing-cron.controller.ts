import { Controller, Get, UseGuards } from '@nestjs/common';
import { CronGuard } from '../../common/guards/cron.guard';
import { BillingService } from './billing.service';

@Controller('cron/billing')
@UseGuards(CronGuard)
export class BillingCronController {
  constructor(private readonly billing: BillingService) {}

  @Get('auto-invoice')
  autoInvoice() {
    return this.billing.autoInvoiceCron();
  }
}
