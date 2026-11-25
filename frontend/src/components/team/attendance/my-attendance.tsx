'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, FileText, LogIn, LogOut, Wrench } from 'lucide-react';
import { useToast } from '@/components/toast';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  checkIn,
  checkOut,
  fmtClock,
  fmtHours,
  fmtMoney,
  getMyHistory,
  getMyPayslips,
  onAttendanceChanged,
  type AttendanceCell,
  type MyHistory,
  type Payslip,
  type PayrollRun,
} from '@/lib/attendance';
import { getMyEarnings, type MyEarnings, METRIC_LABELS } from '@/lib/commissions';
import { zonedMonthString, cn } from '@/lib/utils';
import { useMyToday } from './use-my-today';
import { MonthInput, errMsg } from './shared';
import { CorrectionModal, LeaveModal } from './requests';
import { PayslipSheet } from './payroll';

function monthDays(month: string) {
  const [y, m] = month.split('-').map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0 Sun
  return { n, lead: (first + 6) % 7 }; // Monday-first grid
}

function dayTone(c: AttendanceCell | undefined, off: boolean, future: boolean) {
  if ((c?.checkoutSource === 'auto' || c?.checkoutSource === 'auto_activity')) return { cls: 'bg-violet-50 text-violet-700', label: 'Closed automatically' };
  if (c?.status === 'present' && c.isLate) return { cls: 'bg-amber-50 text-amber-800', label: 'Late' };
  if (c?.status === 'present') return { cls: 'bg-emerald-50 text-emerald-700', label: 'Present' };
  if (c?.status === 'half_day') return { cls: 'bg-violet-50 text-violet-700', label: 'Half day' };
  if (c?.status === 'leave') return { cls: 'bg-sky-50 text-sky-700', label: 'Leave' };
  if (c?.status === 'absent') return { cls: 'bg-red-50 text-red-700', label: 'Absent' };
  if (off || c?.status === 'holiday') return { cls: 'bg-sunken text-muted', label: 'Off' };
  return { cls: future ? 'text-muted' : 'border border-dashed border-line text-muted', label: future ? '' : 'Not marked' };
}

