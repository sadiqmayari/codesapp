'use client';

import { useMemo } from 'react';
import { GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fullMoney, money } from '@/lib/format-number';
import { growthApi, MODEL_LABEL, type Attribution, type Model } from '@/lib/growth';
import { Skeleton, SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { useGrowth } from '@/components/growth/growth-filters';
import { EChart, useChartTheme } from '@/components/growth/echart';
import { barOption, funnelOption, journeySankey } from '@/components/growth/chart-options';
import { ErrorNote, Panel, useGrowthData } from '@/components/growth/ui';
import { useBaseCurrency } from '@/components/growth/insights';

const MODELS: Model[] = ['first', 'last', 'lnd', 'linear', 'position', 'decay'];

export default function GrowthAttributionPage() {
  const { filters, mode } = useGrowth();
  const theme = useChartTheme();
  const { data, loading, error } = useGrowthData<Attribution>((q, signal) => growthApi.attribution(q, { signal }));
  const cur = useBaseCurrency();

  const charts = useMemo(() => {
    if (!data || !theme) return null;
    const c = data.ctwa;
    return {
      journey: journeySankey(data, theme),
      ctwa: funnelOption([
        ['Ad link clicks', c.adClicks, '#128c7e'],
        ['Chats started (Meta)', c.chatsStarted, '#1fa855'],
        ['Chats in your inbox', c.chatsInInbox, '#25d366'],
        ['Orders (last click)', Math.round(c.orders), theme.cyan],
        ['Delivered', Math.round(c.delivered), theme.good],
      ].filter(([, v]) => (v as number) > 0) as Array<[string, number, string]>, theme),
      lag: barOption(data.lag.map((l) => l.label), data.lag.map((l) => Number(l.pct.toFixed(1))), theme, (v) => `${v}%`),
    };
  }, [data, theme]);

  if (error) return <ErrorNote message={error} />;
  if (loading && !data) return <div className="space-y-4"><SkeletonRows rows={6} /><Skeleton className="h-72 w-full" /></div>;
  if (!data) return null;

  const hasData = data.channels.some((c) => Object.values(c.byModel).some((v) => (v ?? 0) > 0));
  if (!hasData) {
    return (
      <EmptyState icon={GitBranch} title="No attributed orders yet"
        description="Attribution fills in as Shopify customer journeys and WhatsApp ad chats are captured. Run “Backfill attribution” in Connections to process past orders." />
    );
  }

  const heat = (rowVals: number[], v: number) => {
    const mx = Math.max(...rowVals, 1);
    return `color-mix(in srgb, rgb(var(--brand-500)) ${Math.round((v / mx) * 26)}%, transparent)`;
  };

  const Matrix = ({ rows }: { rows: Array<{ key: string; name: string; byModel: Partial<Record<Model, number>> }> }) => (
    <div className="-mx-3 overflow-x-auto sm:-mx-4">
      <table className="w-full min-w-[820px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
            <th className="py-2 pl-3 text-left font-bold">Name</th>
            {MODELS.map((m) => (
              <th key={m} className={cn('px-3 py-2 text-right font-bold', m === filters.model && 'text-ink')}>{MODEL_LABEL[m]}</th>
            ))}
            <th className="px-3 py-2 text-right font-bold" title="Last click minus first click">Last − first</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const vals = MODELS.map((m) => r.byModel[m] ?? 0);
            const swing = (r.byModel.last ?? 0) - (r.byModel.first ?? 0);
            return (
              <tr key={r.key} className="border-b border-line">
                <td className="max-w-[280px] truncate py-2 pl-3 font-semibold text-ink" title={r.name}>{r.name}</td>
                {MODELS.map((m, i) => (
                  <td key={m} title={fullMoney(vals[i], cur)} style={{ background: heat(vals, vals[i]) }}
                    className={cn('px-3 py-2 text-right tabular-nums', m === filters.model && 'font-bold ring-2 ring-inset ring-brand-500')}>
                    {money(vals[i], cur, mode)}
                  </td>
                ))}
                <td className={cn('px-3 py-2 text-right font-semibold tabular-nums', swing >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                  {swing >= 0 ? '+' : ''}{money(swing, cur, mode)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-4">
      <Panel title="Net sales by channel under every model"
        hint={`Same orders credited six ways · ${data.win}-day window · outlined = the model in the toolbar. Prospecting channels look strongest on first click; retargeting and WhatsApp on last click.`}>
        <Matrix rows={data.channels.map((c) => ({ key: c.channel, name: c.label, byModel: c.byModel }))} />
      </Panel>

      <Panel title="Top campaigns by model" hint="“(UTM)” campaigns are named in order links but not found in a connected ad account">
        <Matrix rows={data.campaigns.map((c) => ({ key: c.id, name: c.name, byModel: c.byModel }))} />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Customer journeys" hint="First touch (left) → last touch before the order (right) · orders">
          <EChart option={charts?.journey ?? null} height={360} ariaLabel="First touch to last touch journeys" />
        </Panel>
        <Panel title="WhatsApp ads, end to end" hint="Click-to-WhatsApp: from ad click to a delivered parcel — tracked through your inbox">
          <EChart option={charts?.ctwa ?? null} height={360} ariaLabel="Click-to-WhatsApp funnel" />
          {data.ctwa.deliveredValue > 0 && (
            <p className="mt-1 text-xs text-muted">Delivered value from WhatsApp ad chats: <b className="text-ink">{fullMoney(data.ctwa.deliveredValue, cur)}</b></p>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Days from first click to order" hint="Pick an attribution window that covers most of your orders" className="lg:col-span-2">
          <EChart option={charts?.lag ?? null} height={260} ariaLabel="Days to convert" />
        </Panel>
        <Panel title="Touches before ordering" hint="Marketing visits in the 28 days before each order">
          <ul className="space-y-1.5 pt-1">
            {data.touches.slice(0, 8).map((t) => {
              const total = data.touches.reduce((a, x) => a + x.orders, 0) || 1;
              const share = (t.orders / total) * 100;
              return (
                <li key={t.touches} className="grid grid-cols-[72px_1fr_56px] items-center gap-2 text-xs">
                  <span className="text-muted">{t.touches === 0 ? 'No tracked visit' : `${t.touches} touch${t.touches > 1 ? 'es' : ''}`}</span>
                  <span className="h-2 overflow-hidden rounded-full bg-sunken"><span className="block h-full rounded-full bg-brand-500" style={{ width: `${share}%` }} /></span>
                  <span className="text-right font-semibold tabular-nums text-ink">{share.toFixed(0)}%</span>
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
