import { Module } from '@nestjs/common';
import { MediaCleanupController } from './media-cleanup.controller';
import { JobMaintenanceController } from './job-maintenance.controller';
import { EngagementCronController } from './engagement-cron.controller';
import { HandoffCronController } from './handoff-cron.controller';
import { CronMaintenanceService } from './cron-maintenance.service';
import { EngagementModule } from '../engagement/engagement.module';

@Module({
  imports: [EngagementModule],
  controllers: [
    MediaCleanupController,
    JobMaintenanceController,
    EngagementCronController,
    HandoffCronController,
  ],
  providers: [CronMaintenanceService],
})
export class CronModule {}
