import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { InboxGateway } from '../inbox/inbox.gateway';
import { OfficeNetwork, isValidIpEntry, matchOfficeNetwork, parseOfficeNetworks } from '../../common/utils/ip-match';
import { WorkHoursLockService } from '../../common/services/work-hours-lock.service';
import { CommissionsService } from '../commissions/commissions.service';
import {
  AttendanceStatusValue,
  OverrideAttendanceDto,
} from './dto/override-attendance.dto';
import { AttendanceSettingsDto } from './dto/attendance-settings.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { CorrectionRequestDto, LeaveRequestDto, ReviewLeaveDto } from './dto/leave.dto';
import { AdjustmentDto, HolidayDto } from './dto/payroll.dto';
import { Allowance, PayrollPolicy, resolveAllowances, resolvePolicy } from './payroll';
import { DEFAULT_LOCK_BUFFER_MIN } from './work-lock';
import { Payslip, PayslipRecord, computePayslip, isAdditiveAdjustment } from './payroll-math';
import {
  DEFAULT_REQUIRED_MINUTES,
  DEFAULT_SHIFT_LENGTH_MIN,
  MONTH_RE,
  autoEarnsOvertime,
  isAutoSource,
  WorkCalendar,
  addDays,
  dateCol,
  dateRange,
  dayKind,
  isOvernight,
  isValidDay,
  localParts,
  localTimeToInstant,
  minutesSinceShiftStart,
  minutesToHHMM,
  monthBounds,
  resolveWeeklyOff,
  shiftEndInstant,
  shiftMinutes,
  toMinutes,
  workDayFor,
} from './schedule';
import { FeatureService } from '../../common/services/feature.service';

const DEFAULT_WORK_START = '09:30';
const DEFAULT_CHECKIN_WINDOW_MIN = 150; // 2.5h after shift start (09:30 → 12:00)
const EARLY_CHECKIN_MIN = 30; // check-in opens 30 min BEFORE shift start
const OPEN_ROW_MAX_MS = 22 * 3_600_000; // an open day older than this can't be checked out by the member
const MAX_LEAVE_DAYS = 62;
const END_OF_DAY = '23:59';
// Auto-absent went live on 2026-11-21: the sweep never marks earlier days.
const AUTO_ABSENT_FROM = '2026-11-20';

export interface AttendanceCell {
  date: string; // YYYY-MM-DD
  status: AttendanceStatusValue;
  checkInAt: string | null; // ISO
  checkOutAt: string | null; // ISO
  isLate: boolean;
  missedCheckout: boolean;
  checkoutSource: string | null;
  workedMinutes: number | null;
  note: string | null;
  overridden: boolean;
}

export interface DailyGridMember {
  userId: number;
  name: string;
  role: string;
  cells: Record<string, AttendanceCell>;
  offDays: string[];
}

export interface MonthlySummaryRow {
  userId: number;
  name: string;
  role: string;
  flexible: boolean;
  scheduledDays: number;
  present: number;
  absent: number;
  leave: number;
  halfDay: number;
  holiday: number;
  late: number;
  earlyLeaves: number;
  autoClosed: number;
  totalMinutes: number;
  expectedMinutes: number;
  overtimeMinutes: number;
  attendancePct: number;
}

type DbRow = {
  id: number;
  user_id: number;
  work_date: Date;
  status: AttendanceStatusValue;
  check_in_at: Date | null;
  check_out_at: Date | null;
  is_late: boolean;
  missed_checkout: boolean;
  system_marked: boolean;
  checkout_source: string | null;
  last_active_at?: Date | null;
  note: string | null;
  marked_by_user_id: number | null;
};

type MemberRow = {
  id: number;
  name: string;
  role: string;
  status: string;
  created_at: Date;
  attendance_work_start: string | null;
  attendance_work_end: string | null;
  attendance_grace_minutes: number | null;
  attendance_require_office_ip: boolean;
  attendance_exempt_late: boolean;
  attendance_never_late: boolean;
  attendance_lock_after_shift: boolean | null;
  attendance_required_minutes: number | null;
  attendance_weekly_off: unknown;
  joined_on: Date | null;
  left_on: Date | null;
  annual_paid_leave: number | null;
  salary_amount: unknown; // Prisma Decimal | null
  salary_allowances: unknown; // Json | null
  salary_overtime_rate: unknown; // Prisma Decimal | null
};

const MEMBER_SELECT = {
  id: true,
  name: true,
  role: true,
  status: true,
  created_at: true,
  attendance_work_start: true,
  attendance_work_end: true,
  attendance_grace_minutes: true,
  attendance_require_office_ip: true,
  attendance_exempt_late: true,
  attendance_never_late: true,
  attendance_lock_after_shift: true,
  attendance_required_minutes: true,
  attendance_weekly_off: true,
  joined_on: true,
  left_on: true,
  annual_paid_leave: true,
  salary_amount: true,
  salary_allowances: true,
  salary_overtime_rate: true,
} as const;

type Viewer = { userId: number; role: string };

const NOT_TRACKED_ROLES = ['owner', 'super_admin'];
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const isP2002 = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

type CompanyDefaults = {
  tz: string | null;
  start: string;
  end: string | null;
  grace: number;
  officeNetworks: OfficeNetwork[];
  lockAfterShift: boolean;
  lockBufferMin: number;
  policy: PayrollPolicy;
  checkinWindow: number;
  weeklyOff: number[];
  annualPaidLeave: number;
};

@Injectable()
export class AttendanceService {
  private readonly log = new Logger(AttendanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: InboxGateway,
    private readonly commissions: CommissionsService,
    private readonly feature: FeatureService,
    private readonly workLock: WorkHoursLockService,
  ) {}

