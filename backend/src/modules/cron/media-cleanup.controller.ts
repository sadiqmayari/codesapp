import { Controller, Get, UseGuards } from '@nestjs/common';
import { CronGuard } from '../../common/guards/cron.guard';
import { CronMaintenanceService } from './cron-maintenance.service';

@Controller('cron')
@UseGuards(CronGuard)
export class MediaCleanupController {
  constructor(private readonly maintenance: CronMaintenanceService) {}

  @Get('cleanup-media')
  cleanupMedia() {
    return this.maintenance.cleanupMedia();
  }
}
