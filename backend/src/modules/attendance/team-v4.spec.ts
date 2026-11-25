import { autoCheckoutDecision, resolveAutoCheckout } from './auto-checkout';
import { computePayslip, PayslipInput, PayslipRecord } from './payroll-math';
import { resolvePolicy } from './payroll';
import {
  isValidDay,
  localTimeToInstant,
  resolveWeeklyOff,
  shiftMinutes,
  workDayFor,
} from './schedule';
import { calcAmount, computePlan, resolvePlanConfig, UserUnits } from '../commissions/commission-math';

const TZ = 'Asia/Karachi';
const at = (day: string, hhmm: string) => localTimeToInstant(day, hhmm, TZ);

describe('schedule', () => {
  it('validates real days', () => {
    expect(isValidDay('2026-02-28')).toBe(true);
    expect(isValidDay('2026-02-31')).toBe(false);
    expect(isValidDay('2026-13-01')).toBe(false);
  });
  it('wraps overnight shifts', () => {
    expect(shiftMinutes('22:00', '06:00')).toBe(480);
    expect(shiftMinutes('09:30', '18:30')).toBe(540);
    expect(shiftMinutes('09:30', null)).toBeNull();
  });
  it('assigns small-hours punches of a night shift to the previous day', () => {
    expect(workDayFor(at('2026-11-21', '02:00'), TZ, '22:00', '06:00')).toBe('2026-11-20');
    expect(workDayFor(at('2026-11-21', '21:55'), TZ, '22:00', '06:00')).toBe('2026-11-21');
    expect(workDayFor(at('2026-11-21', '02:00'), TZ, '09:30', '18:30')).toBe('2026-11-21');
  });
  it('normalises weekly off', () => {
    expect(resolveWeeklyOff(null)).toEqual([0]);
    expect(resolveWeeklyOff([6, 0, 0, 9])).toEqual([0, 6]);
    expect(resolveWeeklyOff([])).toEqual([]);
  });
});

describe('auto-checkout', () => {
  const policy = resolveAutoCheckout(null);
  it('closes a fixed shift 30 min after its end, credited at the end', () => {
    const day = { workDay: '2026-11-20', checkInAt: at('2026-11-20', '09:25') };
    const sched = { start: '09:30', end: '18:30', flexible: false, requiredMinutes: null };
    expect(autoCheckoutDecision(day, sched, policy, TZ, at('2026-11-20', '18:50')).close).toBe(false);
    const d = autoCheckoutDecision(day, sched, policy, TZ, at('2026-11-20', '19:05'));
    expect(d.close).toBe(true);
    if (d.close) expect(d.at.toISOString()).toBe(at('2026-11-20', '18:30').toISOString());
  });
  it('closes a night shift the next morning', () => {
    const day = { workDay: '2026-11-20', checkInAt: at('2026-11-20', '22:00') };
    const sched = { start: '22:00', end: '06:00', flexible: false, requiredMinutes: null };
    expect(autoCheckoutDecision(day, sched, policy, TZ, at('2026-11-21', '05:00')).close).toBe(false);
    const d = autoCheckoutDecision(day, sched, policy, TZ, at('2026-11-21', '07:00'));
    expect(d.close && d.at.toISOString()).toBe(at('2026-11-21', '06:00').toISOString());
  });
  it('closes flexible staff after max hours, credited the required hours', () => {
    const day = { workDay: '2026-11-20', checkInAt: at('2026-11-20', '11:00') };
    const sched = { start: '09:30', end: null, flexible: true, requiredMinutes: 480 };
    expect(autoCheckoutDecision(day, sched, policy, TZ, at('2026-11-20', '22:00')).close).toBe(false);
    const d = autoCheckoutDecision(day, sched, policy, TZ, at('2026-11-20', '23:05'));
    expect(d.close && d.at.toISOString()).toBe(at('2026-11-20', '19:00').toISOString());
  });
  it('does nothing when off', () => {
    const d = autoCheckoutDecision(
      { workDay: '2026-11-20', checkInAt: at('2026-11-20', '09:00') },
      { start: '09:30', end: '18:30', flexible: false, requiredMinutes: null },
      resolveAutoCheckout({ mode: 'off' }),
      TZ,
      at('2026-11-21', '09:00'),
    );
    expect(d.close).toBe(false);
  });
});

