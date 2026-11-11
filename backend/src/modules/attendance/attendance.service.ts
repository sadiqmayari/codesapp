import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InboxGateway } from '../inbox/inbox.gateway';
import { ipInAllowlist } from '../../common/utils/ip-match';
import {
  AttendanceStatusValue,
  OverrideAttendanceDto,
} from './dto/override-attendance.dto';
import { AttendanceSettingsDto } from './dto/attendance-settings.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { LeaveRequestDto, ReviewLeaveDto } from './dto/leave.dto';
import {
  Allowance,
  PayrollPolicy,
  resolveAllowances,
  resolvePolicy,
} from './payroll';

const DEFAULT_WORK_START = '09:30';
const DEFAULT_CHECKIN_WINDOW_MIN = 150; // 2.5h after shift start (09:30 → 12:00)
const EARLY_CHECKIN_MIN = 30; // check-in opens 30 min BEFORE shift start
const DEFAULT_SHIFT_LENGTH_MIN = 8 * 60; // checkout opens shiftStart+8h when no shift end set
const END_OF_DAY = '23:59';

export interface AttendanceCell {
  date: string; // YYYY-MM-DD
  status: AttendanceStatusValue;
  checkInAt: string | null; // ISO
  checkOutAt: string | null; // ISO
  isLate: boolean;
  missedCheckout: boolean;
  workedMinutes: number | null;
  note: string | null;
  overridden: boolean;
}

export interface DailyGridMember {
  userId: number;
  name: string;
  role: string;
  cells: Record<string, AttendanceCell>;
}

export interface MonthlySummaryRow {
  userId: number;
  name: string;
  role: string;
  present: number;
  absent: number;
  leave: number;
  halfDay: number;
  holiday: number;
  late: number;
  earlyLeaves: number;
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
  note: string | null;
  marked_by_user_id: number | null;
};

type MemberRow = {
  id: number;
  name: string;
  role: string;
  attendance_work_start: string | null;
  attendance_work_end: string | null;
  attendance_grace_minutes: number | null;
  attendance_require_office_ip: boolean;
  attendance_exempt_late: boolean;
  salary_amount: unknown; // Prisma Decimal | null
  salary_allowances: unknown; // Json | null
  salary_overtime_rate: unknown; // Prisma Decimal | null
};

const MEMBER_SELECT = {
  id: true,
  name: true,
  role: true,
  attendance_work_start: true,
  attendance_work_end: true,
  attendance_grace_minutes: true,
  attendance_require_office_ip: true,
  attendance_exempt_late: true,
  salary_amount: true,
  salary_allowances: true,
  salary_overtime_rate: true,
} as const;

