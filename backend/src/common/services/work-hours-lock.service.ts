import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from './cache.service';
import { FeatureService } from './feature.service';
import {
  DEFAULT_LOCK_BUFFER_MIN,
  WorkLockState,
  formatOpensAt,
  workLockState,
} from '../../modules/attendance/work-lock';
import {
  addDays,
  dateCol,
  dateRange,
  localParts,
  resolveWeeklyOff,
  weekdayOf,
} from '../../modules/attendance/schedule';

/** Roles the after-shift lock never applies to. */
const LOCK_EXEMPT_ROLES = new Set(['owner', 'super_admin', 'admin', 'hr_manager']);
const INPUT_TTL_S = 60;
const DEFAULT_WORK_START = '09:30';

export const WORK_HOURS_LOCKED = 'WORK_HOURS_LOCKED';

type LockInputs = {
  enabled: boolean;
  tz: string | null;
  start: string;
  end: string | null;
  flexible: boolean;
  bufferMin: number;
  weeklyOff: number[];
  offDates: string[]; // holidays + approved leave, ~2 weeks around today
};

/**
 * "Lock app after shift end" — decides whether a member may hold a session
 * right now (login, refresh, every authenticated request). Lives in the @Global
 * CommonModule so AuthModule can use it without importing AttendanceModule
 * (that would be an import cycle). The rule itself is the pure
 * `attendance/work-lock.ts`. Never throws except the intended 403.
 */
@Injectable()
export class WorkHoursLockService {
  private readonly log = new Logger(WorkHoursLockService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly feature: FeatureService,
  ) {}

  private epoch(companyId: number): number {
    return this.cache.get<number>(`worklock:epoch:${companyId}`) ?? 0;
  }

  /** Call after any attendance schedule / lock setting change for the company. */
  invalidate(companyId: number): void {
    this.cache.set(`worklock:epoch:${companyId}`, this.epoch(companyId) + 1, 86_400);
  }

  private async inputs(companyId: number, userId: number): Promise<LockInputs | null> {
    const key = `worklock:${companyId}:${this.epoch(companyId)}:${userId}`;
    const hit = this.cache.get<LockInputs | null>(key);
    if (hit !== undefined) return hit;
    const [co, u] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: {
          timezone: true,
          work_start_time: true,
          work_end_time: true,
          attendance_weekly_off: true,
          attendance_lock_after_shift: true,
          attendance_lock_buffer_min: true,
        },
      }),
      this.prisma.user.findFirst({
        where: { id: userId, company_id: companyId },
        select: {
          attendance_work_start: true,
          attendance_work_end: true,
          attendance_exempt_late: true,
          attendance_weekly_off: true,
          attendance_lock_after_shift: true,
        },
      }),
    ]);
    if (!co || !u) {
      this.cache.set(key, null, INPUT_TTL_S);
      return null;
    }
    const enabled =
      (u.attendance_lock_after_shift ?? co.attendance_lock_after_shift) &&
      (await this.feature.enabled(companyId, 'attendance'));
    let offDates: string[] = [];
    if (enabled) {
      const today = localParts(new Date(), co.timezone).dateStr;
      const from = addDays(today, -1);
      const to = addDays(today, 15);
      const [hol, leaves] = await Promise.all([
        this.prisma.attendanceHoliday.findMany({
          where: { company_id: companyId, date: { gte: dateCol(from), lte: dateCol(to) } },
          select: { date: true },
        }),
        this.prisma.attendanceLeaveRequest.findMany({
          where: {
            company_id: companyId,
            user_id: userId,
            status: 'approved',
            kind: 'leave',
            from_date: { lte: dateCol(to) },
            to_date: { gte: dateCol(from) },
          },
          select: { from_date: true, to_date: true },
        }),
      ]);
      const set = new Set(hol.map((h) => h.date.toISOString().slice(0, 10)));
      for (const l of leaves) {
        for (const d of dateRange(l.from_date.toISOString().slice(0, 10), l.to_date.toISOString().slice(0, 10), 70)) set.add(d);
      }
      offDates = [...set];
    }
    const coWeekly = resolveWeeklyOff(co.attendance_weekly_off, [0]);
    const v: LockInputs = {
      enabled: !!enabled,
      tz: co.timezone ?? null,
      start: u.attendance_work_start || co.work_start_time || DEFAULT_WORK_START,
      end: u.attendance_work_end || co.work_end_time || null,
      flexible: u.attendance_exempt_late,
      bufferMin: co.attendance_lock_buffer_min ?? DEFAULT_LOCK_BUFFER_MIN,
      weeklyOff: u.attendance_weekly_off == null ? coWeekly : resolveWeeklyOff(u.attendance_weekly_off, coWeekly),
      offDates,
    };
    this.cache.set(key, v, INPUT_TTL_S);
    return v;
  }

  /** Current lock state for a member; null when the lock does not apply. */
  async state(
    user: { id: number; company_id: number | null; role: string },
    now = new Date(),
  ): Promise<(WorkLockState & { tz: string | null }) | null> {
    if (!user.company_id || LOCK_EXEMPT_ROLES.has(user.role)) return null;
    try {
      const i = await this.inputs(user.company_id, user.id);
      if (!i || !i.enabled) return null;
      const off = new Set(i.offDates);
      const s = workLockState({
        now,
        tz: i.tz,
        start: i.start,
        end: i.end,
        flexible: i.flexible,
        bufferMin: i.bufferMin,
        isWorkDay: (d) => !off.has(d) && !i.weeklyOff.includes(weekdayOf(d)),
      });
      return { ...s, tz: i.tz };
    } catch (e) {
      this.log.warn(`work-hours lock check failed for user ${user.id}: ${(e as Error).message}`);
      return null; // fail open
    }
  }

  /** 403 WORK_HOURS_LOCKED when the member is outside their working hours. */
  async assertMayUseApp(user: { id: number; company_id: number | null; role: string }): Promise<void> {
    const now = new Date();
    const s = await this.state(user, now);
    if (!s?.locked) return;
    const opens = formatOpensAt(s.opensAt, now, s.tz);
    throw new ForbiddenException({
      statusCode: 403,
      code: WORK_HOURS_LOCKED,
      opensAt: s.opensAt ? s.opensAt.toISOString() : null,
      opensAtLabel: opens,
      message: `Outside your working hours. Sign-in opens at ${opens}.`,
    });
  }
}
