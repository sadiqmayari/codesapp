import { Controller, Get, UseGuards } from '@nestjs/common';
import { CronGuard } from '../../common/guards/cron.guard';
import { CourierStatusSyncService } from './courier-status-sync.service';

/**
 * Periodic courier status sync. Excluded from the /api prefix (like every
 * /cron route) and guarded by the X-Cron-Secret. Enqueues one background sync
 * job per company that has active courier credentials.
 */
@Controller('cron/couriers')
@UseGuards(CronGuard)
export class CourierCronController {
  constructor(private readonly statusSync: CourierStatusSyncService) {}

  @Get('sync-status')
  syncStatus() {
    return this.statusSync.syncAllCompanies();
  }
}
