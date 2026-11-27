import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InboxModule } from '../inbox/inbox.module';
import { CommissionsModule } from '../commissions/commissions.module';
import { AttendanceController } from './attendance.controller';
import { AttendanceCronController } from './attendance-cron.controller';
import { AttendanceService } from './attendance.service';
import { AttendanceTickService } from './attendance-tick.service';

@Module({
  imports: [AuthModule, InboxModule, CommissionsModule],
  controllers: [AttendanceController, AttendanceCronController],
  providers: [AttendanceService, AttendanceTickService],
})
export class AttendanceModule {}
