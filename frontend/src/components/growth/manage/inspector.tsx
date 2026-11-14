'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Copy, History, Info, Loader2, Settings2, Sparkles, Undo2, X } from 'lucide-react';
import { cn, fmtDateTime } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import { money, ratio } from '@/lib/format-number';
import type { CampaignNode } from '@/lib/growth';
import { useToast } from '@/components/toast';
import { useGrowth } from '@/components/growth/growth-filters';
import {
  ACTION_LABEL,
  BID_HINT,
  BID_LABEL,
  describePatch,
  EVENT_LABEL,
  GOAL_LABEL,
  growthManageApi,
  WINDOW_LABEL,
  type AttributionWindow,
  type BidStrategy,
  type ChangeLogRow,
  type EntityPatch,
  type EntitySettings,
  type OptimizationGoal,
} from '@/lib/growth-manage';
import { useStaged } from './staged';

const STRATEGIES: BidStrategy[] = ['LOWEST_COST_WITHOUT_CAP', 'COST_CAP', 'LOWEST_COST_WITH_MIN_ROAS', 'LOWEST_COST_WITH_BID_CAP'];
const GOALS: OptimizationGoal[] = ['OFFSITE_CONVERSIONS', 'VALUE', 'CONVERSATIONS', 'LANDING_PAGE_VIEWS', 'LINK_CLICKS'];
const WINDOWS: AttributionWindow[] = ['7d_click_1d_view', '7d_click', '1d_click'];

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-muted">{label}</div>
      {children}
      {hint && <div className="mt-1.5 text-xs leading-relaxed text-muted">{hint}</div>}
    </div>
  );
}

const inputCls = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-200 dark:focus:ring-violet-900';