function rec(
  date: string,
  status: PayslipRecord['status'],
  inT?: string,
  outT?: string,
  extra: Partial<PayslipRecord> = {},
): PayslipRecord {
  return {
    date,
    status,
    checkInAt: inT ? at(date, inT) : null,
    checkOutAt: outT ? at(date, outT) : null,
    isLate: false,
    checkoutSource: outT ? 'self' : null,
    ...extra,
  };
}

const baseMember = {
  userId: 1,
  name: 'A',
  role: 'agent',
  salary: 52000,
  allowances: [{ label: 'Fuel', amount: 2600 }],
  overtimeRate: null,
  flexible: false,
  start: '09:30',
  end: '18:30',
  grace: 10,
  requiredMinutes: null,
  joinedOn: null,
  leftOn: null,
};

function baseInput(over: Partial<PayslipInput> = {}): PayslipInput {
  return {
    member: { ...baseMember },
    month: '2026-11',
    records: [],
    calendar: { weeklyOff: [0], holidays: new Set() },
    unpaidLeaveDays: new Set(),
    adjustments: [],
    commission: null,
    policy: resolvePolicy({}),
    tz: TZ,
    today: '2026-12-01',
    ...over,
  };
}

describe('payroll-math', () => {
  // Nov 2026: 30 days, 5 Sundays → 25 work days. salary 52000 → day rate 2080.
  it('never deducts weekly offs and pays full salary with no records', () => {
    const p = computePayslip(baseInput())!;
    expect(p.scheduledDays).toBe(25);
    expect(p.dayRate).toBe(2080);
    expect(p.absent).toBe(0);
    expect(p.unmarkedDays).toBe(25);
    expect(p.netPayable).toBe(54600);
  });
  it('deducts absences and unpaid leave at the calendar day rate', () => {
    const p = computePayslip(
      baseInput({
        records: [rec('2026-11-02', 'absent'), rec('2026-11-03', 'leave'), rec('2026-11-04', 'leave')],
        unpaidLeaveDays: new Set(['2026-11-04']),
      }),
    )!;
    expect(p.absenceDeduction).toBe(2080);
    expect(p.unpaidLeaveDeduction).toBe(2080);
    expect(p.paidLeave).toBe(1);
    expect(p.netPayable).toBe(54600 - 4160);
  });
  it('prorates a mid-month joiner', () => {
    const p = computePayslip(baseInput({ member: { ...baseMember, joinedOn: '2026-11-16' } }))!;
    // 16–30 Nov: Sundays 22, 29 → 13 work days of 25
    expect(p.prorated).toBe(true);
    expect(p.scheduledDays).toBe(13);
    expect(p.base).toBe(27040);
  });
  it('excludes someone who left before the month', () => {
    expect(computePayslip(baseInput({ member: { ...baseMember, leftOn: '2026-10-31' } }))).toBeNull();
  });
  it('counts overtime only after shift end and caps it', () => {
    const policy = resolvePolicy({ overtimeMethod: 'hourly_multiplier', overtimeMultiplier: 1.5, otMonthlyCapMin: 90 });
    const p = computePayslip(
      baseInput({
        policy,
        records: [rec('2026-11-02', 'present', '08:30', '19:30'), rec('2026-11-03', 'present', '09:30', '19:30')],
      }),
    )!;
    expect(p.overtimeMinutes).toBe(90);
    expect(p.overtimePay).toBeCloseTo(90 * (2080 / 540) * 1.5, 1);
  });
  it('floors net at zero and parts sum to net', () => {
    const p = computePayslip(baseInput({ adjustments: [{ kind: 'advance', label: 'Advance', amount: 999999 }] }))!;
    expect(p.netPayable).toBe(0);
    const p2 = computePayslip(
      baseInput({
        adjustments: [{ kind: 'bonus', label: 'Eid', amount: 5000 }],
        commission: { total: 1234.57, lines: [{ planId: 1, planName: 'Sales', units: 10, base: 10, amount: 1234.57 }] },
      }),
    )!;
    const earn = p2.lines.filter((l) => l.kind === 'earning').reduce((s, l) => s + l.amount, 0);
    const ded = p2.lines.filter((l) => l.kind === 'deduction').reduce((s, l) => s + l.amount, 0);
    expect(Math.round((earn - ded) * 100) / 100).toBe(p2.netPayable);
  });
  it('flexible staff are never late and earn OT over required hours', () => {
    const policy = resolvePolicy({ overtimeMethod: 'per_minute', lateMethod: 'fixed_per_late', lateFixedAmount: 500 });
    const p = computePayslip(
      baseInput({
        policy,
        member: { ...baseMember, flexible: true, requiredMinutes: 480 },
        records: [rec('2026-11-02', 'present', '12:00', '21:00', { isLate: true })],
      }),
    )!;
    expect(p.lateDeduction).toBe(0);
    expect(p.overtimeMinutes).toBe(60);
  });
  it('applies the auto-checkout penalty', () => {
    const policy = resolvePolicy({ autoCheckoutPenalty: 'half_day' });
    const p = computePayslip(
      baseInput({ policy, records: [rec('2026-11-02', 'present', '09:30', '18:30', { checkoutSource: 'auto' })] }),
    )!;
    expect(p.autoCheckoutDeduction).toBe(1040);
  });
  it('legacy policy with workingDaysPerMonth keeps the fixed divisor', () => {
    expect(resolvePolicy({ workingDaysPerMonth: 26 }).dayRateBasis).toBe('fixed');
    expect(resolvePolicy({}).dayRateBasis).toBe('calendar');
  });
});

