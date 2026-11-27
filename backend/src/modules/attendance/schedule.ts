// Pure time/calendar helpers for attendance. No Nest/Prisma imports so they
// are unit-testable in isolation (see schedule.spec.ts). The TENANT clock
// (`companies.timezone`, IANA) is the source of truth for every "day" and
// every HH:MM; a null tz means UTC.

export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const HHMM_OR_EMPTY_RE = /^(([01]\d|2[0-3]):[0-5]\d)?$/;
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const MINUTES_PER_DAY = 24 * 60;

/** A real calendar day (rejects 2026-02-31). */
export function isValidDay(s: string | null | undefined): s is string {
  if (!s || !DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Clamp to 00:00–23:59 and format. */
export function minutesToHHMM(mins: number): string {
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY - 1, Math.round(mins)));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

/** Shift length in minutes. Wraps past midnight (22:00→06:00 = 480). Null end → null. */
export function shiftMinutes(start: string, end: string | null): number | null {
  if (!end) return null;
  const d = toMinutes(end) - toMinutes(start);
  return d > 0 ? d : d + MINUTES_PER_DAY;
}

export function isOvernight(start: string, end: string | null): boolean {
  return !!end && toMinutes(end) <= toMinutes(start);
}

export function localParts(at: Date, tz: string | null): { dateStr: string; minutes: number; weekday: number } {
  const fallback = () => ({
    dateStr: at.toISOString().slice(0, 10),
    minutes: at.getUTCHours() * 60 + at.getUTCMinutes(),
    weekday: at.getUTCDay(),
  });
  if (!tz) return fallback();
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
    const dateStr = `${p.year}-${p.month}-${p.day}`;
    return { dateStr, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: weekdayOf(dateStr) };
  } catch {
    return fallback();
  }
}

export function offsetMinutes(at: Date, tz: string | null): number {
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

/** Tenant-local `dateStr` + `HH:MM` → UTC instant. */
export function localTimeToInstant(dateStr: string, hhmm: string, tz: string | null): Date {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const naiveUtc = Date.UTC(y, mo - 1, d, hh, mm);
  const off = offsetMinutes(new Date(naiveUtc), tz);
  return new Date(naiveUtc - off * 60000);
}

/** `@db.Date` column value for a tenant-local day. */
export function dateCol(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

export function addDays(dateStr: string, n: number): string {
  return new Date(dateCol(dateStr).getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD day. */
export function weekdayOf(dateStr: string): number {
  return dateCol(dateStr).getUTCDay();
}

export function dateRange(fromStr: string, toStr: string, maxDays = 400): string[] {
  const out: string[] = [];
  let d = fromStr;
  while (d <= toStr && out.length < maxDays) {
    out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

export function monthBounds(month: string): { from: string; to: string; days: number } {
  const [y, mo] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(days).padStart(2, '0')}`, days };
}

/** Normalise a stored weekly-off JSON to a sorted unique [0..6] list. NULL → fallback. */
export function resolveWeeklyOff(raw: unknown, fallback: number[] = [0]): number[] {
  if (!Array.isArray(raw)) return fallback;
  const out = Array.from(
    new Set(raw.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)),
  ).sort();
  return out;
}

export interface WorkCalendar {
  weeklyOff: number[];
  holidays: Set<string>;
}

export type DayKind = 'work' | 'weekly_off' | 'holiday';

export function dayKind(dateStr: string, cal: WorkCalendar): DayKind {
  if (cal.holidays.has(dateStr)) return 'holiday';
  if (cal.weeklyOff.includes(weekdayOf(dateStr))) return 'weekly_off';
  return 'work';
}

/**
 * The tenant-local "work day" a punch belongs to. For an overnight shift a punch
 * in the small hours (before the shift end + a 4h buffer) belongs to the
 * PREVIOUS day's shift. Day shifts: just the local date.
 */
export function workDayFor(
  at: Date,
  tz: string | null,
  start: string,
  end: string | null,
): string {
  const lp = localParts(at, tz);
  if (isOvernight(start, end) && end) {
    const cutoff = Math.min(toMinutes(start) - 1, toMinutes(end) + 4 * 60);
    if (lp.minutes <= cutoff) return addDays(lp.dateStr, -1);
  }
  return lp.dateStr;
}

/** Minutes from a shift's own start on `workDay` to instant `at` (can exceed 1440 on overnight). */
export function minutesSinceShiftStart(at: Date, workDay: string, start: string, tz: string | null): number {
  const startAt = localTimeToInstant(workDay, start, tz);
  return Math.round((at.getTime() - startAt.getTime()) / 60000);
}

/** Instant the shift ends for `workDay` (overnight → next calendar day). */
export function shiftEndInstant(workDay: string, start: string, end: string, tz: string | null): Date {
  return localTimeToInstant(isOvernight(start, end) ? addDays(workDay, 1) : workDay, end, tz);
}

/** Flexible staff default required hours per day. */
export const DEFAULT_REQUIRED_MINUTES = 8 * 60;
/** Fixed shift with no end set → start + 8h. */
export const DEFAULT_SHIFT_LENGTH_MIN = 8 * 60;

// Auto-checkout was removed (Nov-2026); historical rows can still carry
// checkout_source 'auto' | 'auto_activity'. These keep them labelled and
// keep plain 'auto' days from earning overtime.
/** Closed by the (retired) auto-checkout. */
export const isAutoSource = (src: string | null | undefined) => src === 'auto' || src === 'auto_activity';
/** Historical auto-closed at schedule credit ('auto') earns no overtime. */
export const autoEarnsOvertime = (src: string | null | undefined) => src !== 'auto';
