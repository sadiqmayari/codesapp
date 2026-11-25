// Auto-checkout: closes a day nobody checked out of. Pure (unit-tested in
// auto-checkout.spec.ts). The worker's AutoCheckoutService feeds it every open
// attendance row on a 10-minute tick.

import { minutesToHHMM, shiftEndInstant, toMinutes } from './schedule';

export type AutoCheckoutMode = 'off' | 'shift_end' | 'max_hours';

export interface AutoCheckoutPolicy {
  /** off = never (nightly sweep only flags missed checkout). */
  mode: AutoCheckoutMode;
  /** shift_end mode: close this many minutes after the shift end. */
  afterEndMin: number;
  /** max_hours mode (and ALWAYS for flexible staff): close after this many hours open. */
  maxHours: number;
}

export const DEFAULT_AUTO_CHECKOUT: AutoCheckoutPolicy = {
  mode: 'shift_end',
  afterEndMin: 30,
  maxHours: 12,
};

export const DEFAULT_REQUIRED_MINUTES = 8 * 60;
export const DEFAULT_SHIFT_LENGTH_MIN = 8 * 60;

const clamp = (v: unknown, lo: number, hi: number, fb: number) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fb;
};

export function resolveAutoCheckout(raw: unknown): AutoCheckoutPolicy {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mode: AutoCheckoutMode =
    p.mode === 'off' || p.mode === 'shift_end' || p.mode === 'max_hours'
      ? p.mode
      : DEFAULT_AUTO_CHECKOUT.mode;
  return {
    mode,
    afterEndMin: clamp(p.afterEndMin, 0, 600, DEFAULT_AUTO_CHECKOUT.afterEndMin),
    maxHours: clamp(p.maxHours, 2, 20, DEFAULT_AUTO_CHECKOUT.maxHours),
  };
}

/** Auto-closed by the system (either credit basis). */
export const isAutoSource = (src: string | null | undefined) => src === 'auto' || src === 'auto_activity';
/** Auto-closed but credited at real app activity: overtime still counts. */
export const autoEarnsOvertime = (src: string | null | undefined) => src !== 'auto';

export interface OpenDay {
  workDay: string; // tenant-local YYYY-MM-DD the row belongs to
  checkInAt: Date;
  /** Last app-activity heartbeat while the day was open (null = none). */
  lastActiveAt?: Date | null;
}

export interface MemberSchedule {
  start: string; // HH:MM
  end: string | null; // HH:MM or null (→ start + 8h)
  flexible: boolean;
  requiredMinutes: number | null;
}

export type AutoCheckoutDecision =
  | { close: false }
  | { close: true; at: Date; reason: string; creditedBy: 'schedule' | 'activity' };

/**
 * Should this open day be closed now, and at what time should the check-out be
 * recorded? The credit is the LATER of the schedule credit (shift end for fixed
 * staff, required hours for flexible staff) and the person's last app activity,
 * so real extra hours count; it never runs past check-in + max hours, never
 * before the check-in and never into the future. A fixed-shift day is not
 * closed while the person is still active (closes `afterEndMin` after the later
 * of shift end and last activity, hard cap at max hours).
 */
export function autoCheckoutDecision(
  day: OpenDay,
  sched: MemberSchedule,
  policy: AutoCheckoutPolicy,
  tz: string | null,
  now: Date,
): AutoCheckoutDecision {
  if (policy.mode === 'off') return { close: false };
  const inMs = day.checkInAt.getTime();
  const nowMs = now.getTime();
  const capMs = inMs + policy.maxHours * 3_600_000;
  const lastMs = day.lastActiveAt ? day.lastActiveAt.getTime() : 0;
  const activeMs = lastMs > inMs ? Math.min(lastMs, capMs) : 0;

  const finish = (scheduleCredit: number, reason: string): AutoCheckoutDecision => {
    const byActivity = activeMs > scheduleCredit;
    const at = Math.min(byActivity ? activeMs : scheduleCredit, nowMs);
    return { close: true, at: new Date(Math.max(inMs, at)), reason, creditedBy: byActivity ? 'activity' : 'schedule' };
  };

  if (sched.flexible) {
    if (nowMs < capMs) return { close: false };
    const req = (sched.requiredMinutes ?? DEFAULT_REQUIRED_MINUTES) * 60_000;
    return finish(Math.min(inMs + req, capMs), 'flexible_max_hours');
  }

  const end = sched.end || minutesToHHMM(toMinutes(sched.start) + DEFAULT_SHIFT_LENGTH_MIN);
  const endAt = shiftEndInstant(day.workDay, sched.start, end, tz).getTime();
  const credit = Math.max(inMs, endAt);

  if (policy.mode === 'shift_end') {
    const afterMs = policy.afterEndMin * 60_000;
    const idleFrom = Math.max(endAt, activeMs);
    const hardCap = Math.max(capMs, endAt + afterMs);
    if (nowMs < idleFrom + afterMs && nowMs < hardCap) return { close: false };
    return finish(credit, 'shift_end');
  }
  // max_hours
  if (nowMs < capMs) return { close: false };
  return finish(Math.max(inMs, Math.min(endAt, capMs)), 'max_hours');
}
