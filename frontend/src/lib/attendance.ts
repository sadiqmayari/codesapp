import { apiFetch, api } from '@/lib/api';
import { getActiveTimeZone } from '@/lib/utils';

export type AttendanceStatus = 'present' | 'absent' | 'leave' | 'half_day' | 'holiday';

export type LateMethod =
  | 'none'
  | 'n_lates_absent'
  | 'fixed_per_late'
  | 'per_minute'
  | 'half_day';
export type OvertimeMethod = 'off' | 'hourly_multiplier' | 'flat_per_hour' | 'per_minute';

export const LATE_METHOD_LABELS: Record<LateMethod, string> = {
  none: 'No deduction',
  n_lates_absent: 'N lates = 1 absent',
  fixed_per_late: 'Fixed Rs per late',
  per_minute: 'Per-minute late',
  half_day: 'Half-day after X min',
};
export const OVERTIME_METHOD_LABELS: Record<OvertimeMethod, string> = {
  off: 'Off (no overtime)',
  hourly_multiplier: 'Hourly rate × multiplier',
  flat_per_hour: 'Flat Rs per overtime hour',
  per_minute: 'Per-minute at normal rate',
};

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
}

export interface Allowance {
  label: string;
  amount: number;
}

export interface PayrollRow {
  userId: number;
  name: string;
  role: string;
  exemptLate: boolean;
  salary: number;
  allowances: Allowance[];
  allowanceTotal: number;
  present: number;
  absent: number;
  halfDay: number;
  leave: number;
  lateCount: number;
  lateMinutes: number;
  overtimeMinutes: number;
  overtimePay: number;
  absenceDeduction: number;
  lateDeduction: number;
  halfDayDeduction: number;
  netPayable: number;
}

export interface PayrollResult {
  month: string;
  from: string;
  to: string;
  policy: PayrollPolicy;
  rows: PayrollRow[];
}

export interface AttendanceCell {
  date: string; // YYYY-MM-DD
  status: AttendanceStatus;
  checkInAt: string | null; // ISO
  checkOutAt: string | null; // ISO
  isLate: boolean;
  missedCheckout: boolean;
  workedMinutes: number | null;
  note: string | null;
  overridden: boolean;
}

export interface MyToday {
  date: string;
  workStart: string; // "HH:MM"
  workEnd: string | null;
  graceMinutes: number;
  checkinOpensAt: string; // "HH:MM" — check-in CTA opens (30m before shift start)
  checkinCutoff: string; // "HH:MM" — self check-in CTA only offered until this
  exemptLate: boolean;
  excluded: boolean; // true for the owner (not tracked)
  record: AttendanceCell | null;
}

export interface AttendanceMember {
  userId: number;
  name: string;
  role: string;
  workStart: string | null; // override (null = company default)
  workEnd: string | null;
  graceMinutes: number | null;
  requireOfficeIp: boolean;
  effectiveStart: string;
  effectiveEnd: string | null;
  effectiveGrace: number;
  exemptLate: boolean;
  salaryAmount: number | null;
  overtimeRate: number | null;
  allowances: Allowance[];
}

