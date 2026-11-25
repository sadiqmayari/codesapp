'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Users } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { SaveBar } from '@/components/ui/save-bar';
import { SideSheet } from '@/components/ui/side-sheet';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import {
  AUTO_PENALTY_LABELS,
  DAY_RATE_LABELS,
  LATE_METHOD_LABELS,
  OVERTIME_METHOD_LABELS,
  WEEKDAYS,
  addHoliday,
  deleteHoliday,
  fmtHours,
  fmtMoney,
  getAttendanceSettings,
  getHolidays,
  getMembers,
  setAttendanceSettings,
  timingModeOf,
  TIMING_LABEL,
  updateMember,
  type TimingMode,
  type Allowance,
  type AttendanceMember,
  type AttendanceSettings,
  type AutoCheckoutPenalty,
  type DayRateBasis,
  type Holiday,
  type LateMethod,
  type MemberPatch,
  type OvertimeMethod,
  type OfficeNetwork,
  type StatutoryDeduction,
} from '@/lib/attendance';
import { ipMatchesEntry } from '@/lib/ip-match';
import { cn } from '@/lib/utils';
import { Field, errMsg, inputCls } from './shared';

function WeekdayPicker({ value, onChange, id }: { value: number[]; onChange: (v: number[]) => void; id: string }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={id}>
      {WEEKDAYS.map((d, i) => {
        const on = value.includes(i);
        return (
          <button
            key={d}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== i) : [...value, i].sort())}
            className={cn('h-8 w-11 rounded-lg border text-xs font-semibold', on ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line text-muted')}
          >
            {d}
          </button>
        );
      })}
    </div>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-line py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{title}</p>
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

const num = (v: string) => (v === '' ? 0 : Number(v));

