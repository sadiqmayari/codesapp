import { Module } from '@nestjs/common';
import { MediaCleanupController } from './media-cleanup.controller';
import { JobMaintenanceController } from './job-maintenance.controller';
import { CronMaintenanceService } from './cron-maintenance.service';

@Module({
  controllers: [MediaCleanupController, JobMaintenanceController],
  providers: [CronMaintenanceService],
})
export class CronModule {}
