'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Columns3, Download, Megaphone } from 'lucide-react';
import { cn } from '@/lib/utils';
import { count, fullMoney, money, pct, ratio } from '@/lib/format-number';
import { growthApi, MODEL_LABEL, type CampaignNode, type Campaigns, type Overview } from '@/lib/growth';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { useGrowth } from '@/components/growth/growth-filters';
import { EChart, useChartTheme } from '@/components/growth/echart';
import { scatterOption } from '@/components/growth/chart-options';
import { ErrorNote, Panel, useGrowthData } from '@/components/growth/ui';

type ColId =
  | 'spend' | 'trend' | 'platformRoas' | 'firstRoas' | 'lastRoas' | 'roas' | 'expRoas' | 'net' | 'expected' | 'delivered'
  | 'orders' | 'cpa' | 'newCustomers' | 'impressions' | 'ctr' | 'cpc' | 'cpm' | 'frequency' | 'hookRate' | 'holdRate'
  | 'messages' | 'platformPurchases';

interface Col {
  id: ColId;
  label: string;
  title?: string;
  kind: 'money' | 'ratio' | 'pct' | 'count' | 'spark';
  get: (n: CampaignNode) => number | null;
}

const COLS: Col[] = [
  { id: 'spend', label: 'Spend', kind: 'money', get: (n) => n.spend },
  { id: 'trend', label: '14-day spend', kind: 'spark', get: () => null },
  { id: 'platformRoas', label: 'Platform ROAS', title: 'What the ad platform reports (placed orders)', kind: 'ratio', get: (n) => n.platformRoas },
  { id: 'firstRoas', label: 'First-click ROAS', kind: 'ratio', get: (n) => n.firstRoas },
  { id: 'lastRoas', label: 'Last-click ROAS', kind: 'ratio', get: (n) => n.lastRoas },
  { id: 'roas', label: 'Model ROAS', title: 'Net sales under the selected attribution model ÷ spend', kind: 'ratio', get: (n) => n.roas },
  { id: 'expRoas', label: 'Expected ROAS', title: 'After predicted cancellations and returns', kind: 'ratio', get: (n) => n.expRoas },
  { id: 'net', label: 'Net sales', kind: 'money', get: (n) => n.net },
  { id: 'expected', label: 'Expected net', kind: 'money', get: (n) => n.expected },
  { id: 'delivered', label: 'Delivered', kind: 'money', get: (n) => n.delivered },
  { id: 'orders', label: 'Orders', kind: 'count', get: (n) => n.orders },
  { id: 'cpa', label: 'CPA', kind: 'money', get: (n) => n.cpa },
  { id: 'newCustomers', label: 'New customers', kind: 'count', get: (n) => n.newCustomers },
  { id: 'impressions', label: 'Impressions', kind: 'count', get: (n) => n.impressions },
  { id: 'ctr', label: 'CTR', kind: 'pct', get: (n) => n.ctr },
  { id: 'cpc', label: 'CPC', kind: 'money', get: (n) => n.cpc },
  { id: 'cpm', label: 'CPM', kind: 'money', get: (n) => n.cpm },
  { id: 'frequency', label: 'Frequency', kind: 'ratio', get: (n) => n.frequency },
  { id: 'hookRate', label: 'Hook rate', kind: 'pct', get: (n) => n.hookRate },
  { id: 'holdRate', label: 'Hold rate', kind: 'pct', get: (n) => n.holdRate },
  { id: 'messages', label: 'Chats started', kind: 'count', get: (n) => n.messages },
  { id: 'platformPurchases', label: 'Platform purchases', kind: 'count', get: (n) => n.platformPurchases },
];

const DEFAULT_COLS: ColId[] = ['spend', 'trend', 'platformRoas', 'firstRoas', 'lastRoas', 'expRoas', 'expected', 'orders', 'cpa', 'frequency', 'ctr'];
const COLS_KEY = 'ca_growth_campaign_cols';

