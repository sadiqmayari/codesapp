'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Loader2, Pencil, RefreshCw, Sparkles, Target } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import { fullMoney, money } from '@/lib/format-number';
import { growthApi, type TargetCoach } from '@/lib/growth';
import { useToast } from '@/components/toast';
import { useGrowth } from '@/components/growth/growth-filters';
import { useBaseCurrency } from '@/components/growth/insights';

const STATUS: Record<'on_track' | 'at_risk' | 'off_track', { label: string; cls: string }> = {
  on_track: { label: 'On track', cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300' },
  at_risk: { label: 'At risk', cls: 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300' },
  off_track: { label: 'Off track', cls: 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300' },
};

/**
 * Monthly NET sales target: set it, see where the month lands (expected net —
 * in-flight orders priced for cancellations and returns) and what to do.
 * `compact` = Overview card (no coach details).
 */
export function TargetCoachCard({ month, compact = false }: { month: string; compact?: boolean }) {
  const { filters, mode, version } = useGrowth();
  const toast = useToast();
  const [data, setData] = useState<TargetCoach | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [nonce, setNonce] = useState(0);
  const storeId = filters.storeId ?? null;

  useEffect(() => {
    let live = true;
    setLoading(true);
    // Compact (Overview) = pacing only, no AI call.
    (compact
      ? growthApi.target(month, storeId).then((r): TargetCoach => ({ ...r, levers: [], plan: null }))
      : growthApi.coach(month, storeId)
    )
      .then((r) => {
        if (!live) return;
        setData(r);
        setVal(r.target.netSalesTarget ? String(Math.round(r.target.netSalesTarget)) : '');
        if (!r.target.netSalesTarget) setEditing(true);
      })
      .catch(() => live && setData(null))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [month, storeId, version, nonce, compact]);

  const baseCur = useBaseCurrency();
  const cur = data?.currency ?? baseCur ?? null;
  const fmt = (v: number | null | undefined) => money(v ?? null, cur, mode);

  const save = async () => {
    const n = Number(val.replace(/[^\d.]/g, ''));
    setSaving(true);
    try {
      await growthApi.setTarget({ month, storeId, netSalesTarget: n > 0 ? n : null });
      setEditing(false);
      setNonce((x) => x + 1);
      toast.success(n > 0 ? 'Target saved' : 'Target cleared');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save the target.');
    } finally {
      setSaving(false);
    }
  };

  const p = data?.pacing ?? null;
  const max = p ? Math.max(p.target, p.projected.p90) * 1.05 : 1;
  const st = p ? STATUS[p.status] : null;

  return (
    <section className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300"><Target size={16} /></span>
          <div>
            <h3 className="text-sm font-bold text-ink">Net sales target · {month}</h3>
            <p className="text-xs text-muted">Paced on expected net: orders still on the way are priced for cancellations and returns.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {st && <span className={cn('rounded-full px-2 py-0.5 text-xs font-bold', st.cls)}>{st.label}</span>}
          {!editing && data?.target.netSalesTarget != null && (
            <button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs font-semibold text-ink hover:bg-sunken">
              <Pencil size={12} /> {fmt(data.target.netSalesTarget)}
            </button>
          )}
        </div>
      </header>

      {editing && (
        <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label htmlFor="net-target" className="text-xs font-semibold text-muted">Target for {month}</label>
          <input id="net-target" inputMode="numeric" value={val} onChange={(e) => setVal(e.target.value.replace(/[^\d.]/g, ''))} placeholder="e.g. 30000000"
            className="w-44 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-bold tabular-nums text-ink outline-none focus:border-brand-400" />
          <button type="submit" disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-xs font-bold text-surface disabled:opacity-50">
            {saving && <Loader2 size={12} className="animate-spin" />} Save
          </button>
          {data?.target.netSalesTarget != null && (
            <button type="button" onClick={() => setEditing(false)} className="text-xs font-semibold text-muted hover:text-ink">Cancel</button>
          )}
          {data?.actual && <span className="text-xs text-muted">Net so far {fmt(data.actual.net)} · expected {fmt(data.actual.expected)}</span>}
        </form>
      )}

      {loading && !data && <div className="mt-4 flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin" /> Working out the month…</div>}

      {p && (
        <div className={cn('mt-4 grid gap-4', !compact && 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]')}>
          <div>
            <div className="text-[26px] font-extrabold tracking-tight text-ink tabular-nums" title={fullMoney(p.projected.p50, cur)}>
              Projected {fmt(p.projected.p50)}
            </div>
            <div className="text-xs text-muted">
              {p.gap > 0 ? `${fmt(p.gap)} short of ${fmt(p.target)} at the current pace` : `${fmt(p.projected.p50 - p.target)} above ${fmt(p.target)}`}
              {' · '}likely {fmt(p.projected.p10)} – {fmt(p.projected.p90)}
            </div>
            <div className="relative mt-4 h-3.5 rounded-full bg-sunken" aria-hidden>
              <div className="absolute inset-y-0 left-0 rounded-full bg-brand-500" style={{ width: `${(p.soFar / max) * 100}%` }} />
              <div className="absolute inset-y-0 rounded-r-full bg-brand-500/35" style={{ left: `${(p.soFar / max) * 100}%`, width: `${(Math.max(0, p.projected.p50 - p.soFar) / max) * 100}%` }} />
              <div className="absolute -inset-y-1.5 w-0.5 bg-ink" style={{ left: `${(p.target / max) * 100}%` }} title={`Target ${fullMoney(p.target, cur)}`} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {([
                ['Expected so far', fmt(p.soFar)],
                [`Needed / day · ${p.daysLeft}d left`, fmt(p.needPerDay)],
                ['Recent pace / day', fmt(p.recentPerDay)],
                ['Chance of hitting', `${p.chance}%`],
              ] as Array<[string, string]>).map(([k, v]) => (
                <div key={k} className="rounded-lg bg-sunken/70 px-2.5 py-2">
                  <div className="text-[11px] font-semibold text-muted">{k}</div>
                  <div className={cn('text-sm font-extrabold tabular-nums text-ink', k === 'Chance of hitting' && (p.chance >= 70 ? 'text-emerald-600' : p.chance >= 40 ? 'text-amber-600' : 'text-red-600'))}>{v}</div>
                </div>
              ))}
            </div>
          </div>

          {!compact && (
            <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-3 dark:border-violet-900 dark:bg-violet-950/25">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-violet-800 dark:text-violet-300"><Sparkles size={13} /> Growth coach</span>
                <button type="button" onClick={() => setNonce((x) => x + 1)} aria-label="Refresh" className="rounded p-1 text-violet-700 hover:bg-violet-100 dark:text-violet-300 dark:hover:bg-violet-900/40"><RefreshCw size={13} /></button>
              </div>
              {data?.plan && <p className="mt-2 text-sm leading-relaxed text-ink">{data.plan.text}</p>}
              <ol className="mt-3 space-y-2">
                {data?.levers.map((l, i) => (
                  <li key={l.id} className="flex items-start gap-2.5 rounded-lg bg-surface/80 p-2.5">
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-violet-600 text-[11px] font-bold text-white">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                        <span className="text-sm font-semibold text-ink">{l.title}</span>
                        {l.impact != null && l.impact > 0 && <span className="text-xs font-bold tabular-nums text-emerald-700 dark:text-emerald-400">+{fmt(l.impact)}</span>}
                      </div>
                      <p className="text-xs leading-relaxed text-muted">{l.detail}</p>
                      {l.link && <Link href={l.link} className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-violet-700 hover:underline dark:text-violet-300">Open <ArrowRight size={11} /></Link>}
                    </div>
                  </li>
                ))}
                {data && !data.levers.length && <li className="text-xs text-muted">No clear levers right now: keep spend steady.</li>}
              </ol>
              {data?.plan && <p className="mt-2 text-[11px] text-muted">{data.plan.source === 'ai' ? 'Written by AI from your numbers.' : 'Calculated from your numbers.'} Impacts are extra expected net by month end.</p>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
