'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Users } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { Modal } from '@/components/ui/modal';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { EmptyState, NoResults } from '@/components/ui/empty-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import {
  STATUS_META,
  dayShort,
  downloadAttendanceCsv,
  fmtClock,
  fmtHours,
  getReport,
  overrideAttendance,
  tenantHHMM,
  type AttendanceCell,
  type AttendanceReport,
  type AttendanceStatus,
} from '@/lib/attendance';
import { periodDays, type PeriodKey } from '@/lib/date-period';
import { cn } from '@/lib/utils';
import { Field, cellCode, errMsg, inputCls } from './shared';

function EditDayModal({
  target,
  onClose,
  onSaved,
}: {
  target: { userId: number; name: string; date: string; cell: AttendanceCell | null } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [status, setStatus] = useState<AttendanceStatus>('present');
  const [inT, setInT] = useState('');
  const [outT, setOutT] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!target) return;
    setStatus(target.cell?.status ?? 'present');
    // Pre-fill on the TENANT clock (the server reads HH:MM in the tenant zone).
    setInT(tenantHHMM(target.cell?.checkInAt ?? null));
    setOutT(tenantHHMM(target.cell?.checkOutAt ?? null));
    setNote(target.cell?.note ?? '');
  }, [target]);
  const save = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await overrideAttendance(target.userId, target.date, { status, checkIn: inT, checkOut: outT, note });
      toast.success('Saved');
      onSaved();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const timed = status === 'present' || status === 'half_day';
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={target ? `${target.name} · ${dayShort(target.date)}` : ''}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={busy} onClick={save}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        {target?.cell?.checkoutSource === 'auto' && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">This day was closed automatically. Set the real check-out time if you know it.</p>
        )}
        <Field label="Status" htmlFor="ed-status">
          <select id="ed-status" className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as AttendanceStatus)}>
            {(Object.keys(STATUS_META) as AttendanceStatus[]).map((s) => (
              <option key={s} value={s}>{STATUS_META[s].label}</option>
            ))}
          </select>
        </Field>
        {timed && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Check in" htmlFor="ed-in">
              <input id="ed-in" type="time" className={inputCls} value={inT} onChange={(e) => setInT(e.target.value)} />
            </Field>
            <Field label="Check out" htmlFor="ed-out" hint="Earlier than check-in = next morning (night shift).">
              <input id="ed-out" type="time" className={inputCls} value={outT} onChange={(e) => setOutT(e.target.value)} />
            </Field>
          </div>
        )}
        <Field label="Note" htmlFor="ed-note">
          <input id="ed-note" className={inputCls} value={note} maxLength={255} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export default function GridTab() {
  const toast = useToast();
  const { user } = useAuth();
  const [period, setPeriod] = useState<PeriodKey>('7d');
  const [custom, setCustom] = useState<{ from?: string; to?: string }>({});
  const [report, setReport] = useState<AttendanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<{ userId: number; name: string; date: string; cell: AttendanceCell | null } | null>(null);
  const [csvBusy, setCsvBusy] = useState(false);

  const range = useMemo(() => periodDays(period, custom), [period, custom]);
  const load = useCallback(() => {
    setError(null);
    getReport({ from: range.from, to: range.to })
      .then(setReport)
      .catch((e) => setError(errMsg(e, 'Could not load the grid')));
  }, [range]);
  useEffect(() => {
    load();
  }, [load]);

  const members = (report?.members ?? []).filter((m) => !q || m.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Period" className={`${inputCls} w-auto`} value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)}>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="month">This month</option>
          <option value="custom">Custom</option>
        </select>
        {period === 'custom' && (
          <>
            <input type="date" aria-label="From" className={`${inputCls} w-auto`} value={custom.from ?? ''} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            <input type="date" aria-label="To" className={`${inputCls} w-auto`} value={custom.to ?? ''} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
          </>
        )}
        <SearchInput value={q} onChange={setQ} placeholder="Search member" className="w-56" />
        <span className="flex-1" />
        <Button
          variant="secondary"
          size="sm"
          loading={csvBusy}
          onClick={async () => {
            setCsvBusy(true);
            try {
              await downloadAttendanceCsv({ from: range.from, to: range.to });
            } catch (e) {
              toast.error(errMsg(e));
            } finally {
              setCsvBusy(false);
            }
          }}
        >
          <Download size={14} /> CSV
        </Button>
      </div>

      {error ? (
        <EmptyState title="Could not load the grid" description={error} action={<Button onClick={load}>Retry</Button>} />
      ) : !report ? (
        <SkeletonRows rows={6} />
      ) : !report.members.length ? (
        <EmptyState icon={Users} title="No tracked members yet" />
      ) : !members.length ? (
        <NoResults query={q} onClear={() => setQ('')} />
      ) : (
        <Card className="overflow-hidden">
          <div className="max-h-[70vh] overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 z-10 bg-surface">
                <tr className="border-b border-line">
                  <th scope="col" className="sticky left-0 z-20 bg-surface px-3 py-2 text-left text-xs font-semibold text-muted">Member</th>
                  {report.dates.map((d) => {
                    const hol = report.holidays.includes(d);
                    return (
                      <th key={d} scope="col" className={cn('px-1 py-2 text-center text-[11px] font-semibold whitespace-nowrap', hol ? 'text-sky-700' : 'text-muted', d === report.today && 'text-brand-700')}>
                        {dayShort(d).replace(',', '')}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {members.map((m) => {
                  const off = new Set(m.offDays);
                  return (
                    <tr key={m.userId}>
                      <th scope="row" className="sticky left-0 bg-surface px-3 py-1.5 text-left font-medium text-ink whitespace-nowrap">{m.name}</th>
                      {report.dates.map((d) => {
                        const c = m.cells[d];
                        const cc = cellCode(c, off.has(d));
                        const future = d > report.today;
                        const self = m.userId === user?.id && user?.role !== 'owner';
                        const label = `${m.name}, ${dayShort(d)}: ${cc.name}${c?.checkInAt ? `, ${fmtClock(c.checkInAt)} to ${fmtClock(c.checkOutAt)}` : ''}${c?.workedMinutes ? `, ${fmtHours(c.workedMinutes)}` : ''}${c?.checkoutSource === 'auto' ? ', closed automatically' : ''}`;
                        return (
                          <td key={d} className="p-0.5 text-center">
                            <button
                              type="button"
                              disabled={future || self}
                              title={label}
                              aria-label={label}
                              onClick={() => setEdit({ userId: m.userId, name: m.name, date: d, cell: c ?? null })}
                              className={cn(
                                'relative h-8 w-9 rounded-md text-xs font-bold disabled:cursor-default',
                                cc.cls,
                                !c && !off.has(d) && !future && 'hover:bg-sunken',
                              )}
                            >
                              {cc.code}
                              {c?.checkoutSource === 'auto' && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-violet-500" aria-hidden />}
                              {c?.overridden && <span className="absolute left-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-gray-400" aria-hidden />}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-3 border-t border-line px-3 py-2 text-xs text-muted">
            <span><b className="text-emerald-700">P</b> present</span>
            <span><b className="text-amber-800">L</b> late</span>
            <span><b className="text-violet-700">½</b> half day</span>
            <span><b className="text-sky-700">Lv</b> leave</span>
            <span><b className="text-red-700">A</b> absent</span>
            <span>· day off</span>
            <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-violet-500" /> auto-closed</span>
            <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-gray-400" /> edited by admin</span>
            <span>Click a cell to edit.</span>
          </div>
        </Card>
      )}

      <EditDayModal
        target={edit}
        onClose={() => setEdit(null)}
        onSaved={() => {
          setEdit(null);
          load();
        }}
      />
    </div>
  );
}
