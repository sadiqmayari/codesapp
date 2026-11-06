'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, Download, Loader2, LogIn, LogOut } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import { periodRange, type PeriodKey } from '@/lib/date-period';
import {
  type AttendanceCell,
  type AttendanceReport,
  type AttendanceStatus,
  type MonthlySummary,
  type MyToday,
  STATUS_META,
  checkIn,
  checkOut,
  downloadAttendanceCsv,
  fmtClock,
  fmtHours,
  getAttendanceSettings,
  getMyHistory,
  getMyToday,
  getReport,
  getSummary,
  overrideAttendance,
  setAttendanceSettings,
} from '@/lib/attendance';

const PRESETS: { key: PeriodKey; label: string }[] = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
];

function StatusChip({ status, late }: { status: AttendanceStatus; late?: boolean }) {
  const meta = STATUS_META[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.cls}`}>
      {meta.label}
      {late && status === 'present' && <span className="text-amber-600">· Late</span>}
    </span>
  );
}

// HH:MM in the viewer's local clock (acceptable: tenant admins share the tenant tz).
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
  const toast = useToast();
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';

  // ── self ──
  const [today, setToday] = useState<MyToday | null>(null);
  const [history, setHistory] = useState<AttendanceCell[]>([]);
  const [punching, setPunching] = useState(false);

  const loadSelf = useCallback(async () => {
    try {
      const [t, h] = await Promise.all([
        getMyToday(),
        getMyHistory(periodRange('30d')),
      ]);
      setToday(t);
      setHistory(h);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load attendance');
    }
  }, [toast]);

  useEffect(() => {
    loadSelf();
  }, [loadSelf]);

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

  const rec = today?.record ?? null;
  const canCheckIn = !rec?.checkInAt;
  const canCheckOut = !!rec?.checkInAt && !rec?.checkOutAt;

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6 space-y-6">
      {/* Self check-in + history */}
      <div className="grid md:grid-cols-3 gap-4">
        <div className="md:col-span-1 rounded-2xl border border-gray-200 p-5 bg-gradient-to-br from-green-50 to-white">
          <p className="text-xs font-medium text-gray-500">
            {today ? dayLabel(today.date) : 'Today'}
          </p>
          <p className="mt-1 text-lg font-bold text-gray-900">
            {rec?.checkOutAt
              ? 'Day complete'
              : rec?.checkInAt
                ? 'Checked in'
                : 'Not checked in yet'}
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <Stat label="Check in" value={fmtClock(rec?.checkInAt ?? null)} />
            <Stat label="Check out" value={fmtClock(rec?.checkOutAt ?? null)} />
            <Stat label="Hours" value={fmtHours(rec?.workedMinutes ?? null)} />
            <div>
              <p className="text-[11px] text-gray-400 uppercase tracking-wide">Status</p>
              {rec ? <StatusChip status={rec.status} late={rec.isLate} /> : <p className="font-semibold text-gray-800">—</p>}
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
              Work start {today.workStart} · after that = <span className="text-amber-600 font-medium">Late</span>
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
                    <td><StatusChip status={r.status} late={r.isLate} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {isAdmin && <AdminSection />}
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

// ── Admin: daily grid + monthly summary + override + settings ──
function AdminSection() {
  const toast = useToast();
  const [sub, setSub] = useState<'grid' | 'summary'>('grid');
  const [period, setPeriod] = useState<PeriodKey>('7d');
  const [report, setReport] = useState<AttendanceReport | null>(null);
  const [summary, setSummary] = useState<MonthlySummary | null>(null);
  const [month, setMonth] = useState(monthNow());
  const [workStart, setWorkStart] = useState('09:30');
  const [loading, setLoading] = useState(false);
  const [edit, setEdit] = useState<{ userId: number; name: string; date: string; cell: AttendanceCell | null } | null>(null);

  const range = useMemo(() => periodRange(period), [period]);

  const loadReport = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await getReport(range));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, [range, toast]);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    try {
      setSummary(await getSummary(month));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load summary');
    } finally {
      setLoading(false);
    }
  }, [month, toast]);

  useEffect(() => {
    getAttendanceSettings().then((s) => setWorkStart(s.workStartTime)).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (sub === 'grid') loadReport();
    else loadSummary();
  }, [sub, loadReport, loadSummary]);

  const saveWorkStart = async () => {
    try {
      const s = await setAttendanceSettings(workStart);
      setWorkStart(s.workStartTime);
      toast.success('Work-start time saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save');
    }
  };

  return (
    <div className="rounded-2xl border border-gray-200 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
          {(['grid', 'summary'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setSub(k)}
              className={`px-3 py-1.5 text-xs rounded-lg ${sub === k ? 'font-semibold bg-white shadow-sm text-gray-900' : 'font-medium text-gray-500'}`}
            >
              {k === 'grid' ? 'Daily grid' : 'Monthly summary'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {sub === 'grid' ? (
            <>
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
            </>
          ) : (
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-gray-700"
            />
          )}
          <span className="hidden sm:flex items-center gap-1 text-xs text-gray-500 border-l border-gray-200 pl-2">
            <Clock size={13} /> Start
            <input
              type="time"
              value={workStart}
              onChange={(e) => setWorkStart(e.target.value)}
              onBlur={saveWorkStart}
              className="w-24 border border-gray-300 rounded-lg px-2 py-1 text-xs"
            />
          </span>
        </div>
      </div>

      {loading && <p className="text-sm text-gray-400 py-8 text-center"><Loader2 className="inline animate-spin" size={16} /> Loading…</p>}

      {!loading && sub === 'grid' && report && (
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
                        {c ? <StatusChip status={c.status} late={c.isLate} /> : <span className="text-gray-300">·</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-gray-400">Click any cell to override (fix a missed check-out, mark leave/holiday).</p>
        </div>
      )}

      {!loading && sub === 'summary' && summary && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border border-gray-100 rounded-xl overflow-hidden">
            <thead>
              <tr className="bg-gray-50 text-[11px] uppercase text-gray-400 text-left">
                <th className="py-2.5 px-3 font-semibold">Member</th>
                <th className="px-2">Present</th><th className="px-2">Absent</th>
                <th className="px-2">Leave</th><th className="px-2">Half-day</th>
                <th className="px-2">Holiday</th><th className="px-2">Late</th><th className="px-2">Total hrs</th>
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
                  <td className="px-2 text-center text-gray-500">{r.holiday}</td>
                  <td className="px-2 text-center text-amber-600">{r.late}</td>
                  <td className="px-2 text-center font-semibold text-gray-800">{fmtHours(r.totalMinutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-gray-400">{summary.month}</p>
        </div>
      )}

      {edit && (
        <OverrideModal
          edit={edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            if (sub === 'grid') loadReport();
            else loadSummary();
          }}
        />
      )}
    </div>
  );
}

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
      await overrideAttendance(edit.userId, edit.date, {
        status,
        checkIn: checkInStr,
        checkOut: checkOutStr,
        note,
      });
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
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Check in</label>
          <input type="time" value={checkInStr} onChange={(e) => setCheckInStr(e.target.value)} className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Check out</label>
          <input type="time" value={checkOutStr} onChange={(e) => setCheckOutStr(e.target.value)} className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm" />
        </div>
      </div>
      <label className="block text-xs font-medium text-gray-600 mb-1">Note</label>
      <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} placeholder="Approved leave / correction…" className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm" />
    </Modal>
  );
}
