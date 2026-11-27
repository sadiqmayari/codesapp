import { apiFetch, api } from '@/lib/api';
import { getActiveTimeZone } from '@/lib/utils';

export type AttendanceStatus = 'present' | 'absent' | 'leave' | 'half_day' | 'holiday';

export type LateMethod = 'none' | 'n_lates_absent' | 'fixed_per_late' | 'per_minute' | 'half_day';
export type OvertimeMethod = 'off' | 'hourly_multiplier' | 'flat_per_hour' | 'per_minute';
export type DayRateBasis = 'calendar' | 'fixed' | 'thirty';
export type AutoCheckoutPenalty = 'none' | 'half_day' | 'absent';
export type AutoCheckoutMode = 'off' | 'shift_end' | 'max_hours';

export const LATE_METHOD_LABELS: Record<LateMethod, string> = {
  none: 'No deduction',
  n_lates_absent: 'Every N lates = 1 day cut',
  fixed_per_late: 'Fixed amount per late',
  per_minute: 'Per minute late',
  half_day: 'Half day when very late',
};
export const OVERTIME_METHOD_LABELS: Record<OvertimeMethod, string> = {
  off: 'No overtime pay',
  hourly_multiplier: 'Hourly rate × multiplier',
  flat_per_hour: 'Flat amount per hour',
  per_minute: 'Per minute at normal rate',
};
export const DAY_RATE_LABELS: Record<DayRateBasis, string> = {
  calendar: "Salary ÷ the month's work days",
  fixed: 'Salary ÷ a fixed number of days',
  thirty: 'Salary ÷ 30',
};
export const AUTO_PENALTY_LABELS: Record<AutoCheckoutPenalty, string> = {
  none: 'No penalty',
  half_day: 'Count as half day',
  absent: 'Count as absent',
};
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface StatutoryDeduction {
  label: string;
  type: 'fixed' | 'percent';
  value: number;
}

export interface PayrollPolicy {
  lateMethod: LateMethod;
  latesPerAbsent: number;
  lateFixedAmount: number;
  halfDayAfterMin: number;
  overtimeMethod: OvertimeMethod;
  overtimeMultiplier: number;
  overtimeFlatRate: number;
  minOvertimeMinutes: number;
  workingDaysPerMonth: number;
  dayRateBasis: DayRateBasis;
  otOnlyAfterShiftEnd: boolean;
  otMonthlyCapMin: number;
  autoCheckoutPenalty: AutoCheckoutPenalty;
  statutory: StatutoryDeduction[];
  currency: string;
}

export interface AutoCheckoutPolicy {
  mode: AutoCheckoutMode;
  afterEndMin: number;
  maxHours: number;
  /** 'activity' = last app activity (fallback shift end); 'shift_end' = later of shift end and activity. */
  creditAt: 'activity' | 'shift_end';
}

export interface Allowance {
  label: string;
  amount: number;
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
  commissionLines: { planId: number; planName: string; units: number; base: number; amount: number }[];
  absenceDeduction: number;
  unpaidLeaveDeduction: number;
  halfDayDeduction: number;
  lateDeduction: number;
  autoCheckoutDeduction: number;
  statutoryDeduction: number;
  adjustmentsPlus: number;
  adjustmentsMinus: number;
  gross: number;
  deductions: number;
  netPayable: number;
  lines: PayslipLineItem[];
}

export interface PayrollRun {
  id: number;
  month: string;
  status: 'draft' | 'approved' | 'paid';
  approvedAt: string | null;
  paidAt: string | null;
  approvedByUserId: number | null;
}

export interface PayrollResult {
  month: string;
  from: string;
  to: string;
  locked: boolean;
  policy: PayrollPolicy;
  run: PayrollRun | null;
  rows: Payslip[];
  totals: { people: number; gross: number; deductions: number; commission: number; overtime: number; net: number };
  /** HR manager view: rows hidden (admins + the HR manager themself). */
  hiddenCount?: number;
}

