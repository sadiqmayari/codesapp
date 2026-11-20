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

export interface OpenDay {
  workDay: string; // tenant-local YYYY-MM-DD the row belongs to
  checkInAt: Date;
}

export interface MemberSchedule {
  start: string; // HH:MM
  end: string | null; // HH:MM or null (→ start + 8h)
  flexible: boolean;
  requiredMinutes: number | null;
}

export type AutoCheckoutDecision = { close: false } | { close: true; at: Date; reason: string };

/**
 * Should this open day be closed now, and at what time should the check-out be
 * recorded? Credit never runs past the shift end (fixed staff) or past the
 * required hours (flexible staff), and never before the check-in.
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
  const maxMs = policy.maxHours * 3_600_000;

  if (sched.flexible) {
    if (nowMs < inMs + maxMs) return { close: false };
    const req = (sched.requiredMinutes ?? DEFAULT_REQUIRED_MINUTES) * 60_000;
    return { close: true, at: new Date(Math.min(inMs + req, nowMs)), reason: 'flexible_max_hours' };
  }

  const end = sched.end || minutesToHHMM(toMinutes(sched.start) + DEFAULT_SHIFT_LENGTH_MIN);
  const endAt = shiftEndInstant(day.workDay, sched.start, end, tz).getTime();
  const credit = Math.max(inMs, endAt);

  if (policy.mode === 'shift_end') {
    if (nowMs < endAt + policy.afterEndMin * 60_000) return { close: false };
    return { close: true, at: new Date(Math.min(credit, nowMs)), reason: 'shift_end' };
  }
  // max_hours
  if (nowMs < inMs + maxMs) return { close: false };
  return {
    close: true,
    at: new Date(Math.min(Math.max(inMs, Math.min(endAt, inMs + maxMs)), nowMs)),
    reason: 'max_hours',
  };
}
