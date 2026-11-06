import { Controller, Get, UseGuards } from '@nestjs/common';
import { CronGuard } from '../../common/guards/cron.guard';
import { AttendanceService } from './attendance.service';

/**
 * Nightly attendance sweep. Excluded from the /api prefix (like every /cron
 * route) and guarded by the X-Cron-Secret. For each company it marks no-show
 * members Absent and flags check-ins with no check-out as missed-checkout, for
 * that tenant's most-recently-completed local day. Idempotent — hit it daily
 * from the external scheduler.
 */
@Controller('cron/attendance')
@UseGuards(CronGuard)
export class AttendanceCronController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get('daily-sweep')
  dailySweep() {
    return this.attendance.dailySweep();
  }
}