export interface AttendanceSettings {
  workStartTime: string;
  workEndTime: string | null;
  graceMinutes: number;
  officeIps: string;
  checkinWindowMinutes: number; // minutes after each user's shift start
  payrollPolicy: PayrollPolicy;
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

export interface LeaveRequest {
  id: number;
  userId: number;
  userName?: string;
  userRole?: string;
  fromDate: string;
  toDate: string;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected';
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface DailyGridMember {
  userId: number;
  name: string;
  role: string;
  cells: Record<string, AttendanceCell>;
}

export interface AttendanceReport {
  from: string;
  to: string;
  dates: string[];
  members: DailyGridMember[];
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
  earlyLeaves: number;
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

export interface OverridePayload {
  status?: AttendanceStatus;
  checkIn?: string; // "HH:MM" or "" to clear
  checkOut?: string;
  note?: string;
}

export const STATUS_META: Record<AttendanceStatus, { label: string; cls: string }> = {
  present: { label: 'Present', cls: 'bg-green-100 text-green-700' },
  absent: { label: 'Absent', cls: 'bg-red-100 text-red-700' },
  leave: { label: 'Leave', cls: 'bg-blue-100 text-blue-700' },
  half_day: { label: 'Half-day', cls: 'bg-purple-100 text-purple-700' },
  holiday: { label: 'Holiday', cls: 'bg-gray-100 text-gray-500' },
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
  apiFetch<AttendanceCell[]>(`/attendance/me${qs(params)}`);

// ── admin ──
export const getReport = (params: { from?: string; to?: string }) =>
  apiFetch<AttendanceReport>(`/attendance/report${qs(params)}`);
export const getSummary = (month: string) =>
  apiFetch<MonthlySummary>(`/attendance/summary${qs({ month })}`);
export const overrideAttendance = (userId: number, date: string, body: OverridePayload) =>
  apiFetch<AttendanceCell>(`/attendance/${userId}/${date}`, { method: 'PATCH', body });
export const getTodaySummary = () => apiFetch<TodaySummary>('/attendance/today-summary');
export const getPayroll = (month: string) =>
  apiFetch<PayrollResult>(`/attendance/payroll${qs({ month })}`);

export const getAttendanceSettings = () =>
  apiFetch<AttendanceSettings>('/attendance/settings');
export const setAttendanceSettings = (body: {
  workStartTime?: string;
  workEndTime?: string;
  graceMinutes?: number;
  officeIps?: string;
  checkinWindowMinutes?: number;
  payrollPolicy?: Partial<PayrollPolicy>;
}) => apiFetch<AttendanceSettings>('/attendance/settings', { method: 'PATCH', body });

// ── per-member config ──
export const getMembers = () => apiFetch<AttendanceMember[]>('/attendance/members');
export const updateMember = (
  userId: number,
  body: {
    workStartTime?: string;
    workEndTime?: string;
    graceMinutes?: number | null;
    requireOfficeIp?: boolean;
    exemptLate?: boolean;
    salaryAmount?: number | null;
    overtimeRate?: number | null;
    allowances?: Allowance[];
  },
) => apiFetch<{ ok: true }>(`/attendance/members/${userId}`, { method: 'PATCH', body });

// ── leave requests ──
export const requestLeave = (body: { fromDate: string; toDate: string; reason?: string }) =>
  apiFetch<LeaveRequest>('/attendance/leave', { method: 'POST', body });
export const getMyLeave = () => apiFetch<LeaveRequest[]>('/attendance/leave/mine');
export const getLeaveRequests = (status?: string) =>
  apiFetch<LeaveRequest[]>(`/attendance/leave${qs({ status })}`);
export const reviewLeave = (
  id: number,
  body: { status: 'approved' | 'rejected'; reviewNote?: string },
) => apiFetch<LeaveRequest>(`/attendance/leave/${id}`, { method: 'PATCH', body });

/** Download the attendance report as CSV (auth header attached by axios). */
export async function downloadAttendanceCsv(params: { from?: string; to?: string }) {
  const res = await api.get('/attendance/report/export', { params, responseType: 'blob' });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'attendance.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── helpers ──
export function fmtClock(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtHours(minutes: number | null): string {
  if (minutes == null) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/** Current tenant-local wall-clock time as "HH:MM" (24h), using the company
 *  timezone set on AuthProvider; falls back to the browser clock. */
export function tenantNowHHMM(): string {
  const tz = getActiveTimeZone();
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date());
  } catch {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

// ── cross-component sync signal ──────────────────────────────────────────────
// Fired after a check-in/out so BOTH the announcement bar and the panel re-load
// their own `myToday`. Kills the "bar still shows after I checked in" bug.
const ATTENDANCE_EVENT = 'attendance:changed';
export function emitAttendanceChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ATTENDANCE_EVENT));
}
export function onAttendanceChanged(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(ATTENDANCE_EVENT, fn);
  return () => window.removeEventListener(ATTENDANCE_EVENT, fn);
}

/** Download the monthly payroll as CSV. */
export function downloadPayrollCsv(result: PayrollResult) {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    'Member', 'Role', 'Flexible', 'Base salary', 'Allowances', 'Overtime pay',
    'Absence deduction', 'Late deduction', 'Half-day deduction', 'Net payable',
  ];
  const lines = [header.map(esc).join(',')];
  for (const r of result.rows) {
    lines.push(
      [
        r.name, r.role, r.exemptLate ? 'yes' : '', r.salary, r.allowanceTotal,
        r.overtimePay, r.absenceDeduction, r.lateDeduction, r.halfDayDeduction, r.netPayable,
      ].map(esc).join(','),
    );
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `payroll-${result.month}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