function OfficeNetworksEditor({
  value,
  onChange,
  yourIp,
}: {
  value: OfficeNetwork[];
  onChange: (v: OfficeNetwork[]) => void;
  yourIp: string;
}) {
  const yours = yourIp ? value.findIndex((n) => ipMatchesEntry(yourIp, n.ip)) : -1;
  const setAt = (i: number, x: Partial<OfficeNetwork>) => onChange(value.map((n, j) => (j === i ? { ...n, ...x } : n)));
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">Office networks</p>
          <p className="text-xs text-muted">
            Members set to &quot;Office network only&quot; can check in from any of these. Use each office WiFi&apos;s public IP
            (ask your internet provider for a static IP, or add it again if it changes).
          </p>
        </div>
        {yourIp && yours < 0 && value.length < 30 && (
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => onChange([...value, { label: `Office WiFi ${value.length + 1}`, ip: yourIp }])}
          >
            <Plus size={14} /> Add the network I&apos;m on
          </Button>
        )}
      </div>
      {value.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-muted">
          No office networks yet. Open this page on the office WiFi and press &quot;Add the network I&apos;m on&quot;.
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {value.map((n, i) => (
            <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 p-2.5 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto_auto] sm:items-center">
              <input
                aria-label={`Network ${i + 1} name`}
                className={inputCls}
                value={n.label}
                maxLength={40}
                placeholder="Office WiFi 1"
                onChange={(e) => setAt(i, { label: e.target.value })}
              />
              <Button
                variant="ghost"
                size="sm"
                className="sm:order-last"
                aria-label={`Remove ${n.label || 'network'}`}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                <Trash2 size={14} />
              </Button>
              <input
                aria-label={`Network ${i + 1} public IP`}
                className={cn(inputCls, 'tabular-nums')}
                value={n.ip}
                maxLength={64}
                placeholder="203.0.113.10 or 10.0.0.0/24"
                onChange={(e) => setAt(i, { ip: e.target.value.trim() })}
              />
              <span className="self-center">{i === yours ? <Badge tone="success">You&apos;re here</Badge> : null}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted tabular-nums">
        Your IP now: {yourIp || 'unknown'}
        {yours >= 0 ? ` · matches ${value[yours].label}` : ''}
      </p>
    </div>
  );
}

function HolidaysCard() {
  const toast = useToast();
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [list, setList] = useState<Holiday[] | null>(null);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const load = useCallback(() => {
    getHolidays(year).then(setList).catch(() => setList([]));
  }, [year]);
  useEffect(load, [load]);
  const add = async () => {
    try {
      await addHoliday({ date, name });
      setDate('');
      setName('');
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };
  return (
    <Card>
      <CardHeader
        title="Holidays"
        description="Nobody is marked absent on a holiday. Work on a holiday counts as overtime."
        action={
          <select aria-label="Year" className={`${inputCls} w-auto`} value={year} onChange={(e) => setYear(e.target.value)}>
            {[0, 1, -1].map((o) => {
              const y = String(new Date().getFullYear() + o);
              return <option key={y} value={y}>{y}</option>;
            })}
          </select>
        }
      />
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Date" htmlFor="hol-date">
            <input id="hol-date" type="date" className={`${inputCls} w-auto`} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <div className="min-w-[10rem] flex-1">
            <Field label="Name" htmlFor="hol-name">
              <input id="hol-name" className={inputCls} value={name} maxLength={120} placeholder="Eid ul Fitr" onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <Button disabled={!date || !name.trim()} onClick={add}>
            <Plus size={14} /> Add
          </Button>
        </div>
        {!list ? (
          <SkeletonRows rows={2} />
        ) : list.length === 0 ? (
          <p className="text-sm text-muted">No holidays for {year}.</p>
        ) : (
          <ul className="divide-y divide-line">
            {list.map((h) => (
              <li key={h.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="w-28 tabular-nums text-muted">{h.date}</span>
                <span className="flex-1 text-ink">{h.name}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${h.name}`}
                  onClick={async () => {
                    try {
                      await deleteHoliday(h.id);
                      load();
                    } catch (e) {
                      toast.error(errMsg(e));
                    }
                  }}
                >
                  <Trash2 size={14} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function MemberSheet({
  member,
  settings,
  onClose,
  onSaved,
}: {
  member: AttendanceMember | null;
  settings: AttendanceSettings;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { user } = useAuth();
  const [f, setF] = useState<AttendanceMember | null>(member);
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(member), [member]);
  if (!f) return <SideSheet open={false} onClose={onClose} title="">{null}</SideSheet>;
  const set = (p: Partial<AttendanceMember>) => setF({ ...f, ...p });
  // Own pay (non-owner) or an HR manager looking at an admin: read-only.
  const selfPay = (f.userId === user?.id && user?.role !== 'owner') || !!f.payHidden;
  const cur = settings.payrollPolicy.currency;
  const save = async () => {
    setBusy(true);
    const body: MemberPatch = {
      workStartTime: f.workStart ?? '',
      workEndTime: f.workEnd ?? '',
      graceMinutes: f.graceMinutes,
      requireOfficeIp: f.requireOfficeIp,
      exemptLate: f.exemptLate,
      neverLate: !f.exemptLate && !!f.neverLate,
      lockAfterShift: f.lockAfterShift ?? null,
      requiredMinutes: f.requiredMinutes,
      weeklyOff: f.weeklyOff,
      joinedOn: f.joinedOn ?? '',
      leftOn: f.leftOn ?? '',
      annualPaidLeave: f.annualPaidLeave,
      ...(selfPay ? {} : { salaryAmount: f.salaryAmount, overtimeRate: f.overtimeRate, allowances: f.allowances.filter((a) => a.label.trim()) }),
    };
    try {
      await updateMember(f.userId, body);
      toast.success('Saved');
      onSaved();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const setAllow = (i: number, p: Partial<Allowance>) => set({ allowances: f.allowances.map((a, j) => (j === i ? { ...a, ...p } : a)) });
  return (
    <SideSheet
      open
      onClose={onClose}
      title={f.name}
      subtitle={f.role}
      width="lg"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={busy} onClick={save}>Save</Button>
        </div>
      }
    >
      <div className="space-y-5">
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-ink">Schedule</h3>
          <div className="space-y-1.5">
            <p id="ms-timing" className="text-xs font-semibold text-muted">Timing</p>
            <div role="radiogroup" aria-labelledby="ms-timing" className="grid grid-cols-3 gap-1 rounded-xl bg-sunken p-1">
              {(['fixed', 'relaxed', 'flexible'] as TimingMode[]).map((m) => {
                const on = timingModeOf(f) === m;
                return (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => set({ exemptLate: m === 'flexible', neverLate: m === 'relaxed' })}
                    className={cn(
                      'h-10 rounded-lg px-2 text-sm font-semibold transition-colors',
                      on ? 'bg-surface text-brand-700 shadow-sm' : 'text-muted hover:text-ink',
                    )}
                  >
                    {TIMING_LABEL[m]}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted">
              {timingModeOf(f) === 'fixed'
                ? 'Fixed shift with a grace period. Late arrivals are marked and follow the late policy.'
                : timingModeOf(f) === 'relaxed'
                  ? 'Fixed shift, check-in window, shift end and overtime, but never marked late (no late deduction).'
                  : 'No fixed shift and never late. Works to a daily hours target.'}
            </p>
          </div>
          {f.exemptLate ? (
            <Field label="Required hours a day" htmlFor="ms-req" hint="Check-out reminder and auto-checkout credit use this.">
              <input
                id="ms-req"
                type="number"
                min="0.5"
                max="24"
                step="0.5"
                className={`${inputCls} w-32`}
                value={(f.requiredMinutes ?? 480) / 60}
                onChange={(e) => set({ requiredMinutes: Math.round(Number(e.target.value) * 60) || null })}
              />
            </Field>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Shift start" htmlFor="ms-start" hint={`Default ${settings.workStartTime}`}>
                <input id="ms-start" type="time" className={inputCls} value={f.workStart ?? ''} onChange={(e) => set({ workStart: e.target.value || null })} />
              </Field>
              <Field label="Shift end" htmlFor="ms-end" hint={`Default ${settings.workEndTime ?? 'start + 8h'}`}>
                <input id="ms-end" type="time" className={inputCls} value={f.workEnd ?? ''} onChange={(e) => set({ workEnd: e.target.value || null })} />
              </Field>
              <Field label="Grace (min)" htmlFor="ms-grace" hint={`Default ${settings.graceMinutes}`}>
                <input
                  id="ms-grace"
                  type="number"
                  min="0"
                  max="240"
                  className={inputCls}
                  value={f.graceMinutes ?? ''}
                  onChange={(e) => set({ graceMinutes: e.target.value === '' ? null : Number(e.target.value) })}
                />
              </Field>
            </div>
          )}
          <div className="space-y-1">
            <p id="ms-off" className="text-xs font-semibold text-muted">
              Weekly off {f.weeklyOff == null && <span className="font-normal">(company default)</span>}
            </p>
            <WeekdayPicker id="ms-off" value={f.weeklyOff ?? settings.weeklyOff} onChange={(v) => set({ weeklyOff: v })} />
            {f.weeklyOff != null && (
              <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => set({ weeklyOff: null })}>
                Use company default
              </button>
            )}
          </div>
          <label className="flex items-center gap-3">
            <Switch checked={f.requireOfficeIp} onChange={(v) => set({ requireOfficeIp: v })} label="Office network only" />
            <span className="text-sm text-ink">
              Can only check in/out from office WiFi
              {settings.officeNetworks.length ? ` (${settings.officeNetworks.map((n) => n.label).join(', ')})` : ' (add networks in General settings first)'}
            </span>
          </label>
          {!f.exemptLate && (
            <Field
              label="Lock app after shift end"
              htmlFor="ms-lock"
              hint={`Company default: ${settings.lockAfterShift ? `on, ${settings.lockBufferMinutes} min after shift end` : 'off'}. Days off are never locked.`}
            >
              <select
                id="ms-lock"
                className={`${inputCls} sm:w-72`}
                value={f.lockAfterShift == null ? 'default' : f.lockAfterShift ? 'on' : 'off'}
                onChange={(e) => set({ lockAfterShift: e.target.value === 'default' ? null : e.target.value === 'on' })}
              >
                <option value="default">Company default ({settings.lockAfterShift ? 'lock' : "don't lock"})</option>
                <option value="on">Lock after shift end</option>
                <option value="off">Don&apos;t lock</option>
              </select>
            </Field>
          )}
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-ink">Employment</h3>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Joined on" htmlFor="ms-join" hint="First month is prorated">
              <input id="ms-join" type="date" className={inputCls} value={f.joinedOn ?? ''} onChange={(e) => set({ joinedOn: e.target.value || null })} />
            </Field>
            <Field label="Left on" htmlFor="ms-left" hint="Last month is prorated">
              <input id="ms-left" type="date" className={inputCls} value={f.leftOn ?? ''} onChange={(e) => set({ leftOn: e.target.value || null })} />
            </Field>
            <Field label="Paid leave / year" htmlFor="ms-leave" hint={`Default ${settings.annualPaidLeave || 'not tracked'}`}>
              <input
                id="ms-leave"
                type="number"
                min="0"
                className={inputCls}
                value={f.annualPaidLeave ?? ''}
                onChange={(e) => set({ annualPaidLeave: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </Field>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-ink">Pay</h3>
          {selfPay && (
            <p className="text-xs text-amber-700">
              {f.payHidden && f.userId !== user?.id ? "Only the owner manages an admin's pay." : 'Only the owner can change your own pay.'}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label={`Monthly salary (${cur})`} htmlFor="ms-salary">
              <input
                id="ms-salary"
                type="number"
                min="0"
                disabled={selfPay}
                className={inputCls}
                value={f.salaryAmount ?? ''}
                onChange={(e) => set({ salaryAmount: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </Field>
            <Field label={`Overtime rate (${cur}/hour)`} htmlFor="ms-ot" hint="Only for the flat-per-hour overtime method">
              <input
                id="ms-ot"
                type="number"
                min="0"
                disabled={selfPay}
                className={inputCls}
                value={f.overtimeRate ?? ''}
                onChange={(e) => set({ overtimeRate: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </Field>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted">Monthly allowances</p>
            {f.allowances.map((a, i) => (
              <div key={i} className="flex gap-2">
                <input aria-label="Allowance name" className={inputCls} value={a.label} disabled={selfPay} placeholder="Fuel" onChange={(e) => setAllow(i, { label: e.target.value })} />
                <input
                  aria-label="Allowance amount"
                  type="number"
                  min="0"
                  className={`${inputCls} w-32`}
                  value={a.amount}
                  disabled={selfPay}
                  onChange={(e) => setAllow(i, { amount: Math.max(0, Number(e.target.value)) })}
                />
                <Button variant="ghost" size="sm" aria-label={`Remove ${a.label || 'allowance'}`} disabled={selfPay} onClick={() => set({ allowances: f.allowances.filter((_, j) => j !== i) })}>
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
            {!selfPay && f.allowances.length < 20 && (
              <Button variant="secondary" size="sm" onClick={() => set({ allowances: [...f.allowances, { label: '', amount: 0 }] })}>
                <Plus size={14} /> Add allowance
              </Button>
            )}
          </div>
        </section>
      </div>
    </SideSheet>
  );
}

export default function SettingsTab() {
  const toast = useToast();
  const [saved, setSaved] = useState<AttendanceSettings | null>(null);
  const [draft, setDraft] = useState<AttendanceSettings | null>(null);
  const [members, setMembers] = useState<AttendanceMember[] | null>(null);
  const [edit, setEdit] = useState<AttendanceMember | null>(null);
  const [saving, setSaving] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(() => {
    getAttendanceSettings()
      .then((s) => {
        setSaved(s);
        setDraft(s);
      })
      .catch((e) => toast.error(errMsg(e)));
    getMembers().then(setMembers).catch(() => setMembers([]));
  }, [toast]);
  useEffect(load, [load]);

  const setOfficeOnlyForAll = async (on: boolean) => {
    if (!members) return;
    setBulkBusy(true);
    const todo = members.filter((m) => m.requireOfficeIp !== on);
    const res = await Promise.allSettled(todo.map((m) => updateMember(m.userId, { requireOfficeIp: on })));
    const failed = res.filter((r) => r.status === 'rejected').length;
    if (failed) toast.error(`${failed} member(s) could not be updated`);
    else toast.success(on ? 'Office WiFi required for everyone' : 'Office WiFi no longer required');
    getMembers().then(setMembers).catch(() => undefined);
    setBulkBusy(false);
  };

  const dirty = useMemo(() => JSON.stringify(saved) !== JSON.stringify(draft), [saved, draft]);
  if (!draft || !saved) return <SkeletonRows rows={8} />;
  const p = draft.payrollPolicy;
  const setP = (x: Partial<typeof p>) => setDraft({ ...draft, payrollPolicy: { ...p, ...x } });
  const setA = (x: Partial<typeof draft.autoCheckout>) => setDraft({ ...draft, autoCheckout: { ...draft.autoCheckout, ...x } });
  const setStat = (i: number, x: Partial<StatutoryDeduction>) => setP({ statutory: p.statutory.map((s, j) => (j === i ? { ...s, ...x } : s)) });

  const save = async () => {
    setSaving(true);
    try {
      const s = await setAttendanceSettings({
        workStartTime: draft.workStartTime,
        workEndTime: draft.workEndTime ?? '',
        graceMinutes: draft.graceMinutes,
        officeNetworks: draft.officeNetworks.filter((n) => n.ip.trim()),
        lockAfterShift: draft.lockAfterShift,
        lockBufferMinutes: draft.lockBufferMinutes,
        checkinWindowMinutes: draft.checkinWindowMinutes,
        payrollPolicy: { ...p, statutory: p.statutory.filter((x) => x.label.trim()) },
        autoCheckout: draft.autoCheckout,
        weeklyOff: draft.weeklyOff,
        annualPaidLeave: draft.annualPaidLeave,
      });
      setSaved(s);
      setDraft(s);
      toast.success('Settings saved');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-4 pb-24 xl:grid-cols-2">
      <Card>
        <CardHeader title="Schedule & calendar" description={`Company clock: ${draft.timezone ?? 'UTC (set a timezone in Settings → General)'}`} />
        <CardBody>
          <Row title="Default shift" hint="Each member can have their own shift.">
            <div className="flex items-center gap-2">
              <input aria-label="Shift start" type="time" className={`${inputCls} w-28`} value={draft.workStartTime} onChange={(e) => setDraft({ ...draft, workStartTime: e.target.value })} />
              <span className="text-muted">to</span>
              <input aria-label="Shift end" type="time" className={`${inputCls} w-28`} value={draft.workEndTime ?? ''} onChange={(e) => setDraft({ ...draft, workEndTime: e.target.value || null })} />
            </div>
          </Row>
          <Row title="Weekly off" hint="Never marked absent, never deducted.">
            <WeekdayPicker id="co-off" value={draft.weeklyOff} onChange={(v) => setDraft({ ...draft, weeklyOff: v })} />
          </Row>
          <Row title="Paid leave per year" hint="0 = not tracked. Each member can have their own.">
            <input aria-label="Paid leave per year" type="number" min="0" className={`${inputCls} w-24`} value={draft.annualPaidLeave} onChange={(e) => setDraft({ ...draft, annualPaidLeave: num(e.target.value) })} />
          </Row>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Check-in rules" description="Applies to fixed-shift staff. Flexible staff check in any time." />
        <CardBody>
          <Row title="Grace" hint="Minutes after shift start before it counts as late.">
            <input aria-label="Grace minutes" type="number" min="0" max="240" className={`${inputCls} w-24`} value={draft.graceMinutes} onChange={(e) => setDraft({ ...draft, graceMinutes: num(e.target.value) })} />
          </Row>
          <Row title="Check-in window" hint={`Opens 30 min before the shift, closes this long after it starts (${fmtHours(draft.checkinWindowMinutes)}).`}>
            <input aria-label="Check-in window minutes" type="number" min="15" max="1440" className={`${inputCls} w-24`} value={draft.checkinWindowMinutes} onChange={(e) => setDraft({ ...draft, checkinWindowMinutes: num(e.target.value) })} />
          </Row>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Office WiFi" description="Optional: restrict check-in to office networks for chosen members." />
        <CardBody>
          <OfficeNetworksEditor
            value={draft.officeNetworks}
            yourIp={draft.yourIp}
            onChange={(v) => setDraft({ ...draft, officeNetworks: v })}
          />
          {members && members.length > 0 && draft.officeNetworks.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <span className="text-xs text-muted">
                {members.filter((m) => m.requireOfficeIp).length} of {members.length} members are office-only.
              </span>
              <span className="flex-1" />
              <Button variant="secondary" size="sm" loading={bulkBusy} onClick={() => setOfficeOnlyForAll(true)}>
                Turn on for all
              </Button>
              <Button variant="ghost" size="sm" loading={bulkBusy} onClick={() => setOfficeOnlyForAll(false)}>
                Turn off for all
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="App access" description="Stop fixed-shift staff using the app after their shift." />
        <CardBody>
          <Row title="Lock app after shift end" hint="Signed out after shift end + buffer until their next check-in window. Owner, admins, HR managers and flexible staff are never locked. Days off are never locked.">
            <Switch checked={draft.lockAfterShift} onChange={(v) => setDraft({ ...draft, lockAfterShift: v })} label="Lock app after shift end" />
          </Row>
          {draft.lockAfterShift && (
            <Row title="Buffer after shift end (min)" hint="Time to wrap up and check out before the lock.">
              <input aria-label="Lock buffer minutes" type="number" min="0" max="240" className={`${inputCls} w-24`} value={draft.lockBufferMinutes} onChange={(e) => setDraft({ ...draft, lockBufferMinutes: num(e.target.value) })} />
            </Row>
          )}
          <p className="pt-2 text-xs text-muted">Each member can override this in their settings.</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Auto-checkout" description="Closes days nobody checked out of." />
        <CardBody>
          <Row title="Close open days automatically">
            <Switch checked={draft.autoCheckout.mode !== 'off'} onChange={(v) => setA({ mode: v ? 'shift_end' : 'off' })} label="Auto-checkout" />
          </Row>
          {draft.autoCheckout.mode !== 'off' && (
            <>
              <Row title="Fixed-shift staff" hint="Credited at shift end, or the last activity in the app if later (extra hours count).">
                <select aria-label="Fixed-shift auto-checkout" className={`${inputCls} w-56`} value={draft.autoCheckout.mode} onChange={(e) => setA({ mode: e.target.value as 'shift_end' | 'max_hours' })}>
                  <option value="shift_end">At shift end + {draft.autoCheckout.afterEndMin} min</option>
                  <option value="max_hours">After {draft.autoCheckout.maxHours} hours open</option>
                </select>
              </Row>
              {draft.autoCheckout.mode === 'shift_end' && (
                <Row title="Wait after shift end (min)">
                  <input aria-label="Wait after shift end" type="number" min="0" max="600" className={`${inputCls} w-24`} value={draft.autoCheckout.afterEndMin} onChange={(e) => setA({ afterEndMin: num(e.target.value) })} />
                </Row>
              )}
              <Row title="Max hours open" hint="Hard limit. Flexible staff are closed after this, credited their required hours or last activity, whichever is later.">
                <input aria-label="Max hours" type="number" min="2" max="20" className={`${inputCls} w-24`} value={draft.autoCheckout.maxHours} onChange={(e) => setA({ maxHours: num(e.target.value) })} />
              </Row>
            </>
          )}
          <Row title="Payroll treatment of auto-closed days">
            <select aria-label="Auto-closed day penalty" className={`${inputCls} w-48`} value={p.autoCheckoutPenalty} onChange={(e) => setP({ autoCheckoutPenalty: e.target.value as AutoCheckoutPenalty })}>
              {Object.entries(AUTO_PENALTY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </Row>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Payroll policy" description="One late method and one overtime method for everyone." />
        <CardBody>
          <Row title="Day rate" hint="Used for absences, unpaid leave and half days.">
            <div className="flex items-center gap-2">
              <select aria-label="Day rate" className={`${inputCls} w-60`} value={p.dayRateBasis} onChange={(e) => setP({ dayRateBasis: e.target.value as DayRateBasis })}>
                {Object.entries(DAY_RATE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              {p.dayRateBasis === 'fixed' && (
                <input aria-label="Days" type="number" min="1" max="31" className={`${inputCls} w-20`} value={p.workingDaysPerMonth} onChange={(e) => setP({ workingDaysPerMonth: num(e.target.value) })} />
              )}
            </div>
          </Row>
          <Row title="Late arrivals">
            <div className="flex items-center gap-2">
              <select aria-label="Late method" className={`${inputCls} w-56`} value={p.lateMethod} onChange={(e) => setP({ lateMethod: e.target.value as LateMethod })}>
                {Object.entries(LATE_METHOD_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              {p.lateMethod === 'n_lates_absent' && (
                <input aria-label="Lates per day cut" type="number" min="1" className={`${inputCls} w-20`} value={p.latesPerAbsent} onChange={(e) => setP({ latesPerAbsent: num(e.target.value) })} />
              )}
              {p.lateMethod === 'fixed_per_late' && (
                <input aria-label="Amount per late" type="number" min="0" className={`${inputCls} w-24`} value={p.lateFixedAmount} onChange={(e) => setP({ lateFixedAmount: num(e.target.value) })} />
              )}
              {p.lateMethod === 'half_day' && (
                <input aria-label="Minutes late for half day" type="number" min="1" className={`${inputCls} w-20`} value={p.halfDayAfterMin} onChange={(e) => setP({ halfDayAfterMin: num(e.target.value) })} />
              )}
            </div>
          </Row>
          <Row title="Overtime">
            <div className="flex items-center gap-2">
              <select aria-label="Overtime method" className={`${inputCls} w-56`} value={p.overtimeMethod} onChange={(e) => setP({ overtimeMethod: e.target.value as OvertimeMethod })}>
                {Object.entries(OVERTIME_METHOD_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              {p.overtimeMethod === 'hourly_multiplier' && (
                <input aria-label="Multiplier" type="number" min="0" step="0.1" className={`${inputCls} w-20`} value={p.overtimeMultiplier} onChange={(e) => setP({ overtimeMultiplier: num(e.target.value) })} />
              )}
              {p.overtimeMethod === 'flat_per_hour' && (
                <input aria-label="Amount per hour" type="number" min="0" className={`${inputCls} w-24`} value={p.overtimeFlatRate} onChange={(e) => setP({ overtimeFlatRate: num(e.target.value) })} />
              )}
            </div>
          </Row>
          {p.overtimeMethod !== 'off' && (
            <>
              <Row title="Only after shift end" hint="Arriving early is not overtime.">
                <Switch checked={p.otOnlyAfterShiftEnd} onChange={(v) => setP({ otOnlyAfterShiftEnd: v })} label="Overtime only after shift end" />
              </Row>
              <Row title="Ignore less than (min/day)">
                <input aria-label="Minimum overtime" type="number" min="0" className={`${inputCls} w-24`} value={p.minOvertimeMinutes} onChange={(e) => setP({ minOvertimeMinutes: num(e.target.value) })} />
              </Row>
              <Row title="Monthly cap (hours)" hint="0 = no cap">
                <input aria-label="Overtime cap hours" type="number" min="0" className={`${inputCls} w-24`} value={p.otMonthlyCapMin / 60} onChange={(e) => setP({ otMonthlyCapMin: Math.round(num(e.target.value) * 60) })} />
              </Row>
            </>
          )}
          <Row title="Statutory deductions" hint="Tax, EOBI, provident fund… fixed or % of base.">
            <div className="space-y-2">
              {p.statutory.map((s, i) => (
                <div key={i} className="flex gap-2">
                  <input aria-label="Deduction name" className={`${inputCls} w-28`} value={s.label} placeholder="EOBI" onChange={(e) => setStat(i, { label: e.target.value })} />
                  <select aria-label="Deduction type" className={`${inputCls} w-20`} value={s.type} onChange={(e) => setStat(i, { type: e.target.value as 'fixed' | 'percent' })}>
                    <option value="fixed">{p.currency}</option>
                    <option value="percent">%</option>
                  </select>
                  <input aria-label="Deduction value" type="number" min="0" className={`${inputCls} w-20`} value={s.value} onChange={(e) => setStat(i, { value: num(e.target.value) })} />
                  <Button variant="ghost" size="sm" aria-label="Remove deduction" onClick={() => setP({ statutory: p.statutory.filter((_, j) => j !== i) })}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
              {p.statutory.length < 10 && (
                <Button variant="secondary" size="sm" onClick={() => setP({ statutory: [...p.statutory, { label: '', type: 'fixed', value: 0 }] })}>
                  <Plus size={14} /> Add
                </Button>
              )}
            </div>
          </Row>
          <Row title="Currency label">
            <input aria-label="Currency" className={`${inputCls} w-20`} maxLength={8} value={p.currency} onChange={(e) => setP({ currency: e.target.value })} />
          </Row>
        </CardBody>
      </Card>

      <div className="xl:col-span-2">
        <HolidaysCard />
      </div>

      <div className="xl:col-span-2">
        <Card>
          <CardHeader title="Members" description="Click a member to set their shift, timing (Fixed, Relaxed or Flexible), app lock, salary and allowances." />
          <CardBody>
            {!members ? (
              <SkeletonRows rows={4} />
            ) : (
              <DataTable<AttendanceMember>
                rows={members}
                rowKey={(m) => m.userId}
                onRowClick={setEdit}
                rowLabel={(m) => `Edit ${m.name}`}
                emptyNode={<EmptyState compact icon={Users} title="No tracked members" />}
                columns={[
                  { key: 'name', header: 'Member', sortValue: (m) => m.name, render: (m) => <span className="font-medium text-ink">{m.name}</span> },
                  {
                    key: 'shift',
                    header: 'Schedule',
                    render: (m) =>
                      m.exemptLate ? (
                        <Badge tone="violet">Flexible · {fmtHours(m.requiredMinutes ?? 480)}</Badge>
                      ) : (
                        <span className="tabular-nums">
                          {m.effectiveStart}–{m.effectiveEnd ?? '+8h'}
                          {m.workStart || m.workEnd ? <Badge className="ml-1.5">own</Badge> : null}
                          {m.neverLate ? <Badge tone="info" className="ml-1.5">Relaxed</Badge> : null}
                        </span>
                      ),
                  },
                  { key: 'off', header: 'Off', render: (m) => m.effectiveWeeklyOff.map((d) => WEEKDAYS[d]).join(', ') || '—' },
                  { key: 'salary', header: 'Salary', align: 'right', sortValue: (m) => m.salaryAmount ?? 0, render: (m) => (m.payHidden ? <span className="text-muted">hidden</span> : m.salaryAmount ? fmtMoney(m.salaryAmount, p.currency) : <span className="text-amber-700">not set</span>) },
                  { key: 'allow', header: 'Allowances', align: 'right', render: (m) => (m.allowances.length ? fmtMoney(m.allowances.reduce((s, a) => s + a.amount, 0), p.currency) : '—') },
                  { key: 'ip', header: 'Office only', render: (m) => (m.requireOfficeIp ? 'Yes' : '—') },
                  { key: 'lock', header: 'App lock', render: (m) => (m.effectiveLockAfterShift ? 'After shift' : '—') },
                ]}
              />
            )}
          </CardBody>
        </Card>
      </div>

      <MemberSheet
        member={edit}
        settings={saved}
        onClose={() => setEdit(null)}
        onSaved={() => {
          setEdit(null);
          getMembers().then(setMembers).catch(() => undefined);
        }}
      />
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={() => setDraft(saved)} />
    </div>
  );
}
