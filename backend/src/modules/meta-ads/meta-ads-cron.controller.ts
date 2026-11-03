import { Controller, Get, UseGuards } from '@nestjs/common';
import { CronGuard } from '../../common/guards/cron.guard';
import { MetaAdsSyncService } from './meta-ads-sync.service';

/**
 * Daily Meta Ads spend sync. Excluded from the /api prefix (like every /cron
 * route) and guarded by the X-Cron-Secret. Enqueues one background spend pull
 * per company that has an ad account connected. Hit this daily from the
 * external scheduler.
 */
@Controller('cron/meta-ads')
@UseGuards(CronGuard)
export class MetaAdsCronController {
  constructor(private readonly sync: MetaAdsSyncService) {}

  @Get('sync-spend')
  syncSpend() {
    return this.sync.syncAllCompanies();
  }
}
