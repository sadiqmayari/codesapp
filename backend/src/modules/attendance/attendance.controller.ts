import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { clientIp } from '../../common/utils/ip-match';
import { AttendanceService } from './attendance.service';
import { OverrideAttendanceDto } from './dto/override-attendance.dto';
import { AttendanceSettingsDto } from './dto/attendance-settings.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { CorrectionRequestDto, LeaveRequestDto, ReviewLeaveDto } from './dto/leave.dto';
import { AdjustmentDto, HolidayDto } from './dto/payroll.dto';

type JwtUser = { userId: number; companyId: number; role: string };
const actor = (u: JwtUser) => ({ userId: u.userId, role: u.role });

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
  checkIn(@CurrentUser() user: JwtUser, @Req() req: Request) {
    return this.attendance.checkIn(user.companyId, user.userId, clientIp(req));
  }

  @Post('check-out')
  checkOut(@CurrentUser() user: JwtUser, @Req() req: Request) {
    return this.attendance.checkOut(user.companyId, user.userId, clientIp(req));
  }

  @Get('me/payslips')
  myPayslips(@CurrentUser() user: JwtUser) {
    return this.attendance.myPayslips(user.companyId, user.userId);
  }

  @Get('me')
  async myHistory(@CurrentUser() user: JwtUser, @Query('from') from?: string, @Query('to') to?: string) {
    const [f, t] = await this.attendance.dayRange(user.companyId, from, to, 30);
    return this.attendance.myHistory(user.companyId, user.userId, f, t);
  }

  // ── leave + correction requests ─────────────────────────────────────────
  @Post('leave')
  requestLeave(@CurrentUser() user: JwtUser, @Body() dto: LeaveRequestDto) {
    return this.attendance.requestLeave(user.companyId, user.userId, dto);
  }

  @Post('corrections')
  requestCorrection(@CurrentUser() user: JwtUser, @Body() dto: CorrectionRequestDto) {
    return this.attendance.requestCorrection(user.companyId, user.userId, dto);
  }

  @Get('leave/mine')
  myLeave(@CurrentUser() user: JwtUser) {
    return this.attendance.myLeave(user.companyId, user.userId);
  }

  @Delete('leave/mine/:id')
  cancelMine(@CurrentUser() user: JwtUser, @Param('id', ParseIntPipe) id: number) {
    return this.attendance.cancelMyRequest(user.companyId, user.userId, id);
  }

  @Get('leave')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  listLeave(@CurrentUser() user: JwtUser, @Query('status') status?: string) {
    return this.attendance.listLeave(user.companyId, status);
  }

  @Patch('leave/:id')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  reviewLeave(@CurrentUser() user: JwtUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ReviewLeaveDto) {
    return this.attendance.reviewLeave(user.companyId, actor(user), id, dto);
  }

  // ── settings + calendar + per-member config (owner/admin) ─────────────────
  @Get('settings')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  getSettings(@CurrentUser() user: JwtUser, @Req() req: Request) {
    return this.attendance.getSettings(user.companyId, clientIp(req));
  }

  @Patch('settings')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  setSettings(@CurrentUser() user: JwtUser, @Body() dto: AttendanceSettingsDto) {
    return this.attendance.setSettings(user.companyId, dto);
  }

  @Get('holidays')
  holidays(@CurrentUser() user: JwtUser, @Query('year') year?: string) {
    return this.attendance.listHolidays(user.companyId, year);
  }

  @Post('holidays')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  addHoliday(@CurrentUser() user: JwtUser, @Body() dto: HolidayDto) {
    return this.attendance.addHoliday(user.companyId, dto);
  }

  @Delete('holidays/:id')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  deleteHoliday(@CurrentUser() user: JwtUser, @Param('id', ParseIntPipe) id: number) {
    return this.attendance.deleteHoliday(user.companyId, id);
  }

  @Get('members')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  members(@CurrentUser() user: JwtUser) {
    return this.attendance.listMembers(user.companyId);
  }

  @Patch('members/:userId')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  updateMember(@CurrentUser() user: JwtUser, @Param('userId', ParseIntPipe) userId: number, @Body() dto: UpdateMemberDto) {
    return this.attendance.updateMember(user.companyId, actor(user), userId, dto);
  }

  // ── admin report (owner/admin). Static routes BEFORE the :userId param. ──
  @Get('report')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  async report(@CurrentUser() user: JwtUser, @Query('from') from?: string, @Query('to') to?: string) {
    const [f, t] = await this.attendance.dayRange(user.companyId, from, to, 6);
    return this.attendance.report(user.companyId, f, t);
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
    const [f, t] = await this.attendance.dayRange(user.companyId, from, to, 6);
    const csv = await this.attendance.reportCsv(user.companyId, f, t);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-${f}-to-${t}.csv"`);
    res.send(csv);
  }

  @Get('summary')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  async summary(@CurrentUser() user: JwtUser, @Query('month') month?: string) {
    return this.attendance.summary(user.companyId, await this.attendance.monthOrCurrent(user.companyId, month));
  }

  @Get('today-summary')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  todaySummary(@CurrentUser() user: JwtUser) {
    return this.attendance.todaySummary(user.companyId);
  }

  @Get('today-board')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  todayBoard(@CurrentUser() user: JwtUser) {
    return this.attendance.todayBoard(user.companyId);
  }

  // ── payroll (owner/admin) ─────────────────────────────────────────────────
  @Get('payroll')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  async payroll(@CurrentUser() user: JwtUser, @Query('month') month?: string) {
    return this.attendance.payroll(user.companyId, await this.attendance.monthOrCurrent(user.companyId, month));
  }

  @Get('payroll/export')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  async payrollExport(@CurrentUser() user: JwtUser, @Res() res: Response, @Query('month') month?: string) {
    const m = await this.attendance.monthOrCurrent(user.companyId, month);
    const csv = await this.attendance.payrollCsv(user.companyId, m);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payroll-${m}.csv"`);
    res.send(csv);
  }

  @Post('payroll/:month/approve')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  approve(@CurrentUser() user: JwtUser, @Param('month') month: string) {
    return this.attendance.approveRun(user.companyId, user.userId, month);
  }

  @Post('payroll/:month/paid')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  paid(@CurrentUser() user: JwtUser, @Param('month') month: string) {
    return this.attendance.markRunPaid(user.companyId, user.userId, month);
  }

  @Post('payroll/:month/reopen')
  @UseGuards(RolesGuard)
  @Roles('owner')
  reopen(@CurrentUser() user: JwtUser, @Param('month') month: string) {
    return this.attendance.reopenRun(user.companyId, actor(user), month);
  }

  @Get('adjustments')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  async adjustments(@CurrentUser() user: JwtUser, @Query('month') month?: string) {
    return this.attendance.listAdjustments(user.companyId, await this.attendance.monthOrCurrent(user.companyId, month));
  }

  @Post('adjustments')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  addAdjustment(@CurrentUser() user: JwtUser, @Body() dto: AdjustmentDto) {
    return this.attendance.addAdjustment(user.companyId, actor(user), dto);
  }

  @Delete('adjustments/:id')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  deleteAdjustment(@CurrentUser() user: JwtUser, @Param('id', ParseIntPipe) id: number) {
    return this.attendance.deleteAdjustment(user.companyId, id);
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
    return this.attendance.override(user.companyId, actor(user), userId, date, dto);
  }
}
