'use client';

import { useMemo } from 'react';
import { Users } from 'lucide-react';
import { count, fullMoney, money, pct } from '@/lib/format-number';
import { growthApi, type Customers } from '@/lib/growth';
import { Skeleton, SkeletonCards } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { useGrowth } from '@/components/growth/growth-filters';
import { EChart, useChartTheme } from '@/components/growth/echart';
import { cohortHeatmap, newVsReturning } from '@/components/growth/chart-options';
import { useBaseCurrency } from '@/components/growth/insights';
import { ErrorNote, Panel, useGrowthData } from '@/components/growth/ui';

function Stat({ label, value, title, hint }: { label: string; value: string; title?: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3 shadow-sm">
      <div className="text-xs font-semibold text-muted">{label}</div>
      <div className="mt-1 text-[22px] font-extrabold tracking-tight text-ink tabular-nums" title={title}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export default function GrowthCustomersPage() {
  const { mode } = useGrowth();
  const theme = useChartTheme();
  const cur = useBaseCurrency();
  const { data, loading, error } = useGrowthData<Customers>((q, signal) => growthApi.customers(q, { signal }));

  const charts = useMemo(() => {
    if (!data || !theme) return null;
    return { cohort: cohortHeatmap(data, theme, mode, cur), nvr: newVsReturning(data, theme, mode, cur) };
  }, [data, theme, mode, cur]);

  if (error) return <ErrorNote message={error} />;
  if (loading && !data) return <div className="space-y-4"><SkeletonCards count={4} /><Skeleton className="h-80 w-full" /></div>;
  if (!data) return null;
  if (!data.cohorts.length && !data.newCustomers) {
    return <EmptyState icon={Users} title="No customers in this period" description="Customer cohorts build up as orders are placed and delivered." />;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Stat label="New customers" value={count(data.newCustomers, mode)} hint="First non-cancelled order in the period" />
        <Stat label="nCAC" value={money(data.ncac, cur, mode)} title={fullMoney(data.ncac, cur)} hint="Ad spend per new customer" />
        <Stat label="LTV : CAC (90 days)" value={data.ltvToCac != null ? `${data.ltvToCac.toFixed(1)} : 1` : '—'} hint={data.ltv90 != null ? `90-day revenue per customer ${money(data.ltv90, cur, mode)}` : 'Needs 3 months of cohorts'} />
        <Stat label="Payback" value={data.paybackDays != null ? `${data.paybackDays} days` : '—'} hint={`Returning customers: ${pct(data.returningShare, 0)} of revenue`} />
      </div>
      <Panel title="Revenue per customer by first-order month" hint="Cumulative net sales per customer, month 0 = month of first order · cohort size in brackets">
        <EChart option={charts?.cohort ?? null} height={Math.max(260, data.cohorts.length * 44 + 90)} ariaLabel="Customer cohorts" />
      </Panel>
      <Panel title="New vs returning revenue" hint="Net sales per day">
        <EChart option={charts?.nvr ?? null} height={280} ariaLabel="New versus returning revenue" />
      </Panel>
    </div>
  );
}