describe('commission-math', () => {
  const users = (rows: [number, number, number?][]) =>
    new Map<number, UserUnits>(rows.map(([id, count, value]) => [id, { count, value: value ?? 0, minutesWorked: 0 }]));
  it('per unit + cap', () => {
    const c = resolvePlanConfig('parcels_packed', { calc: { type: 'per_unit', rate: 10 }, cap: 5000 });
    const r = computePlan(c, users([[1, 100], [2, 900]]));
    expect(r.find((x) => x.userId === 1)!.amount).toBe(1000);
    expect(r.find((x) => x.userId === 2)!.amount).toBe(5000);
  });
  it('percent of value with reversals going negative', () => {
    const c = resolvePlanConfig('orders', { basis: 'value', calc: { type: 'percent', rate: 2 } });
    const r = computePlan(c, users([[1, 0, 100000], [2, -1, -5000]]));
    expect(r.find((x) => x.userId === 1)!.amount).toBe(2000);
    expect(r.find((x) => x.userId === 2)!.amount).toBe(-100);
  });
  it('slabs whole vs marginal', () => {
    const tiers = [
      { from: 0, rate: 8 },
      { from: 1000, rate: 12 },
      { from: 2000, rate: 15 },
    ];
    expect(calcAmount({ type: 'slab', mode: 'whole', tiers }, 'count', 1533).amount).toBe(1533 * 12);
    expect(calcAmount({ type: 'slab', mode: 'marginal', tiers }, 'count', 1533).amount).toBe(1000 * 8 + 533 * 12);
  });
  it('target bonus once or repeating', () => {
    expect(calcAmount({ type: 'target_bonus', target: 400, bonus: 5000, repeat: false }, 'count', 850).amount).toBe(5000);
    expect(calcAmount({ type: 'target_bonus', target: 400, bonus: 5000, repeat: true }, 'count', 850).amount).toBe(10000);
    expect(calcAmount({ type: 'target_bonus', target: 400, bonus: 5000, repeat: true }, 'count', 399).amount).toBe(0);
  });
  it('team pool split by hours', () => {
    const c = resolvePlanConfig('parcels_dispatched', { calc: { type: 'pool', rate: 3, splitBy: 'hours' } });
    const m = new Map<number, UserUnits>([
      [1, { count: 600, value: 0, minutesWorked: 3000 }],
      [2, { count: 400, value: 0, minutesWorked: 1000 }],
    ]);
    const r = computePlan(c, m);
    expect(r.find((x) => x.userId === 1)!.amount).toBe(2250);
    expect(r.find((x) => x.userId === 2)!.amount).toBe(750);
  });
  it('minimum threshold', () => {
    const c = resolvePlanConfig('orders', { min: 50, calc: { type: 'per_unit', rate: 100 } });
    expect(computePlan(c, users([[1, 49]]))[0].amount).toBe(0);
    expect(computePlan(c, users([[1, 50]]))[0].amount).toBe(5000);
  });
});

