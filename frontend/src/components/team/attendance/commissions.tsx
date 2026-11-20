'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { History, Pencil, Plus, Trash2, Trophy } from 'lucide-react';
import { useToast } from '@/components/toast';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { SideSheet } from '@/components/ui/side-sheet';
import { ConfirmDialog } from '@/components/ui/modal';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonCards, SkeletonRows } from '@/components/ui/skeleton';
import { fmtMoney, getMembers, type AttendanceMember } from '@/lib/attendance';
import {
  CALC_LABELS,
  DEFAULT_CONFIG,
  EARN_ON_LABELS,
  METRIC_HINTS,
  METRIC_LABELS,
  backfillAttributions,
  createPlan,
  deletePlan,
  describePlan,
  getStatement,
  listPlans,
  previewPlan,
  updatePlan,
  type AppliesTo,
  type Calc,
  type CalcType,
  type CommissionPlan,
  type Metric,
  type PlanConfig,
  type PlanStatement,
  type Statement,
} from '@/lib/commissions';
import { ROLE_LABELS } from '@/lib/crm-types';
import { cn, zonedMonthString } from '@/lib/utils';
import { Avatar, Field, MonthInput, errMsg, inputCls } from './shared';

const ROLE_OPTIONS = ['admin', 'agent', 'fulfillment', 'finance', 'member'];

type Draft = { id: number | null; name: string; active: boolean; metric: Metric; config: PlanConfig; appliesTo: AppliesTo };

const TEMPLATES: { label: string; draft: Omit<Draft, 'id'> }[] = [
  {
    label: '% of delivered sales',
    draft: { name: 'Sales · delivered', active: true, metric: 'orders', config: { ...DEFAULT_CONFIG, basis: 'value', earnOn: 'delivered', calc: { type: 'percent', rate: 2 } }, appliesTo: { roles: ['agent'], userIds: [] } },
  },
  {
    label: 'Bonus at a confirmation target',
    draft: { name: 'Confirmation target', active: true, metric: 'orders', config: { ...DEFAULT_CONFIG, creditTo: 'confirmed', earnOn: 'confirmed', calc: { type: 'target_bonus', target: 400, bonus: 5000, repeat: false } }, appliesTo: { roles: ['agent'], userIds: [] } },
  },
  {
    label: 'Per parcel packed (slabs)',
    draft: { name: 'Packing', active: true, metric: 'parcels_packed', config: { ...DEFAULT_CONFIG, calc: { type: 'slab', mode: 'whole', tiers: [{ from: 0, rate: 8 }, { from: 1000, rate: 12 }, { from: 2000, rate: 15 }] } }, appliesTo: { roles: ['fulfillment', 'member'], userIds: [] } },
  },
  {
    label: 'Warehouse team pool',
    draft: { name: 'Dispatch pool', active: true, metric: 'parcels_dispatched', config: { ...DEFAULT_CONFIG, calc: { type: 'pool', rate: 3, splitBy: 'hours' } }, appliesTo: { roles: ['fulfillment'], userIds: [] } },
  },
];

function defaultCalc(type: CalcType, prev: Calc): Calc {
  if (prev.type === type) return prev;
  switch (type) {
    case 'percent':
      return { type, rate: 1 };
    case 'slab':
      return { type, mode: 'whole', tiers: [{ from: 0, rate: 5 }, { from: 500, rate: 8 }] };
    case 'target_bonus':
      return { type, target: 100, bonus: 1000, repeat: false };
    case 'pool':
      return { type, rate: 2, splitBy: 'units' };
    default:
      return { type: 'per_unit', rate: 10 };
  }
}

