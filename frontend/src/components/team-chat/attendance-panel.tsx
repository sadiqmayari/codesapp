'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Loader2, LogIn, LogOut } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import { periodRange, type PeriodKey } from '@/lib/date-period';
import {
  type AttendanceCell,
  type AttendanceMember,
  type AttendanceReport,
  type AttendanceSettings,
  type AttendanceStatus,
  type LeaveRequest,
  type MonthlySummary,
  type MyToday,
  STATUS_META,
  checkIn,
  checkOut,
  downloadAttendanceCsv,
  fmtClock,
  fmtHours,
  getAttendanceSettings,
  getLeaveRequests,
  getMembers,
  getMyHistory,
  getMyLeave,
  getMyToday,
  getReport,
  getSummary,
  overrideAttendance,
  requestLeave,
  reviewLeave,
  setAttendanceSettings,
  updateMember,
} from '@/lib/attendance';

const PRESETS: { key: PeriodKey; label: string }[] = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
];

type Tab = 'checkin' | 'grid' | 'summary' | 'leave' | 'settings';

function StatusChip({ status, late, missed }: { status: AttendanceStatus; late?: boolean; missed?: boolean }) {
  const meta = STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.cls}`}>
        {meta.label}
        {late && status === 'present' && <span className="text-amber-600">· Late</span>}
      </span>
      {missed && <span title="Missed checkout" className="text-amber-500">⚠</span>}
    </span>
  );
}

function toHHMM(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function dayLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}
function monthNow(): string {
  return new Date().toISOString().slice(0, 7);
}

export default function AttendancePanel() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';
  const isOwner = user?.role === 'owner';

  const tabs: { key: Tab; label: string }[] = isAdmin
    ? [
        { key: 'checkin', label: 'Check in' },
        { key: 'grid', label: 'Daily grid' },
        { key: 'summary', label: 'Monthly summary' },
        { key: 'leave', label: 'Leave' },
        { key: 'settings', label: 'Settings' },
      ]
    : [
        { key: 'checkin', label: 'Check in' },
        { key: 'leave', label: 'Leave' },
      ];
  const [tab, setTab] = useState<Tab>(isOwner ? 'grid' : 'checkin');

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mb-5 flex gap-1 flex-wrap border-b border-gray-200">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-sm -mb-px border-b-2 ${tab === t.key ? 'font-semibold text-green-700 border-green-600' : 'font-medium text-gray-500 border-transparent hover:text-gray-700'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'checkin' && <CheckinTab isOwner={isOwner} />}
      {tab === 'grid' && isAdmin && <GridTab />}
      {tab === 'summary' && isAdmin && <SummaryTab />}
      {tab === 'leave' && <LeaveTab isAdmin={isAdmin} isOwner={isOwner} />}
      {tab === 'settings' && isAdmin && <SettingsTab />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-gray-400 uppercase tracking-wide">{label}</p>
      <p className="font-semibold text-gray-800">{value}</p>
    </div>
  );
}

// ── Check-in (self) ──
function CheckinTab({ isOwner }: { isOwner: boolean }) {
  const toast = useToast();
  const [today, setToday] = useState<MyToday | null>(null);
  const [history, setHistory] = useState<AttendanceCell[]>([]);
  const [punching, setPunching] = useState(false);

  const loadSelf = useCallback(async () => {
    try {
      const [t, h] = await Promise.all([getMyToday(), getMyHistory(periodRange('30d'))]);
      setToday(t);
      setHistory(h);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load attendance');
    }
  }, [toast]);

  useEffect(() => {
    loadSelf();
  }, [loadSelf]);

  if (isOwner || today?.excluded) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-gray-50 p-8 text-center text-sm text-gray-500">
        👑 As the owner, you&apos;re not tracked for attendance. Use the other tabs to see the team
        report, summary, leave requests, and settings.
      </div>
    );
  }

  const rec = today?.record ?? null;
  const canCheckIn = !rec?.checkInAt;
  const canCheckOut = !!rec?.checkInAt && !rec?.checkOutAt;

  const punch = async (dir: 'in' | 'out') => {
    setPunching(true);
    try {
      await (dir === 'in' ? checkIn() : checkOut());
      await loadSelf();
      toast.success(dir === 'in' ? 'Checked in' : 'Checked out');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not record attendance');
    } finally {
      setPunching(false);
    }
  };

  return (
    <div className="grid md:grid-cols-3 gap-4">
      <div className="md:col-span-1 rounded-2xl border border-gray-200 p-5 bg-gradient-to-br from-green-50 to-white">
        <p className="text-xs font-medium text-gray-500">{today ? dayLabel(today.date) : 'Today'}</p>
        <p className="mt-1 text-lg font-bold text-gray-900">
          {rec?.checkOutAt ? 'Day complete' : rec?.checkInAt ? 'Checked in' : 'Not checked in yet'}
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <Stat label="Check in" value={fmtClock(rec?.checkInAt ?? null)} />
          <Stat label="Check out" value={fmtClock(rec?.checkOutAt ?? null)} />
          <Stat label="Hours" value={fmtHours(rec?.workedMinutes ?? null)} />
          <div>
            <p className="text-[11px] text-gray-400 uppercase tracking-wide">Status</p>
            {rec ? <StatusChip status={rec.status} late={rec.isLate} missed={rec.missedCheckout} /> : <p className="font-semibold text-gray-800">—</p>}
          </div>
        </div>
        <div className="mt-5 flex gap-2">
          <button
            onClick={() => punch('in')}
            disabled={punching || !canCheckIn}
            className="flex-1 inline-flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-green-600 hover:bg-green-700 disabled:opacity-40 disabled:hover:bg-green-600 text-white text-sm font-semibold transition"
          >
            {punching && canCheckIn ? <Loader2 size={15} className="animate-spin" /> : <LogIn size={15} />}
            Check In
          </button>
          <button
            onClick={() => punch('out')}
            disabled={punching || !canCheckOut}
            className="flex-1 inline-flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-gray-800 hover:bg-gray-900 disabled:opacity-40 disabled:hover:bg-gray-800 text-white text-sm font-semibold transition"
          >
            <LogOut size={15} />
            Check Out
          </button>
        </div>
        {today && (
          <p className="mt-2 text-[11px] text-gray-400">
            Your shift: <b>{today.workStart}{today.workEnd ? ` – ${today.workEnd}` : ''}</b> · after{' '}
            {today.workStart} = <span className="text-amber-600 font-medium">Late</span>
          </p>
        )}
      </div>

      <div className="md:col-span-2 rounded-2xl border border-gray-200 p-5">
        <p className="text-sm font-semibold text-gray-900 mb-3">My recent attendance</p>
        {history.length === 0 ? (
          <p className="text-sm text-gray-400 py-6 text-center">No records yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase text-gray-400 border-b border-gray-100">
                <th className="py-2">Date</th><th>In</th><th>Out</th><th>Hours</th><th>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {history.map((r) => (
                <tr key={r.date}>
                  <td className="py-2 text-gray-700">{dayLabel(r.date)}</td>
                  <td className="text-gray-600">{fmtClock(r.checkInAt)}</td>
                  <td className="text-gray-600">{fmtClock(r.checkOutAt)}</td>
                  <td className="text-gray-600">{fmtHours(r.workedMinutes)}</td>
                  <td><StatusChip status={r.status} late={r.isLate} missed={r.missedCheckout} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Daily grid (admin) ──
function GridTab() {
  const toast = useToast();
  const [period, setPeriod] = useState<PeriodKey>('7d');
  const [report, setReport] = useState<AttendanceReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [edit, setEdit] = useState<{ userId: number; name: string; date: string; cell: AttendanceCell | null } | null>(null);
  const range = useMemo(() => periodRange(period), [period]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await getReport(range));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, [range, toast]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as PeriodKey)}
          className="border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-gray-700"
        >
          {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <button
          onClick={() => downloadAttendanceCsv(range).catch(() => toast.error('Export failed'))}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
        >
          <Download size={13} /> CSV
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400 py-8 text-center"><Loader2 className="inline animate-spin" size={16} /> Loading…</p>
      ) : report && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border border-gray-100 rounded-xl overflow-hidden">
            <thead>
              <tr className="bg-gray-50 text-[11px] uppercase text-gray-400">
                <th className="text-left py-2.5 px-3 font-semibold sticky left-0 bg-gray-50">Member</th>
                {report.dates.map((d) => (
                  <th key={d} className="py-2.5 px-2 whitespace-nowrap">{dayLabel(d).replace(/,/, '')}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {report.members.map((m) => (
                <tr key={m.userId}>
                  <td className="py-2.5 px-3 sticky left-0 bg-white">
                    <div className="font-medium text-gray-800">{m.name}</div>
                    <div className="text-[11px] text-gray-400">{m.role}</div>
                  </td>
                  {report.dates.map((d) => {
                    const c = m.cells[d] ?? null;
                    return (
                      <td
                        key={d}
                        onClick={() => setEdit({ userId: m.userId, name: m.name, date: d, cell: c })}
                        className="py-2.5 px-2 text-center cursor-pointer hover:bg-green-50"
                        title={c ? `${fmtClock(c.checkInAt)}–${fmtClock(c.checkOutAt)} · ${fmtHours(c.workedMinutes)}` : 'No record — click to add'}
                      >
                        {c ? <StatusChip status={c.status} late={c.isLate} missed={c.missedCheckout} /> : <span className="text-gray-300">·</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-gray-400">Click a cell to override. ⚠ = missed checkout (auto-flagged nightly). Owner isn&apos;t listed.</p>
        </div>
      )}

      {edit && (
        <OverrideModal
          edit={edit}
          onClose={() => setEdit(null)}
          onSaved={() => { setEdit(null); load(); }}
        />
      )}
    </div>
  );
}

// ── Monthly summary (admin) ──
function SummaryTab() {
  const toast = useToast();
  const [month, setMonth] = useState(monthNow());
  const [summary, setSummary] = useState<MonthlySummary | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getSummary(month)
      .then((s) => { if (alive) setSummary(s); })
      .catch((e) => toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load summary'))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [month, toast]);

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
          className="border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-gray-700" />
      </div>
      {loading ? (
        <p className="text-sm text-gray-400 py-8 text-center"><Loader2 className="inline animate-spin" size={16} /> Loading…</p>
      ) : summary && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border border-gray-100 rounded-xl overflow-hidden">
            <thead>
              <tr className="bg-gray-50 text-[11px] uppercase text-gray-400 text-left">
                <th className="py-2.5 px-3 font-semibold">Member</th>
                <th className="px-2">Present</th><th className="px-2">Absent</th><th className="px-2">Leave</th>
                <th className="px-2">Half</th><th className="px-2">Late</th><th className="px-2">Early-leave</th>
                <th className="px-2">Hours</th><th className="px-2">Overtime</th><th className="px-2">Attend.%</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {summary.rows.map((r) => (
                <tr key={r.userId}>
                  <td className="py-2.5 px-3"><div className="font-medium text-gray-800">{r.name}</div><div className="text-[11px] text-gray-400">{r.role}</div></td>
                  <td className="px-2 text-center text-green-700 font-semibold">{r.present}</td>
                  <td className="px-2 text-center text-red-600">{r.absent}</td>
                  <td className="px-2 text-center text-blue-600">{r.leave}</td>
                  <td className="px-2 text-center text-purple-600">{r.halfDay}</td>
                  <td className="px-2 text-center text-amber-600">{r.late}</td>
                  <td className="px-2 text-center text-orange-600">{r.earlyLeaves}</td>
                  <td className="px-2 text-center font-semibold text-gray-800">{fmtHours(r.totalMinutes)}</td>
                  <td className="px-2 text-center text-indigo-600">{r.overtimeMinutes ? fmtHours(r.overtimeMinutes) : '—'}</td>
                  <td className={`px-2 text-center font-semibold ${r.attendancePct >= 95 ? 'text-green-700' : r.attendancePct >= 80 ? 'text-amber-600' : 'text-red-600'}`}>{r.attendancePct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-gray-400">{summary.month} · overtime &amp; attendance % use each member&apos;s shift start/end.</p>
        </div>
      )}
    </div>
  );
}

// ── Leave (member request + admin review) ──
function LeaveTab({ isAdmin, isOwner }: { isAdmin: boolean; isOwner: boolean }) {
  const toast = useToast();
  const [mine, setMine] = useState<LeaveRequest[]>([]);
  const [pending, setPending] = useState<LeaveRequest[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      if (!isOwner) setMine(await getMyLeave());
      if (isAdmin) setPending(await getLeaveRequests('pending'));
    } catch {
      /* non-fatal */
    }
  }, [isAdmin, isOwner]);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (!from || !to) { toast.error('Pick a date range'); return; }
    setBusy(true);
    try {
      await requestLeave({ fromDate: from, toDate: to, reason });
      setFrom(''); setTo(''); setReason('');
      toast.success('Leave request submitted');
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not submit');
    } finally {
      setBusy(false);
    }
  };

  const review = async (id: number, status: 'approved' | 'rejected') => {
    try {
      await reviewLeave(id, { status });
      toast.success(status === 'approved' ? 'Approved' : 'Rejected');
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not update');
    }
  };

  const statusChip = (s: string) => {
    const cls = s === 'approved' ? 'bg-green-100 text-green-700' : s === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700';
    return <span className={`chip rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{s[0].toUpperCase() + s.slice(1)}</span>;
  };

  return (
    <div className="space-y-5">
      {!isOwner && (
        <div className="grid md:grid-cols-2 gap-4">
          <div className="rounded-2xl border border-gray-200 p-5">
            <p className="text-sm font-semibold text-gray-900 mb-3">Request leave</p>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div><label className="block text-xs text-gray-500 mb-1">From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm" /></div>
              <div><label className="block text-xs text-gray-500 mb-1">To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm" /></div>
            </div>
            <label className="block text-xs text-gray-500 mb-1">Reason</label>
            <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Family event…" className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm mb-3" />
            <button onClick={submit} disabled={busy} className="w-full py-2 rounded-xl bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-semibold">{busy ? 'Submitting…' : 'Submit request'}</button>
          </div>
          <div className="rounded-2xl border border-gray-200 p-5">
            <p className="text-sm font-semibold text-gray-900 mb-3">My requests</p>
            {mine.length === 0 ? <p className="text-sm text-gray-400 py-4 text-center">No requests yet.</p> : (
              <div className="space-y-2 text-sm">
                {mine.map((r) => (
                  <div key={r.id} className="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-2">
                    <span className="min-w-0 truncate">{dayLabel(r.fromDate)}{r.toDate !== r.fromDate ? ` – ${dayLabel(r.toDate)}` : ''}{r.reason ? ` · ${r.reason}` : ''}</span>
                    {statusChip(r.status)}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="rounded-2xl border border-gray-200 p-5">
          <p className="text-sm font-semibold text-gray-900 mb-3">Pending leave requests</p>
          {pending.length === 0 ? <p className="text-sm text-gray-400 py-4 text-center">No pending requests.</p> : (
            <div className="space-y-2 text-sm">
              {pending.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-100 px-3 py-2">
                  <span className="min-w-0"><b>{r.userName}</b> · {dayLabel(r.fromDate)}{r.toDate !== r.fromDate ? ` – ${dayLabel(r.toDate)}` : ''}{r.reason ? ` · ${r.reason}` : ''}</span>
                  <span className="flex gap-2">
                    <button onClick={() => review(r.id, 'approved')} className="px-3 py-1 rounded-lg bg-green-600 text-white text-xs font-medium">Approve</button>
                    <button onClick={() => review(r.id, 'rejected')} className="px-3 py-1 rounded-lg border border-gray-300 text-gray-600 text-xs">Reject</button>
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-[11px] text-gray-400">Approving auto-marks those days as <b>Leave</b> on the grid.</p>
        </div>
      )}
    </div>
  );
}

// ── Settings (admin) ──
function SettingsTab() {
  const toast = useToast();
  const [settings, setSettings] = useState<AttendanceSettings | null>(null);
  const [members, setMembers] = useState<AttendanceMember[]>([]);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [ips, setIps] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([getAttendanceSettings(), getMembers()]);
      setSettings(s);
      setStart(s.workStartTime || '');
      setEnd(s.workEndTime || '');
      setIps(s.officeIps || '');
      setMembers(m);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load settings');
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const saveCompany = async () => {
    setSaving(true);
    try {
      const s = await setAttendanceSettings({ workStartTime: start, workEndTime: end, officeIps: ips });
      setSettings(s);
      toast.success('Saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const saveMember = async (userId: number, body: { workStartTime?: string; workEndTime?: string; requireOfficeIp?: boolean }) => {
    try {
      await updateMember(userId, body);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save');
      load();
    }
  };

  const setMemberLocal = (userId: number, patch: Partial<AttendanceMember>) =>
    setMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, ...patch } : m)));

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-gray-200 p-5">
        <p className="text-sm font-semibold text-gray-900 mb-3">General (company default)</p>
        <div className="flex flex-wrap gap-4 items-end">
          <div><label className="block text-xs text-gray-500 mb-1">Shift start</label><input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm w-28" /></div>
          <div><label className="block text-xs text-gray-500 mb-1">Shift end</label><input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm w-28" /></div>
          <button onClick={saveCompany} disabled={saving} className="px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-medium">{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 p-5">
        <p className="text-sm font-semibold text-gray-900 mb-1">🔒 Office network (IP allow-list)</p>
        <p className="text-xs text-gray-500 mb-3">
          Optional. Members with the toggle ON can only check in from these networks (comma-separated IPs or CIDR ranges).
          {settings?.yourIp && (
            <> Your current IP: <b>{settings.yourIp}</b>{' '}
              <button onClick={() => setIps((v) => (v.includes(settings.yourIp) ? v : v ? `${v}, ${settings.yourIp}` : settings.yourIp))} className="text-green-700 underline">+ add</button>
            </>
          )}
        </p>
        <textarea rows={2} value={ips} onChange={(e) => setIps(e.target.value)} placeholder="39.38.120.112, 103.47.0.0/16" className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm font-mono" />
        <button onClick={saveCompany} disabled={saving} className="mt-2 px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-medium">{saving ? 'Saving…' : 'Save'}</button>
      </div>

      <div className="rounded-2xl border border-gray-200 p-5 overflow-x-auto">
        <p className="text-sm font-semibold text-gray-900 mb-3">Per-member schedule &amp; network</p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase text-gray-400 border-b border-gray-100">
              <th className="py-2">Member</th><th>Shift start</th><th>Shift end</th><th>Require office network</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {members.map((m) => (
              <tr key={m.userId}>
                <td className="py-2 font-medium text-gray-800">{m.name}<div className="text-[11px] text-gray-400 font-normal">{m.role}</div></td>
                <td>
                  <input type="time" value={m.workStart ?? ''} placeholder={m.effectiveStart}
                    onChange={(e) => setMemberLocal(m.userId, { workStart: e.target.value })}
                    onBlur={(e) => saveMember(m.userId, { workStartTime: e.target.value })}
                    className="border border-gray-300 rounded px-2 py-1 text-xs w-24" />
                </td>
                <td>
                  <input type="time" value={m.workEnd ?? ''} placeholder={m.effectiveEnd ?? ''}
                    onChange={(e) => setMemberLocal(m.userId, { workEnd: e.target.value })}
                    onBlur={(e) => saveMember(m.userId, { workEndTime: e.target.value })}
                    className="border border-gray-300 rounded px-2 py-1 text-xs w-24" />
                </td>
                <td>
                  <input type="checkbox" checked={m.requireOfficeIp}
                    onChange={(e) => { setMemberLocal(m.userId, { requireOfficeIp: e.target.checked }); saveMember(m.userId, { requireOfficeIp: e.target.checked }); }}
                    className="w-4 h-4 accent-green-600" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] text-gray-400">Blank start/end = use the company default. Owner isn&apos;t listed.</p>
      </div>
    </div>
  );
}

// ── Override modal ──
function OverrideModal({
  edit,
  onClose,
  onSaved,
}: {
  edit: { userId: number; name: string; date: string; cell: AttendanceCell | null };
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [status, setStatus] = useState<AttendanceStatus>(edit.cell?.status ?? 'present');
  const [checkInStr, setCheckInStr] = useState(toHHMM(edit.cell?.checkInAt ?? null));
  const [checkOutStr, setCheckOutStr] = useState(toHHMM(edit.cell?.checkOutAt ?? null));
  const [note, setNote] = useState(edit.cell?.note ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await overrideAttendance(edit.userId, edit.date, { status, checkIn: checkInStr, checkOut: checkOutStr, note });
      toast.success('Attendance updated');
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Override attendance"
      footer={
        <>
          <button onClick={onClose} disabled={busy} className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">Cancel</button>
          <button onClick={save} disabled={busy} className="px-4 py-2 text-sm rounded-lg bg-green-600 hover:bg-green-700 text-white font-medium disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
        </>
      }
    >
      <p className="text-xs text-gray-500 mb-4">{edit.name} · {dayLabel(edit.date)}</p>
      <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
      <select value={status} onChange={(e) => setStatus(e.target.value as AttendanceStatus)} className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm mb-3">
        {(Object.keys(STATUS_META) as AttendanceStatus[]).map((s) => (
          <option key={s} value={s}>{STATUS_META[s].label}</option>
        ))}
      </select>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div><label className="block text-xs font-medium text-gray-600 mb-1">Check in</label><input type="time" value={checkInStr} onChange={(e) => setCheckInStr(e.target.value)} className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm" /></div>
        <div><label className="block text-xs font-medium text-gray-600 mb-1">Check out</label><input type="time" value={checkOutStr} onChange={(e) => setCheckOutStr(e.target.value)} className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm" /></div>
      </div>
      <label className="block text-xs font-medium text-gray-600 mb-1">Note</label>
      <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} placeholder="Approved leave / correction…" className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm" />
    </Modal>
  );
}