export default function MyAttendanceTab() {
  const toast = useToast();
  const a = useMyToday();
  const [month, setMonth] = useState(() => zonedMonthString());
  const [hist, setHist] = useState<MyHistory | null>(null);
  const [slips, setSlips] = useState<{ currency: string; payslips: { run: PayrollRun; slip: Payslip }[] } | null>(null);
  const [earn, setEarn] = useState<MyEarnings | null>(null);
  const [busy, setBusy] = useState(false);
  const [fixDate, setFixDate] = useState<string | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [openSlip, setOpenSlip] = useState<Payslip | null>(null);

  const loadMonth = useCallback(() => {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    getMyHistory({ from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` })
      .then(setHist)
      .catch(() => setHist({ from: '', to: '', offDays: [], rows: [] }));
  }, [month]);

  useEffect(() => {
    loadMonth();
    return onAttendanceChanged(loadMonth);
  }, [loadMonth]);
  useEffect(() => {
    getMyPayslips().then(setSlips).catch(() => undefined);
  }, []);
  useEffect(() => {
    getMyEarnings(month).then(setEarn).catch(() => setEarn(null));
  }, [month]);

  const byDate = useMemo(() => new Map((hist?.rows ?? []).map((r) => [r.date, r])), [hist]);
  const off = useMemo(() => new Set(hist?.offDays ?? []), [hist]);
  const totals = useMemo(() => {
    const rows = hist?.rows ?? [];
    return {
      present: rows.filter((r) => r.status === 'present' || r.status === 'half_day').length,
      late: rows.filter((r) => r.isLate).length,
      absent: rows.filter((r) => r.status === 'absent').length,
      leave: rows.filter((r) => r.status === 'leave').length,
      minutes: rows.reduce((s, r) => s + (r.workedMinutes ?? 0), 0),
    };
  }, [hist]);

  const punch = async (kind: 'in' | 'out') => {
    setBusy(true);
    try {
      await (kind === 'in' ? checkIn() : checkOut());
      toast.success(kind === 'in' ? 'Checked in' : 'Checked out');
    } catch (e) {
      toast.error(errMsg(e, 'Could not save'));
    } finally {
      setBusy(false);
    }
  };

  const t = a.today;
  const todayStr = t?.date ?? '';
  const { n, lead } = monthDays(month);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* ── Today ── */}
      <Card className="lg:col-span-1">
        <CardHeader
          title="Today"
          description={
            t
              ? t.dayKind === 'holiday'
                ? `Holiday${t.holidayName ? `: ${t.holidayName}` : ''}`
                : t.dayKind === 'weekly_off'
                  ? 'Your day off'
                  : t.flexible
                    ? `Flexible · ${fmtHours(a.requiredMin)} a day`
                    : `Shift ${t.workStart}–${t.effectiveEnd}${t.neverLate ? ' · Relaxed (late not counted)' : t.graceMinutes ? ` · ${t.graceMinutes} min grace` : ''}`
              : undefined
          }
          action={t?.flexible ? <Badge tone="violet">Flexible</Badge> : undefined}
        />
        <CardBody className="space-y-4">
          {!a.loaded ? (
            <Skeleton className="h-24" />
          ) : !t ? (
            <p className="text-sm text-muted">Attendance isn&apos;t tracked for your role.</p>
          ) : (
            <>
              <div className="text-center">
                <p className="text-4xl font-bold tabular-nums text-ink">{fmtHours(a.workedMin)}</p>
                <p className="text-xs text-muted">
                  {a.open
                    ? `Checked in ${fmtClock(a.rec?.checkInAt ?? null)}`
                    : a.checkedIn
                      ? `${fmtClock(a.rec?.checkInAt ?? null)} – ${fmtClock(a.rec?.checkOutAt ?? null)}${a.rec?.checkoutSource === 'auto' ? ' · closed automatically' : a.rec?.checkoutSource === 'auto_activity' ? ' · closed automatically at your last activity' : ''}`
                      : 'Not checked in'}
                </p>
                {a.requiredMin && a.checkedIn && (
                  <div className="mx-auto mt-3 h-2 max-w-xs overflow-hidden rounded-full bg-sunken" aria-hidden>
                    <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.min(100, (a.workedMin / a.requiredMin) * 100)}%` }} />
                  </div>
                )}
              </div>
              {t.requireOfficeNetwork && (!a.checkedIn || a.open) && (
                <p
                  className={
                    t.onOfficeNetwork
                      ? 'rounded-lg bg-brand-50 px-3 py-2 text-center text-xs text-brand-700'
                      : 'rounded-lg bg-red-50 px-3 py-2 text-center text-xs text-red-700'
                  }
                >
                  {t.onOfficeNetwork
                    ? `On ${t.onOfficeNetwork}`
                    : 'Not on office WiFi. Connect to an office network to check in or out.'}
                </p>
              )}
              <div className="flex gap-2">
                {!a.checkedIn && (
                  <Button
                    className="flex-1"
                    loading={busy}
                    disabled={t.dayKind === 'work' && !a.inWindow}
                    onClick={() => punch('in')}
                    title={t.dayKind === 'work' && !a.inWindow ? `Check-in is open ${t.checkinOpensAt}–${t.checkinCutoff}` : undefined}
                  >
                    <LogIn size={16} /> {t.dayKind === 'work' ? 'Check in' : 'Check in (working today)'}
                  </Button>
                )}
                {a.open && (
                  <Button className="flex-1" variant={a.doneForToday || t.flexible ? 'primary' : 'secondary'} loading={busy} onClick={() => punch('out')}>
                    <LogOut size={16} /> {a.doneForToday || t.flexible ? 'Check out' : 'Leave early'}
                  </Button>
                )}
              </div>
              {!a.checkedIn && t.dayKind === 'work' && !a.inWindow && !t.flexible && (
                <p className="text-center text-xs text-muted">
                  Check-in is open {t.checkinOpensAt}–{t.checkinCutoff}. Missed it? Ask for a fix.
                </p>
              )}
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" className="flex-1" onClick={() => setLeaveOpen(true)}>
                  <CalendarDays size={14} /> Request leave
                </Button>
                <Button variant="secondary" size="sm" className="flex-1" onClick={() => setFixDate(todayStr)}>
                  <Wrench size={14} /> Fix a day
                </Button>
              </div>
            </>
          )}
        </CardBody>
      </Card>

      {/* ── Month calendar ── */}
      <Card className="lg:col-span-2">
        <CardHeader
          title="My month"
          description={`${totals.present} days worked · ${fmtHours(totals.minutes)} · ${totals.late} late · ${totals.absent} absent · ${totals.leave} leave`}
          action={<MonthInput id="my-month" value={month} onChange={setMonth} />}
        />
        <CardBody>
          <div className="grid grid-cols-7 gap-1.5 text-center text-xs" role="grid" aria-label="Attendance calendar">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
              <div key={d} className="py-1 font-semibold text-muted">
                {d}
              </div>
            ))}
            {Array.from({ length: lead }).map((_, i) => (
              <div key={`l${i}`} />
            ))}
            {Array.from({ length: n }).map((_, i) => {
              const ds = `${month}-${String(i + 1).padStart(2, '0')}`;
              const c = byDate.get(ds);
              const future = !!todayStr && ds > todayStr;
              const tone = dayTone(c, off.has(ds), future);
              const title = [ds, tone.label, c?.checkInAt ? `${fmtClock(c.checkInAt)}–${fmtClock(c.checkOutAt)}` : '', c?.note ?? '']
                .filter(Boolean)
                .join(' · ');
              return (
                <button
                  key={ds}
                  type="button"
                  disabled={future}
                  onClick={() => setFixDate(ds)}
                  title={title}
                  aria-label={title}
                  className={cn(
                    'flex aspect-square flex-col items-center justify-center rounded-lg font-semibold tabular-nums disabled:cursor-default',
                    tone.cls,
                    ds === todayStr && 'ring-2 ring-brand-500',
                  )}
                >
                  {i + 1}
                  {c?.workedMinutes ? <span className="hidden text-[10px] font-medium opacity-80 sm:block">{fmtHours(c.workedMinutes).replace('h ', ':').replace('m', '')}</span> : null}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted">
            {[
              ['bg-emerald-50', 'Present'],
              ['bg-amber-50', 'Late'],
              ['bg-red-50', 'Absent'],
              ['bg-sky-50', 'Leave'],
              ['bg-violet-50', 'Half day / auto-closed'],
              ['bg-sunken', 'Off'],
            ].map(([c, l]) => (
              <span key={l} className="inline-flex items-center gap-1">
                <span className={cn('h-2.5 w-2.5 rounded-sm', c)} aria-hidden />
                {l}
              </span>
            ))}
            <span>Tap a day to ask for a fix.</span>
          </div>
        </CardBody>
      </Card>

      {/* ── Earnings ── */}
      {earn && earn.plans.length > 0 && (
        <Card className="lg:col-span-2">
          <CardHeader title="My commission this month" description="Updates as orders and parcels count." action={<b className="text-lg tabular-nums text-brand-700">{fmtMoney(earn.total)}</b>} />
          <CardBody className="space-y-3">
            {earn.plans.map((p) => {
              const pct = p.next ? Math.min(100, (p.units / p.next.at) * 100) : 100;
              return (
                <div key={p.planId} className="space-y-1">
                  <div className="flex items-baseline gap-2 text-sm">
                    <span className="font-semibold text-ink">{p.planName}</span>
                    <span className="text-xs text-muted">{METRIC_LABELS[p.metric]}</span>
                    <span className="flex-1" />
                    <b className="tabular-nums">{fmtMoney(p.amount)}</b>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-sunken" aria-hidden>
                    <div className="h-full rounded-full bg-brand-500" style={{ width: `${pct}%` }} />
                  </div>
                  <p className="text-xs text-muted">
                    {p.detail}
                    {p.next ? ` · ${Math.max(0, Math.ceil(p.next.at - p.units)).toLocaleString()} more to ${p.next.label}` : ''}
                    {p.rank ? ` · #${p.rank} of ${p.of}` : ''}
                  </p>
                </div>
              );
            })}
          </CardBody>
        </Card>
      )}

      {/* ── Payslips ── */}
      <Card className={earn && earn.plans.length > 0 ? 'lg:col-span-1' : 'lg:col-span-3'}>
        <CardHeader title="My payslips" description="Approved payslips appear here." />
        <CardBody>
          {!slips ? (
            <Skeleton className="h-16" />
          ) : slips.payslips.length === 0 ? (
            <p className="text-sm text-muted">No payslips yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {slips.payslips.map(({ run, slip }) => (
                <li key={run.id}>
                  <button type="button" onClick={() => setOpenSlip(slip)} className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-sunken rounded-lg px-2">
                    <FileText size={16} className="text-muted" aria-hidden />
                    <span className="flex-1 text-sm font-medium text-ink">
                      {new Date(`${run.month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })}
                    </span>
                    <Badge tone={run.status === 'paid' ? 'success' : 'info'}>{run.status === 'paid' ? 'Paid' : 'Approved'}</Badge>
                    <b className="tabular-nums text-sm">{fmtMoney(slip.netPayable, slips.currency)}</b>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <LeaveModal open={leaveOpen} onClose={() => setLeaveOpen(false)} onDone={() => setLeaveOpen(false)} />
      <CorrectionModal
        date={fixDate}
        cell={fixDate ? byDate.get(fixDate) ?? null : null}
        onClose={() => setFixDate(null)}
        onDone={() => setFixDate(null)}
      />
      <PayslipSheet slip={openSlip} currency={slips?.currency ?? 'Rs'} onClose={() => setOpenSlip(null)} />
    </div>
  );
}
