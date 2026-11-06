import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InboxModule } from '../inbox/inbox.module';
import { AttendanceController } from './attendance.controller';
import { AttendanceCronController } from './attendance-cron.controller';
import { AttendanceService } from './attendance.service';

@Module({
  imports: [AuthModule, InboxModule],
  controllers: [AttendanceController, AttendanceCronController],
  providers: [AttendanceService],
})
export class AttendanceModule {}
