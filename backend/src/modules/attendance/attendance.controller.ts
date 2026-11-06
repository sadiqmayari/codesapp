import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AttendanceService } from './attendance.service';
import { OverrideAttendanceDto } from './dto/override-attendance.dto';
import { AttendanceSettingsDto } from './dto/attendance-settings.dto';

type JwtUser = { userId: number; companyId: number; role: string };

// Accept either a plain YYYY-MM-DD or a full ISO datetime (date-period.ts sends
// UTC ISO) → the tenant-local day boundary is enforced in the service; here we
// just want the calendar date portion.
const dayStr = (v: string | undefined, fallback: string) =>
  v ? v.slice(0, 10) : fallback;

function defaultFrom(days: number): string {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().slice(0, 10);
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

@Controller('attendance')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  // ── self-service (every active member) ──────────────────────────────────
  @Get('me/today')
  myToday(@CurrentUser() user: JwtUser) {
    return this.attendance.myToday(user.companyId, user.userId);
  }

  @Post('check-in')
  checkIn(@CurrentUser() user: JwtUser) {
    return this.attendance.checkIn(user.companyId, user.userId);
  }

  @Post('check-out')
  checkOut(@CurrentUser() user: JwtUser) {
    return this.attendance.checkOut(user.companyId, user.userId);
  }

  @Get('me')
  myHistory(
    @CurrentUser() user: JwtUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.attendance.myHistory(
      user.companyId,
      user.userId,
      dayStr(from, defaultFrom(30)),
      dayStr(to, today()),
    );
  }

  // ── settings (owner/admin) ───────────────────────────────────────────────
  @Get('settings')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  getSettings(@CurrentUser() user: JwtUser) {
    return this.attendance.getSettings(user.companyId);
  }

  @Patch('settings')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  setSettings(@CurrentUser() user: JwtUser, @Body() dto: AttendanceSettingsDto) {
    return this.attendance.setSettings(user.companyId, dto);
  }

  // ── admin report (owner/admin). Static routes BEFORE the :userId param. ──
  @Get('report')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  report(
    @CurrentUser() user: JwtUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.attendance.report(
      user.companyId,
      dayStr(from, defaultFrom(6)),
      dayStr(to, today()),
    );
  }

  @Get('report/export')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  async reportExport(
    @CurrentUser() user: JwtUser,
    @Res() res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const csv = await this.attendance.reportCsv(
      user.companyId,
      dayStr(from, defaultFrom(6)),
      dayStr(to, today()),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance.csv"');
    res.send(csv);
  }

  @Get('summary')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  summary(@CurrentUser() user: JwtUser, @Query('month') month?: string) {
    return this.attendance.summary(user.companyId, month || today().slice(0, 7));
  }

  @Patch(':userId/:date')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  override(
    @CurrentUser() user: JwtUser,
    @Param('userId', ParseIntPipe) userId: number,
    @Param('date') date: string,
    @Body() dto: OverrideAttendanceDto,
  ) {
    return this.attendance.override(user.companyId, user.userId, userId, date, dto);
  }
}
