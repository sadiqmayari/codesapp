// "Lock app after shift end" — pure rule (unit-tested in team-v4.spec.ts).
// Consumed by WorkHoursLockService (login / refresh / every JWT request).
//
// A tracked member with a FIXED shift may use the app from check-in opening
// (shift start − 30 min) until shift end + buffer on each work day. Outside
// that, on a work day, the app is locked until the next opening. Days off,
// holidays and approved leave are NEVER locked. Flexible staff are never locked.

import {
  addDays,
  localParts,
  localTimeToInstant,
  minutesToHHMM,
  shiftEndInstant,
  toMinutes,
  workDayFor,
} from './schedule';
import { DEFAULT_SHIFT_LENGTH_MIN } from './auto-checkout';

export const LOCK_EARLY_OPEN_MIN = 30; // same as the check-in window opening
export const DEFAULT_LOCK_BUFFER_MIN = 30;

export interface WorkLockInput {
  now: Date;
  tz: string | null;
  start: string; // HH:MM
  end: string | null; // HH:MM, null = start + 8h
  flexible: boolean;
  bufferMin: number;
  /** false for weekly off, holiday or approved leave. */
  isWorkDay: (dateStr: string) => boolean;
}

export interface WorkLockState {
  locked: boolean;
  /** When the app unlocks again (null when not locked). */
  opensAt: Date | null;
  /** Next time the app locks (null when locked, or no lock ahead today). */
  locksAt: Date | null;
}

function windowFor(day: string, i: WorkLockInput) {
  const end = i.end || minutesToHHMM(toMinutes(i.start) + DEFAULT_SHIFT_LENGTH_MIN);
  const open = new Date(localTimeToInstant(day, i.start, i.tz).getTime() - LOCK_EARLY_OPEN_MIN * 60_000);
  const close = new Date(shiftEndInstant(day, i.start, end, i.tz).getTime() + i.bufferMin * 60_000);
  return { open, close };
}

/** Next moment the app is usable after `fromDay` (next work day's opening, or the start of a day off). */
function nextOpening(fromDay: string, i: WorkLockInput): Date | null {
  for (let n = 1; n <= 14; n++) {
    const d = addDays(fromDay, n);
    if (!i.isWorkDay(d)) return localTimeToInstant(d, '00:00', i.tz);
    return windowFor(d, i).open;
  }
  return null;
}

export function workLockState(i: WorkLockInput): WorkLockState {
  if (i.flexible) return { locked: false, opensAt: null, locksAt: null };
  const day = workDayFor(i.now, i.tz, i.start, i.end);
  if (!i.isWorkDay(day)) return { locked: false, opensAt: null, locksAt: null };
  const { open, close } = windowFor(day, i);
  const t = i.now.getTime();
  if (t < open.getTime()) return { locked: true, opensAt: open, locksAt: null };
  if (t <= close.getTime()) return { locked: false, opensAt: null, locksAt: close };
  return { locked: true, opensAt: nextOpening(day, i), locksAt: null };
}

/** "09:00" today, or "Thu 09:00" on another tenant-local day. */
export function formatOpensAt(opensAt: Date | null, now: Date, tz: string | null): string {
  if (!opensAt) return 'your next shift';
  const a = localParts(opensAt, tz);
  const hhmm = minutesToHHMM(a.minutes);
  if (a.dateStr === localParts(now, tz).dateStr) return hhmm;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][a.weekday];
  return `${wd} ${hhmm}`;
}
