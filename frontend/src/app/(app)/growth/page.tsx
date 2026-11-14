'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Database, Plug, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { growthApi, type Overview } from '@/lib/growth';
import { SkeletonCards, Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { useGrowth } from '@/components/growth/growth-filters';
import { EChart, useChartTheme } from '@/components/growth/echart';
import { channelDonut, lifecycleSankey, trendOption, waterfallOption } from '@/components/growth/chart-options';
import { BriefCard, OpportunityList, useCatalog } from '@/components/growth/insights';
import { COMPARE_LABEL, ErrorNote, KpiCard, Panel, useGrowthData } from '@/components/growth/ui';
import { SalesBreakdownRows } from '@/components/ui/sales-breakdown';
import { TargetCoachCard } from '@/components/growth/target-coach';
import { zonedMonthString } from '@/lib/utils';
import { money } from '@/lib/format-number';

type Focus = 'net' | 'realized' | 'expected' | 'gross' | 'spend';

const TILES: Array<{ id: string; focus: Focus; spark: keyof Overview['series'][number]; color: string }> = [
  { id: 'gross', focus: 'gross', spark: 'gross', color: '#64748b' },
  { id: 'net', focus: 'net', spark: 'net', color: '#16a34a' },
  { id: 'realized', focus: 'realized', spark: 'realized', color: '#15803d' },
  { id: 'expected', focus: 'expected', spark: 'expected', color: '#7c3aed' },
  { id: 'spend', focus: 'spend', spark: 'spend', color: '#d97706' },
  { id: 'expRoas', focus: 'expected', spark: 'roas', color: '#7c3aed' },
  { id: 'roas', focus: 'net', spark: 'roas', color: '#16a34a' },
  { id: 'platformRoas', focus: 'net', spark: 'platformValue', color: '#4f46e5' },
  { id: 'mer', focus: 'spend', spark: 'spend', color: '#d97706' },
  { id: 'ncac', focus: 'spend', spark: 'newCustomers', color: '#0891b2' },
  { id: 'aov', focus: 'gross', spark: 'gross', color: '#0891b2' },
  { id: 'rtoRate', focus: 'net', spark: 'orders', color: '#dc2626' },
  { id: 'netProfit', focus: 'net', spark: 'net', color: '#15803d' },
];

export default function GrowthOverviewPage() {
  const { filters, mode } = useGrowth();
  const theme = useChartTheme();
  const { def } = useCatalog();
  const [focus, setFocus] = useState<Focus>('net');
  const [focusTile, setFocusTile] = useState('net');
  const { data, loading, error } = useGrowthData<Overview>((q, signal) => growthApi.overview(q, { signal }));

  const options = useMemo(() => {
    if (!data || !theme) return null;
    return {
      trend: trendOption(data, theme, mode, focus, filters.compare !== 'none'),
      waterfall: waterfallOption(data, theme, mode),
      sankey: lifecycleSankey(data, theme),
      donut: channelDonut(data, theme, mode, 'net sales'),
    };
  }, [data, theme, mode, focus, filters.compare]);

  if (error) return <ErrorNote message={error} />;
  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <SkeletonCards count={6} />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }
  if (!data) return null;

  const empty = (data.kpis.gross?.value ?? 0) === 0 && (data.kpis.spend?.value ?? 0) === 0;
  if (empty) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No orders or ad spend in this period"
        description="Pick a wider period, or connect an ad account to bring spend in next to your orders."
        action={<Link href="/growth/connections" className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white"><Plug size={15} /> Connect ad account</Link>}
      />
    );
  }

  const cmp = COMPARE_LABEL[filters.compare];
  const cov = data.coverage;
  const covWarn = (cov.unitsWithCostPct != null && cov.unitsWithCostPct < 90) || (cov.breakdownPct != null && cov.breakdownPct < 80);

  return (
    <div className="space-y-4">
      <BriefCard />

      {covWarn && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <Database size={14} />
          Profit figures are partial:
          {cov.unitsWithCostPct != null && cov.unitsWithCostPct < 90 && <b>{(100 - cov.unitsWithCostPct).toFixed(0)}% of units have no cost price</b>}
          {cov.breakdownPct != null && cov.breakdownPct < 80 && <b>{(100 - cov.breakdownPct).toFixed(0)}% of orders lack a discount breakdown</b>}
          <Link href="/growth/connections#data" className="ml-auto font-semibold underline">Fix data</Link>
        </div>
      )}

      {(() => {
        const lc = data.lifecycle;
        const inflight = lc.unconfirmed.orders + lc.confirmed.orders + lc.in_transit.orders;
        const share = lc.placed.orders ? inflight / lc.placed.orders : 0;
        if (share < 0.1) return null;
        return (
          <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
            <b>This period is still settling:</b> {inflight.toLocaleString()} orders ({Math.round(share * 100)}%) are on the way, and returns arrive about 2 weeks after shipping.
            Net sales will drop as they come back. Compare periods on <b>Expected net</b>; the % change on Net sales is not like-for-like yet.
          </div>
        );
      })()}

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {TILES.map((t) => (
          <KpiCard
            key={t.id}
            def={def(t.id)}
            value={data.kpis[t.id]?.value ?? null}
            prev={data.kpis[t.id]?.prev ?? null}
            cur={data.currency}
            mode={mode}
            color={t.color}
            spark={data.series.map((p) => Number(p[t.spark] ?? 0))}
            compareLabel={cmp}
            active={focusTile === t.id}
            onClick={() => { setFocusTile(t.id); setFocus(t.focus); }}
          />
        ))}
      </div>

      <TargetCoachCard month={zonedMonthString()} compact />

      <details className="rounded-xl border border-line bg-surface px-4 py-3 shadow-sm">
        <summary className="cursor-pointer text-sm font-bold text-ink">How Gross becomes Net</summary>
        <SalesBreakdownRows
          className="mt-3 max-w-xl"
          fmt={(v) => money(v, data.currency, mode)}
          b={{
            orders: data.lifecycle.placed.orders,
            keptOrders: data.lifecycle.placed.orders - data.lifecycle.cancelled.orders - data.lifecycle.rto.orders,
            cancelledOrders: data.lifecycle.cancelled.orders,
            returnedOrders: data.lifecycle.rto.orders,
            gross: data.kpis.gross?.value ?? 0,
            discounts: data.kpis.discounts?.value ?? 0,
            cancelled: data.kpis.cancelledValue?.value ?? 0,
            returned: data.kpis.returnedValue?.value ?? 0,
            net: data.kpis.net?.value ?? 0,
            shipping: 0,
            tax: 0,
          }}
        />
      </details>

      <Panel
        title="Revenue, spend and ROAS"
        hint={`${data.range.granularity === 'week' ? 'Weekly' : 'Daily'} · drag the slider to zoom · red pins mark unusual days`}
        action={
          <div role="group" aria-label="Bar metric" className="inline-flex rounded-lg border border-line p-0.5">
            {(['net', 'realized', 'expected', 'spend'] as Focus[]).map((f) => (
              <button key={f} type="button" onClick={() => setFocus(f)} aria-pressed={focus === f}
                className={cn('rounded-md px-2.5 py-1 text-xs font-semibold capitalize', focus === f ? 'bg-ink text-surface' : 'text-muted hover:text-ink')}>
                {f === 'expected' ? 'Expected' : f}
              </button>
            ))}
          </div>
        }
      >
        <EChart option={options?.trend ?? null} height={340} ariaLabel="Revenue, spend and ROAS trend" />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Profit waterfall" hint="From gross sales to net profit for the period">
          <EChart option={options?.waterfall ?? null} height={320} ariaLabel="Profit waterfall" />
        </Panel>
        <Panel title="Order lifecycle" hint="Where every placed rupee ended up · hover a flow for its share">
          <EChart option={options?.sankey ?? null} height={320} ariaLabel="Order lifecycle" />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Opportunities" hint="Ranked by expected monthly impact" className="lg:col-span-2" action={<Link href="/growth/campaigns" className="text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300">Open campaigns</Link>}>
          <OpportunityList limit={6} />
        </Panel>
        <Panel title="Channel mix" hint={`Net sales by channel · ${filters.model === 'first' ? 'first' : filters.model === 'last' ? 'last' : 'model-weighted'} touch`}>
          <EChart option={options?.donut ?? null} height={300} ariaLabel="Net sales by channel" />
        </Panel>
      </div>
    </div>
  );
}
