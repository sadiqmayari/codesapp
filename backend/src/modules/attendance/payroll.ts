// Attendance v3 — payroll policy types, defaults, and a single resolver used by
// both the settings read/write and the payroll/lateness computation. Keep the
// stored shape (companies.attendance_payroll_policy JSON) flowing through
// `resolvePolicy` so a partial/legacy blob always yields a complete, clamped
// policy (defaults = late + overtime OFF).

export type LateMethod =
  | 'none'
  | 'n_lates_absent'
  | 'fixed_per_late'
  | 'per_minute'
  | 'half_day';

export type OvertimeMethod =
  | 'off'
  | 'hourly_multiplier'
  | 'flat_per_hour'
  | 'per_minute';

export const LATE_METHODS: LateMethod[] = [
  'none',
  'n_lates_absent',
  'fixed_per_late',
  'per_minute',
  'half_day',
];

export const OVERTIME_METHODS: OvertimeMethod[] = [
  'off',
  'hourly_multiplier',
  'flat_per_hour',
  'per_minute',
];

export interface PayrollPolicy {
  lateMethod: LateMethod;
  latesPerAbsent: number; // n_lates_absent: N lates → 1 absent-day deduction
  lateFixedAmount: number; // fixed_per_late: Rs deducted per late
  halfDayAfterMin: number; // half_day: late by > X min → half-day
  overtimeMethod: OvertimeMethod;
  overtimeMultiplier: number; // hourly_multiplier: e.g. 1.5
  overtimeFlatRate: number; // flat_per_hour: Rs/hour (company fallback)
  minOvertimeMinutes: number; // ignore OT below this many minutes/day
  workingDaysPerMonth: number; // divisor for daily/minute rate
}

export const DEFAULT_PAYROLL_POLICY: PayrollPolicy = {
  lateMethod: 'none',
  latesPerAbsent: 3,
  lateFixedAmount: 0,
  halfDayAfterMin: 60,
  overtimeMethod: 'off',
  overtimeMultiplier: 1.5,
  overtimeFlatRate: 0,
  minOvertimeMinutes: 0,
  workingDaysPerMonth: 26,
};

const clampNum = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** Merge a stored (possibly partial/legacy/null) policy JSON over the defaults
 *  and clamp every field to a safe range. Always returns a complete policy. */
export function resolvePolicy(raw: unknown): PayrollPolicy {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const lateMethod = LATE_METHODS.includes(p.lateMethod as LateMethod)
    ? (p.lateMethod as LateMethod)
    : DEFAULT_PAYROLL_POLICY.lateMethod;
  const overtimeMethod = OVERTIME_METHODS.includes(p.overtimeMethod as OvertimeMethod)
    ? (p.overtimeMethod as OvertimeMethod)
    : DEFAULT_PAYROLL_POLICY.overtimeMethod;
  return {
    lateMethod,
    overtimeMethod,
    latesPerAbsent: Math.round(clampNum(p.latesPerAbsent, 1, 31, DEFAULT_PAYROLL_POLICY.latesPerAbsent)),
    lateFixedAmount: clampNum(p.lateFixedAmount, 0, 10_000_000, DEFAULT_PAYROLL_POLICY.lateFixedAmount),
    halfDayAfterMin: Math.round(clampNum(p.halfDayAfterMin, 1, 600, DEFAULT_PAYROLL_POLICY.halfDayAfterMin)),
    overtimeMultiplier: clampNum(p.overtimeMultiplier, 0, 10, DEFAULT_PAYROLL_POLICY.overtimeMultiplier),
    overtimeFlatRate: clampNum(p.overtimeFlatRate, 0, 10_000_000, DEFAULT_PAYROLL_POLICY.overtimeFlatRate),
    minOvertimeMinutes: Math.round(clampNum(p.minOvertimeMinutes, 0, 600, DEFAULT_PAYROLL_POLICY.minOvertimeMinutes)),
    workingDaysPerMonth: Math.round(
      clampNum(p.workingDaysPerMonth, 1, 31, DEFAULT_PAYROLL_POLICY.workingDaysPerMonth),
    ),
  };
}

export interface Allowance {
  label: string;
  amount: number;
}

/** Normalize a stored allowances JSON into a clean, bounded array. */
export function resolveAllowances(raw: unknown): Allowance[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) => {
      const o = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
      const label = String(o.label ?? '').slice(0, 60).trim();
      const amount = Number(o.amount);
      return { label, amount: Number.isFinite(amount) ? amount : 0 };
    })
    .filter((a) => a.label.length > 0)
    .slice(0, 20);
}