function MiniSpark({ values }: { values: number[] }) {
  if (values.length < 2 || values.every((v) => v === 0)) return <span className="text-muted">—</span>;
  const w = 84;
  const h = 22;
  const mx = Math.max(...values) || 1;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * w).toFixed(1)} ${(h - 2 - (v / mx) * (h - 4)).toFixed(1)}`).join(' ');
  return <svg viewBox={`0 0 ${w} ${h}`} className="inline-block h-[22px] w-[84px] align-middle" aria-hidden><path d={d} fill="none" stroke="#d97706" strokeWidth={1.5} /></svg>;
}

function statusPill(s: string | null) {
  if (!s) return null;
  const on = /ACTIVE|ENABLE/i.test(s);
  return <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-bold', on ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300' : 'bg-sunken text-muted')}>{on ? 'Active' : s.toLowerCase().replace(/_/g, ' ')}</span>;
}

function signal(n: CampaignNode, be: number | null): { label: string; cls: string } | null {
  if (n.spend <= 0 || n.expRoas == null || be == null) return null;
  if ((n.frequency ?? 0) > 3.2) return { label: 'Fatigue risk', cls: 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300' };
  if (n.expRoas >= be * 1.3) return { label: 'Scale', cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300' };
  if (n.expRoas < be * 0.85) return { label: 'Below break-even', cls: 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300' };
  return { label: 'Hold', cls: 'bg-sunken text-muted' };
}

export default function GrowthCampaignsPage() {
  const { filters, mode } = useGrowth();
  const theme = useChartTheme();
  const { data, loading, error } = useGrowthData<Campaigns>((q, signal) => growthApi.campaigns(q, { signal }));
  const { data: ov } = useGrowthData<Overview>((q, signal) => growthApi.overview({ ...q, compare: 'none' }, { signal }));
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [cols, setCols] = useState<ColId[]>(DEFAULT_COLS);
  const [picker, setPicker] = useState(false);
  const [sort, setSort] = useState<{ id: ColId; dir: 1 | -1 }>({ id: 'spend', dir: -1 });
  const [platform, setPlatform] = useState<string>('all');

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_KEY) ?? 'null') as ColId[] | null;
      if (Array.isArray(saved) && saved.length) setCols(saved.filter((c) => COLS.some((x) => x.id === c)));
    } catch {
      /* ignore */
    }
  }, []);
  const saveCols = (next: ColId[]) => {
    setCols(next);
    try {
      localStorage.setItem(COLS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const be = (ov?.kpis.breakEvenRoas?.value as number | null) ?? null;
  const cur = data?.currency ?? null;
  const visible = COLS.filter((c) => cols.includes(c.id));
  const modelCol: ColId = filters.model === 'first' ? 'firstRoas' : filters.model === 'last' ? 'lastRoas' : 'roas';

  const rows = useMemo(() => {
    const list = (data?.rows ?? []).filter((r) => platform === 'all' || r.platform === platform);
    const col = COLS.find((c) => c.id === sort.id)!;
    return [...list].sort((a, b) => ((col.get(a) ?? -Infinity) - (col.get(b) ?? -Infinity)) * sort.dir);
  }, [data, platform, sort]);

  const platforms = useMemo(() => Array.from(new Set((data?.rows ?? []).map((r) => r.platform))), [data]);

  const fmt = (c: Col, n: CampaignNode) => {
    const v = c.get(n);
    if (c.kind === 'money') return money(v, cur, mode);
    if (c.kind === 'ratio') return ratio(v);
    if (c.kind === 'pct') return pct(v, 2);
    return count(v, mode);
  };

  const exportCsv = () => {
    const header = ['Level', 'Name', 'Platform', 'Status', ...COLS.filter((c) => c.kind !== 'spark').map((c) => c.label)];
    const lines = [header];
    const walk = (n: CampaignNode) => {
      lines.push([n.level, n.name, n.platform, n.status ?? '', ...COLS.filter((c) => c.kind !== 'spark').map((c) => {
        const v = c.get(n);
        return v == null ? '' : c.kind === 'money' || c.kind === 'count' ? String(Math.round(v)) : v.toFixed(2);
      })]);
      n.children.forEach(walk);
    };
    rows.forEach(walk);
    const csv = '﻿' + lines.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `growth-campaigns-${filters.from}-to-${filters.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (error) return <ErrorNote message={error} />;

  const renderRow = (n: CampaignNode, depth: number): React.ReactNode => {
    const key = `${n.level}:${n.id}`;
    const isOpen = !!open[key];
    const sig = n.level === 'campaign' ? signal(n, be) : null;
    return (
      <Fragment key={key}>
        <tr className={cn('border-b border-line', depth === 0 ? 'hover:bg-sunken/70' : 'bg-sunken/40')}>
          <td className="sticky left-0 z-[1] max-w-[340px] bg-inherit py-2 pr-3" style={{ paddingLeft: 12 + depth * 22 }}>
            <div className="flex items-center gap-2">
              {n.children.length > 0 ? (
                <button type="button" aria-label={isOpen ? 'Collapse' : 'Expand'} onClick={() => setOpen((o) => ({ ...o, [key]: !isOpen }))}
                  className="grid h-5 w-5 shrink-0 place-items-center rounded border border-line text-muted hover:text-ink">
                  {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
              ) : <span className="w-5 shrink-0" />}
              {n.thumb && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={n.thumb} alt="" className="h-8 w-8 shrink-0 rounded object-cover" loading="lazy" />
              )}
              <div className="min-w-0">
                <div className="truncate font-semibold text-ink" title={n.name}>{n.name}</div>
                <div className="flex items-center gap-1.5 text-[11px] text-muted">
                  <span className="capitalize">{n.level === 'adset' ? 'ad set' : n.level}</span>
                  {statusPill(n.status)}
                  {!n.matched && n.level === 'campaign' && <span title="Order UTMs name a campaign that isn't in the connected ad account">UTM only</span>}
                </div>
              </div>
            </div>
          </td>
          {visible.map((c) => (
            <td key={c.id} className={cn('whitespace-nowrap px-3 py-2 text-right tabular-nums', c.id === modelCol && 'bg-brand-50/60 font-semibold dark:bg-brand-900/20',
              c.kind === 'ratio' && c.id.endsWith('Roas') && be != null && c.get(n) != null && ((c.get(n) as number) >= be ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'))}
              title={c.kind === 'money' ? fullMoney(c.get(n), cur) : undefined}>
              {c.kind === 'spark' ? <MiniSpark values={n.spark} /> : fmt(c, n)}
            </td>
          ))}
          <td className="whitespace-nowrap px-3 py-2 text-right">{sig && <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', sig.cls)}>{sig.label}</span>}</td>
        </tr>
        {isOpen && n.children.map((ch) => renderRow(ch, depth + 1))}
      </Fragment>
    );
  };

  return (
    <div className="space-y-4">
      <Panel
        title="Campaigns → ad sets → ads"
        hint={<>Highlighted column follows the attribution model ({MODEL_LABEL[filters.model]}). Expected ROAS subtracts predicted cancellations and returns{be != null ? `; break-even is ${be.toFixed(2)}×` : ''}.</>}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {platforms.length > 1 && (
              <select aria-label="Platform" value={platform} onChange={(e) => setPlatform(e.target.value)} className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs font-semibold text-ink">
                <option value="all">All platforms</option>
                {platforms.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            )}
            <div className="relative">
              <button type="button" onClick={() => setPicker((v) => !v)} aria-expanded={picker} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink">
                <Columns3 size={14} /> Columns
              </button>
              {picker && (
                <div className="absolute right-0 z-30 mt-1 w-56 rounded-xl border border-line bg-surface p-2 shadow-xl">
                  {COLS.map((c) => (
                    <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs text-ink hover:bg-sunken">
                      <input type="checkbox" checked={cols.includes(c.id)} onChange={() => saveCols(cols.includes(c.id) ? cols.filter((x) => x !== c.id) : [...cols, c.id])} />
                      {c.label}
                    </label>
                  ))}
                  <button type="button" onClick={() => saveCols(DEFAULT_COLS)} className="mt-1 w-full rounded-md px-2 py-1 text-left text-xs font-semibold text-brand-700 hover:bg-sunken dark:text-brand-300">Reset to default</button>
                </div>
              )}
            </div>
            <button type="button" onClick={exportCsv} disabled={!rows.length} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink disabled:opacity-50">
              <Download size={14} /> CSV
            </button>
          </div>
        }
      >
        {loading && !data ? (
          <SkeletonRows rows={8} />
        ) : !rows.length ? (
          <EmptyState icon={Megaphone} title="No campaign data for this period" description="Connect an ad account, or widen the period. Orders with UTM campaigns also appear here." compact />
        ) : (
          <div className="-mx-3 max-h-[70vh] overflow-auto sm:-mx-4">
            <table className="w-full min-w-[960px] border-collapse text-sm">
              <thead className="sticky top-0 z-[2] bg-surface">
                <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                  <th className="sticky left-0 z-[3] bg-surface py-2 pl-3 text-left font-bold">Name</th>
                  {visible.map((c) => (
                    <th key={c.id} title={c.title} className={cn('whitespace-nowrap px-3 py-2 text-right font-bold', c.id === modelCol && 'bg-brand-50/60 text-ink dark:bg-brand-900/20')}>
                      {c.kind === 'spark' ? c.label : (
                        <button type="button" onClick={() => setSort((s) => ({ id: c.id, dir: s.id === c.id ? (s.dir === 1 ? -1 : 1) : -1 }))} className="inline-flex items-center gap-1 uppercase hover:text-ink">
                          {c.label}{sort.id === c.id ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
                        </button>
                      )}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-bold">Signal</th>
                </tr>
              </thead>
              <tbody>{rows.map((n) => renderRow(n, 0))}</tbody>
            </table>
          </div>
        )}
      </Panel>

      {theme && rows.length > 0 && (
        <Panel title="Spend vs expected ROAS" hint="Bubble size = attributed orders · green = comfortably above break-even, amber = near it, red = below">
          <EChart option={scatterOption(rows.map((r) => ({ name: r.name, spend: r.spend, expRoas: r.expRoas, orders: r.orders })), be, theme, mode, cur)} height={340} ariaLabel="Spend versus expected ROAS" />
        </Panel>
      )}
    </div>
  );
}