// ── Attendance follow-ups (Nov-2026) ──────────────────────────────────────────
import { formatOpensAt, workLockState } from './work-lock';
import { isValidIpEntry, matchOfficeNetwork, parseOfficeNetworks } from '../../common/utils/ip-match';

describe('auto-checkout credits last activity', () => {
  const policy = resolveAutoCheckout(null);
  const sched = { start: '09:30', end: '18:30', flexible: false, requiredMinutes: null };
  it('waits while still active, then credits the last activity', () => {
    const day = { workDay: '2026-11-20', checkInAt: at('2026-11-20', '09:25'), lastActiveAt: at('2026-11-20', '20:40') };
    expect(autoCheckoutDecision(day, sched, policy, TZ, at('2026-11-20', '21:00')).close).toBe(false);
    const d = autoCheckoutDecision(day, sched, policy, TZ, at('2026-11-20', '21:15'));
    expect(d.close && d.at.toISOString()).toBe(at('2026-11-20', '20:40').toISOString());
    expect(d.close && d.creditedBy).toBe('activity');
  });
  it('never credits less than shift end', () => {
    const day = { workDay: '2026-11-20', checkInAt: at('2026-11-20', '09:25'), lastActiveAt: at('2026-11-20', '14:00') };
    const d = autoCheckoutDecision(day, sched, policy, TZ, at('2026-11-20', '19:05'));
    expect(d.close && d.at.toISOString()).toBe(at('2026-11-20', '18:30').toISOString());
    expect(d.close && d.creditedBy).toBe('schedule');
  });
  it('caps activity credit at max hours', () => {
    const day = { workDay: '2026-11-20', checkInAt: at('2026-11-20', '09:00'), lastActiveAt: at('2026-11-20', '23:30') };
    const d = autoCheckoutDecision(day, sched, policy, TZ, at('2026-11-21', '00:10'));
    expect(d.close && d.at.toISOString()).toBe(at('2026-11-20', '21:00').toISOString());
  });
  it('flexible staff get their later activity', () => {
    const day = { workDay: '2026-11-20', checkInAt: at('2026-11-20', '11:00'), lastActiveAt: at('2026-11-20', '21:30') };
    const d = autoCheckoutDecision(day, { ...sched, flexible: true, requiredMinutes: 480 }, policy, TZ, at('2026-11-20', '23:05'));
    expect(d.close && d.at.toISOString()).toBe(at('2026-11-20', '21:30').toISOString());
  });
});

