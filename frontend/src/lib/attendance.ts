import { apiFetch, api } from '@/lib/api';

export type AttendanceStatus = 'present' | 'absent' | 'leave' | 'half_day' | 'holiday';

export interface AttendanceCell {
  date: string; // YYYY-MM-DD
  status: AttendanceStatus;
  checkInAt: string | null; // ISO
  checkOutAt: string | null; // ISO
  isLate: boolean;
  workedMinutes: number | null;
  note: string | null;
  overridden: boolean;
}

export interface MyToday {
  date: string;
  workStart: string; // "HH:MM"
  record: AttendanceCell | null;
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
  totalMinutes: number;
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
export const checkIn = () => apiFetch<AttendanceCell>('/attendance/check-in', { method: 'POST' });
export const checkOut = () => apiFetch<AttendanceCell>('/attendance/check-out', { method: 'POST' });
export const getMyHistory = (params: { from?: string; to?: string }) =>
  apiFetch<AttendanceCell[]>(`/attendance/me${qs(params)}`);

// ── admin ──
export const getReport = (params: { from?: string; to?: string }) =>
  apiFetch<AttendanceReport>(`/attendance/report${qs(params)}`);
export const getSummary = (month: string) =>
  apiFetch<MonthlySummary>(`/attendance/summary${qs({ month })}`);
export const overrideAttendance = (userId: number, date: string, body: OverridePayload) =>
  apiFetch<AttendanceCell>(`/attendance/${userId}/${date}`, { method: 'PATCH', body });
export const getAttendanceSettings = () =>
  apiFetch<{ workStartTime: string }>('/attendance/settings');
export const setAttendanceSettings = (workStartTime: string) =>
  apiFetch<{ workStartTime: string }>('/attendance/settings', {
    method: 'PATCH',
    body: { workStartTime },
  });

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
