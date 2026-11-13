'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { fullMoney, money, ratio } from '@/lib/format-number';
import { CHANNEL_COLOR, growthApi, type Accounts, type Overview } from '@/lib/growth';
import { SkeletonRows } from '@/components/ui/skeleton';
import { useGrowth } from '@/components/growth/growth-filters';
import { EChart, useChartTheme } from '@/components/growth/echart';
import { channelDonut } from '@/components/growth/chart-options';
import { ErrorNote, Panel, useGrowthData } from '@/components/growth/ui';

const PLATFORM_LOGO: Record<string, [string, string]> = {
  meta: ['M', '#1877f2'],
  google: ['G', '#ea4335'],
  tiktok: ['T', '#111827'],
  snap: ['S', '#eab308'],
};

export default function GrowthChannelsPage() {
  const { mode } = useGrowth();
  const theme = useChartTheme();
  const { data, loading, error } = useGrowthData<Overview>((q, signal) => growthApi.overview({ ...q, compare: 'none' }, { signal }));
  const { data: accts } = useGrowthData<Accounts>(() => growthApi.accounts(), 'accounts');
  const donut = useMemo(() => (data && theme ? channelDonut(data, theme, mode, 'net sales') : null), [data, theme, mode]);

  if (error) return <ErrorNote message={error} />;
  const cur = data?.currency ?? null;
  const connected = new Set((accts?.accounts ?? []).map((a) => a.platform));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {(accts?.platforms ?? []).map((p) => {
          const [l, c] = PLATFORM_LOGO[p.platform] ?? ['?', '#64748b'];
          const isOn = connected.has(p.platform);
          return (
            <div key={p.platform} className={cn('flex items-center gap-3 rounded-xl border bg-surface p-3 shadow-sm', isOn ? 'border-line' : 'border-dashed border-line')}>
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-sm font-extrabold text-white" style={{ background: c }}>{l}</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold text-ink">{p.label}</div>
                <div className="text-xs text-muted">{isOn ? 'Connected' : p.available ? 'Not connected' : 'Coming soon'}</div>
              </div>
              {!isOn && p.available && <Link href="/growth/connections" className="rounded-lg bg-brand-600 px-2.5 py-1.5 text-xs font-semibold text-white">Connect</Link>}
            </div>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Channel performance" hint="Net / expected sales credited to each channel under the selected model, against that channel's spend" className="lg:col-span-2">
          {loading && !data ? <SkeletonRows rows={6} /> : (
            <div className="-mx-3 overflow-x-auto sm:-mx-4">
              <table className="w-full min-w-[720px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                    {['Channel', 'Spend', 'Orders', 'Net sales', 'Expected net', 'New customers', 'Expected ROAS'].map((h, i) => (
                      <th key={h} className={cn('px-3 py-2 font-bold', i === 0 ? 'text-left' : 'text-right')}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(data?.channels ?? []).map((c) => (
                    <tr key={c.channel} className="border-b border-line">
                      <td className="px-3 py-2 font-semibold text-ink"><span className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ background: CHANNEL_COLOR[c.channel] ?? '#94a3b8' }} />{c.label}</td>
                      <td className="px-3 py-2 text-right tabular-nums" title={fullMoney(c.spend, cur)}>{c.paid ? money(c.spend, cur, mode) : '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Math.round(c.orders).toLocaleString()}</td>
                      <td className="px-3 py-2 text-right tabular-nums" title={fullMoney(c.net, cur)}>{money(c.net, cur, mode)}</td>
                      <td className="px-3 py-2 text-right tabular-nums" title={fullMoney(c.expected, cur)}>{money(c.expected, cur, mode)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Math.round(c.newCustomers).toLocaleString()}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{c.paid ? ratio(c.expRoas) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        <Panel title="Channel mix" hint="Share of net sales">
          <EChart option={donut} height={320} ariaLabel="Channel mix" />
        </Panel>
      </div>
    </div>
  );
}
