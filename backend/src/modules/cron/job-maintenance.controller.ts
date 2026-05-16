import { Controller, Get, UseGuards } from '@nestjs/common';
import { CronGuard } from '../../common/guards/cron.guard';
import { CronMaintenanceService } from './cron-maintenance.service';

@Controller('cron/jobs')
@UseGuards(CronGuard)
export class JobMaintenanceController {
  constructor(private readonly maintenance: CronMaintenanceService) {}

  @Get('cleanup-orphans')
  cleanupOrphans() {
    return this.maintenance.cleanupOrphans();
  }

  @Get('purge-old')
  purgeOld() {
    return this.maintenance.purgeOldJobs();
  }
}