export interface PayrollRow {
  userId: number;
  name: string;
  role: string;
  exemptLate: boolean;
  salary: number;
  allowances: Allowance[];
  allowanceTotal: number;
  present: number;
  absent: number;
  halfDay: number;
  leave: number;
  lateCount: number;
  lateMinutes: number;
  overtimeMinutes: number;
  overtimePay: number;
  absenceDeduction: number;
  lateDeduction: number;
  halfDayDeduction: number;
  netPayable: number;
}

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: InboxGateway,
  ) {}

  // ── company defaults + per-user schedule ──────────────────────────────────
  private async companyDefaults(companyId: number) {
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
      },
    });
    return {
      tz: c?.timezone ?? null,
      start: c?.work_start_time || DEFAULT_WORK_START,
      end: c?.work_end_time || null,
      grace: c?.attendance_grace_minutes ?? 0,
      officeIps: c?.attendance_office_ips ?? null,
      policy: resolvePolicy(c?.attendance_payroll_policy),
      checkinWindow: c?.attendance_checkin_window_minutes ?? DEFAULT_CHECKIN_WINDOW_MIN,
    };
  }

  /** Resolve the effective schedule + flags for one user (per-user overrides
   *  fall back to the company defaults). */
  private async resolveUser(companyId: number, userId: number) {
    const u = (await this.prisma.user.findFirst({
      where: { id: userId, company_id: companyId },
      select: MEMBER_SELECT,
    })) as MemberRow | null;
    if (!u) throw new NotFoundException('Team member not found');
    const co = await this.companyDefaults(companyId);
    const start = u.attendance_work_start || co.start;
    const startMin = this.toMinutes(start);
    // Check-in window is RELATIVE to this user's own shift start: it OPENS 30 min
    // before the shift (not at midnight) and CLOSES `checkinWindow` minutes after
    // it, so staff on different shifts each get their own window. Flexible
    // (exempt) staff have NO window — they can check in any time (00:00–23:59).
    const checkinOpensAt = u.attendance_exempt_late
      ? '00:00'
      : this.minutesToHHMM(startMin - EARLY_CHECKIN_MIN);
    const checkinCutoff = u.attendance_exempt_late
      ? END_OF_DAY
      : this.minutesToHHMM(startMin + co.checkinWindow);
    const end = u.attendance_work_end || co.end;
    // Check-out opens at the effective shift END (not immediately after check-in).
    // No shift end configured → default to shift start + 8h. Flexible (exempt)
    // staff can check out any time.
    const checkoutOpensAt = u.attendance_exempt_late
      ? '00:00'
      : end || this.minutesToHHMM(startMin + DEFAULT_SHIFT_LENGTH_MIN);
    return {
      tz: co.tz,
      role: u.role,
      name: u.name,
      start,
      end,
      grace: u.attendance_grace_minutes ?? co.grace,
      requireOfficeIp: u.attendance_require_office_ip,
      officeIps: co.officeIps,
      exemptLate: u.attendance_exempt_late,
      policy: co.policy,
      checkinOpensAt,
      checkinCutoff,
      checkoutOpensAt,
    };
  }

  // ── timezone helpers ──────────────────────────────────────────────────────
  private localParts(at: Date, tz: string | null): { dateStr: string; minutes: number } {
    if (!tz) {
      return {
        dateStr: at.toISOString().slice(0, 10),
        minutes: at.getUTCHours() * 60 + at.getUTCMinutes(),
      };
    }
    try {
      const p = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
        .formatToParts(at)
        .reduce<Record<string, string>>((a, x) => {
          if (x.type !== 'literal') a[x.type] = x.value;
          return a;
        }, {});
      return {
        dateStr: `${p.year}-${p.month}-${p.day}`,
        minutes: Number(p.hour) * 60 + Number(p.minute),
      };
    } catch {
      return {
        dateStr: at.toISOString().slice(0, 10),
        minutes: at.getUTCHours() * 60 + at.getUTCMinutes(),
      };
    }
  }

  private offsetMinutes(at: Date, tz: string | null): number {
    if (!tz) return 0;
    try {
      const p = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(at)
        .reduce<Record<string, number>>((a, x) => {
          if (x.type !== 'literal') a[x.type] = Number(x.value);
          return a;
        }, {});
      const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      return Math.round((asUtc - at.getTime()) / 60000);
    } catch {
      return 0;
    }
  }

  private dateCol(dateStr: string): Date {
    return new Date(`${dateStr}T00:00:00.000Z`);
  }

  private localTimeToInstant(dateStr: string, hhmm: string, tz: string | null): Date {
    const [y, mo, d] = dateStr.split('-').map(Number);
    const [hh, mm] = hhmm.split(':').map(Number);
    const naiveUtc = Date.UTC(y, mo - 1, d, hh, mm);
    const approx = new Date(naiveUtc);
    const off = this.offsetMinutes(approx, tz);
    return new Date(naiveUtc - off * 60000);
  }

  private toMinutes(hhmm: string): number {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }

  private minutesToHHMM(mins: number): string {
    const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(mins)));
    return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
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
      workedMinutes: this.workedMinutes(row),
      note: row.note,
      overridden: row.marked_by_user_id != null,
    };
  }

  private dateRange(fromStr: string, toStr: string): string[] {
    const out: string[] = [];
    const from = this.dateCol(fromStr);
    const to = this.dateCol(toStr);
    for (let d = from; d <= to; d = new Date(d.getTime() + 86400000)) {
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  private assertNotOwner(role: string) {
    if (role === 'owner') {
      throw new ForbiddenException('Owners are not tracked for attendance');
    }
  }

  private assertOnOfficeNetwork(
    u: { requireOfficeIp: boolean; officeIps: string | null },
    ip: string,
  ) {
    if (!u.requireOfficeIp || !u.officeIps?.trim()) return;
    if (!ipInAllowlist(ip, u.officeIps)) {
      throw new ForbiddenException(
        `You must be on an approved office network to mark attendance. ` +
          `Detected IP: "${ip}". Ask your admin to add it.`,
      );
    }
  }

  // ── self-service ────────────────────────────────────────────────────────
  async myToday(companyId: number, userId: number) {
    const u = await this.resolveUser(companyId, userId);
    const { dateStr } = this.localParts(new Date(), u.tz);
    const row = (await this.prisma.attendanceRecord.findFirst({
      where: { company_id: companyId, user_id: userId, work_date: this.dateCol(dateStr) },
    })) as DbRow | null;
    return {
      date: dateStr,
      workStart: u.start,
      workEnd: u.end,
      graceMinutes: u.grace,
      checkinOpensAt: u.checkinOpensAt,
      checkinCutoff: u.checkinCutoff,
      checkoutOpensAt: u.checkoutOpensAt,
      exemptLate: u.exemptLate,
      excluded: u.role === 'owner',
      record: row ? this.toCell(row) : null,
    };
  }

  async checkIn(companyId: number, userId: number, ip: string) {
    const u = await this.resolveUser(companyId, userId);
    this.assertNotOwner(u.role);
    this.assertOnOfficeNetwork(u, ip);

    const now = new Date();
    const { dateStr, minutes } = this.localParts(now, u.tz);
    const startMin = this.toMinutes(u.start);
    // Flexible/exempt staff are never marked late.
    const isLate = !u.exemptLate && minutes > startMin + u.grace;
    // Half-day late policy: late by more than X min (from shift start) → half-day.
    const status: AttendanceStatusValue =
      !u.exemptLate &&
      u.policy.lateMethod === 'half_day' &&
      minutes - startMin > u.policy.halfDayAfterMin
        ? 'half_day'
        : 'present';
    const existing = (await this.prisma.attendanceRecord.findFirst({
      where: { company_id: companyId, user_id: userId, work_date: this.dateCol(dateStr) },
    })) as DbRow | null;

    let row: DbRow;
    if (existing) {
      if (existing.check_in_at) return this.toCell(existing); // idempotent
      row = (await this.prisma.attendanceRecord.update({
        where: { id: existing.id },
        data: { check_in_at: now, is_late: isLate, status, system_marked: false },
      })) as DbRow;
    } else {
      row = (await this.prisma.attendanceRecord.create({
        data: {
          company_id: companyId,
          user_id: userId,
          work_date: this.dateCol(dateStr),
          status,
          check_in_at: now,
          is_late: isLate,
        },
      })) as DbRow;
    }

    if (isLate) {
      try {
        this.gateway.emitToCompany(companyId, 'attendance.late', {
          userId,
          name: u.name,
          at: now.toISOString(),
        });
      } catch {
        /* a socket failure must never block a check-in */
      }
    }
    return this.toCell(row);
  }

  async checkOut(companyId: number, userId: number, ip: string) {
    const u = await this.resolveUser(companyId, userId);
    this.assertNotOwner(u.role);
    this.assertOnOfficeNetwork(u, ip);

    const now = new Date();
    const { dateStr } = this.localParts(now, u.tz);
    const existing = (await this.prisma.attendanceRecord.findFirst({
      where: { company_id: companyId, user_id: userId, work_date: this.dateCol(dateStr) },
    })) as DbRow | null;
    if (!existing || !existing.check_in_at) {
      throw new BadRequestException('Check in first');
    }
    const updated = (await this.prisma.attendanceRecord.update({
      where: { id: existing.id },
      data: { check_out_at: now, missed_checkout: false },
    })) as DbRow;
    return this.toCell(updated);
  }

  async myHistory(companyId: number, userId: number, fromStr: string, toStr: string) {
    const rows = (await this.prisma.attendanceRecord.findMany({
      where: {
        company_id: companyId,
        user_id: userId,
        work_date: { gte: this.dateCol(fromStr), lte: this.dateCol(toStr) },
      },
      orderBy: { work_date: 'desc' },
    })) as DbRow[];
    return rows.map((r) => this.toCell(r));
  }

  // ── members (non-owner, non-suspended) ────────────────────────────────────
  private activeMembers(companyId: number) {
    return this.prisma.user.findMany({
      where: {
        company_id: companyId,
        status: { not: 'suspended' },
        role: { notIn: ['owner', 'super_admin'] },
      },
      select: MEMBER_SELECT,
      orderBy: { name: 'asc' },
    }) as Promise<MemberRow[]>;
  }

  async listMembers(companyId: number) {
    const co = await this.companyDefaults(companyId);
    const members = await this.activeMembers(companyId);
    return members.map((m) => ({
      userId: m.id,
      name: m.name,
      role: m.role,
      workStart: m.attendance_work_start, // override (null = default)
      workEnd: m.attendance_work_end,
      graceMinutes: m.attendance_grace_minutes,
      requireOfficeIp: m.attendance_require_office_ip,
      effectiveStart: m.attendance_work_start || co.start,
      effectiveEnd: m.attendance_work_end || co.end,
      effectiveGrace: m.attendance_grace_minutes ?? co.grace,
      exemptLate: m.attendance_exempt_late,
      salaryAmount: m.salary_amount == null ? null : Number(m.salary_amount),
      overtimeRate: m.salary_overtime_rate == null ? null : Number(m.salary_overtime_rate),
      allowances: resolveAllowances(m.salary_allowances),
    }));
  }

  async updateMember(companyId: number, userId: number, dto: UpdateMemberDto) {
    const member = await this.prisma.user.findFirst({
      where: { id: userId, company_id: companyId, role: { notIn: ['owner', 'super_admin'] } },
      select: { id: true },
    });
    if (!member) throw new NotFoundException('Team member not found');
    const data: Record<string, unknown> = {};
    if (dto.workStartTime !== undefined) data.attendance_work_start = dto.workStartTime || null;
    if (dto.workEndTime !== undefined) data.attendance_work_end = dto.workEndTime || null;
    if (dto.graceMinutes !== undefined)
      data.attendance_grace_minutes = dto.graceMinutes == null ? null : dto.graceMinutes;
    if (dto.requireOfficeIp !== undefined) data.attendance_require_office_ip = dto.requireOfficeIp;
    if (dto.exemptLate !== undefined) data.attendance_exempt_late = dto.exemptLate;
    if (dto.salaryAmount !== undefined)
      data.salary_amount = dto.salaryAmount == null ? null : dto.salaryAmount;
    if (dto.overtimeRate !== undefined)
      data.salary_overtime_rate = dto.overtimeRate == null ? null : dto.overtimeRate;
    if (dto.allowances !== undefined)
      data.salary_allowances = resolveAllowances(dto.allowances);
    await this.prisma.user.update({ where: { id: userId }, data });
    return { ok: true };
  }

  // ── admin report ──────────────────────────────────────────────────────────
  async report(companyId: number, fromStr: string, toStr: string) {
    const members = await this.activeMembers(companyId);
    const ids = members.map((m) => m.id);
    const rows = ids.length
      ? ((await this.prisma.attendanceRecord.findMany({
          where: {
            company_id: companyId,
            user_id: { in: ids },
            work_date: { gte: this.dateCol(fromStr), lte: this.dateCol(toStr) },
          },
        })) as DbRow[])
      : [];

    const byUser = new Map<number, Record<string, AttendanceCell>>();
    for (const r of rows) {
      const cell = this.toCell(r);
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, {});
      byUser.get(r.user_id)![cell.date] = cell;
    }

    const grid: DailyGridMember[] = members.map((m) => ({
      userId: m.id,
      name: m.name,
      role: m.role,
      cells: byUser.get(m.id) ?? {},
    }));

    return {
      from: fromStr,
      to: toStr,
      dates: this.dateRange(fromStr, toStr),
      members: grid,
    };
  }

  async summary(companyId: number, month: string) {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new BadRequestException('month must be YYYY-MM');
    }
    const [y, mo] = month.split('-').map(Number);
    const fromStr = `${month}-01`;
    const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const toStr = `${month}-${String(lastDay).padStart(2, '0')}`;

    const co = await this.companyDefaults(companyId);
    const members = await this.activeMembers(companyId);
    const ids = members.map((m) => m.id);
    const rows = ids.length
      ? ((await this.prisma.attendanceRecord.findMany({
          where: {
            company_id: companyId,
            user_id: { in: ids },
            work_date: { gte: this.dateCol(fromStr), lte: this.dateCol(toStr) },
          },
        })) as DbRow[])
      : [];

    const agg = new Map<number, MonthlySummaryRow>();
    const shift = new Map<number, number | null>(); // userId → expected minutes/day
    for (const m of members) {
      const start = m.attendance_work_start || co.start;
      const end = m.attendance_work_end || co.end;
      shift.set(m.id, end ? Math.max(0, this.toMinutes(end) - this.toMinutes(start)) : null);
      agg.set(m.id, {
        userId: m.id,
        name: m.name,
        role: m.role,
        present: 0,
        absent: 0,
        leave: 0,
        halfDay: 0,
        holiday: 0,
        late: 0,
        earlyLeaves: 0,
        totalMinutes: 0,
        expectedMinutes: 0,
        overtimeMinutes: 0,
        attendancePct: 0,
      });
    }
    for (const r of rows) {
      const a = agg.get(r.user_id);
      if (!a) continue;
      if (r.status === 'present') a.present += 1;
      else if (r.status === 'absent') a.absent += 1;
      else if (r.status === 'leave') a.leave += 1;
      else if (r.status === 'half_day') a.halfDay += 1;
      else if (r.status === 'holiday') a.holiday += 1;
      if (r.is_late) a.late += 1;
      const worked = this.workedMinutes(r) ?? 0;
      a.totalMinutes += worked;
      const perDay = shift.get(r.user_id) ?? null;
      if (perDay != null && (r.status === 'present' || r.status === 'half_day')) {
        a.expectedMinutes += perDay;
        if (worked > perDay) a.overtimeMinutes += worked - perDay;
        // Early leave: checked out before the shift end (tenant-local). Flexible
        // (exempt) staff are never flagged for leaving early.
        const mem = members.find((m) => m.id === r.user_id);
        if (r.check_out_at && !mem?.attendance_exempt_late) {
          const endMin = this.toMinutes(mem?.attendance_work_end || co.end || '23:59');
          const outMin = this.localParts(r.check_out_at, co.tz).minutes;
          if (outMin < endMin) a.earlyLeaves += 1;
        }
      }
    }
    for (const a of agg.values()) {
      const marked = a.present + a.absent + a.leave + a.halfDay;
      a.attendancePct = marked
        ? Math.round(((a.present + 0.5 * a.halfDay) / marked) * 100)
        : 0;
    }

    return { month, from: fromStr, to: toStr, rows: Array.from(agg.values()) };
  }

  // ── payroll (owner/admin): salary + allowances + overtime − deductions ─────
  async payroll(companyId: number, month: string) {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new BadRequestException('month must be YYYY-MM');
    }
    const [y, mo] = month.split('-').map(Number);
    const fromStr = `${month}-01`;
    const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const toStr = `${month}-${String(lastDay).padStart(2, '0')}`;

    const co = await this.companyDefaults(companyId);
    const policy: PayrollPolicy = co.policy;
    const members = await this.activeMembers(companyId);
    const ids = members.map((m) => m.id);
    const rows = ids.length
      ? ((await this.prisma.attendanceRecord.findMany({
          where: {
            company_id: companyId,
            user_id: { in: ids },
            work_date: { gte: this.dateCol(fromStr), lte: this.dateCol(toStr) },
          },
        })) as DbRow[])
      : [];

    const byUser = new Map<number, DbRow[]>();
    for (const r of rows) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id)!.push(r);
    }

    const round2 = (n: number) => Math.round(n * 100) / 100;
    const workingDays = policy.workingDaysPerMonth;

    const out: PayrollRow[] = members.map((m) => {
      const start = m.attendance_work_start || co.start;
      const end = m.attendance_work_end || co.end;
      const startMin = this.toMinutes(start);
      const grace = m.attendance_grace_minutes ?? co.grace;
      const shiftMin = end ? Math.max(0, this.toMinutes(end) - startMin) : null;
      const exempt = m.attendance_exempt_late;

      const salary = m.salary_amount == null ? 0 : Number(m.salary_amount);
      const allowances = resolveAllowances(m.salary_allowances);
      const allowanceTotal = allowances.reduce((s, a) => s + a.amount, 0);
      const perUserOtRate = m.salary_overtime_rate == null ? null : Number(m.salary_overtime_rate);

      const dailyRate = workingDays > 0 ? salary / workingDays : 0;
      const minuteRate = shiftMin && workingDays > 0 ? salary / (workingDays * shiftMin) : 0;

      let present = 0;
      let absent = 0;
      let halfDay = 0;
      let leave = 0;
      let lateCount = 0;
      let lateMinutes = 0;
      let overtimeMinutes = 0;

      for (const r of byUser.get(m.id) ?? []) {
        if (r.status === 'present') present += 1;
        else if (r.status === 'absent') absent += 1;
        else if (r.status === 'half_day') halfDay += 1;
        else if (r.status === 'leave') leave += 1;
        if (r.is_late) lateCount += 1;

        if (!exempt && r.check_in_at && (r.status === 'present' || r.status === 'half_day')) {
          const inMin = this.localParts(r.check_in_at, co.tz).minutes;
          lateMinutes += Math.max(0, inMin - (startMin + grace));
        }

        if (shiftMin != null && (r.status === 'present' || r.status === 'half_day')) {
          const worked = this.workedMinutes(r) ?? 0;
          const dayOt = worked > shiftMin ? worked - shiftMin : 0;
          if (dayOt >= policy.minOvertimeMinutes && dayOt > 0) overtimeMinutes += dayOt;
        }
      }

      // Deductions
      const absenceDeduction = absent * dailyRate;
      const halfDayDeduction = halfDay * 0.5 * dailyRate;
      let lateDeduction = 0;
      if (!exempt) {
        switch (policy.lateMethod) {
          case 'n_lates_absent':
            lateDeduction = Math.floor(lateCount / policy.latesPerAbsent) * dailyRate;
            break;
          case 'fixed_per_late':
            lateDeduction = lateCount * policy.lateFixedAmount;
            break;
          case 'per_minute':
            lateDeduction = lateMinutes * minuteRate;
            break;
          // 'half_day' is realised via the half_day status at check-in → handled
          // by halfDayDeduction above; 'none' → no late deduction.
          default:
            lateDeduction = 0;
        }
      }

      // Overtime pay
      let overtimePay = 0;
      switch (policy.overtimeMethod) {
        case 'hourly_multiplier':
          overtimePay = overtimeMinutes * minuteRate * policy.overtimeMultiplier;
          break;
        case 'flat_per_hour':
          overtimePay = (overtimeMinutes / 60) * (perUserOtRate ?? policy.overtimeFlatRate);
          break;
        case 'per_minute':
          overtimePay = overtimeMinutes * minuteRate;
          break;
        default:
          overtimePay = 0;
      }

      const netPayable =
        salary + allowanceTotal + overtimePay - absenceDeduction - lateDeduction - halfDayDeduction;

      return {
        userId: m.id,
        name: m.name,
        role: m.role,
        exemptLate: exempt,
        salary: round2(salary),
        allowances,
        allowanceTotal: round2(allowanceTotal),
        present,
        absent,
        halfDay,
        leave,
        lateCount,
        lateMinutes,
        overtimeMinutes,
        overtimePay: round2(overtimePay),
        absenceDeduction: round2(absenceDeduction),
        lateDeduction: round2(lateDeduction),
        halfDayDeduction: round2(halfDayDeduction),
        netPayable: round2(netPayable),
      };
    });

    return { month, from: fromStr, to: toStr, policy, rows: out };
  }

  async todaySummary(companyId: number) {
    const co = await this.companyDefaults(companyId);
    const { dateStr } = this.localParts(new Date(), co.tz);
    const members = await this.activeMembers(companyId);
    const ids = members.map((m) => m.id);
    const rows = ids.length
      ? ((await this.prisma.attendanceRecord.findMany({
          where: { company_id: companyId, user_id: { in: ids }, work_date: this.dateCol(dateStr) },
        })) as DbRow[])
      : [];
    const byUser = new Map(rows.map((r) => [r.user_id, r]));
    let present = 0;
    let late = 0;
    let absent = 0;
    let notCheckedIn = 0;
    for (const m of members) {
      const r = byUser.get(m.id);
      if (r?.check_in_at && (r.status === 'present' || r.status === 'half_day')) {
        present += 1;
        if (r.is_late) late += 1;
      } else if (r?.status === 'absent') {
        absent += 1;
      } else if (r?.status === 'leave' || r?.status === 'holiday') {
        // off today — not counted as missing
      } else {
        notCheckedIn += 1;
      }
    }
    return { date: dateStr, total: members.length, present, late, absent, notCheckedIn };
  }

  async override(
    companyId: number,
    adminId: number,
    userId: number,
    dateStr: string,
    dto: OverrideAttendanceDto,
  ) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }
    const u = await this.resolveUser(companyId, userId);
    this.assertNotOwner(u.role);

    const workDate = this.dateCol(dateStr);
    const existing = (await this.prisma.attendanceRecord.findFirst({
      where: { company_id: companyId, user_id: userId, work_date: workDate },
    })) as DbRow | null;

    const data: Record<string, unknown> = { marked_by_user_id: adminId };
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.note !== undefined) data.note = dto.note || null;

    let checkInInstant = existing?.check_in_at ?? null;
    if (dto.checkIn !== undefined) {
      checkInInstant = dto.checkIn ? this.localTimeToInstant(dateStr, dto.checkIn, u.tz) : null;
      data.check_in_at = checkInInstant;
    }
    if (dto.checkOut !== undefined) {
      data.check_out_at = dto.checkOut
        ? this.localTimeToInstant(dateStr, dto.checkOut, u.tz)
        : null;
      if (dto.checkOut) data.missed_checkout = false;
    }

    const effStatus = (dto.status ?? existing?.status ?? 'present') as AttendanceStatusValue;
    if (!u.exemptLate && checkInInstant && effStatus === 'present') {
      const { minutes } = this.localParts(checkInInstant, u.tz);
      data.is_late = minutes > this.toMinutes(u.start) + u.grace;
    } else if (u.exemptLate || dto.checkIn !== undefined || dto.status !== undefined) {
      data.is_late = false;
    }

    const row = existing
      ? ((await this.prisma.attendanceRecord.update({
          where: { id: existing.id },
          data,
        })) as DbRow)
      : ((await this.prisma.attendanceRecord.create({
          data: {
            company_id: companyId,
            user_id: userId,
            work_date: workDate,
            status: (dto.status ?? 'present') as AttendanceStatusValue,
            check_in_at: (data.check_in_at as Date | null) ?? null,
            check_out_at: (data.check_out_at as Date | null) ?? null,
            is_late: (data.is_late as boolean) ?? false,
            note: (data.note as string | null) ?? null,
            marked_by_user_id: adminId,
          },
        })) as DbRow);
    return this.toCell(row);
  }

  // ── settings ────────────────────────────────────────────────────────────
  async getSettings(companyId: number, yourIp?: string) {
    const co = await this.companyDefaults(companyId);
    return {
      workStartTime: co.start,
      workEndTime: co.end,
      graceMinutes: co.grace,
      officeIps: co.officeIps ?? '',
      checkinWindowMinutes: co.checkinWindow,
      payrollPolicy: co.policy,
      yourIp: yourIp ?? '',
    };
  }

  async setSettings(companyId: number, dto: AttendanceSettingsDto) {
    const data: Record<string, unknown> = {};
    if (dto.workStartTime !== undefined) data.work_start_time = dto.workStartTime || null;
    if (dto.workEndTime !== undefined) data.work_end_time = dto.workEndTime || null;
    if (dto.graceMinutes !== undefined)
      data.attendance_grace_minutes = dto.graceMinutes == null ? null : dto.graceMinutes;
    if (dto.officeIps !== undefined) data.attendance_office_ips = dto.officeIps?.trim() || null;
    if (dto.checkinWindowMinutes !== undefined)
      data.attendance_checkin_window_minutes =
        dto.checkinWindowMinutes == null ? null : Math.max(0, dto.checkinWindowMinutes);
    if (dto.payrollPolicy !== undefined) {
      // Merge the incoming (possibly partial) policy over the current one, then
      // clamp via resolvePolicy so a stored blob is always complete + valid.
      const co = await this.companyDefaults(companyId);
      data.attendance_payroll_policy = resolvePolicy({
        ...co.policy,
        ...dto.payrollPolicy,
      }) as unknown as object;
    }
    await this.prisma.company.update({ where: { id: companyId }, data });
    return this.getSettings(companyId);
  }

  // ── leave requests ────────────────────────────────────────────────────────
  private mapLeave(r: {
    id: number;
    user_id: number;
    from_date: Date;
    to_date: Date;
    reason: string | null;
    status: string;
    review_note: string | null;
    reviewed_at: Date | null;
    created_at: Date;
  }) {
    return {
      id: r.id,
      userId: r.user_id,
      fromDate: r.from_date.toISOString().slice(0, 10),
      toDate: r.to_date.toISOString().slice(0, 10),
      reason: r.reason,
      status: r.status,
      reviewNote: r.review_note,
      reviewedAt: r.reviewed_at ? r.reviewed_at.toISOString() : null,
      createdAt: r.created_at.toISOString(),
    };
  }

  async requestLeave(companyId: number, userId: number, role: string, dto: LeaveRequestDto) {
    this.assertNotOwner(role);
    const from = dto.fromDate?.slice(0, 10);
    const to = dto.toDate?.slice(0, 10);
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new BadRequestException('Valid from/to dates are required');
    }
    if (to < from) throw new BadRequestException('"To" date is before "from" date');
    const created = await this.prisma.attendanceLeaveRequest.create({
      data: {
        company_id: companyId,
        user_id: userId,
        from_date: this.dateCol(from),
        to_date: this.dateCol(to),
        reason: dto.reason?.slice(0, 500) || null,
      },
    });
    return this.mapLeave(created);
  }

  async myLeave(companyId: number, userId: number) {
    const rows = await this.prisma.attendanceLeaveRequest.findMany({
      where: { company_id: companyId, user_id: userId },
      orderBy: { created_at: 'desc' },
      take: 50,
    });
    return rows.map((r) => this.mapLeave(r));
  }

  async listLeave(companyId: number, status?: string) {
    const rows = await this.prisma.attendanceLeaveRequest.findMany({
      where: {
        company_id: companyId,
        ...(status === 'pending' || status === 'approved' || status === 'rejected'
          ? { status }
          : {}),
      },
      orderBy: [{ status: 'asc' }, { created_at: 'desc' }],
      take: 200,
      include: { user: { select: { name: true, role: true } } },
    });
    return rows.map((r) => ({
      ...this.mapLeave(r),
      userName: r.user?.name ?? 'Teammate',
      userRole: r.user?.role ?? '',
    }));
  }

  async reviewLeave(companyId: number, adminId: number, id: number, dto: ReviewLeaveDto) {
    const req = await this.prisma.attendanceLeaveRequest.findFirst({
      where: { id, company_id: companyId },
    });
    if (!req) throw new NotFoundException('Leave request not found');
    if (dto.status !== 'approved' && dto.status !== 'rejected') {
      throw new BadRequestException('status must be approved or rejected');
    }
    const updated = await this.prisma.attendanceLeaveRequest.update({
      where: { id },
      data: {
        status: dto.status,
        reviewed_by_user_id: adminId,
        reviewed_at: new Date(),
        review_note: dto.reviewNote?.slice(0, 255) || null,
      },
    });
    // Approving auto-marks each day in the range as leave.
    if (dto.status === 'approved') {
      for (const dateStr of this.dateRange(
        req.from_date.toISOString().slice(0, 10),
        req.to_date.toISOString().slice(0, 10),
      )) {
        const workDate = this.dateCol(dateStr);
        const existing = await this.prisma.attendanceRecord.findFirst({
          where: { company_id: companyId, user_id: req.user_id, work_date: workDate },
          select: { id: true },
        });
        if (existing) {
          await this.prisma.attendanceRecord.update({
            where: { id: existing.id },
            data: { status: 'leave', system_marked: true, marked_by_user_id: adminId, is_late: false },
          });
        } else {
          await this.prisma.attendanceRecord.create({
            data: {
              company_id: companyId,
              user_id: req.user_id,
              work_date: workDate,
              status: 'leave',
              system_marked: true,
              marked_by_user_id: adminId,
            },
          });
        }
      }
    }
    return this.mapLeave(updated);
  }

  // ── nightly sweep (cron): auto-absent + missed-checkout ────────────────────
  async dailySweep() {
    const companies = await this.prisma.company.findMany({ select: { id: true, timezone: true } });
    let absent = 0;
    let missed = 0;
    for (const co of companies) {
      try {
        // The most-recently-completed tenant-local day = yesterday.
        const { dateStr: todayStr } = this.localParts(new Date(), co.timezone);
        const yStr = new Date(this.dateCol(todayStr).getTime() - 86400000)
          .toISOString()
          .slice(0, 10);
        const workDate = this.dateCol(yStr);
        const members = await this.activeMembers(co.id);
        if (!members.length) continue;
        const rows = (await this.prisma.attendanceRecord.findMany({
          where: {
            company_id: co.id,
            user_id: { in: members.map((m) => m.id) },
            work_date: workDate,
          },
        })) as DbRow[];
        const byUser = new Map(rows.map((r) => [r.user_id, r]));
        for (const m of members) {
          const r = byUser.get(m.id);
          if (!r) {
            await this.prisma.attendanceRecord.create({
              data: {
                company_id: co.id,
                user_id: m.id,
                work_date: workDate,
                status: 'absent',
                system_marked: true,
              },
            });
            absent += 1;
          } else if (r.check_in_at && !r.check_out_at && !r.missed_checkout) {
            await this.prisma.attendanceRecord.update({
              where: { id: r.id },
              data: { missed_checkout: true },
            });
            missed += 1;
          }
        }
      } catch {
        /* one tenant failing must not abort the sweep */
      }
    }
    return { ok: true, absentMarked: absent, missedCheckoutFlagged: missed };
  }

  // ── CSV export ────────────────────────────────────────────────────────────
  async reportCsv(companyId: number, fromStr: string, toStr: string): Promise<string> {
    const { dates, members } = await this.report(companyId, fromStr, toStr);
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const fmtTime = (iso: string | null) => (iso ? iso.slice(11, 16) : '');
    const hrs = (m: number | null) => (m == null ? '' : `${Math.floor(m / 60)}h ${m % 60}m`);

    const header = ['Member', 'Role', 'Date', 'Status', 'Check in', 'Check out', 'Hours', 'Late', 'Missed checkout', 'Note'];
    const lines = [header.map(esc).join(',')];
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
            c.missedCheckout ? 'yes' : '',
            c.note ?? '',
          ].map(esc).join(','),
        );
      }
    }
    return lines.join('\n');
  }
}