function PlanEditor({
  draft,
  members,
  onClose,
  onSaved,
}: {
  draft: Draft | null;
  members: AttendanceMember[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [d, setD] = useState<Draft | null>(draft);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<(PlanStatement & { month: string }) | null>(null);
  const [pvErr, setPvErr] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => setD(draft), [draft]);

  // Live preview on last month's real data (debounced).
  useEffect(() => {
    if (!d) return;
    const my = ++seq.current;
    const t = setTimeout(() => {
      previewPlan({ name: d.name, metric: d.metric, config: d.config, appliesTo: d.appliesTo })
        .then((p) => my === seq.current && (setPreview(p), setPvErr(null)))
        .catch((e) => my === seq.current && setPvErr(errMsg(e, 'Preview failed')));
    }, 500);
    return () => clearTimeout(t);
  }, [d]);

  if (!d) return <SideSheet open={false} onClose={onClose} title="">{null}</SideSheet>;
  const set = (p: Partial<Draft>) => setD({ ...d, ...p });
  const setCfg = (p: Partial<PlanConfig>) => setD({ ...d, config: { ...d.config, ...p } });
  const isOrders = d.metric === 'orders';
  const basis = isOrders ? d.config.basis : 'count';
  const calc = d.config.calc;
  const calcTypes: CalcType[] = basis === 'value' ? ['percent', 'slab', 'target_bonus', 'pool'] : ['per_unit', 'slab', 'target_bonus', 'pool'];
  const rateUnit = basis === 'value' ? '%' : 'per unit';
  const toggleRole = (r: string) =>
    set({ appliesTo: { ...d.appliesTo, roles: d.appliesTo.roles.includes(r) ? d.appliesTo.roles.filter((x) => x !== r) : [...d.appliesTo.roles, r] } });
  const toggleUser = (id: number) =>
    set({ appliesTo: { ...d.appliesTo, userIds: d.appliesTo.userIds.includes(id) ? d.appliesTo.userIds.filter((x) => x !== id) : [...d.appliesTo.userIds, id] } });

  const save = async () => {
    setBusy(true);
    try {
      const body = { name: d.name, metric: d.metric, active: d.active, config: d.config, appliesTo: d.appliesTo };
      if (d.id) await updatePlan(d.id, body);
      else await createPlan(body);
      toast.success('Plan saved');
      onSaved();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SideSheet
      open
      onClose={onClose}
      title={d.id ? 'Edit commission plan' : 'New commission plan'}
      subtitle={describePlan(d)}
      width="lg"
      footer={
        <div className="flex w-full items-center gap-3">
          <Switch checked={d.active} onChange={(v) => set({ active: v })} label="Plan active" />
          <span className="text-sm text-muted">{d.active ? 'Active' : 'Paused'}</span>
          <span className="flex-1" />
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!d.name.trim()} onClick={save}>Save plan</Button>
        </div>
      }
    >
      <div className="space-y-5">
        <Field label="Plan name" htmlFor="pl-name">
          <input id="pl-name" className={inputCls} value={d.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} />
        </Field>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">1 · What counts</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {(Object.keys(METRIC_LABELS) as Metric[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() =>
                  setD({
                    ...d,
                    metric: m,
                    config: { ...d.config, basis: m === 'orders' ? d.config.basis : 'count', calc: m !== 'orders' && d.config.calc.type === 'percent' ? { type: 'per_unit', rate: 10 } : d.config.calc },
                  })
                }
                className={cn('rounded-lg border p-3 text-left', d.metric === m ? 'border-brand-500 bg-brand-50' : 'border-line hover:bg-sunken')}
              >
                <p className="text-sm font-semibold text-ink">{METRIC_LABELS[m]}</p>
                <p className="text-xs text-muted">{METRIC_HINTS[m]}</p>
              </button>
            ))}
          </div>
          {isOrders && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Credit goes to" htmlFor="pl-credit">
                <select id="pl-credit" className={inputCls} value={d.config.creditTo} onChange={(e) => setCfg({ creditTo: e.target.value as PlanConfig['creditTo'] })}>
                  <option value="created">The agent who created the order</option>
                  <option value="confirmed">The agent who confirmed it</option>
                </select>
              </Field>
              <Field label="Counts" htmlFor="pl-earn">
                <select id="pl-earn" className={inputCls} value={d.config.earnOn} onChange={(e) => setCfg({ earnOn: e.target.value as PlanConfig['earnOn'] })}>
                  {Object.entries(EARN_ON_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </Field>
              <Field label="Measure" htmlFor="pl-basis">
                <select
                  id="pl-basis"
                  className={inputCls}
                  value={d.config.basis}
                  onChange={(e) => {
                    const b = e.target.value as PlanConfig['basis'];
                    const c = d.config.calc;
                    setCfg({ basis: b, calc: b === 'value' && c.type === 'per_unit' ? { type: 'percent', rate: 1 } : b === 'count' && c.type === 'percent' ? { type: 'per_unit', rate: 10 } : c });
                  }}
                >
                  <option value="count">Number of orders</option>
                  <option value="value">Net order value (after discount)</option>
                </select>
              </Field>
              <Field label="Orders from" htmlFor="pl-src">
                <select id="pl-src" className={inputCls} value={d.config.source} onChange={(e) => setCfg({ source: e.target.value as PlanConfig['source'] })}>
                  <option value="any">Any order</option>
                  <option value="inbox">Chat orders only</option>
                  <option value="abandoned_cart">Recovered abandoned carts only</option>
                </select>
              </Field>
              <label className="flex items-center gap-3 sm:col-span-2">
                <Switch checked={d.config.reverse} onChange={(v) => setCfg({ reverse: v })} label="Take back on cancel or return" />
                <span className="text-sm text-ink">Take it back when the order is cancelled or returned (a later month shows it as a minus)</span>
              </label>
            </div>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">2 · How it pays</h3>
          <div className="flex flex-wrap gap-1 rounded-lg bg-sunken p-1" role="radiogroup" aria-label="Payment type">
            {calcTypes.map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={calc.type === t}
                onClick={() => setCfg({ calc: defaultCalc(t, calc) })}
                className={cn('flex-1 rounded-md px-3 py-1.5 text-sm font-medium', calc.type === t ? 'bg-surface text-ink shadow-sm' : 'text-muted')}
              >
                {CALC_LABELS[t]}
              </button>
            ))}
          </div>
          {(calc.type === 'per_unit' || calc.type === 'percent') && (
            <Field label={calc.type === 'percent' ? 'Percent of value' : 'Amount per unit'} htmlFor="pl-rate">
              <input id="pl-rate" type="number" min="0" step="any" className={inputCls} value={calc.rate} onChange={(e) => setCfg({ calc: { ...calc, rate: Number(e.target.value) } })} />
            </Field>
          )}
          {calc.type === 'slab' && (
            <div className="space-y-2">
              <Field label="Slab mode" htmlFor="pl-mode">
                <select id="pl-mode" className={inputCls} value={calc.mode} onChange={(e) => setCfg({ calc: { ...calc, mode: e.target.value as 'whole' | 'marginal' } })}>
                  <option value="whole">Whole month at the slab reached</option>
                  <option value="marginal">Each slab pays only its own part (like tax bands)</option>
                </select>
              </Field>
              {calc.tiers.map((t, i) => (
                <div key={i} className="flex items-end gap-2">
                  <Field label={i === 0 ? `From (${basis === 'value' ? 'value' : 'units'})` : ' '} htmlFor={`tier-from-${i}`}>
                    <input
                      id={`tier-from-${i}`}
                      type="number"
                      min="0"
                      disabled={i === 0}
                      className={inputCls}
                      value={t.from}
                      onChange={(e) => setCfg({ calc: { ...calc, tiers: calc.tiers.map((x, j) => (j === i ? { ...x, from: Number(e.target.value) } : x)) } })}
                    />
                  </Field>
                  <Field label={i === 0 ? `Rate (${rateUnit})` : ' '} htmlFor={`tier-rate-${i}`}>
                    <input
                      id={`tier-rate-${i}`}
                      type="number"
                      min="0"
                      step="any"
                      className={inputCls}
                      value={t.rate}
                      onChange={(e) => setCfg({ calc: { ...calc, tiers: calc.tiers.map((x, j) => (j === i ? { ...x, rate: Number(e.target.value) } : x)) } })}
                    />
                  </Field>
                  {i > 0 && (
                    <Button variant="ghost" size="sm" aria-label="Remove slab" onClick={() => setCfg({ calc: { ...calc, tiers: calc.tiers.filter((_, j) => j !== i) } })}>
                      <Trash2 size={14} />
                    </Button>
                  )}
                </div>
              ))}
              {calc.tiers.length < 12 && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const last = calc.tiers[calc.tiers.length - 1];
                    setCfg({ calc: { ...calc, tiers: [...calc.tiers, { from: Math.max(1, last.from * 2 || 100), rate: last.rate }] } });
                  }}
                >
                  <Plus size={14} /> Add slab
                </Button>
              )}
            </div>
          )}
          {calc.type === 'target_bonus' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={`Target (${basis === 'value' ? 'net value' : 'units'})`} htmlFor="pl-target">
                <input id="pl-target" type="number" min="1" className={inputCls} value={calc.target} onChange={(e) => setCfg({ calc: { ...calc, target: Number(e.target.value) } })} />
              </Field>
              <Field label="Bonus amount" htmlFor="pl-bonus">
                <input id="pl-bonus" type="number" min="0" className={inputCls} value={calc.bonus} onChange={(e) => setCfg({ calc: { ...calc, bonus: Number(e.target.value) } })} />
              </Field>
              <label className="flex items-center gap-3 sm:col-span-2">
                <Switch checked={calc.repeat} onChange={(v) => setCfg({ calc: { ...calc, repeat: v } })} label="Repeat for every target reached" />
                <span className="text-sm text-ink">Pay again every time the target is reached (2× target = 2 bonuses)</span>
              </label>
            </div>
          )}
          {calc.type === 'pool' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={`Pool ${basis === 'value' ? '% of team value' : 'amount per team unit'}`} htmlFor="pl-pool">
                <input id="pl-pool" type="number" min="0" step="any" className={inputCls} value={calc.rate} onChange={(e) => setCfg({ calc: { ...calc, rate: Number(e.target.value) } })} />
              </Field>
              <Field label="Split the pool by" htmlFor="pl-split">
                <select id="pl-split" className={inputCls} value={calc.splitBy} onChange={(e) => setCfg({ calc: { ...calc, splitBy: e.target.value as 'units' | 'hours' | 'equal' } })}>
                  <option value="units">Each person&apos;s own units</option>
                  <option value="hours">Hours worked (attendance)</option>
                  <option value="equal">Equally</option>
                </select>
              </Field>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Minimum before anything is paid" htmlFor="pl-min" hint="0 = pays from the first unit">
              <input id="pl-min" type="number" min="0" className={inputCls} value={d.config.min} onChange={(e) => setCfg({ min: Number(e.target.value) })} />
            </Field>
            <Field label="Monthly cap per person" htmlFor="pl-cap" hint="0 = no cap">
              <input id="pl-cap" type="number" min="0" className={inputCls} value={d.config.cap} onChange={(e) => setCfg({ cap: Number(e.target.value) })} />
            </Field>
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">3 · Who it applies to</h3>
          <p className="text-xs text-muted">Pick roles and/or people. Nothing picked = every tracked member.</p>
          <div className="flex flex-wrap gap-2">
            {ROLE_OPTIONS.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={d.appliesTo.roles.includes(r)}
                onClick={() => toggleRole(r)}
                className={cn('rounded-full border px-3 py-1 text-xs font-semibold', d.appliesTo.roles.includes(r) ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line text-muted')}
              >
                {(ROLE_LABELS[r] ?? r).replace(/ \(.*\)$/, '')}
              </button>
            ))}
          </div>
          {members.length > 0 && (
            <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto">
              {members.map((m) => (
                <button
                  key={m.userId}
                  type="button"
                  aria-pressed={d.appliesTo.userIds.includes(m.userId)}
                  onClick={() => toggleUser(m.userId)}
                  className={cn('rounded-full border px-3 py-1 text-xs', d.appliesTo.userIds.includes(m.userId) ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line text-muted')}
                >
                  {m.name}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">Preview{preview ? ` on ${preview.month}` : ''}</h3>
          {pvErr ? (
            <p className="text-sm text-red-700">{pvErr}</p>
          ) : !preview ? (
            <SkeletonRows rows={3} />
          ) : preview.rows.length === 0 ? (
            <p className="text-sm text-muted">Nobody matches “who it applies to”.</p>
          ) : (
            <div className="rounded-lg bg-sunken p-3 font-mono text-xs leading-6">
              {preview.rows.slice(0, 12).map((r) => (
                <div key={r.userId} className="flex gap-3">
                  <span className="w-32 truncate">{r.name}</span>
                  <span className="flex-1 truncate text-muted">{r.detail}</span>
                  <b className="tabular-nums">{fmtMoney(r.amount)}</b>
                </div>
              ))}
              <div className="mt-1 flex border-t border-line pt-1">
                <span className="flex-1">Total</span>
                <b className="tabular-nums">{fmtMoney(preview.total)}</b>
              </div>
            </div>
          )}
        </section>
      </div>
    </SideSheet>
  );
}

export default function CommissionsTab() {
  const toast = useToast();
  const [plans, setPlans] = useState<CommissionPlan[] | null>(null);
  const [members, setMembers] = useState<AttendanceMember[]>([]);
  const [month, setMonth] = useState(() => zonedMonthString());
  const [stmt, setStmt] = useState<Statement | null>(null);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [del, setDel] = useState<CommissionPlan | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    listPlans()
      .then(setPlans)
      .catch((e) => {
        setPlans([]);
        toast.error(errMsg(e));
      });
  }, [toast]);
  useEffect(() => {
    load();
    getMembers().then(setMembers).catch(() => undefined);
  }, [load]);
  useEffect(() => {
    setStmt(null);
    getStatement(month).then(setStmt).catch(() => setStmt({ month, plans: [], leaderboard: [], total: 0 }));
  }, [month, plans]);

  const stmtByPlan = useMemo(() => new Map((stmt?.plans ?? []).map((p) => [p.planId, p])), [stmt]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h2 className="text-lg font-bold text-ink">Commission plans</h2>
          <p className="text-xs text-muted">Calculated automatically from orders and parcels, and added to payroll.</p>
        </div>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          loading={busy}
          title="Credit past orders, bookings, dispatch and returns from history"
          onClick={async () => {
            setBusy(true);
            try {
              await backfillAttributions();
              toast.success('History imported');
              setPlans((p) => (p ? [...p] : p));
            } catch (e) {
              toast.error(errMsg(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <History size={14} /> Import history
        </Button>
        <Button
          size="sm"
          onClick={() => setEdit({ id: null, name: 'New plan', active: true, metric: 'orders', config: { ...DEFAULT_CONFIG }, appliesTo: { roles: [], userIds: [] } })}
        >
          <Plus size={14} /> New plan
        </Button>
      </div>

      {!plans ? (
        <SkeletonCards count={3} />
      ) : plans.length === 0 ? (
        <Card>
          <CardBody className="pt-5">
            <EmptyState
              icon={Trophy}
              title="No commission plans yet"
              description="Start from a template. Every number can be changed."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  {TEMPLATES.map((t) => (
                    <Button key={t.label} variant="secondary" size="sm" onClick={() => setEdit({ id: null, ...t.draft })}>
                      {t.label}
                    </Button>
                  ))}
                </div>
              }
            />
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {plans.map((p) => {
            const s = stmtByPlan.get(p.id);
            return (
              <Card key={p.id} className="p-4 space-y-2">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-ink">{p.name}</p>
                    <p className="text-xs text-muted">{describePlan(p)}</p>
                  </div>
                  <Badge tone={p.active ? 'success' : 'neutral'}>{p.active ? 'Active' : 'Paused'}</Badge>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone="info">{METRIC_LABELS[p.metric]}</Badge>
                  {(p.appliesTo.roles.length ? p.appliesTo.roles : p.appliesTo.userIds.length ? [] : ['everyone']).map((r) => (
                    <Badge key={r}>{(ROLE_LABELS[r] ?? r).replace(/ \(.*\)$/, '')}</Badge>
                  ))}
                  {p.appliesTo.userIds.length > 0 && <Badge>{p.appliesTo.userIds.length} people</Badge>}
                  {p.metric === 'orders' && p.config.reverse && <Badge tone="warn">Returns reverse</Badge>}
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <span className="text-sm text-muted">
                    {month}: <b className="tabular-nums text-ink">{s ? fmtMoney(s.total) : p.active ? '…' : '—'}</b>
                  </span>
                  <span className="flex-1" />
                  <Button size="sm" variant="ghost" onClick={() => setEdit({ id: p.id, name: p.name, active: p.active, metric: p.metric, config: p.config, appliesTo: p.appliesTo })}>
                    <Pencil size={14} /> Edit
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Delete ${p.name}`} onClick={() => setDel(p)}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader title="Earnings by person" description="All active plans, this month so far." action={<MonthInput id="com-month" value={month} onChange={setMonth} />} />
        <CardBody>
          {!stmt ? (
            <SkeletonRows rows={4} />
          ) : stmt.leaderboard.length === 0 ? (
            <p className="text-sm text-muted">Nothing earned yet.</p>
          ) : (
            <ol className="divide-y divide-line">
              {stmt.leaderboard.map((r, i) => (
                <li key={r.userId} className="flex items-center gap-3 py-2">
                  <span className="w-5 text-right text-xs font-bold text-muted tabular-nums">{i + 1}</span>
                  <Avatar name={r.name} />
                  <span className="flex-1 text-sm font-medium text-ink">{r.name}</span>
                  <span className="text-xs text-muted">
                    {stmt.plans
                      .map((p) => {
                        const row = p.rows.find((x) => x.userId === r.userId);
                        return row && row.amount ? `${p.planName} ${fmtMoney(row.amount)}` : null;
                      })
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <b className="tabular-nums">{fmtMoney(r.total)}</b>
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>

      <PlanEditor
        draft={edit}
        members={members}
        onClose={() => setEdit(null)}
        onSaved={() => {
          setEdit(null);
          load();
        }}
      />
      <ConfirmDialog
        open={!!del}
        title={`Delete “${del?.name}”?`}
        message="Approved payslips keep what they already paid. Future payroll won't include this plan."
        confirmLabel="Delete plan"
        danger
        onConfirm={async () => {
          if (!del) return;
          try {
            await deletePlan(del.id);
            setDel(null);
            load();
          } catch (e) {
            toast.error(errMsg(e));
          }
        }}
        onCancel={() => setDel(null)}
      />
    </div>
  );
}
