import { Controller, Get, UseGuards } from '@nestjs/common';
import { CronGuard } from '../../common/guards/cron.guard';
import { AdSyncService } from './services/ad-sync.service';

/**
 * External-scheduler safety net for the in-process ad sync (both routes are
 * gated by each account's cadence, so hitting them often is harmless).
 * `/cron/meta-ads/sync-spend` is the pre-Growth URL still in the VPS crontab.
 */
@Controller('cron')
@UseGuards(CronGuard)
export class GrowthCronController {
  constructor(private readonly sync: AdSyncService) {}

  @Get('growth/sync')
  syncGrowth() {
    return this.sync.syncDue();
  }

  @Get('meta-ads/sync-spend')
  syncLegacy() {
    return this.sync.syncDue();
  }
}
