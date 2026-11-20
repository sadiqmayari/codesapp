// Payroll v2 — ONE pure payslip calculator (unit-tested in payroll-math.spec.ts).
// AttendanceService.payroll() loads data and calls computePayslip() per member;
// approved runs store its output as the locked snapshot.

import { Allowance, PayrollPolicy } from './payroll';
import {
  WorkCalendar,
  dateRange,
  dayKind,
  minutesSinceShiftStart,
  monthBounds,
  shiftEndInstant,
  shiftMinutes,
} from './schedule';
import { DEFAULT_REQUIRED_MINUTES } from './auto-checkout';

export interface PayslipMember {
  userId: number;
  name: string;
  role: string;
  salary: number;
  allowances: Allowance[];
  overtimeRate: number | null;
  flexible: boolean;
  start: string;
  end: string | null;
  grace: number;
  requiredMinutes: number | null;
  joinedOn: string | null; // YYYY-MM-DD
  leftOn: string | null;
}

export interface PayslipRecord {
  date: string;
  status: 'present' | 'absent' | 'leave' | 'half_day' | 'holiday';
  checkInAt: Date | null;
  checkOutAt: Date | null;
  isLate: boolean;
  checkoutSource: string | null;
}

export interface PayslipAdjustment {
  id?: number;
  kind: string; // bonus | reimbursement | deduction | advance | loan
  label: string;
  amount: number;
}

export interface PayslipCommission {
  total: number;
  lines: { planId: number; planName: string; units: number; base: number; amount: number }[];
}

export interface PayslipLineItem {
  label: string;
  amount: number;
  kind: 'earning' | 'deduction';
  detail?: string;
}

export interface Payslip {
  userId: number;
  name: string;
  role: string;
  flexible: boolean;
  month: string;
  periodFrom: string;
  periodTo: string;
  prorated: boolean;
  salary: number;
  base: number;
  allowances: Allowance[];
  allowanceTotal: number;
  scheduledDays: number;
  present: number;
  absent: number;
  halfDay: number;
  paidLeave: number;
  unpaidLeave: number;
  offDays: number;
  offDaysWorked: number;
  unmarkedDays: number;
  autoClosed: number;
  lateCount: number;
  lateMinutes: number;
  workedMinutes: number;
  overtimeMinutes: number;
  dayRate: number;
  overtimePay: number;
  commission: number;
  commissionLines: PayslipCommission['lines'];
  absenceDeduction: number;
  unpaidLeaveDeduction: number;
  halfDayDeduction: number;
  lateDeduction: number;
  autoCheckoutDeduction: number;
  statutoryDeduction: number;
  adjustmentsPlus: number;
  adjustmentsMinus: number;
  adjustments: PayslipAdjustment[];
  gross: number;
  deductions: number;
  netPayable: number;
  lines: PayslipLineItem[];
}

export const ADJUSTMENT_KINDS = ['bonus', 'reimbursement', 'deduction', 'advance', 'loan'] as const;
export const isAdditiveAdjustment = (kind: string) => kind === 'bonus' || kind === 'reimbursement';

const r2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
const hm = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;

export interface PayslipInput {
  member: PayslipMember;
  month: string;
  records: PayslipRecord[];
  calendar: WorkCalendar;
  unpaidLeaveDays: Set<string>;
  adjustments: PayslipAdjustment[];
  commission: PayslipCommission | null;
  policy: PayrollPolicy;
  tz: string | null;
  /** Tenant-local today; future days are never counted as absent/unmarked. */
  today: string;
}