  // ── company defaults + per-user schedule ──────────────────────────────────
  async companyDefaults(companyId: number): Promise<CompanyDefaults> {
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        timezone: true,
        work_start_time: true,
        work_end_time: true,
        attendance_grace_minutes: true,
        attendance_office_ips: true,
        attendance_payroll_policy: true,
        attendance_checkin_window_minutes: true,
        attendance_weekly_off: true,
        attendance_annual_paid_leave: true,
        attendance_lock_after_shift: true,
        attendance_lock_buffer_min: true,
      },
    });
    return {
      tz: c?.timezone ?? null,
      start: c?.work_start_time || DEFAULT_WORK_START,
      end: c?.work_end_time || null,
      grace: c?.attendance_grace_minutes ?? 0,
      officeNetworks: parseOfficeNetworks(c?.attendance_office_ips),
      lockAfterShift: c?.attendance_lock_after_shift ?? false,
      lockBufferMin: c?.attendance_lock_buffer_min ?? DEFAULT_LOCK_BUFFER_MIN,
      policy: resolvePolicy(c?.attendance_payroll_policy),
      checkinWindow: c?.attendance_checkin_window_minutes ?? DEFAULT_CHECKIN_WINDOW_MIN,
      weeklyOff: resolveWeeklyOff(c?.attendance_weekly_off, [0]),
      annualPaidLeave: c?.attendance_annual_paid_leave ?? 0,
    };
  }

  private schedule(m: MemberRow, co: CompanyDefaults) {
    const start = m.attendance_work_start || co.start;
    const end = m.attendance_work_end || co.end;
    return {
      start,
      end,
      grace: m.attendance_grace_minutes ?? co.grace,
      flexible: m.attendance_exempt_late,
      // Relaxed = fixed shift, never late. Flexible already implies never late.
      neverLate: !m.attendance_exempt_late && m.attendance_never_late,
      lockAfterShift: m.attendance_lock_after_shift ?? co.lockAfterShift,
      requiredMinutes: m.attendance_required_minutes ?? null,
      weeklyOff: m.attendance_weekly_off == null ? co.weeklyOff : resolveWeeklyOff(m.attendance_weekly_off, co.weeklyOff),
      joinedOn: day(m.joined_on) ?? day(m.created_at),
      leftOn: day(m.left_on),
    };
  }

  private async loadMember(companyId: number, userId: number) {
    const u = (await this.prisma.user.findFirst({
      where: { id: userId, company_id: companyId },
      select: MEMBER_SELECT,
    })) as MemberRow | null;
    if (!u) throw new NotFoundException('Team member not found');
    return u;
  }

  /** Effective schedule + flags for one user (per-user overrides → company defaults). */
  private async resolveUser(companyId: number, userId: number) {
    const u = await this.loadMember(companyId, userId);
    const co = await this.companyDefaults(companyId);
    const s = this.schedule(u, co);
    const startMin = toMinutes(s.start);
    // The check-in window is RELATIVE to this user's own shift start: it opens
    // 30 min before and closes `checkinWindow` min after. Flexible staff have none.
    const checkinOpensAt = s.flexible ? '00:00' : minutesToHHMM(startMin - EARLY_CHECKIN_MIN);
    const checkinCutoff = s.flexible ? END_OF_DAY : minutesToHHMM(startMin + co.checkinWindow);
    const effEnd = s.end || minutesToHHMM(startMin + DEFAULT_SHIFT_LENGTH_MIN);
    return {
      ...s,
      tz: co.tz,
      role: u.role,
      name: u.name,
      requireOfficeIp: u.attendance_require_office_ip,
      officeNetworks: co.officeNetworks,
      lockBufferMin: co.lockBufferMin,
      policy: co.policy,
      checkinWindow: co.checkinWindow,
      checkinOpensAt,
      checkinCutoff,
      // Fixed staff: the check-out nudge appears at the shift end. Flexible staff:
      // after their required hours (the client counts from their check-in).
      checkoutOpensAt: s.flexible ? '00:00' : effEnd,
      effEnd,
    };
  }

  private async calendarFor(companyId: number, weeklyOff: number[], from: string, to: string): Promise<WorkCalendar> {
    const hol = await this.prisma.attendanceHoliday.findMany({
      where: { company_id: companyId, date: { gte: dateCol(from), lte: dateCol(to) } },
      select: { date: true },
    });
    return { weeklyOff, holidays: new Set(hol.map((h) => h.date.toISOString().slice(0, 10))) };
  }

  /**
   * Normalise a report/history range to TENANT-LOCAL `YYYY-MM-DD` days. A bare
   * day passes through; a full ISO instant is converted on the company clock.
   * Missing bounds default to `defaultDays` back → today. from > to is swapped;
   * the span is capped at 400 days.
   */
  async dayRange(
    companyId: number,
    from: string | undefined,
    to: string | undefined,
    defaultDays: number,
  ): Promise<[string, string]> {
    const { tz } = await this.companyDefaults(companyId);
    const norm = (v?: string): string | null => {
      if (!v) return null;
      if (isValidDay(v)) return v;
      const t = Date.parse(v);
      return Number.isNaN(t) ? null : localParts(new Date(t), tz).dateStr;
    };
    const t = norm(to) ?? localParts(new Date(), tz).dateStr;
    const f = norm(from) ?? localParts(new Date(Date.now() - defaultDays * 86_400_000), tz).dateStr;
    let [a, b] = f > t ? [t, f] : [f, t];
    if (dateRange(a, b, 401).length > 400) a = addDays(b, -399);
    return [a, b];
  }

  /** Validated `YYYY-MM`, else the current TENANT-LOCAL month. */
  async monthOrCurrent(companyId: number, month?: string): Promise<string> {
    if (month && MONTH_RE.test(month)) return month;
    const { tz } = await this.companyDefaults(companyId);
    return localParts(new Date(), tz).dateStr.slice(0, 7);
  }

  private workedMinutes(row: DbRow): number | null {
    if (!row.check_in_at || !row.check_out_at) return null;
    const diff = row.check_out_at.getTime() - row.check_in_at.getTime();
    return diff > 0 ? Math.round(diff / 60000) : 0;
  }

  private toCell(row: DbRow): AttendanceCell {
    return {
      date: row.work_date.toISOString().slice(0, 10),
      status: row.status,
      checkInAt: row.check_in_at ? row.check_in_at.toISOString() : null,
      checkOutAt: row.check_out_at ? row.check_out_at.toISOString() : null,
      isLate: row.is_late,
      missedCheckout: row.missed_checkout,
      checkoutSource: row.checkout_source ?? null,
      workedMinutes: this.workedMinutes(row),
      note: row.note,
      overridden: row.marked_by_user_id != null && !row.system_marked,
    };
  }

  private assertTracked(role: string) {
    if (NOT_TRACKED_ROLES.includes(role)) {
      throw new ForbiddenException('Owners are not tracked for attendance');
    }
  }

  private assertOnOfficeNetwork(u: { requireOfficeIp: boolean; officeNetworks: OfficeNetwork[] }, ip: string) {
    if (!u.requireOfficeIp || !u.officeNetworks.length) return;
    if (!matchOfficeNetwork(ip, u.officeNetworks)) {
      const names = u.officeNetworks.map((n) => n.label).join(', ');
      throw new ForbiddenException(
        `Check-in only from office WiFi. You're on ${ip || 'an unknown network'}, not one of: ${names}.`,
      );
    }
  }

  /** The member's open day (checked in, not out), if any, within the last 22h. */
  private async openRow(companyId: number, userId: number): Promise<DbRow | null> {
    return (await this.prisma.attendanceRecord.findFirst({
      where: {
        company_id: companyId,
        user_id: userId,
        check_in_at: { not: null, gte: new Date(Date.now() - OPEN_ROW_MAX_MS) },
        check_out_at: null,
      },
      orderBy: { check_in_at: 'desc' },
    })) as DbRow | null;
  }

  // ── self-service ────────────────────────────────────────────────────────
  async myToday(companyId: number, userId: number, ip = '') {
    const u = await this.resolveUser(companyId, userId);
    const now = new Date();
    const open = NOT_TRACKED_ROLES.includes(u.role) ? null : await this.openRow(companyId, userId);
    const workDay = open ? open.work_date.toISOString().slice(0, 10) : workDayFor(now, u.tz, u.start, u.end);
    const row =
      open ??
      ((await this.prisma.attendanceRecord.findFirst({
        where: { company_id: companyId, user_id: userId, work_date: dateCol(workDay) },
      })) as DbRow | null);
    const cal = await this.calendarFor(companyId, u.weeklyOff, workDay, workDay);
    const holiday = cal.holidays.has(workDay)
      ? await this.prisma.attendanceHoliday.findFirst({
          where: { company_id: companyId, date: dateCol(workDay) },
          select: { name: true },
        })
      : null;
    return {
      date: workDay,
      dayKind: dayKind(workDay, cal),
      holidayName: holiday?.name ?? null,
      workStart: u.start,
      workEnd: u.end,
      effectiveEnd: u.effEnd,
      graceMinutes: u.grace,
      checkinOpensAt: u.checkinOpensAt,
      checkinCutoff: u.checkinCutoff,
      checkoutOpensAt: u.checkoutOpensAt,
      exemptLate: u.flexible,
      flexible: u.flexible,
      neverLate: u.neverLate,
      requireOfficeNetwork: u.requireOfficeIp && u.officeNetworks.length > 0,
      onOfficeNetwork: ip ? matchOfficeNetwork(ip, u.officeNetworks) : null,
      lockAfterShift: u.lockAfterShift && !u.flexible,
      appLocksAt: await this.appLocksAt(companyId, userId, u.role),
      requiredMinutes: u.flexible ? u.requiredMinutes ?? DEFAULT_REQUIRED_MINUTES : null,
      excluded: NOT_TRACKED_ROLES.includes(u.role),
      record: row ? this.toCell(row) : null,
    };
  }

  async checkIn(companyId: number, userId: number, ip: string) {
    const u = await this.resolveUser(companyId, userId);
    this.assertTracked(u.role);
    this.assertOnOfficeNetwork(u, ip);

    const now = new Date();
    const open = await this.openRow(companyId, userId);
    if (open) return this.toCell(open); // already in

    const workDay = workDayFor(now, u.tz, u.start, u.end);
    const cal = await this.calendarFor(companyId, u.weeklyOff, workDay, workDay);
    const kind = dayKind(workDay, cal);
    const sinceStart = minutesSinceShiftStart(now, workDay, u.start, u.tz);

    // Fixed staff on a work day may only check in inside their own window.
    if (!u.flexible && kind === 'work') {
      if (sinceStart < -EARLY_CHECKIN_MIN) {
        throw new BadRequestException(`Check-in opens at ${u.checkinOpensAt}.`);
      }
      if (sinceStart > u.checkinWindow) {
        throw new BadRequestException(
          `Check-in closed at ${u.checkinCutoff}. Ask your admin to mark your attendance.`,
        );
      }
    }

    const isLate = !u.flexible && !u.neverLate && kind === 'work' && sinceStart > u.grace;
    const status: AttendanceStatusValue =
      isLate && u.policy.lateMethod === 'half_day' && sinceStart > u.policy.halfDayAfterMin
        ? 'half_day'
        : 'present';

    const where = { company_id: companyId, user_id: userId, work_date: dateCol(workDay) };
    const existing = (await this.prisma.attendanceRecord.findFirst({ where })) as DbRow | null;
    let row: DbRow;
    if (existing) {
      if (existing.check_in_at) {
        if (!existing.check_out_at) return this.toCell(existing);
        throw new ConflictException('You already checked out today. Ask your admin to reopen the day.');
      }
      if ((existing.status === 'leave' || existing.status === 'holiday') && !existing.system_marked) {
        throw new ConflictException('This day is marked as leave. Ask your admin to change it first.');
      }
      if (existing.status === 'leave' && existing.system_marked) {
        throw new ConflictException('You are on approved leave today. Ask your admin to cancel it first.');
      }
      row = (await this.prisma.attendanceRecord.update({
        where: { id: existing.id },
        data: { check_in_at: now, is_late: isLate, status, system_marked: false, marked_by_user_id: null },
      })) as DbRow;
    } else {
      try {
        row = (await this.prisma.attendanceRecord.create({
          data: { ...where, status, check_in_at: now, is_late: isLate },
        })) as DbRow;
      } catch (e) {
        if (!isP2002(e)) throw e;
        row = (await this.prisma.attendanceRecord.findFirst({ where })) as DbRow; // double tap
      }
    }

    this.safeEmit(() => {
      this.gateway.emitToCompany(companyId, 'attendance.changed', { userId, at: now.toISOString() });
      if (isLate) {
        this.gateway.emitToHrAdmins(companyId, 'attendance.late', { userId, name: u.name, at: now.toISOString() });
      }
    });
    return this.toCell(row);
  }

  async checkOut(companyId: number, userId: number, ip: string) {
    const u = await this.resolveUser(companyId, userId);
    this.assertTracked(u.role);
    this.assertOnOfficeNetwork(u, ip);

    const now = new Date();
    const open = await this.openRow(companyId, userId);
    if (!open) {
      const workDay = workDayFor(now, u.tz, u.start, u.end);
      const done = (await this.prisma.attendanceRecord.findFirst({
        where: { company_id: companyId, user_id: userId, work_date: dateCol(workDay), check_out_at: { not: null } },
      })) as DbRow | null;
      if (done) return this.toCell(done); // idempotent: never overwrite an earlier/admin check-out
      throw new BadRequestException('Check in first');
    }
    if (open.check_in_at && now.getTime() - open.check_in_at.getTime() < 60_000) {
      throw new BadRequestException('You just checked in. Wait a minute before checking out.');
    }
    const updated = (await this.prisma.attendanceRecord.update({
      where: { id: open.id },
      data: { check_out_at: now, missed_checkout: false, checkout_source: 'self' },
    })) as DbRow;
    this.safeEmit(() => this.gateway.emitToCompany(companyId, 'attendance.changed', { userId, at: now.toISOString() }));
    return this.toCell(updated);
  }

  /** When the app locks for this member today (ISO), null when no lock applies. */
  private async appLocksAt(companyId: number, userId: number, role: string): Promise<string | null> {
    const st = await this.workLock.state({ id: userId, company_id: companyId, role });
    return st?.locksAt ? st.locksAt.toISOString() : null;
  }

  async myHistory(companyId: number, userId: number, fromStr: string, toStr: string) {
    const u = await this.resolveUser(companyId, userId);
    const rows = (await this.prisma.attendanceRecord.findMany({
      where: { company_id: companyId, user_id: userId, work_date: { gte: dateCol(fromStr), lte: dateCol(toStr) } },
      orderBy: { work_date: 'desc' },
    })) as DbRow[];
    const cal = await this.calendarFor(companyId, u.weeklyOff, fromStr, toStr);
    return {
      from: fromStr,
      to: toStr,
      offDays: dateRange(fromStr, toStr).filter((d) => dayKind(d, cal) !== 'work'),
      rows: rows.map((r) => this.toCell(r)),
    };
  }

  // ── members (tracked, not suspended) ──────────────────────────────────────
  private activeMembers(companyId: number) {
    return this.prisma.user.findMany({
      where: { company_id: companyId, status: { not: 'suspended' }, role: { notIn: NOT_TRACKED_ROLES as never } },
      select: MEMBER_SELECT,
      orderBy: { name: 'asc' },
    }) as Promise<MemberRow[]>;
  }

  /** Members employed at any point in [from,to] — includes people who left mid-period. */
  private payrollMembers(companyId: number, from: string, to: string) {
    return this.prisma.user.findMany({
      where: {
        company_id: companyId,
        role: { notIn: NOT_TRACKED_ROLES as never },
        OR: [{ status: { not: 'suspended' } }, { left_on: { gte: dateCol(from) } }],
        AND: [{ OR: [{ joined_on: null }, { joined_on: { lte: dateCol(to) } }] }],
      },
      select: MEMBER_SELECT,
      orderBy: { name: 'asc' },
    }) as Promise<MemberRow[]>;
  }

  /**
   * HR managers never see or touch the pay of admins, nor their own (the
   * owner manages those). Returns true when `viewer` must not see `target`'s pay.
   */
  private payHidden(viewer: Viewer | undefined, target: { userId: number; role: string }): boolean {
    if (!viewer || viewer.role !== 'hr_manager') return false;
    return target.role === 'admin' || target.userId === viewer.userId;
  }

  /** 403 when an HR manager tries to change an admin's pay. */
  private async assertCanTouchPay(companyId: number, actor: Viewer, userId: number) {
    if (actor.role !== 'hr_manager') return;
    const u = await this.prisma.user.findFirst({ where: { id: userId, company_id: companyId }, select: { role: true } });
    if (u?.role === 'admin') throw new ForbiddenException("HR managers can't change an admin's pay. Ask the owner.");
  }

  async listMembers(companyId: number, viewer?: Viewer) {
    const co = await this.companyDefaults(companyId);
    const members = await this.activeMembers(companyId);
    return members.map((m) => {
      const s = this.schedule(m, co);
      return {
        userId: m.id,
        name: m.name,
        role: m.role,
        workStart: m.attendance_work_start, // override (null = default)
        workEnd: m.attendance_work_end,
        graceMinutes: m.attendance_grace_minutes,
        requireOfficeIp: m.attendance_require_office_ip,
        effectiveStart: s.start,
        effectiveEnd: s.end,
        effectiveGrace: s.grace,
        exemptLate: m.attendance_exempt_late,
        neverLate: s.neverLate,
        lockAfterShift: m.attendance_lock_after_shift,
        effectiveLockAfterShift: s.lockAfterShift && !s.flexible,
        requiredMinutes: m.attendance_required_minutes,
        weeklyOff: m.attendance_weekly_off == null ? null : resolveWeeklyOff(m.attendance_weekly_off, co.weeklyOff),
        effectiveWeeklyOff: s.weeklyOff,
        joinedOn: day(m.joined_on),
        leftOn: day(m.left_on),
        annualPaidLeave: m.annual_paid_leave,
        payHidden: this.payHidden(viewer, { userId: m.id, role: m.role }),
        salaryAmount: this.payHidden(viewer, { userId: m.id, role: m.role }) || m.salary_amount == null ? null : Number(m.salary_amount),
        overtimeRate: this.payHidden(viewer, { userId: m.id, role: m.role }) || m.salary_overtime_rate == null ? null : Number(m.salary_overtime_rate),
        allowances: this.payHidden(viewer, { userId: m.id, role: m.role }) ? [] : resolveAllowances(m.salary_allowances),
      };
    });
  }

  async updateMember(companyId: number, actor: { userId: number; role: string }, userId: number, dto: UpdateMemberDto) {
    const member = await this.prisma.user.findFirst({
      where: { id: userId, company_id: companyId, role: { notIn: NOT_TRACKED_ROLES as never } },
      select: { id: true },
    });
    if (!member) throw new NotFoundException('Team member not found');
    const touchesPay =
      dto.salaryAmount !== undefined || dto.overtimeRate !== undefined || dto.allowances !== undefined;
    if (touchesPay && actor.userId === userId && actor.role !== 'owner') {
      throw new ForbiddenException('You cannot change your own salary. Ask the owner.');
    }
    if (touchesPay) await this.assertCanTouchPay(companyId, actor, userId);
    const data: Record<string, unknown> = {};
    if (dto.workStartTime !== undefined) data.attendance_work_start = dto.workStartTime || null;
    if (dto.workEndTime !== undefined) data.attendance_work_end = dto.workEndTime || null;
    if (dto.graceMinutes !== undefined) data.attendance_grace_minutes = dto.graceMinutes ?? null;
    if (dto.requireOfficeIp !== undefined) data.attendance_require_office_ip = dto.requireOfficeIp;
    if (dto.exemptLate === true && dto.neverLate === true) {
      throw new BadRequestException('Pick one timing mode: Relaxed or Flexible hours.');
    }
    if (dto.exemptLate !== undefined) data.attendance_exempt_late = dto.exemptLate;
    if (dto.neverLate !== undefined) data.attendance_never_late = dto.neverLate;
    // One timing mode at a time: Flexible and Relaxed are exclusive.
    if (dto.exemptLate === true && dto.neverLate === undefined) data.attendance_never_late = false;
    if (dto.neverLate === true && dto.exemptLate === undefined) data.attendance_exempt_late = false;
    if (dto.lockAfterShift !== undefined) data.attendance_lock_after_shift = dto.lockAfterShift;
    if (dto.requiredMinutes !== undefined) data.attendance_required_minutes = dto.requiredMinutes ?? null;
    if (dto.weeklyOff !== undefined)
      data.attendance_weekly_off = dto.weeklyOff == null ? Prisma.DbNull : resolveWeeklyOff(dto.weeklyOff, []);
    if (dto.joinedOn !== undefined) {
      if (dto.joinedOn && !isValidDay(dto.joinedOn)) throw new BadRequestException('joinedOn must be YYYY-MM-DD');
      data.joined_on = dto.joinedOn ? dateCol(dto.joinedOn) : null;
    }
    if (dto.leftOn !== undefined) {
      if (dto.leftOn && !isValidDay(dto.leftOn)) throw new BadRequestException('leftOn must be YYYY-MM-DD');
      data.left_on = dto.leftOn ? dateCol(dto.leftOn) : null;
    }
    if (dto.annualPaidLeave !== undefined) data.annual_paid_leave = dto.annualPaidLeave ?? null;
    if (dto.salaryAmount !== undefined) data.salary_amount = dto.salaryAmount ?? null;
    if (dto.overtimeRate !== undefined) data.salary_overtime_rate = dto.overtimeRate ?? null;
    if (dto.allowances !== undefined) data.salary_allowances = resolveAllowances(dto.allowances);
    await this.prisma.user.update({ where: { id: userId }, data });
    this.workLock.invalidate(companyId);
    return { ok: true };
  }

  // ── admin report ──────────────────────────────────────────────────────────
  private async rowsFor(companyId: number, ids: number[], from: string, to: string) {
    if (!ids.length) return [] as DbRow[];
    return (await this.prisma.attendanceRecord.findMany({
      where: { company_id: companyId, user_id: { in: ids }, work_date: { gte: dateCol(from), lte: dateCol(to) } },
    })) as DbRow[];
  }

  async report(companyId: number, fromStr: string, toStr: string) {
    const co = await this.companyDefaults(companyId);
    const members = await this.activeMembers(companyId);
    const rows = await this.rowsFor(companyId, members.map((m) => m.id), fromStr, toStr);
    const holidays = await this.calendarFor(companyId, [], fromStr, toStr);
    const dates = dateRange(fromStr, toStr);

    const byUser = new Map<number, Record<string, AttendanceCell>>();
    for (const r of rows) {
      const cell = this.toCell(r);
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, {});
      byUser.get(r.user_id)![cell.date] = cell;
    }
    const grid: DailyGridMember[] = members.map((m) => {
      const cal = { weeklyOff: this.schedule(m, co).weeklyOff, holidays: holidays.holidays };
      return {
        userId: m.id,
        name: m.name,
        role: m.role,
        cells: byUser.get(m.id) ?? {},
        offDays: dates.filter((d) => dayKind(d, cal) !== 'work'),
      };
    });
    return {
      from: fromStr,
      to: toStr,
      today: localParts(new Date(), co.tz).dateStr,
      dates,
      holidays: Array.from(holidays.holidays),
      members: grid,
    };
  }

  async summary(companyId: number, month: string) {
    if (!MONTH_RE.test(month)) throw new BadRequestException('month must be YYYY-MM');
    const { from: fromStr, to: toStr } = monthBounds(month);
    const co = await this.companyDefaults(companyId);
    const members = await this.activeMembers(companyId);
    const rows = await this.rowsFor(companyId, members.map((m) => m.id), fromStr, toStr);
    const hol = await this.calendarFor(companyId, [], fromStr, toStr);
    const today = localParts(new Date(), co.tz).dateStr;
    const memberById = new Map(members.map((m) => [m.id, m]));

    const agg = new Map<number, MonthlySummaryRow>();
    for (const m of members) {
      const s = this.schedule(m, co);
      const cal = { weeklyOff: s.weeklyOff, holidays: hol.holidays };
      const lastDay = toStr < today ? toStr : today;
      agg.set(m.id, {
        userId: m.id,
        name: m.name,
        role: m.role,
        flexible: s.flexible,
        scheduledDays: dateRange(fromStr, lastDay).filter((d) => dayKind(d, cal) === 'work').length,
        present: 0,
        absent: 0,
        leave: 0,
        halfDay: 0,
        holiday: 0,
        late: 0,
        earlyLeaves: 0,
        autoClosed: 0,
        totalMinutes: 0,
        expectedMinutes: 0,
        overtimeMinutes: 0,
        attendancePct: 0,
      });
    }
    for (const r of rows) {
      const a = agg.get(r.user_id);
      const m = memberById.get(r.user_id);
      if (!a || !m) continue;
      const s = this.schedule(m, co);
      if (r.status === 'present') a.present += 1;
      else if (r.status === 'absent') a.absent += 1;
      else if (r.status === 'leave') a.leave += 1;
      else if (r.status === 'half_day') a.halfDay += 1;
      else if (r.status === 'holiday') a.holiday += 1;
      if (r.is_late) a.late += 1;
      if (isAutoSource(r.checkout_source)) a.autoClosed += 1;
      const worked = this.workedMinutes(r) ?? 0;
      a.totalMinutes += worked;
      if (r.status !== 'present' && r.status !== 'half_day') continue;
      const perDay = s.flexible ? s.requiredMinutes ?? DEFAULT_REQUIRED_MINUTES : shiftMinutes(s.start, s.end);
      if (perDay == null) continue;
      a.expectedMinutes += perDay;
      if (autoEarnsOvertime(r.checkout_source) && worked > perDay) a.overtimeMinutes += worked - perDay;
      if (r.check_out_at && !s.flexible && s.end && !isAutoSource(r.checkout_source)) {
        const date = r.work_date.toISOString().slice(0, 10);
        if (r.check_out_at < shiftEndInstant(date, s.start, s.end, co.tz)) a.earlyLeaves += 1;
      }
    }
    for (const a of agg.values()) {
      const base = a.scheduledDays || a.present + a.absent + a.leave + a.halfDay;
      a.attendancePct = base ? Math.min(100, Math.round(((a.present + 0.5 * a.halfDay + a.leave) / base) * 100)) : 0;
    }
    return { month, from: fromStr, to: toStr, rows: Array.from(agg.values()) };
  }

  // ── today board ───────────────────────────────────────────────────────────
  async todayBoard(companyId: number) {
    const co = await this.companyDefaults(companyId);
    const now = new Date();
    const today = localParts(now, co.tz).dateStr;
    const yesterday = addDays(today, -1);
    const members = await this.activeMembers(companyId);
    const rows = await this.rowsFor(companyId, members.map((m) => m.id), yesterday, today);
    const hol = await this.calendarFor(companyId, [], today, today);
    const holidayName = hol.holidays.size
      ? (await this.prisma.attendanceHoliday.findFirst({ where: { company_id: companyId, date: dateCol(today) } }))?.name ?? null
      : null;
    const key = (uid: number, d: string) => `${uid}:${d}`;
    const byKey = new Map(rows.map((r) => [key(r.user_id, r.work_date.toISOString().slice(0, 10)), r]));

    const people = members.map((m) => {
      const s = this.schedule(m, co);
      // A night shift that started yesterday is still "today" for the board.
      const openYesterday = byKey.get(key(m.id, yesterday));
      const r =
        openYesterday?.check_in_at && !openYesterday.check_out_at && isOvernight(s.start, s.end)
          ? openYesterday
          : byKey.get(key(m.id, today));
      const autoYesterday = isAutoSource(byKey.get(key(m.id, yesterday))?.checkout_source);
      const kind = dayKind(today, { weeklyOff: s.weeklyOff, holidays: hol.holidays });
      const cutoffPassed =
        !s.flexible && minutesSinceShiftStart(now, today, s.start, co.tz) > co.checkinWindow;
      let lane: 'in' | 'late' | 'out' | 'leave' | 'off' | 'absent' | 'not_in';
      if (r?.check_in_at && !r.check_out_at) lane = r.is_late ? 'late' : 'in';
      else if (r?.check_in_at && r.check_out_at) lane = 'out';
      else if (r?.status === 'leave') lane = 'leave';
      else if (r?.status === 'absent') lane = 'absent';
      else if (r?.status === 'holiday' || kind !== 'work') lane = 'off';
      else lane = cutoffPassed ? 'absent' : 'not_in';
      return {
        userId: m.id,
        name: m.name,
        role: m.role,
        flexible: s.flexible,
        start: s.start,
        end: s.end,
        requiredMinutes: s.flexible ? s.requiredMinutes ?? DEFAULT_REQUIRED_MINUTES : null,
        lane,
        checkInAt: r?.check_in_at?.toISOString() ?? null,
        checkOutAt: r?.check_out_at?.toISOString() ?? null,
        status: r?.status ?? null,
        halfDay: r?.status === 'half_day',
        lateByMin:
          r?.is_late && r.check_in_at
            ? Math.max(0, minutesSinceShiftStart(r.check_in_at, r.work_date.toISOString().slice(0, 10), s.start, co.tz) - s.grace)
            : 0,
        autoClosedYesterday: autoYesterday,
      };
    });
    return { date: today, now: now.toISOString(), holidayName, checkinWindow: co.checkinWindow, people };
  }

  async todaySummary(companyId: number) {
    const b = await this.todayBoard(companyId);
    let present = 0,
      late = 0,
      absent = 0,
      notCheckedIn = 0;
    for (const p of b.people) {
      if (p.lane === 'in' || p.lane === 'late' || p.lane === 'out') {
        present += 1;
        if (p.lane === 'late' || p.lateByMin > 0) late += 1;
      } else if (p.lane === 'absent') absent += 1;
      else if (p.lane === 'not_in') notCheckedIn += 1;
    }
    return { date: b.date, total: b.people.length, present, late, absent, notCheckedIn };
  }

  // ── payroll ───────────────────────────────────────────────────────────────
  private toNum = (v: unknown) => (v == null ? 0 : Number(v));

  /** Compute every member's payslip for a month (live). */
  private async computeMonth(companyId: number, month: string): Promise<{ policy: PayrollPolicy; rows: Payslip[] }> {
    const { from, to } = monthBounds(month);
    const co = await this.companyDefaults(companyId);
    const members = await this.payrollMembers(companyId, from, to);
    const ids = members.map((m) => m.id);
    const [rows, holCal, leaves, adjustments, commission] = await Promise.all([
      this.rowsFor(companyId, ids, from, to),
      this.calendarFor(companyId, [], from, to),
      ids.length
        ? this.prisma.attendanceLeaveRequest.findMany({
            where: {
              company_id: companyId,
              user_id: { in: ids },
              status: 'approved',
              kind: 'leave',
              paid: false,
              from_date: { lte: dateCol(to) },
              to_date: { gte: dateCol(from) },
            },
            select: { user_id: true, from_date: true, to_date: true },
          })
        : [],
      this.prisma.payrollAdjustment.findMany({ where: { company_id: companyId, month } }),
      this.commissions.forPayroll(companyId, month).catch((e) => {
        this.log.warn(`commission compute failed for ${companyId}/${month}: ${(e as Error).message}`);
        return new Map();
      }),
    ]);
    const today = localParts(new Date(), co.tz).dateStr;

    const recByUser = new Map<number, PayslipRecord[]>();
    for (const r of rows) {
      if (!recByUser.has(r.user_id)) recByUser.set(r.user_id, []);
      recByUser.get(r.user_id)!.push({
        date: r.work_date.toISOString().slice(0, 10),
        status: r.status,
        checkInAt: r.check_in_at,
        checkOutAt: r.check_out_at,
        isLate: r.is_late,
        checkoutSource: r.checkout_source,
      });
    }
    const unpaidByUser = new Map<number, Set<string>>();
    for (const l of leaves) {
      const set = unpaidByUser.get(l.user_id) ?? new Set<string>();
      for (const d of dateRange(day(l.from_date)!, day(l.to_date)!)) set.add(d);
      unpaidByUser.set(l.user_id, set);
    }

    const out: Payslip[] = [];
    for (const m of members) {
      const s = this.schedule(m, co);
      const p = computePayslip({
        member: {
          userId: m.id,
          name: m.name,
          role: m.role,
          salary: this.toNum(m.salary_amount),
          allowances: resolveAllowances(m.salary_allowances),
          overtimeRate: m.salary_overtime_rate == null ? null : Number(m.salary_overtime_rate),
          flexible: s.flexible,
          neverLate: s.neverLate,
          start: s.start,
          end: s.end,
          grace: s.grace,
          requiredMinutes: s.requiredMinutes,
          joinedOn: s.joinedOn,
          leftOn: s.leftOn,
        },
        month,
        records: recByUser.get(m.id) ?? [],
        calendar: { weeklyOff: s.weeklyOff, holidays: holCal.holidays },
        unpaidLeaveDays: unpaidByUser.get(m.id) ?? new Set(),
        adjustments: adjustments
          .filter((a) => a.user_id === m.id)
          .map((a) => ({ id: a.id, kind: a.kind, label: a.label, amount: Number(a.amount) })),
        commission: commission.get(m.id) ?? null,
        policy: co.policy,
        tz: co.tz,
        today,
      });
      if (p) out.push(p);
    }
    return { policy: co.policy, rows: out };
  }

  private totalsOf(rows: Payslip[]) {
    const sum = (f: (p: Payslip) => number) => Math.round(rows.reduce((s, p) => s + f(p), 0) * 100) / 100;
    return {
      people: rows.length,
      gross: sum((p) => p.gross),
      deductions: sum((p) => p.deductions),
      commission: sum((p) => p.commission),
      overtime: sum((p) => p.overtimePay),
      net: sum((p) => p.netPayable),
    };
  }

  private runView(run: { id: number; month: string; status: string; approved_at: Date | null; paid_at: Date | null; approved_by_user_id: number | null } | null) {
    return run
      ? {
          id: run.id,
          month: run.month,
          status: run.status,
          approvedAt: run.approved_at?.toISOString() ?? null,
          paidAt: run.paid_at?.toISOString() ?? null,
          approvedByUserId: run.approved_by_user_id,
        }
      : null;
  }

  async payroll(companyId: number, month: string, viewer?: Viewer) {
    const p = await this.payrollAll(companyId, month);
    if (!viewer || viewer.role !== 'hr_manager') return p;
    const rows = p.rows.filter((r) => !this.payHidden(viewer, r));
    return { ...p, rows, hiddenCount: p.rows.length - rows.length, totals: this.totalsOf(rows) };
  }

  private async payrollAll(companyId: number, month: string) {
    if (!MONTH_RE.test(month)) throw new BadRequestException('month must be YYYY-MM');
    const { from, to } = monthBounds(month);
    const run = await this.prisma.payrollRun.findUnique({ where: { company_id_month: { company_id: companyId, month } } });
    if (run && run.status !== 'draft') {
      const lines = await this.prisma.payrollRunLine.findMany({ where: { run_id: run.id }, orderBy: { id: 'asc' } });
      const rows = lines.map((l) => l.snapshot as unknown as Payslip);
      return {
        month,
        from,
        to,
        locked: true,
        policy: resolvePolicy(run.policy_snapshot),
        run: this.runView(run),
        rows,
        totals: this.totalsOf(rows),
      };
    }
    const { policy, rows } = await this.computeMonth(companyId, month);
    return { month, from, to, locked: false, policy, run: this.runView(run), rows, totals: this.totalsOf(rows) };
  }

  async approveRun(companyId: number, actorId: number, month: string, viewer?: Viewer) {
    if (!MONTH_RE.test(month)) throw new BadRequestException('month must be YYYY-MM');
    const existing = await this.prisma.payrollRun.findUnique({ where: { company_id_month: { company_id: companyId, month } } });
    if (existing && existing.status !== 'draft') throw new ConflictException('This month is already approved');
    const { policy, rows } = await this.computeMonth(companyId, month);
    const totals = this.totalsOf(rows);
    await this.prisma.$transaction(async (tx) => {
      const run = existing
        ? await tx.payrollRun.update({
            where: { id: existing.id },
            data: { status: 'approved', approved_by_user_id: actorId, approved_at: new Date(), policy_snapshot: policy as never, totals },
          })
        : await tx.payrollRun.create({
            data: {
              company_id: companyId,
              month,
              status: 'approved',
              created_by_user_id: actorId,
              approved_by_user_id: actorId,
              approved_at: new Date(),
              policy_snapshot: policy as never,
              totals,
            },
          });
      await tx.payrollRunLine.deleteMany({ where: { run_id: run.id } });
      if (rows.length) {
        await tx.payrollRunLine.createMany({
          data: rows.map((p) => ({
            run_id: run.id,
            company_id: companyId,
            user_id: p.userId,
            snapshot: p as never,
            gross: p.gross,
            deductions: p.deductions,
            commission: p.commission,
            net: p.netPayable,
          })),
        });
      }
    });
    return this.payroll(companyId, month, viewer);
  }

  async markRunPaid(companyId: number, actorId: number, month: string, viewer?: Viewer) {
    const run = await this.prisma.payrollRun.findUnique({ where: { company_id_month: { company_id: companyId, month } } });
    if (!run || run.status === 'draft') throw new BadRequestException('Approve the payroll first');
    if (run.status !== 'paid') {
      await this.prisma.payrollRun.update({
        where: { id: run.id },
        data: { status: 'paid', paid_at: new Date(), paid_by_user_id: actorId },
      });
    }
    return this.payroll(companyId, month, viewer);
  }

  async reopenRun(companyId: number, actor: { userId: number; role: string }, month: string) {
    if (actor.role !== 'owner') throw new ForbiddenException('Only the owner can reopen an approved payroll');
    const run = await this.prisma.payrollRun.findUnique({ where: { company_id_month: { company_id: companyId, month } } });
    if (!run) throw new NotFoundException('No payroll run for this month');
    await this.prisma.$transaction([
      this.prisma.payrollRunLine.deleteMany({ where: { run_id: run.id } }),
      this.prisma.payrollRun.update({
        where: { id: run.id },
        data: { status: 'draft', approved_at: null, approved_by_user_id: null, paid_at: null, paid_by_user_id: null },
      }),
    ]);
    return this.payroll(companyId, month);
  }

  private async assertMonthOpen(companyId: number, month: string) {
    const run = await this.prisma.payrollRun.findUnique({ where: { company_id_month: { company_id: companyId, month } } });
    if (run && run.status !== 'draft') {
      throw new ConflictException(`${month} payroll is ${run.status}. Reopen it to change adjustments.`);
    }
  }

  async listAdjustments(companyId: number, month: string, viewer?: Viewer) {
    let hide: number[] = [];
    if (viewer?.role === 'hr_manager') {
      const admins = await this.prisma.user.findMany({ where: { company_id: companyId, role: 'admin' }, select: { id: true } });
      hide = [...admins.map((a) => a.id), viewer.userId];
    }
    const rows = await this.prisma.payrollAdjustment.findMany({
      where: { company_id: companyId, month, ...(hide.length ? { user_id: { notIn: hide } } : {}) },
      orderBy: { created_at: 'asc' },
    });
    return rows.map((a) => ({
      id: a.id,
      userId: a.user_id,
      month: a.month,
      kind: a.kind,
      label: a.label,
      amount: Number(a.amount),
      note: a.note,
      additive: isAdditiveAdjustment(a.kind),
      createdAt: a.created_at.toISOString(),
    }));
  }

  async addAdjustment(companyId: number, actor: { userId: number; role: string }, dto: AdjustmentDto) {
    if (!MONTH_RE.test(dto.month)) throw new BadRequestException('month must be YYYY-MM');
    if (dto.userId === actor.userId && actor.role !== 'owner') {
      throw new ForbiddenException('You cannot add adjustments to your own pay. Ask the owner.');
    }
    await this.assertCanTouchPay(companyId, actor, dto.userId);
    await this.loadMember(companyId, dto.userId);
    await this.assertMonthOpen(companyId, dto.month);
    const a = await this.prisma.payrollAdjustment.create({
      data: {
        company_id: companyId,
        user_id: dto.userId,
        month: dto.month,
        kind: dto.kind,
        label: dto.label.trim().slice(0, 120) || dto.kind,
        amount: Math.abs(dto.amount),
        note: dto.note?.slice(0, 255) || null,
        created_by_user_id: actor.userId,
      },
    });
    return { id: a.id };
  }

  async deleteAdjustment(companyId: number, id: number, actor?: Viewer) {
    const a = await this.prisma.payrollAdjustment.findFirst({ where: { id, company_id: companyId } });
    if (!a) throw new NotFoundException('Adjustment not found');
    if (actor) {
      if (actor.role !== 'owner' && a.user_id === actor.userId) {
        throw new ForbiddenException('You cannot change your own pay. Ask the owner.');
      }
      await this.assertCanTouchPay(companyId, actor, a.user_id);
    }
    await this.assertMonthOpen(companyId, a.month);
    await this.prisma.payrollAdjustment.delete({ where: { id } });
    return { ok: true };
  }

  /** A member's own approved payslips (newest first) + their live current-month estimate. */
  async myPayslips(companyId: number, userId: number) {
    const lines = await this.prisma.payrollRunLine.findMany({
      where: { company_id: companyId, user_id: userId },
      orderBy: { id: 'desc' },
      take: 24,
    });
    const runIds = Array.from(new Set(lines.map((l) => l.run_id)));
    const runs = runIds.length
      ? await this.prisma.payrollRun.findMany({ where: { id: { in: runIds }, company_id: companyId } })
      : [];
    const runById = new Map(runs.map((r) => [r.id, r]));
    const co = await this.companyDefaults(companyId);
    return {
      currency: co.policy.currency,
      payslips: lines
        .map((l) => ({ run: this.runView(runById.get(l.run_id) ?? null), slip: l.snapshot as unknown as Payslip }))
        .filter((x) => x.run && x.run.status !== 'draft'),
    };
  }

  /**
   * Worker tick: drop live sockets of members whose app just locked (after
   * shift end). REST is already refused by JwtStrategy; this ends realtime.
   * `known` carries the locked set between ticks so each lock fires once.
   */
  async disconnectLockedMembers(known: Set<number>, now = new Date()) {
    const granted = await this.feature.companiesWith('attendance');
    if (!granted.size) return { dropped: 0 };
    const users = await this.prisma.user.findMany({
      where: {
        company_id: { in: [...granted] },
        status: 'active',
        role: { notIn: ['owner', 'super_admin', 'admin', 'hr_manager'] as never },
        attendance_exempt_late: false,
        OR: [{ attendance_lock_after_shift: true }, { attendance_lock_after_shift: null, company: { attendance_lock_after_shift: true } }],
      },
      select: { id: true, company_id: true, role: true },
      take: 5000,
    });
    let dropped = 0;
    const lockedNow = new Set<number>();
    for (const u of users) {
      const st = await this.workLock.state(u, now);
      if (!st?.locked) continue;
      lockedNow.add(u.id);
      if (!known.has(u.id)) {
        dropped += 1;
        this.safeEmit(() => this.gateway.disconnectUser(u.id));
      }
    }
    known.clear();
    for (const id of lockedNow) known.add(id);
    return { dropped };
  }

  // ── admin override ────────────────────────────────────────────────────────
  async override(companyId: number, actor: { userId: number; role: string }, userId: number, dateStr: string, dto: OverrideAttendanceDto) {
    if (!isValidDay(dateStr)) throw new BadRequestException('date must be a real YYYY-MM-DD day');
    if (userId === actor.userId && actor.role !== 'owner') {
      throw new ForbiddenException('You cannot edit your own attendance. Ask the owner.');
    }
    const u = await this.resolveUser(companyId, userId);
    this.assertTracked(u.role);
    const today = localParts(new Date(), u.tz).dateStr;
    if (dateStr > today) throw new BadRequestException('You cannot mark a future day. Use leave or holidays for that.');
    const run = await this.prisma.payrollRun.findUnique({
      where: { company_id_month: { company_id: companyId, month: dateStr.slice(0, 7) } },
    });
    if (run && run.status !== 'draft') {
      throw new ConflictException(`${dateStr.slice(0, 7)} payroll is ${run.status}. Reopen it to change attendance.`);
    }

    const workDate = dateCol(dateStr);
    const existing = (await this.prisma.attendanceRecord.findFirst({
      where: { company_id: companyId, user_id: userId, work_date: workDate },
    })) as DbRow | null;

    const data: Record<string, unknown> = { marked_by_user_id: actor.userId, system_marked: false };
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.note !== undefined) data.note = dto.note || null;

    let checkIn = existing?.check_in_at ?? null;
    if (dto.checkIn !== undefined) {
      checkIn = dto.checkIn ? localTimeToInstant(dateStr, dto.checkIn, u.tz) : null;
      data.check_in_at = checkIn;
    }
    if (dto.checkOut !== undefined) {
      let out = dto.checkOut ? localTimeToInstant(dateStr, dto.checkOut, u.tz) : null;
      // A check-out earlier than the check-in is the next morning (night shift).
      if (out && checkIn && out <= checkIn) out = new Date(out.getTime() + 86_400_000);
      data.check_out_at = out;
      if (out) {
        data.missed_checkout = false;
        data.checkout_source = 'admin';
      } else {
        data.checkout_source = null;
      }
    }
    if (!existing && dto.status === undefined && !checkIn) {
      throw new BadRequestException('Pick a status or enter a check-in time.');
    }

    const effStatus = (dto.status ?? existing?.status ?? 'present') as AttendanceStatusValue;
    if (!u.flexible && !u.neverLate && checkIn && (effStatus === 'present' || effStatus === 'half_day')) {
      data.is_late = minutesSinceShiftStart(checkIn, dateStr, u.start, u.tz) > u.grace;
    } else {
      data.is_late = false;
    }

    const row = existing
      ? ((await this.prisma.attendanceRecord.update({ where: { id: existing.id }, data })) as DbRow)
      : ((await this.prisma.attendanceRecord.upsert({
          where: { company_id_user_id_work_date: { company_id: companyId, user_id: userId, work_date: workDate } },
          update: data,
          create: {
            company_id: companyId,
            user_id: userId,
            work_date: workDate,
            status: effStatus,
            check_in_at: (data.check_in_at as Date | null) ?? null,
            check_out_at: (data.check_out_at as Date | null) ?? null,
            checkout_source: (data.checkout_source as string | null) ?? null,
            is_late: (data.is_late as boolean) ?? false,
            note: (data.note as string | null) ?? null,
            marked_by_user_id: actor.userId,
          },
        })) as DbRow);
    this.safeEmit(() => this.gateway.emitToCompany(companyId, 'attendance.changed', { userId }));
    return this.toCell(row);
  }

  // ── settings ────────────────────────────────────────────────────────────
  async getSettings(companyId: number, yourIp?: string) {
    const co = await this.companyDefaults(companyId);
    return {
      timezone: co.tz,
      workStartTime: co.start,
      workEndTime: co.end,
      graceMinutes: co.grace,
      officeNetworks: co.officeNetworks,
      officeIps: co.officeNetworks.map((n) => n.ip).join(', '), // legacy readers
      yourNetwork: yourIp ? matchOfficeNetwork(yourIp, co.officeNetworks) : null,
      lockAfterShift: co.lockAfterShift,
      lockBufferMinutes: co.lockBufferMin,
      checkinWindowMinutes: co.checkinWindow,
      payrollPolicy: co.policy,
      weeklyOff: co.weeklyOff,
      annualPaidLeave: co.annualPaidLeave,
      yourIp: yourIp ?? '',
    };
  }

  async setSettings(companyId: number, dto: AttendanceSettingsDto) {
    const co = await this.companyDefaults(companyId);
    const data: Record<string, unknown> = {};
    if (dto.workStartTime !== undefined) data.work_start_time = dto.workStartTime || null;
    if (dto.workEndTime !== undefined) data.work_end_time = dto.workEndTime || null;
    if (dto.graceMinutes !== undefined) data.attendance_grace_minutes = dto.graceMinutes ?? null;
    if (dto.officeNetworks !== undefined) {
      const bad = dto.officeNetworks.find((n) => !isValidIpEntry(n.ip));
      if (bad) throw new BadRequestException(`"${bad.ip}" is not a valid IP address or range.`);
      const nets = dto.officeNetworks.map((n, i) => ({ label: n.label.trim().slice(0, 40) || `Network ${i + 1}`, ip: n.ip.trim() }));
      data.attendance_office_ips = nets.length ? JSON.stringify(nets) : null;
    } else if (dto.officeIps !== undefined) {
      const nets = parseOfficeNetworks(dto.officeIps);
      data.attendance_office_ips = nets.length ? JSON.stringify(nets) : null;
    }
    if (dto.lockAfterShift !== undefined) data.attendance_lock_after_shift = dto.lockAfterShift;
    if (dto.lockBufferMinutes !== undefined) data.attendance_lock_buffer_min = dto.lockBufferMinutes ?? null;
    if (dto.checkinWindowMinutes !== undefined) data.attendance_checkin_window_minutes = dto.checkinWindowMinutes ?? null;
    if (dto.payrollPolicy !== undefined) {
      data.attendance_payroll_policy = resolvePolicy({ ...co.policy, ...dto.payrollPolicy }) as unknown as object;
    }
    if (dto.weeklyOff !== undefined) data.attendance_weekly_off = resolveWeeklyOff(dto.weeklyOff, []);
    if (dto.annualPaidLeave !== undefined) data.attendance_annual_paid_leave = dto.annualPaidLeave ?? null;
    await this.prisma.company.update({ where: { id: companyId }, data });
    this.workLock.invalidate(companyId);
    return this.getSettings(companyId);
  }

  // ── holidays ──────────────────────────────────────────────────────────────
  async listHolidays(companyId: number, year?: string) {
    const y = /^\d{4}$/.test(year ?? '') ? year! : String(new Date().getUTCFullYear());
    const rows = await this.prisma.attendanceHoliday.findMany({
      where: { company_id: companyId, date: { gte: dateCol(`${y}-01-01`), lte: dateCol(`${y}-12-31`) } },
      orderBy: { date: 'asc' },
    });
    return rows.map((h) => ({ id: h.id, date: day(h.date)!, name: h.name }));
  }

  async addHoliday(companyId: number, dto: HolidayDto) {
    if (!isValidDay(dto.date)) throw new BadRequestException('date must be YYYY-MM-DD');
    const name = dto.name.trim().slice(0, 120);
    if (!name) throw new BadRequestException('Give the holiday a name');
    const h = await this.prisma.attendanceHoliday.upsert({
      where: { company_id_date: { company_id: companyId, date: dateCol(dto.date) } },
      update: { name },
      create: { company_id: companyId, date: dateCol(dto.date), name },
    });
    return { id: h.id, date: dto.date, name };
  }

  async deleteHoliday(companyId: number, id: number) {
    const res = await this.prisma.attendanceHoliday.deleteMany({ where: { id, company_id: companyId } });
    if (!res.count) throw new NotFoundException('Holiday not found');
    return { ok: true };
  }

  // ── leave + correction requests ───────────────────────────────────────────
  private mapLeave(r: {
    id: number;
    user_id: number;
    from_date: Date;
    to_date: Date;
    reason: string | null;
    status: string;
    review_note: string | null;
    reviewed_at: Date | null;
    reviewed_by_user_id: number | null;
    created_at: Date;
    kind: string;
    paid: boolean;
    leave_type: string | null;
    req_check_in: string | null;
    req_check_out: string | null;
  }) {
    return {
      id: r.id,
      userId: r.user_id,
      kind: r.kind,
      leaveType: r.leave_type,
      paid: r.paid,
      fromDate: day(r.from_date)!,
      toDate: day(r.to_date)!,
      reqCheckIn: r.req_check_in,
      reqCheckOut: r.req_check_out,
      reason: r.reason,
      status: r.status,
      reviewNote: r.review_note,
      reviewedAt: r.reviewed_at ? r.reviewed_at.toISOString() : null,
      createdAt: r.created_at.toISOString(),
    };
  }

  private normDay(v: string | undefined, tz: string | null): string | null {
    if (!v) return null;
    if (isValidDay(v)) return v;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : localParts(new Date(t), tz).dateStr;
  }

  async requestLeave(companyId: number, userId: number, dto: LeaveRequestDto) {
    const u = await this.resolveUser(companyId, userId);
    this.assertTracked(u.role);
    const from = this.normDay(dto.fromDate, u.tz);
    const to = this.normDay(dto.toDate, u.tz);
    if (!from || !to) throw new BadRequestException('Valid from/to dates are required');
    if (to < from) throw new BadRequestException('"To" date is before "from" date');
    if (dateRange(from, to, MAX_LEAVE_DAYS + 1).length > MAX_LEAVE_DAYS) {
      throw new BadRequestException(`One request can cover at most ${MAX_LEAVE_DAYS} days`);
    }
    const overlap = await this.prisma.attendanceLeaveRequest.findFirst({
      where: {
        company_id: companyId,
        user_id: userId,
        kind: 'leave',
        status: { in: ['pending', 'approved'] },
        from_date: { lte: dateCol(to) },
        to_date: { gte: dateCol(from) },
      },
    });
    if (overlap) throw new ConflictException('You already have a leave request covering some of these days');
    const leaveType = dto.leaveType ?? 'casual';
    const created = await this.prisma.attendanceLeaveRequest.create({
      data: {
        company_id: companyId,
        user_id: userId,
        kind: 'leave',
        leave_type: leaveType,
        paid: leaveType === 'unpaid' ? false : dto.paid !== false,
        from_date: dateCol(from),
        to_date: dateCol(to),
        reason: dto.reason?.slice(0, 500) || null,
      },
    });
    this.safeEmit(() => this.gateway.emitToHrAdmins(companyId, 'attendance.request', { id: created.id, userId }));
    return this.mapLeave(created);
  }

  async requestCorrection(companyId: number, userId: number, dto: CorrectionRequestDto) {
    const u = await this.resolveUser(companyId, userId);
    this.assertTracked(u.role);
    if (!isValidDay(dto.date)) throw new BadRequestException('date must be YYYY-MM-DD');
    const today = localParts(new Date(), u.tz).dateStr;
    if (dto.date > today) throw new BadRequestException('You can only fix a past day');
    if (!dto.checkIn && !dto.checkOut) throw new BadRequestException('Enter the check-in and/or check-out time');
    const dup = await this.prisma.attendanceLeaveRequest.findFirst({
      where: { company_id: companyId, user_id: userId, kind: 'correction', status: 'pending', from_date: dateCol(dto.date) },
    });
    if (dup) throw new ConflictException('You already asked to fix this day');
    const created = await this.prisma.attendanceLeaveRequest.create({
      data: {
        company_id: companyId,
        user_id: userId,
        kind: 'correction',
        paid: true,
        from_date: dateCol(dto.date),
        to_date: dateCol(dto.date),
        req_check_in: dto.checkIn || null,
        req_check_out: dto.checkOut || null,
        reason: dto.reason?.slice(0, 500) || null,
      },
    });
    this.safeEmit(() => this.gateway.emitToHrAdmins(companyId, 'attendance.request', { id: created.id, userId }));
    return this.mapLeave(created);
  }

  async cancelMyRequest(companyId: number, userId: number, id: number) {
    const r = await this.prisma.attendanceLeaveRequest.findFirst({ where: { id, company_id: companyId, user_id: userId } });
    if (!r) throw new NotFoundException('Request not found');
    if (r.status !== 'pending') throw new ConflictException('Only a pending request can be cancelled');
    await this.prisma.attendanceLeaveRequest.delete({ where: { id } });
    return { ok: true };
  }

  async myLeave(companyId: number, userId: number) {
    const u = await this.loadMember(companyId, userId);
    const co = await this.companyDefaults(companyId);
    const rows = await this.prisma.attendanceLeaveRequest.findMany({
      where: { company_id: companyId, user_id: userId },
      orderBy: { created_at: 'desc' },
      take: 60,
    });
    const year = localParts(new Date(), co.tz).dateStr.slice(0, 4);
    const quota = u.annual_paid_leave ?? co.annualPaidLeave;
    const used = await this.prisma.attendanceRecord.count({
      where: {
        company_id: companyId,
        user_id: userId,
        status: 'leave',
        work_date: { gte: dateCol(`${year}-01-01`), lte: dateCol(`${year}-12-31`) },
      },
    });
    return {
      requests: rows.map((r) => this.mapLeave(r)),
      balance: quota > 0 ? { year, quota, used, left: Math.max(0, quota - used) } : null,
    };
  }

  async listLeave(companyId: number, status?: string) {
    const rows = await this.prisma.attendanceLeaveRequest.findMany({
      where: {
        company_id: companyId,
        ...(status === 'pending' || status === 'approved' || status === 'rejected' ? { status } : {}),
      },
      orderBy: [{ status: 'asc' }, { created_at: 'desc' }],
      take: 200,
      include: { user: { select: { name: true, role: true } } },
    });
    return rows.map((r) => ({ ...this.mapLeave(r), userName: r.user?.name ?? 'Teammate', userRole: r.user?.role ?? '' }));
  }

  async reviewLeave(companyId: number, actor: { userId: number; role: string }, id: number, dto: ReviewLeaveDto) {
    const req = await this.prisma.attendanceLeaveRequest.findFirst({ where: { id, company_id: companyId } });
    if (!req) throw new NotFoundException('Request not found');
    if (req.user_id === actor.userId && actor.role !== 'owner') {
      throw new ForbiddenException('You cannot review your own request. Ask the owner.');
    }
    if (req.status === dto.status) return this.mapLeave(req);

    const from = day(req.from_date)!;
    const to = day(req.to_date)!;

    if (req.kind === 'correction') {
      if (req.status !== 'pending') throw new ConflictException('This correction was already decided');
      if (dto.status === 'approved') {
        await this.override(companyId, { userId: actor.userId, role: 'owner' }, req.user_id, from, {
          status: 'present',
          ...(req.req_check_in ? { checkIn: req.req_check_in } : {}),
          ...(req.req_check_out ? { checkOut: req.req_check_out } : {}),
          note: `Fixed on request${req.reason ? `: ${req.reason.slice(0, 200)}` : ''}`,
        });
      }
      const updated = await this.prisma.attendanceLeaveRequest.update({
        where: { id },
        data: { status: dto.status, reviewed_by_user_id: actor.userId, reviewed_at: new Date(), review_note: dto.reviewNote?.slice(0, 255) || null },
      });
      return this.mapLeave(updated);
    }

    const member = await this.loadMember(companyId, req.user_id);
    const co = await this.companyDefaults(companyId);
    const cal = await this.calendarFor(companyId, this.schedule(member, co).weeklyOff, from, to);
    const workDays = dateRange(from, to).filter((d) => dayKind(d, cal) === 'work');

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.attendanceLeaveRequest.update({
        where: { id },
        data: { status: dto.status, reviewed_by_user_id: actor.userId, reviewed_at: new Date(), review_note: dto.reviewNote?.slice(0, 255) || null },
      });
      const existing = await tx.attendanceRecord.findMany({
        where: { company_id: companyId, user_id: req.user_id, work_date: { gte: dateCol(from), lte: dateCol(to) } },
      });
      const byDate = new Map(existing.map((r) => [r.work_date.toISOString().slice(0, 10), r]));
      if (dto.status === 'approved') {
        for (const d of workDays) {
          const r = byDate.get(d);
          if (r?.check_in_at) continue; // they worked that day — keep it
          if (r) {
            await tx.attendanceRecord.update({
              where: { id: r.id },
              data: { status: 'leave', system_marked: true, marked_by_user_id: actor.userId, is_late: false },
            });
          } else {
            await tx.attendanceRecord.create({
              data: { company_id: companyId, user_id: req.user_id, work_date: dateCol(d), status: 'leave', system_marked: true, marked_by_user_id: actor.userId },
            });
          }
        }
      } else if (req.status === 'approved') {
        // Approved → rejected: remove the leave days this approval created.
        const ids = existing.filter((r) => r.status === 'leave' && r.system_marked && !r.check_in_at).map((r) => r.id);
        if (ids.length) await tx.attendanceRecord.deleteMany({ where: { id: { in: ids } } });
      }
      return u;
    });
    this.safeEmit(() => this.gateway.emitToUsers([req.user_id], 'attendance.request.reviewed', { id, status: dto.status }));
    return this.mapLeave(updated);
  }

  // ── nightly sweep (cron): auto-absent + missed-checkout ────────────────────
  /** For each tenant, the last 3 completed local days: mark scheduled no-shows absent
   *  (weekly offs + holidays skipped; only active members who had joined) and flag
   *  check-ins still open. Idempotent. */
  async dailySweep() {
    const granted = await this.feature.companiesWith('attendance');
    const companies = (
      await this.prisma.company.findMany({
        where: { activation_status: 'active' },
        select: { id: true },
      })
    ).filter((c) => granted.has(c.id));
    let absent = 0;
    let missed = 0;
    for (const { id: companyId } of companies) {
      try {
        // Only tenants that actually use attendance (a check-in in the last 14
        // days) — otherwise a tenant that never adopted it fills with absents.
        const inUse = await this.prisma.attendanceRecord.findFirst({
          where: { company_id: companyId, check_in_at: { gte: new Date(Date.now() - 14 * 86_400_000) } },
          select: { id: true },
        });
        if (!inUse) continue;
        const co = await this.companyDefaults(companyId);
        const today = localParts(new Date(), co.tz).dateStr;
        // Never back-mark days before auto-absent went live.
        const days = [addDays(today, -3), addDays(today, -2), addDays(today, -1)].filter((d) => d >= AUTO_ABSENT_FROM);
        if (!days.length) continue;
        const members = (await this.prisma.user.findMany({
          where: { company_id: companyId, status: 'active', role: { notIn: NOT_TRACKED_ROLES as never } },
          select: MEMBER_SELECT,
        })) as MemberRow[];
        if (!members.length) continue;
        const rows = await this.rowsFor(companyId, members.map((m) => m.id), days[0], days[days.length - 1]);
        const hol = await this.calendarFor(companyId, [], days[0], days[days.length - 1]);
        const have = new Set(rows.map((r) => `${r.user_id}:${r.work_date.toISOString().slice(0, 10)}`));
        const toCreate: Prisma.AttendanceRecordCreateManyInput[] = [];
        for (const m of members) {
          const s = this.schedule(m, co);
          for (const d of days) {
            if (s.joinedOn && d < s.joinedOn) continue;
            if (s.leftOn && d > s.leftOn) continue;
            if (dayKind(d, { weeklyOff: s.weeklyOff, holidays: hol.holidays }) !== 'work') continue;
            if (have.has(`${m.id}:${d}`)) continue;
            toCreate.push({ company_id: companyId, user_id: m.id, work_date: dateCol(d), status: 'absent', system_marked: true });
          }
        }
        if (toCreate.length) {
          const res = await this.prisma.attendanceRecord.createMany({ data: toCreate, skipDuplicates: true });
          absent += res.count;
        }
        const res = await this.prisma.attendanceRecord.updateMany({
          where: {
            company_id: companyId,
            work_date: { gte: dateCol(days[0]), lte: dateCol(days[days.length - 1]) },
            check_in_at: { not: null },
            check_out_at: null,
            missed_checkout: false,
          },
          data: { missed_checkout: true },
        });
        missed += res.count;
      } catch (e) {
        this.log.warn(`attendance sweep failed for company ${companyId}: ${(e as Error).message}`);
      }
    }
    return { ok: true, absentMarked: absent, missedCheckoutFlagged: missed };
  }

  // ── CSV export ────────────────────────────────────────────────────────────
  async reportCsv(companyId: number, fromStr: string, toStr: string): Promise<string> {
    const { dates, members } = await this.report(companyId, fromStr, toStr);
    const { tz } = await this.companyDefaults(companyId);
    const fmtTime = (iso: string | null) => (iso ? minutesToHHMM(localParts(new Date(iso), tz).minutes) : '');
    const hrs = (m: number | null) => (m == null ? '' : `${Math.floor(m / 60)}h ${m % 60}m`);
    const header = ['Member', 'Role', 'Date', 'Status', 'Check in', 'Check out', 'Hours', 'Late', 'Closed by', 'Note'];
    const lines = [header.map(csvCell).join(',')];
    for (const m of members) {
      for (const date of dates) {
        const c = m.cells[date];
        if (!c) continue;
        lines.push(
          [
            m.name,
            m.role,
            date,
            c.status,
            fmtTime(c.checkInAt),
            fmtTime(c.checkOutAt),
            hrs(c.workedMinutes),
            c.isLate ? 'yes' : '',
            c.checkoutSource ?? (c.missedCheckout ? 'missed' : ''),
            c.note ?? '',
          ]
            .map(csvCell)
            .join(','),
        );
      }
    }
    return '﻿' + lines.join('\r\n');
  }

  async payrollCsv(companyId: number, month: string, viewer?: Viewer): Promise<string> {
    const p = await this.payroll(companyId, month, viewer);
    const header = [
      'Member', 'Role', 'Period', 'Work days', 'Present', 'Half days', 'Absent', 'Paid leave', 'Unpaid leave',
      'Late', 'Late min', 'OT min', 'Base', 'Allowances', 'Overtime', 'Commission', 'Additions',
      'Absence', 'Unpaid leave ded', 'Half-day ded', 'Late ded', 'Statutory', 'Other deductions',
      'Gross', 'Deductions', 'Net',
    ];
    const lines = [header.map(csvCell).join(',')];
    for (const r of p.rows) {
      lines.push(
        [
          r.name, r.role, `${r.periodFrom}..${r.periodTo}`, r.scheduledDays, r.present, r.halfDay, r.absent, r.paidLeave,
          r.unpaidLeave, r.lateCount, r.lateMinutes, r.overtimeMinutes, r.base, r.allowanceTotal, r.overtimePay,
          r.commission, r.adjustmentsPlus, r.absenceDeduction, r.unpaidLeaveDeduction, r.halfDayDeduction,
          r.lateDeduction, r.statutoryDeduction, r.adjustmentsMinus, r.gross, r.deductions,
          r.netPayable,
        ]
          .map(csvCell)
          .join(','),
      );
    }
    return '﻿' + lines.join('\r\n');
  }

  private safeEmit(fn: () => void) {
    try {
      fn();
    } catch {
      /* a socket failure must never block attendance */
    }
  }
}

/** CSV cell: quoted when needed + formula-injection safe. */
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export type { Allowance };