export type AdjustmentKind = 'bonus' | 'reimbursement' | 'deduction' | 'advance' | 'loan';
export const ADJUSTMENT_LABELS: Record<AdjustmentKind, string> = {
  bonus: 'Bonus',
  reimbursement: 'Reimbursement',
  deduction: 'Deduction',
  advance: 'Advance (recovered)',
  loan: 'Loan instalment',
};
export interface Adjustment {
  id: number;
  userId: number;
  month: string;
  kind: AdjustmentKind;
  label: string;
  amount: number;
  note: string | null;
  additive: boolean;
  createdAt: string;
}

export interface AttendanceCell {
  date: string; // YYYY-MM-DD
  status: AttendanceStatus;
  checkInAt: string | null; // ISO
  checkOutAt: string | null; // ISO
  isLate: boolean;
  missedCheckout: boolean;
  checkoutSource: 'self' | 'auto' | 'auto_activity' | 'admin' | null;
  /** Last app activity while the day was open (auto-checkout credit). */
  lastActiveAt?: string | null;
  workedMinutes: number | null;
  note: string | null;
  overridden: boolean;
}

export interface MyToday {
  date: string;
  dayKind: 'work' | 'weekly_off' | 'holiday';
  holidayName: string | null;
  workStart: string;
  workEnd: string | null;
  effectiveEnd: string;
  graceMinutes: number;
  checkinOpensAt: string;
  checkinCutoff: string;
  checkoutOpensAt: string;
  exemptLate: boolean;
  flexible: boolean;
  /** "Relaxed" timing: fixed shift, never marked late. */
  neverLate?: boolean;
  /** Check-in restricted to office networks for this member. */
  requireOfficeNetwork?: boolean;
  /** Label of the office network the caller is on now, null = not on one. */
  onOfficeNetwork?: string | null;
  /** App locks after shift end for this member. */
  lockAfterShift?: boolean;
  /** ISO instant the app locks today (null = no lock ahead). */
  appLocksAt?: string | null;
  requiredMinutes: number | null;
  autoCheckout: AutoCheckoutPolicy;
  excluded: boolean;
  record: AttendanceCell | null;
}

export interface AttendanceMember {
  userId: number;
  name: string;
  role: string;
  workStart: string | null;
  workEnd: string | null;
  graceMinutes: number | null;
  requireOfficeIp: boolean;
  effectiveStart: string;
  effectiveEnd: string | null;
  effectiveGrace: number;
  exemptLate: boolean;
  /** "Relaxed" timing (fixed shift, never late). */
  neverLate?: boolean;
  /** Per-member lock override (null = company default). */
  lockAfterShift?: boolean | null;
  effectiveLockAfterShift?: boolean;
  /** Per-member auto-checkout override (null = company default). */
  autoCheckout?: boolean | null;
  effectiveAutoCheckout?: boolean;
  requiredMinutes: number | null;
  weeklyOff: number[] | null;
  effectiveWeeklyOff: number[];
  joinedOn: string | null;
  leftOn: string | null;
  annualPaidLeave: number | null;
  /** True when the viewer (an HR manager) may not see/edit this pay. */
  payHidden?: boolean;
  salaryAmount: number | null;
  overtimeRate: number | null;
  allowances: Allowance[];
}

export interface OfficeNetwork {
  label: string;
  ip: string;
}

export interface AttendanceSettings {
  timezone: string | null;
  workStartTime: string;
  workEndTime: string | null;
  graceMinutes: number;
  officeIps: string;
  officeNetworks: OfficeNetwork[];
  yourNetwork: string | null;
  lockAfterShift: boolean;
  lockBufferMinutes: number;
  checkinWindowMinutes: number;
  payrollPolicy: PayrollPolicy;
  autoCheckout: AutoCheckoutPolicy;
  weeklyOff: number[];
  annualPaidLeave: number;
  yourIp: string;
}

