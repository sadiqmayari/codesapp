'use client';

import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import { fullMoney, money, ratio } from '@/lib/format-number';
import { growthApi, type Forecast } from '@/lib/growth';
import { Skeleton, SkeletonCards } from '@/components/ui/skeleton';
import { useGrowth } from '@/components/growth/growth-filters';
import { EChart, useChartTheme } from '@/components/growth/echart';
import { pacingOption } from '@/components/growth/chart-options';
import { ErrorNote, Panel } from '@/components/growth/ui';
import { TargetCoachCard } from '@/components/growth/target-coach';

type Metric = 'net' | 'expected' | 'gross' | 'spend';
const LABEL: Record<Metric, string> = { net: 'Net sales', expected: 'Expected net', gross: 'Gross sales', spend: 'Ad spend' };

export default function GrowthForecastPage() {
  const { filters, version, mode } = useGrowth();
  const theme = useChartTheme();
  const [data, setData] = useState<Forecast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>('expected');
  const [budgets, setBudgets] = useState<Record<string, number>>({});

  useEffect(() => {
    let live = true;
    growthApi
      .forecast(filters.storeId ?? undefined)
      .then((f) => {
        if (!live) return;
        setData(f);
        setBudgets(Object.fromEntries(f.simulator.map((s) => [s.campaignId, Math.round(s.dailySpend)])));
      })
      .catch((e) => live && setError(e instanceof ApiError ? e.userMessage : 'Could not load the forecast.'));
    return () => {
      live = false;
    };
  }, [filters.storeId, version]);

  const option = useMemo(() => (data && theme ? pacingOption(data, metric, theme, mode) : null), [data, theme, metric, mode]);

  const sim = useMemo(() => {
    if (!data) return null;
    let now = 0;
    let next = 0;
    let spendNow = 0;
    let spendNext = 0;
    const rows = data.simulator.map((s) => {
      const b = budgets[s.campaignId] ?? s.dailySpend;
      const revNow = s.a * Math.pow(s.dailySpend, s.b);
      const revNext = b > 0 ? s.a * Math.pow(b, s.b) : 0;
      now += revNow;
      next += revNext;
      spendNow += s.dailySpend;
      spendNext += b;
      return { ...s, budget: b, revNow, revNext, marginal: s.b * (revNow / Math.max(1, s.dailySpend)) };
    });
    return { rows, deltaRev: (next - now) * 30, deltaSpend: (spendNext - spendNow) * 30, deltaProfit: (next - now - (spendNext - spendNow)) * 30 };
  }, [data, budgets]);

  if (error) return <ErrorNote message={error} />;
  if (!data) return <div className="space-y-4"><SkeletonCards count={4} /><Skeleton className="h-80 w-full" /></div>;

  const m = data[metric];
  const pace = m.lastMonthToDate > 0 ? (m.mtd / m.lastMonthToDate) * 100 : null;
  const cur = data.currency;

  const cal = data.calibration;
  return (
    <div className="space-y-4">
      <TargetCoachCard month={data.month} />
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {([
          ['Month to date', money(m.mtd, cur, mode), fullMoney(m.mtd, cur), `${data.monthStart} → ${data.today}`],
          ['Projected month-end', money(m.projected.p50, cur, mode), fullMoney(m.projected.p50, cur), `Likely range ${money(m.projected.p10, cur, mode)} – ${money(m.projected.p90, cur, mode)}`],
          ['vs last month, same day', pace != null ? `${pace.toFixed(0)}%` : '—', undefined, `Last month to date ${money(m.lastMonthToDate, cur, mode)}`],
          ['Last month total', money(m.lastMonthTotal, cur, mode), fullMoney(m.lastMonthTotal, cur), m.lastMonthTotal ? `Projection is ${(((m.projected.p50 - m.lastMonthTotal) / m.lastMonthTotal) * 100).toFixed(1)}% ${m.projected.p50 >= m.lastMonthTotal ? 'above' : 'below'}` : ''],
        ] as Array<[string, string, string | undefined, string]>).map(([k, v, t, h]) => (
          <div key={k} className="rounded-xl border border-line bg-surface px-4 py-3 shadow-sm">
            <div className="text-xs font-semibold text-muted">{k}</div>
            <div className="mt-1 text-[22px] font-extrabold tracking-tight text-ink tabular-nums" title={t}>{v}</div>
            <div className="mt-0.5 text-xs text-muted">{h}</div>
          </div>
        ))}
      </div>

      <Panel
        title={`${LABEL[metric]} — ${data.month} pacing`}
        hint="Cumulative actual, projection with an 80% range, and last month’s daily pace. A projection, not a promise."
        action={
          <div role="group" aria-label="Metric" className="inline-flex rounded-lg border border-line p-0.5">
            {(Object.keys(LABEL) as Metric[]).map((k) => (
              <button key={k} type="button" onClick={() => setMetric(k)} aria-pressed={metric === k}
                className={cn('rounded-md px-2.5 py-1 text-xs font-semibold', metric === k ? 'bg-ink text-surface' : 'text-muted hover:text-ink')}>
                {LABEL[k]}
              </button>
            ))}
          </div>
        }
      >
        <EChart option={option} height={340} ariaLabel="Month pacing forecast" />
      </Panel>

      {cal && cal.weeks.length > 0 && (
        <Panel title="Model check" hint={`What the model would have predicted when each order was placed vs the net that actually stayed, for weeks old enough to have settled (${cal.settleDays}+ days). Trust the projection as much as this error.`}
          action={cal.errorPct != null ? (
            <span className={cn('rounded-full px-2 py-0.5 text-xs font-bold', Math.abs(cal.errorPct) <= 3 ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300' : Math.abs(cal.errorPct) <= 6 ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300' : 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300')}>
              {cal.errorPct > 0 ? '+' : ''}{cal.errorPct}% overall
            </span>
          ) : undefined}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm tabular-nums">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                  <th className="py-2 text-left font-bold">Order week</th>
                  <th className="py-2 text-right font-bold">Predicted net</th>
                  <th className="py-2 text-right font-bold">Actual net</th>
                  <th className="py-2 text-right font-bold">Error</th>
                </tr>
              </thead>
              <tbody>
                {cal.weeks.map((w) => (
                  <tr key={w.week} className="border-b border-line last:border-0">
                    <td className="py-1.5 text-ink">{w.week}</td>
                    <td className="py-1.5 text-right" title={fullMoney(w.predicted, cur)}>{money(w.predicted, cur, mode)}</td>
                    <td className="py-1.5 text-right" title={fullMoney(w.actual, cur)}>{money(w.actual, cur, mode)}</td>
                    <td className={cn('py-1.5 text-right font-semibold', w.errorPct != null && Math.abs(w.errorPct) > 6 ? 'text-red-600' : 'text-muted')}>
                      {w.errorPct == null ? '—' : `${w.errorPct > 0 ? '+' : ''}${w.errorPct}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <Panel title="Budget simulator" hint="Each campaign’s spend → expected-revenue curve, fitted on its last 60 days (last click, 7-day). Drag a budget to see the monthly effect.">
        {!sim || !sim.rows.length ? (
          <p className="py-6 text-sm text-muted">Needs campaigns with spend in the last 60 days.</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
            <div className="divide-y divide-line">
              {sim.rows.map((r) => (
                <div key={r.campaignId} className="py-3">
                  <div className="flex items-center justify-between gap-3">
                    <label htmlFor={`b-${r.campaignId}`} className="min-w-0 truncate text-sm font-semibold text-ink" title={r.name}>{r.name}</label>
                    <span className="shrink-0 text-sm font-bold tabular-nums text-ink">{money(r.budget, cur, 'full')}/day</span>
                  </div>
                  <input id={`b-${r.campaignId}`} type="range" min={0} max={Math.max(1000, Math.round(r.dailySpend * 2.5))} step={Math.max(100, Math.round(r.dailySpend / 50))}
                    value={r.budget} onChange={(e) => setBudgets((b) => ({ ...b, [r.campaignId]: Number(e.target.value) }))} className="mt-1.5 w-full accent-[rgb(var(--brand-600))]" />
                  <div className="mt-0.5 flex flex-wrap gap-x-4 text-xs text-muted">
                    <span>Now {money(r.dailySpend, cur, mode)}/day → {ratio(r.revNow / Math.max(1, r.dailySpend))} expected ROAS</span>
                    <span>Next rupee returns ≈ {ratio(r.marginal)}</span>
                    <span>Curve elasticity {r.b.toFixed(2)}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="space-y-2 self-start rounded-xl bg-sunken p-4">
              <div className="text-xs font-semibold text-muted">Monthly effect of your changes</div>
              {([
                ['Ad spend', sim.deltaSpend],
                ['Expected net sales', sim.deltaRev],
                ['Expected profit (before COGS)', sim.deltaProfit],
              ] as Array<[string, number]>).map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-2">
                  <span className="text-sm text-ink">{k}</span>
                  <b className={cn('tabular-nums', k.startsWith('Expected profit') && (v >= 0 ? 'text-emerald-600' : 'text-red-600'))} title={fullMoney(v, cur)}>
                    {v >= 0 ? '+' : ''}{money(v, cur, mode)}
                  </b>
                </div>
              ))}
              <button type="button" onClick={() => setBudgets(Object.fromEntries(data.simulator.map((s) => [s.campaignId, Math.round(s.dailySpend)])))}
                className="mt-1 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300">Reset to current budgets</button>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
