'use client';

import { useMemo, useState } from 'react';
import { ImageOff, Images, TrendingDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fullMoney, money, pct, ratio } from '@/lib/format-number';
import { growthApi, type Creative } from '@/lib/growth';
import { SkeletonCards } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { useGrowth } from '@/components/growth/growth-filters';
import { ErrorNote, Panel, useGrowthData } from '@/components/growth/ui';

type SortKey = 'spend' | 'expRoas' | 'ctr' | 'hookRate' | 'holdRate' | 'cpa';
const SORTS: Array<[SortKey, string]> = [
  ['spend', 'Spend'],
  ['expRoas', 'Expected ROAS'],
  ['ctr', 'CTR'],
  ['hookRate', 'Hook rate'],
  ['holdRate', 'Hold rate'],
  ['cpa', 'CPA (lowest)'],
];

export default function GrowthCreativesPage() {
  const { mode } = useGrowth();
  const [sort, setSort] = useState<SortKey>('spend');
  const [onlyFatigued, setOnlyFatigued] = useState(false);
  const { data, loading, error } = useGrowthData((q, signal) => growthApi.creatives(q, { signal }));

  const rows = useMemo(() => {
    const list = (data?.rows ?? []).filter((r) => !onlyFatigued || r.fatigued);
    const get = (r: Creative) => (r[sort] as number | null) ?? (sort === 'cpa' ? Infinity : -Infinity);
    return [...list].sort((a, b) => (sort === 'cpa' ? get(a) - get(b) : get(b) - get(a)));
  }, [data, sort, onlyFatigued]);

  if (error) return <ErrorNote message={error} />;
  const cur = data?.currency ?? null;
  const fatigued = (data?.rows ?? []).filter((r) => r.fatigued).length;

  return (
    <Panel
      title="Creatives"
      hint="Every ad with spend in the period · hook = 3-second views ÷ impressions · hold = ThruPlays ÷ 3-second views"
      action={
        <div className="flex flex-wrap items-center gap-2">
          {fatigued > 0 && (
            <button type="button" onClick={() => setOnlyFatigued((v) => !v)} aria-pressed={onlyFatigued}
              className={cn('inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold', onlyFatigued ? 'border-amber-400 bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200' : 'border-line bg-surface text-ink')}>
              <TrendingDown size={14} /> {fatigued} fatigued
            </button>
          )}
          <select aria-label="Sort creatives" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs font-semibold text-ink">
            {SORTS.map(([k, l]) => <option key={k} value={k}>Sort: {l}</option>)}
          </select>
        </div>
      }
    >
      {loading && !data ? (
        <SkeletonCards count={8} />
      ) : !rows.length ? (
        <EmptyState icon={Images} title="No ads with spend in this period" description="Creatives appear once an ad account is connected and synced at ad level." compact />
      ) : (
        <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {rows.map((r) => (
            <article key={r.id} className={cn('overflow-hidden rounded-xl border bg-surface shadow-sm', r.fatigued ? 'border-amber-300 dark:border-amber-800' : 'border-line')}>
              <div className="relative aspect-[4/3] bg-sunken">
                {r.thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
                ) : (
                  <div className="grid h-full w-full place-items-center text-muted"><ImageOff size={22} /></div>
                )}
                {r.fatigued && <span className="absolute left-2 top-2 rounded-full bg-amber-500 px-2 py-0.5 text-[11px] font-bold text-white">Fatigued</span>}
                <span className="absolute right-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-semibold text-white" title={fullMoney(r.spend, cur)}>{money(r.spend, cur, mode)}</span>
              </div>
              <div className="space-y-2 p-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-bold text-ink" title={r.name}>{r.name}</div>
                  <div className="truncate text-xs text-muted" title={r.campaign}>{r.campaign}</div>
                </div>
                <dl className="grid grid-cols-4 gap-1 text-center">
                  {([
                    ['Hook', pct(r.hookRate, 0)],
                    ['Hold', pct(r.holdRate, 0)],
                    ['CTR', pct(r.ctr, 2)],
                    ['ROAS', ratio(r.expRoas)],
                  ] as Array<[string, string]>).map(([k, v]) => (
                    <div key={k} className="rounded-md bg-sunken px-1 py-1.5">
                      <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted">{k}</dt>
                      <dd className="text-sm font-bold tabular-nums text-ink">{v}</dd>
                    </div>
                  ))}
                </dl>
                <div className="flex items-center justify-between text-xs text-muted">
                  <span>CPA <b className="text-ink">{money(r.cpa, cur, mode)}</b></span>
                  <span>Freq <b className="text-ink">{r.frequency?.toFixed(1) ?? '—'}</b></span>
                  {r.ctrTrend && r.ctrTrend.prevCtr > 0 && (
                    <span title="CTR last 7 days vs the 7 days before" className={r.ctrTrend.ctr >= r.ctrTrend.prevCtr ? 'text-emerald-600' : 'text-red-600'}>
                      CTR {r.ctrTrend.ctr >= r.ctrTrend.prevCtr ? '▲' : '▼'} {Math.abs(((r.ctrTrend.ctr - r.ctrTrend.prevCtr) / r.ctrTrend.prevCtr) * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}