describe('payroll follow-ups', () => {
  it('relaxed staff are never late but keep fixed-shift overtime', () => {
    const policy = resolvePolicy({ overtimeMethod: 'per_minute', lateMethod: 'fixed_per_late', lateFixedAmount: 500 });
    const p = computePayslip(
      baseInput({
        policy,
        member: { ...baseMember, neverLate: true },
        records: [rec('2026-11-02', 'present', '11:00', '19:30', { isLate: true })],
      }),
    )!;
    expect(p.lateDeduction).toBe(0);
    expect(p.overtimeMinutes).toBe(60);
  });
  it('auto_activity days earn overtime, plain auto days do not', () => {
    const policy = resolvePolicy({ overtimeMethod: 'per_minute' });
    const a = computePayslip(baseInput({ policy, records: [rec('2026-11-02', 'present', '09:30', '20:30', { checkoutSource: 'auto_activity' })] }))!;
    const b = computePayslip(baseInput({ policy, records: [rec('2026-11-02', 'present', '09:30', '20:30', { checkoutSource: 'auto' })] }))!;
    expect(a.overtimeMinutes).toBe(120);
    expect(b.overtimeMinutes).toBe(0);
    expect(a.autoClosed).toBe(1);
  });
});

describe('work-hours lock', () => {
  const base = { tz: TZ, start: '09:30', end: '18:30', flexible: false, bufferMin: 30, isWorkDay: (d: string) => d !== '2026-11-22' };
  it('open inside the window, locked after shift end + buffer until next opening', () => {
    expect(workLockState({ ...base, now: at('2026-11-20', '12:00') }).locked).toBe(false);
    expect(workLockState({ ...base, now: at('2026-11-20', '18:55') }).locked).toBe(false);
    const s = workLockState({ ...base, now: at('2026-11-20', '19:05') });
    expect(s.locked).toBe(true);
    expect(s.opensAt?.toISOString()).toBe(at('2026-11-21', '09:00').toISOString());
    expect(formatOpensAt(s.opensAt, at('2026-11-20', '19:05'), TZ)).toBe('Sat 09:00');
  });
  it('locked before opening on a work day', () => {
    const s = workLockState({ ...base, now: at('2026-11-20', '07:00') });
    expect(s.locked).toBe(true);
    expect(formatOpensAt(s.opensAt, at('2026-11-20', '07:00'), TZ)).toBe('09:00');
  });
  it('never locks a day off and unlocks at its midnight', () => {
    expect(workLockState({ ...base, now: at('2026-11-22', '23:00') }).locked).toBe(false);
    const s = workLockState({ ...base, now: at('2026-11-21', '20:00') });
    expect(s.opensAt?.toISOString()).toBe(at('2026-11-22', '00:00').toISOString());
  });
  it('night shift stays open past midnight', () => {
    const n = { ...base, start: '22:00', end: '06:00' };
    expect(workLockState({ ...n, now: at('2026-11-21', '03:00') }).locked).toBe(false);
    expect(workLockState({ ...n, now: at('2026-11-21', '07:00') }).locked).toBe(true);
  });
  it('flexible staff are never locked', () => {
    expect(workLockState({ ...base, flexible: true, now: at('2026-11-20', '23:00') }).locked).toBe(false);
  });
});

describe('office networks', () => {
  it('parses JSON and legacy CSV, matches by label', () => {
    const legacy = parseOfficeNetworks('39.45.120.18, 10.0.0.0/8 junk');
    expect(legacy).toEqual([
      { label: 'Network 1', ip: '39.45.120.18' },
      { label: 'Network 2', ip: '10.0.0.0/8' },
    ]);
    const nets = parseOfficeNetworks(JSON.stringify([{ label: 'Office WiFi 1', ip: '39.45.120.18' }, { label: 'WiFi 2', ip: '203.99.48.0/28' }]));
    expect(matchOfficeNetwork('203.99.48.5', nets)).toBe('WiFi 2');
    expect(matchOfficeNetwork('182.185.4.9', nets)).toBeNull();
    expect(isValidIpEntry('10.0.0.0/')).toBe(false);
    expect(isValidIpEntry('2001:db8::1')).toBe(true);
  });
});