export interface TodaySummary {
  date: string;
  total: number;
  present: number;
  late: number;
  absent: number;
  notCheckedIn: number;
}

export type BoardLane = 'in' | 'late' | 'out' | 'leave' | 'off' | 'absent' | 'not_in';
export interface TodayPerson {
  userId: number;
  name: string;
  role: string;
  flexible: boolean;
  start: string;
  end: string | null;
  requiredMinutes: number | null;
  lane: BoardLane;
  checkInAt: string | null;
  checkOutAt: string | null;
  status: AttendanceStatus | null;
  halfDay: boolean;
  lateByMin: number;
  autoClosedYesterday: boolean;
}
export interface TodayBoard {
  date: string;
  now: string;
  holidayName: string | null;
  checkinWindow: number;
  people: TodayPerson[];
}

export type LeaveType = 'casual' | 'sick' | 'annual' | 'unpaid' | 'other';
export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  casual: 'Casual',
  sick: 'Sick',
  annual: 'Annual',
  unpaid: 'Unpaid',
  other: 'Other',
};

export interface LeaveRequest {
  id: number;
  userId: number;
  userName?: string;
  userRole?: string;
  kind: 'leave' | 'correction';
  leaveType: LeaveType | null;
  paid: boolean;
  fromDate: string;
  toDate: string;
  reqCheckIn: string | null;
  reqCheckOut: string | null;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected';
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface MyLeave {
  requests: LeaveRequest[];
  balance: { year: string; quota: number; used: number; left: number } | null;
}

export interface DailyGridMember {
  userId: number;
  name: string;
  role: string;
  cells: Record<string, AttendanceCell>;
  offDays: string[];
}

export interface AttendanceReport {
  from: string;
  to: string;
  today: string;
  dates: string[];
  holidays: string[];
  members: DailyGridMember[];
}

export interface MonthlySummaryRow {
  userId: number;
  name: string;
  role: string;
  flexible: boolean;
  scheduledDays: number;
  present: number;
  absent: number;
  leave: number;
  halfDay: number;
  holiday: number;
  late: number;
  earlyLeaves: number;
  autoClosed: number;
  totalMinutes: number;
  expectedMinutes: number;
  overtimeMinutes: number;
  attendancePct: number;
}

export interface MonthlySummary {
  month: string;
  from: string;
  to: string;
  rows: MonthlySummaryRow[];
}

export interface MyHistory {
  from: string;
  to: string;
  offDays: string[];
  rows: AttendanceCell[];
}

export interface Holiday {
  id: number;
  date: string;
  name: string;
}

export interface OverridePayload {
  status?: AttendanceStatus;
  checkIn?: string; // "HH:MM" or "" to clear
  checkOut?: string;
  note?: string;
}

export const STATUS_META: Record<AttendanceStatus, { label: string; cls: string }> = {
  present: { label: 'Present', cls: 'bg-emerald-50 text-emerald-700' },
  absent: { label: 'Absent', cls: 'bg-red-50 text-red-700' },
  leave: { label: 'Leave', cls: 'bg-sky-50 text-sky-700' },
  half_day: { label: 'Half day', cls: 'bg-violet-50 text-violet-700' },
  holiday: { label: 'Holiday', cls: 'bg-gray-100 text-gray-600' },
};

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ── self-service ──
export const getMyToday = () => apiFetch<MyToday>('/attendance/me/today');
export const checkIn = async () => {
  const r = await apiFetch<AttendanceCell>('/attendance/check-in', { method: 'POST' });
  emitAttendanceChanged();
  return r;
};
export const checkOut = async () => {
  const r = await apiFetch<AttendanceCell>('/attendance/check-out', { method: 'POST' });
  emitAttendanceChanged();
  return r;
};
export const getMyHistory = (params: { from?: string; to?: string }) =>
  apiFetch<MyHistory>(`/attendance/me${qs(params)}`);
export const getMyPayslips = () =>
  apiFetch<{ currency: string; payslips: { run: PayrollRun; slip: Payslip }[] }>('/attendance/me/payslips');

// ── admin ──
export const getReport = (params: { from?: string; to?: string }) =>
  apiFetch<AttendanceReport>(`/attendance/report${qs(params)}`);
export const getSummary = (month: string) => apiFetch<MonthlySummary>(`/attendance/summary${qs({ month })}`);
export const overrideAttendance = (userId: number, date: string, body: OverridePayload) =>
  apiFetch<AttendanceCell>(`/attendance/${userId}/${date}`, { method: 'PATCH', body });
export const getTodaySummary = () => apiFetch<TodaySummary>('/attendance/today-summary');
export const getTodayBoard = () => apiFetch<TodayBoard>('/attendance/today-board');

// ── payroll ──
export const getPayroll = (month: string) => apiFetch<PayrollResult>(`/attendance/payroll${qs({ month })}`);
export const approvePayroll = (month: string) =>
  apiFetch<PayrollResult>(`/attendance/payroll/${month}/approve`, { method: 'POST' });
export const markPayrollPaid = (month: string) =>
  apiFetch<PayrollResult>(`/attendance/payroll/${month}/paid`, { method: 'POST' });
export const reopenPayroll = (month: string) =>
  apiFetch<PayrollResult>(`/attendance/payroll/${month}/reopen`, { method: 'POST' });
export const getAdjustments = (month: string) => apiFetch<Adjustment[]>(`/attendance/adjustments${qs({ month })}`);
export const addAdjustment = (body: { userId: number; month: string; kind: AdjustmentKind; label: string; amount: number; note?: string }) =>
  apiFetch<{ id: number }>('/attendance/adjustments', { method: 'POST', body });
export const deleteAdjustment = (id: number) =>
  apiFetch<{ ok: true }>(`/attendance/adjustments/${id}`, { method: 'DELETE' });

// ── settings + calendar ──
export const getAttendanceSettings = () => apiFetch<AttendanceSettings>('/attendance/settings');
export const setAttendanceSettings = (body: {
  workStartTime?: string;
  workEndTime?: string;
  graceMinutes?: number;
  officeIps?: string;
  officeNetworks?: OfficeNetwork[];
  lockAfterShift?: boolean;
  lockBufferMinutes?: number | null;
  checkinWindowMinutes?: number;
  payrollPolicy?: Partial<PayrollPolicy>;
  autoCheckout?: Partial<AutoCheckoutPolicy>;
  weeklyOff?: number[];
  annualPaidLeave?: number | null;
}) => apiFetch<AttendanceSettings>('/attendance/settings', { method: 'PATCH', body });
export const getHolidays = (year?: string) => apiFetch<Holiday[]>(`/attendance/holidays${qs({ year })}`);
export const addHoliday = (body: { date: string; name: string }) =>
  apiFetch<Holiday>('/attendance/holidays', { method: 'POST', body });
export const deleteHoliday = (id: number) => apiFetch<{ ok: true }>(`/attendance/holidays/${id}`, { method: 'DELETE' });

// ── per-member config ──
export interface MemberPatch {
  workStartTime?: string;
  workEndTime?: string;
  graceMinutes?: number | null;
  requireOfficeIp?: boolean;
  exemptLate?: boolean;
  neverLate?: boolean;
  lockAfterShift?: boolean | null;
  autoCheckout?: boolean | null;
  requiredMinutes?: number | null;
  weeklyOff?: number[] | null;
  joinedOn?: string;
  leftOn?: string;
  annualPaidLeave?: number | null;
  salaryAmount?: number | null;
  overtimeRate?: number | null;
  allowances?: Allowance[];
}
/** App-activity heartbeat while checked in (auto-checkout credits real hours). */
export const sendAttendanceHeartbeat = () =>
  apiFetch<{ ok: true; open: boolean }>('/attendance/me/heartbeat', { method: 'POST' });

export type TimingMode = 'fixed' | 'relaxed' | 'flexible';
export const timingModeOf = (m: { exemptLate: boolean; neverLate?: boolean }): TimingMode =>
  m.exemptLate ? 'flexible' : m.neverLate ? 'relaxed' : 'fixed';
export const TIMING_LABEL: Record<TimingMode, string> = {
  fixed: 'Fixed',
  relaxed: 'Relaxed',
  flexible: 'Flexible hours',
};

export const getMembers = () => apiFetch<AttendanceMember[]>('/attendance/members');
export const updateMember = (userId: number, body: MemberPatch) =>
  apiFetch<{ ok: true }>(`/attendance/members/${userId}`, { method: 'PATCH', body });

// ── leave + correction requests ──
export const requestLeave = (body: { fromDate: string; toDate: string; reason?: string; leaveType?: LeaveType }) =>
  apiFetch<LeaveRequest>('/attendance/leave', { method: 'POST', body });
export const requestCorrection = (body: { date: string; checkIn?: string; checkOut?: string; reason?: string }) =>
  apiFetch<LeaveRequest>('/attendance/corrections', { method: 'POST', body });
export const cancelMyRequest = (id: number) =>
  apiFetch<{ ok: true }>(`/attendance/leave/mine/${id}`, { method: 'DELETE' });
export const getMyLeave = () => apiFetch<MyLeave>('/attendance/leave/mine');
export const getLeaveRequests = (status?: string) => apiFetch<LeaveRequest[]>(`/attendance/leave${qs({ status })}`);
export const reviewLeave = (id: number, body: { status: 'approved' | 'rejected'; reviewNote?: string }) =>
  apiFetch<LeaveRequest>(`/attendance/leave/${id}`, { method: 'PATCH', body });

async function downloadBlob(path: string, params: Record<string, string | undefined>, filename: string) {
  const res = await api.get(path, { params, responseType: 'blob' });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const downloadAttendanceCsv = (params: { from?: string; to?: string }) =>
  downloadBlob('/attendance/report/export', params, `attendance-${params.from ?? ''}-to-${params.to ?? ''}.csv`);
export const downloadPayrollCsv = (month: string) =>
  downloadBlob('/attendance/payroll/export', { month }, `payroll-${month}.csv`);

// ── helpers ──
const clockFmt = () => {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone: getActiveTimeZone() });
  } catch {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  }
};

