import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AttendanceStatusValue,
  OverrideAttendanceDto,
} from './dto/override-attendance.dto';
import { AttendanceSettingsDto } from './dto/attendance-settings.dto';

const DEFAULT_WORK_START = '09:30';

export interface AttendanceCell {
  date: string; // YYYY-MM-DD
  status: AttendanceStatusValue;
  checkInAt: string | null; // ISO
  checkOutAt: string | null; // ISO
  isLate: boolean;
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
  totalMinutes: number;
}

type DbRow = {
  id: number;
  user_id: number;
  work_date: Date;
  status: AttendanceStatusValue;
  check_in_at: Date | null;
  check_out_at: Date | null;
  is_late: boolean;
  note: string | null;
  marked_by_user_id: number | null;
};

@Injectable()
export class AttendanceService {
  constructor(private readonly prisma: PrismaService) {}

  // ── timezone helpers ──────────────────────────────────────────────────────
  private async companyClock(companyId: number) {
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { timezone: true, work_start_time: true },
    });
    return {
      tz: c?.timezone ?? null,
      workStart: c?.work_start_time || DEFAULT_WORK_START,
    };
  }

  /** Tenant-local calendar date (YYYY-MM-DD) + minutes-since-midnight of `at`. */
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

  /** Tenant UTC offset (minutes) at a given instant. */
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

  /** A YYYY-MM-DD string → the DATE column value (UTC midnight). */
  private dateCol(dateStr: string): Date {
    return new Date(`${dateStr}T00:00:00.000Z`);
  }

  /** A tenant-local wall time (HH:MM on dateStr) → the matching UTC instant. */
  private localTimeToInstant(dateStr: string, hhmm: string, tz: string | null): Date {
    const [y, mo, d] = dateStr.split('-').map(Number);
    const [hh, mm] = hhmm.split(':').map(Number);
    const naiveUtc = Date.UTC(y, mo - 1, d, hh, mm);
    // naiveUtc treats the wall clock as if it were UTC; back out the offset.
    const approx = new Date(naiveUtc);
    const off = this.offsetMinutes(approx, tz);
    return new Date(naiveUtc - off * 60000);
  }

  private startMinutes(workStart: string): number {
    const [h, m] = workStart.split(':').map(Number);
    return h * 60 + m;
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

  // ── self-service ────────────────────────────────────────────────────────
  async myToday(companyId: number, userId: number) {
    const { tz, workStart } = await this.companyClock(companyId);
    const { dateStr } = this.localParts(new Date(), tz);
    const row = (await this.prisma.attendanceRecord.findFirst({
      where: { company_id: companyId, user_id: userId, work_date: this.dateCol(dateStr) },
    })) as DbRow | null;
    return {
      date: dateStr,
      workStart,
      record: row ? this.toCell(row) : null,
    };
  }

  async checkIn(companyId: number, userId: number) {
    const now = new Date();
    const { tz, workStart } = await this.companyClock(companyId);
    const { dateStr, minutes } = this.localParts(now, tz);
    const isLate = minutes > this.startMinutes(workStart);
    const existing = (await this.prisma.attendanceRecord.findFirst({
      where: { company_id: companyId, user_id: userId, work_date: this.dateCol(dateStr) },
    })) as DbRow | null;

    if (existing) {
      if (existing.check_in_at) {
        // already checked in today — idempotent, return current state
        return this.toCell(existing);
      }
      const updated = (await this.prisma.attendanceRecord.update({
        where: { id: existing.id },
        data: { check_in_at: now, is_late: isLate, status: 'present' },
      })) as DbRow;
      return this.toCell(updated);
    }

    const created = (await this.prisma.attendanceRecord.create({
      data: {
        company_id: companyId,
        user_id: userId,
        work_date: this.dateCol(dateStr),
        status: 'present',
        check_in_at: now,
        is_late: isLate,
      },
    })) as DbRow;
    return this.toCell(created);
  }

  async checkOut(companyId: number, userId: number) {
    const now = new Date();
    const { tz } = await this.companyClock(companyId);
    const { dateStr } = this.localParts(now, tz);
    const existing = (await this.prisma.attendanceRecord.findFirst({
      where: { company_id: companyId, user_id: userId, work_date: this.dateCol(dateStr) },
    })) as DbRow | null;
    if (!existing || !existing.check_in_at) {
      throw new BadRequestException('Check in first');
    }
    const updated = (await this.prisma.attendanceRecord.update({
      where: { id: existing.id },
      data: { check_out_at: now },
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

  // ── admin report ──────────────────────────────────────────────────────────
  private activeMembers(companyId: number) {
    return this.prisma.user.findMany({
      where: { company_id: companyId, status: { not: 'suspended' } },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });
  }

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
    for (const m of members) {
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
        totalMinutes: 0,
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
      a.totalMinutes += this.workedMinutes(r) ?? 0;
    }

    return { month, from: fromStr, to: toStr, rows: Array.from(agg.values()) };
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
    const member = await this.prisma.user.findFirst({
      where: { id: userId, company_id: companyId },
      select: { id: true },
    });
    if (!member) throw new NotFoundException('Team member not found');

    const { tz, workStart } = await this.companyClock(companyId);
    const workDate = this.dateCol(dateStr);
    const existing = (await this.prisma.attendanceRecord.findFirst({
      where: { company_id: companyId, user_id: userId, work_date: workDate },
    })) as DbRow | null;

    const data: Record<string, unknown> = { marked_by_user_id: adminId };
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.note !== undefined) data.note = dto.note || null;

    let checkInInstant = existing?.check_in_at ?? null;
    if (dto.checkIn !== undefined) {
      checkInInstant = dto.checkIn ? this.localTimeToInstant(dateStr, dto.checkIn, tz) : null;
      data.check_in_at = checkInInstant;
    }
    if (dto.checkOut !== undefined) {
      data.check_out_at = dto.checkOut
        ? this.localTimeToInstant(dateStr, dto.checkOut, tz)
        : null;
    }

    // Recompute lateness from the effective check-in when a present day.
    const effStatus = (dto.status ?? existing?.status ?? 'present') as AttendanceStatusValue;
    if (checkInInstant && effStatus === 'present') {
      const { minutes } = this.localParts(checkInInstant, tz);
      data.is_late = minutes > this.startMinutes(workStart);
    } else if (dto.checkIn !== undefined || dto.status !== undefined) {
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
  async getSettings(companyId: number) {
    const { workStart } = await this.companyClock(companyId);
    return { workStartTime: workStart };
  }

  async setSettings(companyId: number, dto: AttendanceSettingsDto) {
    await this.prisma.company.update({
      where: { id: companyId },
      data: { work_start_time: dto.workStartTime || null },
    });
    return this.getSettings(companyId);
  }

  // ── CSV export ────────────────────────────────────────────────────────────
  async reportCsv(companyId: number, fromStr: string, toStr: string): Promise<string> {
    const { dates, members } = await this.report(companyId, fromStr, toStr);
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const fmtTime = (iso: string | null) => (iso ? iso.slice(11, 16) : '');
    const hrs = (m: number | null) =>
      m == null ? '' : `${Math.floor(m / 60)}h ${m % 60}m`;

    const header = ['Member', 'Role', 'Date', 'Status', 'Check in', 'Check out', 'Hours', 'Late', 'Note'];
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
            c.note ?? '',
          ].map(esc).join(','),
        );
      }
    }
    return lines.join('\n');
  }
}