/** Inspector drawer for one campaign / ad set / ad: settings, CodesApp insight, history. */
export function Inspector({ node, breakEven, canEdit, onClose }: { node: CampaignNode; breakEven: number | null; canEdit: boolean; onClose: () => void }) {
  const { mode } = useGrowth();
  const toast = useToast();
  const { stage, pendingFor, currency } = useStaged();
  const [tab, setTab] = useState<'settings' | 'history'>('settings');
  const [s, setS] = useState<EntitySettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<EntityPatch>({});
  const [log, setLog] = useState<ChangeLogRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    growthManageApi
      .settings(node.level, node.id)
      .then((r) => {
        if (!alive) return;
        setS(r);
        setForm({ ...r.snapshot, ...(pendingFor(node.level, node.id) ?? {}) });
      })
      .catch((e) => alive && setErr(e instanceof ApiError ? e.userMessage : 'Could not load the settings.'));
    return () => {
      alive = false;
    };
    // pendingFor is read once when the drawer opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.level, node.id]);

  useEffect(() => {
    if (tab !== 'history') return;
    growthManageApi.log(node.id, 50).then(setLog).catch(() => setLog([]));
  }, [tab, node.id]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const fmt = (v: number | null | undefined) => money(v ?? null, currency, mode);
  const owns = s?.budgetOwner === node.level && node.level !== 'ad';
  const isSet = node.level === 'adset';
  const wa = s?.destinationType === 'WHATSAPP';
  // Meta reports PLACED-order value; translate the delivered break-even into Meta's terms.
  const placedFactor = node.platformRoas && node.expRoas ? node.platformRoas / node.expRoas : null;
  const metaBreakEven = breakEven && placedFactor ? breakEven * placedFactor : null;

  const diff = useMemo(() => {
    if (!s) return {} as EntityPatch;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(form)) {
      const was = (s.snapshot as Record<string, unknown>)[k];
      if (v !== undefined && v !== '' && v !== was && !(v == null && was == null)) out[k] = v;
    }
    return out as EntityPatch;
  }, [form, s]);
  const dirty = Object.keys(diff).length > 0;

  const issues: string[] = [];
  if (form.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS') {
    const goals = isSet ? [form.optimizationGoal] : s?.childGoals.map((c) => c.optimizationGoal) ?? [];
    if (goals.some((g) => g !== 'VALUE')) issues.push(isSet ? 'A ROAS goal needs “Maximise value of conversions”.' : 'Every ad set must optimise for value of conversions to use a ROAS goal.');
    if (!(Number(form.roasFloor) > 0)) issues.push('Enter the ROAS goal.');
  }
  if ((form.bidStrategy === 'COST_CAP' || form.bidStrategy === 'LOWEST_COST_WITH_BID_CAP') && !(Number(form.bidAmount) > 0)) issues.push('Enter the amount.');

  const save = () => {
    if (!dirty || issues.length) return;
    const patch = { ...diff };
    // Switching away from a capped strategy clears the old amount on Meta's side.
    stage({ kind: 'patch', level: node.level, entityId: node.id, patch }, `${node.name}`);
    toast.info('Staged. Review and publish when ready.');
    onClose();
  };

  const duplicate = async () => {
    setBusy(true);
    try {
      const r = await growthManageApi.duplicate(node.level, node.id);
      toast.success(`Duplicated (paused) · new id ${r.newId}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Duplicate failed.');
    } finally {
      setBusy(false);
    }
  };

  const undoOne = async (id: number) => {
    try {
      const r = await growthManageApi.undo({ logId: id });
      toast[r.ok ? 'success' : 'error'](r.ok ? 'Reverted' : r.results[0]?.error ?? 'Undo failed');
      setLog(await growthManageApi.log(node.id, 50));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Undo failed.');
    }
  };

  const strategyCard = (b: BidStrategy) => {
    const active = form.bidStrategy === b;
    return (
      <button key={b} type="button" disabled={!canEdit} onClick={() => setForm((f) => ({ ...f, bidStrategy: b }))} aria-pressed={active}
        className={cn('rounded-xl border p-3 text-left transition', active ? 'border-violet-400 bg-violet-50/70 ring-1 ring-violet-300 dark:border-violet-600 dark:bg-violet-950/30 dark:ring-violet-700' : 'border-line hover:bg-sunken')}>
        <div className="text-sm font-bold text-ink">{BID_LABEL[b]}</div>
        <div className="mt-0.5 text-xs leading-snug text-muted">{BID_HINT[b]}</div>
      </button>
    );
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end whitespace-normal text-left normal-case" aria-modal="true" role="dialog" aria-label={`${node.name} settings`}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" />
      <aside className="relative flex h-full w-full max-w-[520px] flex-col border-l border-line bg-surface shadow-2xl">
        <header className="border-b border-line px-5 pb-3 pt-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-bold uppercase tracking-wide text-muted">{node.level === 'adset' ? 'Ad set' : node.level}</div>
              <h2 className="mt-0.5 truncate text-lg font-extrabold text-ink" title={node.name}>{node.name}</h2>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-muted hover:bg-sunken hover:text-ink"><X size={18} /></button>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-2 text-center">
            {[
              ['Spend', fmt(node.spend)],
              ['Meta ROAS', ratio(node.platformRoas)],
              ['Expected', ratio(node.expRoas)],
              ['Orders', String(Math.round(node.orders))],
            ].map(([l, v]) => (
              <div key={l} className="rounded-lg bg-sunken/70 px-2 py-1.5">
                <div className="text-[10px] font-bold uppercase tracking-wide text-muted">{l}</div>
                <div className="text-sm font-extrabold tabular-nums text-ink">{v}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-1">
            {([['settings', 'Settings', Settings2], ['history', 'History', History]] as const).map(([id, l, I]) => (
              <button key={id} type="button" onClick={() => setTab(id)} aria-pressed={tab === id}
                className={cn('inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold', tab === id ? 'bg-ink text-surface' : 'text-muted hover:bg-sunken hover:text-ink')}>
                <I size={13} /> {l}
              </button>
            ))}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{err}</div>}
          {tab === 'settings' && !s && !err && <div className="flex items-center gap-2 py-10 text-sm text-muted"><Loader2 size={16} className="animate-spin" /> Loading settings…</div>}

          {tab === 'settings' && s && (
            <div className="space-y-5">
              <Field label="Name">
                <input className={inputCls} value={form.name ?? ''} disabled={!canEdit} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} maxLength={400} />
              </Field>

              {node.level !== 'ad' && (
                <Field label="Budget"
                  hint={owns ? 'Edit the amount in the table, or below.' : node.level === 'adset' ? 'This campaign uses Advantage+ campaign budget — the budget is on the campaign.' : 'Budgets are set on each ad set.'}>
                  {owns ? (
                    <div className="flex items-center gap-2">
                      <input className={inputCls} inputMode="decimal" disabled={!canEdit}
                        value={String((s.budgetType === 'lifetime' ? form.lifetimeBudget : form.dailyBudget) ?? '')}
                        onChange={(e) => {
                          const v = Number(e.target.value.replace(/[^\d.]/g, '')) || undefined;
                          setForm((f) => (s.budgetType === 'lifetime' ? { ...f, lifetimeBudget: v } : { ...f, dailyBudget: v }));
                        }} />
                      <span className="whitespace-nowrap text-xs font-semibold text-muted">{currency} {s.budgetType === 'lifetime' ? 'total' : '/ day'}</span>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-line px-3 py-2 text-sm text-muted">{node.level === 'adset' ? 'Campaign budget' : 'Ad set budgets'}</div>
                  )}
                </Field>
              )}

              {owns && (
                <Field label="Bid strategy">
                  <div className="grid grid-cols-2 gap-2">{STRATEGIES.map(strategyCard)}</div>
                  {(form.bidStrategy === 'COST_CAP' || form.bidStrategy === 'LOWEST_COST_WITH_BID_CAP') && (
                    <div className="mt-3">
                      <div className="flex items-center gap-2">
                        <input className={inputCls} inputMode="decimal" placeholder="Amount" disabled={!canEdit} value={String(form.bidAmount ?? '')}
                          onChange={(e) => setForm((f) => ({ ...f, bidAmount: Number(e.target.value.replace(/[^\d.]/g, '')) || null }))} />
                        <span className="whitespace-nowrap text-xs font-semibold text-muted">{currency} per result</span>
                      </div>
                      {s.stats.platformCpa != null && (
                        <p className="mt-1.5 text-xs text-muted">
                          Recent cost per purchase in Meta: <b className="text-ink">{fmt(s.stats.platformCpa)}</b>.
                          {form.bidAmount != null && form.bidAmount < s.stats.platformCpa * 0.8 && (
                            <span className="ml-1 font-semibold text-amber-700 dark:text-amber-300">A goal this low will limit delivery; ~{fmt(s.stats.platformCpa * 0.95)} is realistic.</span>
                          )}
                        </p>
                      )}
                      {node.level === 'campaign' && <p className="mt-1 text-xs text-muted">With a campaign budget, Meta stores this amount on each ad set. CodesApp sets it on all {s.childGoals.length}.</p>}
                    </div>
                  )}
                  {form.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS' && (
                    <div className="mt-3">
                      <div className="flex items-center gap-2">
                        <input className={inputCls} inputMode="decimal" placeholder="e.g. 3.2" disabled={!canEdit} value={String(form.roasFloor ?? '')}
                          onChange={(e) => setForm((f) => ({ ...f, roasFloor: Number(e.target.value.replace(/[^\d.]/g, '')) || null }))} />
                        <span className="text-xs font-semibold text-muted">× ROAS</span>
                      </div>
                      {metaBreakEven != null && (
                        <div className="mt-2 rounded-lg border border-violet-200 bg-violet-50/60 px-3 py-2 text-xs text-violet-900 dark:border-violet-800 dark:bg-violet-950/30 dark:text-violet-100">
                          <div className="flex items-center gap-1.5 font-bold"><Sparkles size={13} /> CodesApp insight</div>
                          <p className="mt-1 leading-relaxed">
                            Your break-even on <b>delivered</b> orders is {ratio(breakEven)}. Meta counts <b>placed</b> orders, about {placedFactor!.toFixed(2)}× more,
                            so break-even in Meta’s terms is <b>{ratio(metaBreakEven)}</b>.
                          </p>
                          <button type="button" className="mt-1.5 font-bold underline" onClick={() => setForm((f) => ({ ...f, roasFloor: Math.round(metaBreakEven * 1.1 * 100) / 100 }))}>
                            Use {ratio(metaBreakEven * 1.1)} (break-even + 10%)
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </Field>
              )}

              {isSet && (
                <>
                  <Field label="Performance goal" hint={form.optimizationGoal === 'VALUE' ? 'Meta looks for the buyers who spend the most — needs purchase values on your pixel.' : undefined}>
                    <select className={inputCls} disabled={!canEdit} value={form.optimizationGoal ?? ''} onChange={(e) => setForm((f) => ({ ...f, optimizationGoal: e.target.value as OptimizationGoal }))}>
                      {!form.optimizationGoal && <option value="">—</option>}
                      {GOALS.filter((g) => (wa ? g === 'CONVERSATIONS' || g === form.optimizationGoal : g !== 'CONVERSATIONS' || g === form.optimizationGoal)).map((g) => (
                        <option key={g} value={g}>{GOAL_LABEL[g]}</option>
                      ))}
                    </select>
                  </Field>
                  {!wa && (form.optimizationGoal === 'OFFSITE_CONVERSIONS' || form.optimizationGoal === 'VALUE') && (
                    <Field label="Conversion event">
                      <select className={inputCls} disabled={!canEdit} value={form.conversionEvent ?? 'PURCHASE'} onChange={(e) => setForm((f) => ({ ...f, conversionEvent: e.target.value }))}>
                        {Object.entries(EVENT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </Field>
                  )}
                  <Field label="Attribution setting" hint="How long after a click or view Meta credits a conversion. Changing it can restart learning.">
                    <div className="grid grid-cols-3 gap-1.5">
                      {WINDOWS.map((w) => (
                        <button key={w} type="button" disabled={!canEdit} onClick={() => setForm((f) => ({ ...f, attributionWindow: w }))} aria-pressed={form.attributionWindow === w}
                          className={cn('rounded-lg border px-2 py-2 text-xs font-semibold', form.attributionWindow === w ? 'border-violet-400 bg-violet-50 text-violet-800 dark:border-violet-600 dark:bg-violet-950/40 dark:text-violet-200' : 'border-line text-ink hover:bg-sunken')}>
                          {WINDOW_LABEL[w]}
                        </button>
                      ))}
                    </div>
                  </Field>
                </>
              )}

              {node.level !== 'ad' && (
                <Field label="End date" hint={s.budgetType === 'lifetime' ? 'A lifetime budget needs an end date.' : 'Optional.'}>
                  <input type="date" className={inputCls} disabled={!canEdit} value={form.endTime ? form.endTime.slice(0, 10) : ''}
                    onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value ? `${e.target.value}T23:59:00Z` : null }))} />
                </Field>
              )}

              {issues.length > 0 && (
                <div className="space-y-1 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
                  {issues.map((i) => <div key={i} className="flex items-start gap-1.5"><AlertTriangle size={13} className="mt-px shrink-0" /> {i}</div>)}
                </div>
              )}
              {dirty && (
                <div className="rounded-lg border border-violet-200 bg-violet-50/60 px-3 py-2 text-xs text-violet-900 dark:border-violet-800 dark:bg-violet-950/30 dark:text-violet-100">
                  <b>Will stage:</b> {describePatch(diff, (v) => fmt(v)).join(' · ')}
                </div>
              )}
              {!canEdit && (
                <p className="flex items-start gap-1.5 text-xs text-muted"><Info size={13} className="mt-px shrink-0" /> Read-only: the ad account token needs the ads_management permission. See Connections.</p>
              )}
            </div>
          )}

          {tab === 'history' && (
            log == null ? <div className="flex items-center gap-2 py-10 text-sm text-muted"><Loader2 size={16} className="animate-spin" /> Loading…</div> :
            !log.length ? <p className="py-10 text-center text-sm text-muted">No changes made from CodesApp yet.</p> : (
              <ol className="relative space-y-4 border-l border-line pl-4">
                {log.map((r) => (
                  <li key={r.id} className="relative">
                    <span className={cn('absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ring-4 ring-surface', r.result === 'ok' ? 'bg-emerald-500' : r.result === 'failed' ? 'bg-red-500' : 'bg-gray-400')} />
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 text-sm">
                        <span className="font-bold text-ink">{ACTION_LABEL[r.action] ?? r.action}</span>
                        <span className="text-muted"> · {r.userName ?? 'Someone'} · {fmtDateTime(r.createdAt)}</span>
                        <div className="mt-0.5 text-xs text-muted">{describePatch((r.after ?? {}) as EntityPatch, (v) => fmt(v)).join(' · ')}</div>
                        {r.error && <div className="mt-0.5 text-xs text-red-600">{r.error}</div>}
                        {r.undoneAt && <div className="mt-0.5 text-xs font-semibold text-muted">Undone</div>}
                      </div>
                      {r.canUndo && canEdit && (
                        <button type="button" onClick={() => undoOne(r.id)} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-xs font-semibold text-ink hover:bg-sunken">
                          <Undo2 size={12} /> Undo
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )
          )}
        </div>

        {tab === 'settings' && (
          <footer className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
            <button type="button" onClick={duplicate} disabled={!canEdit || busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm font-semibold text-ink hover:bg-sunken disabled:opacity-50">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />} Duplicate (paused)
            </button>
            <button type="button" onClick={save} disabled={!canEdit || !dirty || issues.length > 0}
              className="rounded-lg bg-ink px-4 py-2 text-sm font-bold text-surface disabled:opacity-40">Stage changes</button>
          </footer>
        )}
      </aside>
    </div>,
    document.body,
  );
}