/** Clock time of an instant on the TENANT clock (never the browser's). */
export function fmtClock(iso: string | null): string {
  if (!iso) return '—';
  return clockFmt().format(new Date(iso));
}

/** "HH:MM" 24h of an instant on the tenant clock — for pre-filling time inputs. */
export function tenantHHMM(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: getActiveTimeZone(),
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(iso));
  } catch {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

export function fmtHours(minutes: number | null | undefined): string {
  if (minutes == null) return '—';
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Current tenant-local wall-clock "HH:MM" (24h). */
export function tenantNowHHMM(): string {
  return tenantHHMM(new Date().toISOString());
}

export function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function fmtMoney(n: number | null | undefined, currency = 'Rs'): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${currency} ${Math.round(n).toLocaleString('en-US')}`;
}

/** "Short weekday, 12 Nov" for a bare YYYY-MM-DD. */
export function dayShort(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// ── cross-component sync signal ──────────────────────────────────────────────
// Fired after a check-in/out so the navbar chip, the reminder bar and the panel
// all re-load their own `myToday`.
const ATTENDANCE_EVENT = 'attendance:changed';
export function emitAttendanceChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ATTENDANCE_EVENT));
}
export function onAttendanceChanged(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(ATTENDANCE_EVENT, fn);
  return () => window.removeEventListener(ATTENDANCE_EVENT, fn);
}
