import { Module } from '@nestjs/common';
import { MediaCleanupController } from './media-cleanup.controller';
import { JobMaintenanceController } from './job-maintenance.controller';
import { QueueHealthController } from './queue-health.controller';
import { QueueHealthService } from './queue-health.service';
import { CronMaintenanceService } from './cron-maintenance.service';

@Module({
  controllers: [
    MediaCleanupController,
    JobMaintenanceController,
    QueueHealthController,
  ],
  providers: [CronMaintenanceService, QueueHealthService],
})
export class CronModule {}