/** Null when the member was not employed at all during the month. */
export function computePayslip(input: PayslipInput): Payslip | null {
  const { member: m, month, policy, calendar, tz } = input;
  const mb = monthBounds(month);
  const from = m.joinedOn && m.joinedOn > mb.from ? m.joinedOn : mb.from;
  const to = m.leftOn && m.leftOn < mb.to ? m.leftOn : mb.to;
  if (from > to) return null;

  const monthDays = dateRange(mb.from, mb.to);
  const windowDays = dateRange(from, to);
  const monthWork = monthDays.filter((d) => dayKind(d, calendar) === 'work').length;
  const windowWork = windowDays.filter((d) => dayKind(d, calendar) === 'work').length;
  const prorated = from !== mb.from || to !== mb.to;

  const divisor =
    policy.dayRateBasis === 'thirty'
      ? 30
      : policy.dayRateBasis === 'fixed'
        ? policy.workingDaysPerMonth
        : Math.max(1, monthWork);
  const ratio = !prorated
    ? 1
    : policy.dayRateBasis === 'thirty'
      ? windowDays.length / mb.days
      : monthWork > 0
        ? windowWork / monthWork
        : 0;

  const salary = m.salary;
  const base = salary * ratio;
  const dayRate = divisor > 0 ? salary / divisor : 0;
  const expectedPerDay = m.flexible
    ? m.requiredMinutes ?? DEFAULT_REQUIRED_MINUTES
    : shiftMinutes(m.start, m.end) ?? DEFAULT_REQUIRED_MINUTES;
  const minuteRate = expectedPerDay > 0 ? dayRate / expectedPerDay : 0;

  const byDate = new Map(input.records.map((r) => [r.date, r]));
  let present = 0,
    absent = 0,
    halfDay = 0,
    paidLeave = 0,
    unpaidLeave = 0,
    offDays = 0,
    offDaysWorked = 0,
    unmarked = 0,
    autoClosed = 0,
    lateCount = 0,
    lateMinutes = 0,
    worked = 0,
    otMinutes = 0;

  for (const d of windowDays) {
    const kind = dayKind(d, calendar);
    const r = byDate.get(d);
    const w = r?.checkInAt && r.checkOutAt ? Math.max(0, Math.round((r.checkOutAt.getTime() - r.checkInAt.getTime()) / 60000)) : 0;
    worked += w;

    if (kind !== 'work' || r?.status === 'holiday') {
      offDays += 1;
      if (r?.checkInAt && w > 0) {
        offDaysWorked += 1;
        if (r.checkoutSource !== 'auto' && w >= policy.minOvertimeMinutes) otMinutes += w;
      }
      continue;
    }
    if (!r) {
      if (d < input.today) unmarked += 1;
      continue;
    }
    switch (r.status) {
      case 'present':
        present += 1;
        break;
      case 'half_day':
        halfDay += 1;
        break;
      case 'absent':
        absent += 1;
        break;
      case 'leave':
        if (input.unpaidLeaveDays.has(d)) unpaidLeave += 1;
        else paidLeave += 1;
        break;
    }
    const attended = r.status === 'present' || r.status === 'half_day';
    if (!attended) continue;

    if (r.checkoutSource === 'auto') autoClosed += 1;

    if (!m.flexible && r.isLate && r.checkInAt) {
      lateCount += 1;
      lateMinutes += Math.max(0, minutesSinceShiftStart(r.checkInAt, d, m.start, tz) - m.grace);
    }

    if (r.checkoutSource === 'auto' || !r.checkOutAt || !r.checkInAt) continue;
    let dayOt = 0;
    if (!m.flexible && policy.otOnlyAfterShiftEnd && m.end) {
      const endAt = shiftEndInstant(d, m.start, m.end, tz);
      dayOt = Math.max(0, Math.round((r.checkOutAt.getTime() - Math.max(endAt.getTime(), r.checkInAt.getTime())) / 60000));
    } else {
      dayOt = Math.max(0, w - expectedPerDay);
    }
    if (dayOt > 0 && dayOt >= policy.minOvertimeMinutes) otMinutes += dayOt;
  }
  if (policy.otMonthlyCapMin > 0) otMinutes = Math.min(otMinutes, policy.otMonthlyCapMin);

  // ── deductions ──
  const absenceDeduction = absent * dayRate;
  const unpaidLeaveDeduction = unpaidLeave * dayRate;
  const halfDayDeduction = halfDay * 0.5 * dayRate;
  let lateDeduction = 0;
  if (!m.flexible) {
    if (policy.lateMethod === 'n_lates_absent') lateDeduction = Math.floor(lateCount / policy.latesPerAbsent) * dayRate;
    else if (policy.lateMethod === 'fixed_per_late') lateDeduction = lateCount * policy.lateFixedAmount;
    else if (policy.lateMethod === 'per_minute') lateDeduction = lateMinutes * minuteRate;
  }
  const autoCheckoutDeduction =
    policy.autoCheckoutPenalty === 'absent'
      ? autoClosed * dayRate
      : policy.autoCheckoutPenalty === 'half_day'
        ? autoClosed * 0.5 * dayRate
        : 0;

  // ── overtime ──
  let overtimePay = 0;
  if (policy.overtimeMethod === 'hourly_multiplier') overtimePay = otMinutes * minuteRate * policy.overtimeMultiplier;
  else if (policy.overtimeMethod === 'flat_per_hour') overtimePay = (otMinutes / 60) * (m.overtimeRate ?? policy.overtimeFlatRate);
  else if (policy.overtimeMethod === 'per_minute') overtimePay = otMinutes * minuteRate;

  const statutoryItems = policy.statutory.map((s) => ({
    label: s.label,
    amount: r2(s.type === 'percent' ? (base * s.value) / 100 : s.value * (prorated ? ratio : 1)),
    detail: s.type === 'percent' ? `${s.value}% of base` : undefined,
  }));

  const commission = input.commission?.total ?? 0;
  const plusAdj = input.adjustments.filter((a) => isAdditiveAdjustment(a.kind));
  const minusAdj = input.adjustments.filter((a) => !isAdditiveAdjustment(a.kind));

  // ── line items (rounded once; totals are sums of the rounded lines) ──
  const lines: PayslipLineItem[] = [];
  const earn = (label: string, amount: number, detail?: string) => {
    const a = r2(amount);
    if (a !== 0) lines.push({ label, amount: a, kind: 'earning', detail });
    return a;
  };
  const ded = (label: string, amount: number, detail?: string) => {
    const a = r2(amount);
    if (a !== 0) lines.push({ label, amount: a, kind: 'deduction', detail });
    return a;
  };

  const baseR = earn('Base salary', base, prorated ? `${windowWork} of ${monthWork} work days` : undefined);
  let allowR = 0;
  for (const a of m.allowances) allowR += earn(a.label, a.amount * ratio);
  const otR = earn('Overtime', overtimePay, otMinutes ? hm(otMinutes) : undefined);
  let commR = 0;
  for (const c of input.commission?.lines ?? []) commR += earn(`Commission · ${c.planName}`, c.amount);
  if (!input.commission?.lines?.length && commission) commR += earn('Commission', commission);
  let plusR = 0;
  for (const a of plusAdj) plusR += earn(a.label, Math.abs(a.amount), a.kind);

  const absR = ded('Absences', absenceDeduction, absent ? `${absent} day${absent > 1 ? 's' : ''}` : undefined);
  const unpR = ded('Unpaid leave', unpaidLeaveDeduction, unpaidLeave ? `${unpaidLeave} day${unpaidLeave > 1 ? 's' : ''}` : undefined);
  const halfR = ded('Half days', halfDayDeduction, halfDay ? `${halfDay} × ½ day` : undefined);
  const lateR = ded('Late arrivals', lateDeduction, lateCount ? `${lateCount} late · ${lateMinutes} min` : undefined);
  const autoR = ded('Missed check-out', autoCheckoutDeduction, autoClosed ? `${autoClosed} auto-closed` : undefined);
  let statR = 0;
  for (const s of statutoryItems) statR += ded(s.label, s.amount, s.detail);
  let minusR = 0;
  for (const a of minusAdj) minusR += ded(a.label, Math.abs(a.amount), a.kind);

  const gross = r2(baseR + allowR + otR + commR + plusR);
  const deductions = r2(absR + unpR + halfR + lateR + autoR + statR + minusR);

  return {
    userId: m.userId,
    name: m.name,
    role: m.role,
    flexible: m.flexible,
    month,
    periodFrom: from,
    periodTo: to,
    prorated,
    salary: r2(salary),
    base: baseR,
    allowances: m.allowances,
    allowanceTotal: r2(allowR),
    scheduledDays: windowWork,
    present,
    absent,
    halfDay,
    paidLeave,
    unpaidLeave,
    offDays,
    offDaysWorked,
    unmarkedDays: unmarked,
    autoClosed,
    lateCount,
    lateMinutes,
    workedMinutes: worked,
    overtimeMinutes: otMinutes,
    dayRate: r2(dayRate),
    overtimePay: otR,
    commission: r2(commR),
    commissionLines: input.commission?.lines ?? [],
    absenceDeduction: absR,
    unpaidLeaveDeduction: unpR,
    halfDayDeduction: halfR,
    lateDeduction: lateR,
    autoCheckoutDeduction: autoR,
    statutoryDeduction: r2(statR),
    adjustmentsPlus: r2(plusR),
    adjustmentsMinus: r2(minusR),
    adjustments: input.adjustments,
    gross,
    deductions,
    netPayable: Math.max(0, r2(gross - deductions)),
    lines,
  };
}
