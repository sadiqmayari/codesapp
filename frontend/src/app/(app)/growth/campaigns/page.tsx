'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, Columns3, Download, History, Lock, Megaphone, Plus, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { count, fullMoney, money, pct, ratio } from '@/lib/format-number';
import { growthApi, MODEL_LABEL, type CampaignNode, type Campaigns, type Overview } from '@/lib/growth';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { useGrowth } from '@/components/growth/growth-filters';
import { EChart, useChartTheme } from '@/components/growth/echart';
import { scatterOption } from '@/components/growth/chart-options';
import { ErrorNote, Panel, useGrowthData } from '@/components/growth/ui';
import { growthManageApi, BID_LABEL, type AccessRow, type BidStrategy } from '@/lib/growth-manage';
import type { Opportunity } from '@/lib/growth';
import { StagedProvider, useStaged } from '@/components/growth/manage/staged';
import { BudgetCell, StatusSwitch } from '@/components/growth/manage/budget-cell';
import { Inspector } from '@/components/growth/manage/inspector';

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
const ACTIVE_KEY = 'ca_growth_campaign_active_only';

const isActive = (s: string | null) => !!s && /^(ACTIVE|ENABLED?)$/i.test(s);

/** Keep active nodes only (and their active children), like Meta's "Active" filter. */
function activeOnly(list: CampaignNode[]): CampaignNode[] {
  return list.filter((n) => isActive(n.status)).map((n) => ({ ...n, children: activeOnly(n.children) }));
}

/** Footer total row: sums for amounts/counts, ratios re-derived from the sums (as Meta does). */
function totalOf(list: CampaignNode[]): CampaignNode {
  const sum = (k: keyof CampaignNode) => list.reduce((a, n) => a + ((n[k] as number) || 0), 0);
  const spend = sum('spend');
  const impressions = sum('impressions');
  const reach = sum('reach');
  const linkClicks = sum('linkClicks');
  const video3s = sum('video3s');
  const thruplay = sum('thruplay');
  const orders = sum('orders');
  const div = (a: number, b: number) => (b > 0 ? a / b : null);
  const len = Math.max(0, ...list.map((n) => n.spark.length));
  return {
    level: 'campaign', id: '__total', platform: '', name: 'Total', status: null, objective: null, dailyBudget: null, thumb: null, matched: false,
    spend, impressions, reach, clicks: sum('clicks'), linkClicks, video3s, thruplay,
    platformPurchases: sum('platformPurchases'), platformValue: sum('platformValue'), messages: sum('messages'),
    orders, net: sum('net'), expected: sum('expected'), delivered: sum('delivered'), newCustomers: sum('newCustomers'),
    firstNet: sum('firstNet'), lastNet: sum('lastNet'),
    ctr: impressions ? (linkClicks / impressions) * 100 : null,
    cpm: impressions ? (spend / impressions) * 1000 : null,
    cpc: div(spend, linkClicks),
    cpa: orders >= 0.5 ? spend / orders : null,
    frequency: div(impressions, reach),
    hookRate: impressions && video3s ? (video3s / impressions) * 100 : null,
    holdRate: video3s ? (thruplay / video3s) * 100 : null,
    roas: div(sum('net'), spend), expRoas: div(sum('expected'), spend), platformRoas: div(sum('platformValue'), spend),
    firstRoas: div(sum('firstNet'), spend), lastRoas: div(sum('lastNet'), spend),
    spark: Array.from({ length: len }, (_, i) => list.reduce((a, n) => a + (n.spark[n.spark.length - len + i] ?? 0), 0)),
    children: [],
  };
}

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

function bidLabel(n: CampaignNode, staged?: BidStrategy) {
  const owns = n.budgetOwner === n.level && n.level !== 'ad';
  if (!owns) return n.level === 'ad' ? '' : n.level === 'adset' ? 'From campaign' : '—';
  const b = (staged ?? n.bidStrategy) as BidStrategy | null | undefined;
  if (!b) return '—';
  const extra = b === 'LOWEST_COST_WITH_MIN_ROAS' && n.roasFloor ? ` ${n.roasFloor.toFixed(2)}×` : '';
  return <span className={cn(staged && 'font-bold text-violet-700 dark:text-violet-300')}>{(BID_LABEL[b] ?? b) + extra}</span>;
}

function signal(n: CampaignNode, be: number | null): { label: string; cls: string } | null {
  if (n.spend <= 0 || n.expRoas == null || be == null) return null;
  if ((n.frequency ?? 0) > 3.2) return { label: 'Fatigue risk', cls: 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300' };
  if (n.expRoas >= be * 1.3) return { label: 'Scale', cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300' };
  if (n.expRoas < be * 0.85) return { label: 'Below break-even', cls: 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300' };
  return { label: 'Hold', cls: 'bg-sunken text-muted' };
}

export default function GrowthCampaignsPage() {
  return (
    <StagedProvider>
      <CampaignsView />
    </StagedProvider>
  );
}

/** Opportunities that come with a one-click change: staged, never applied directly. */
function SuggestedActions({ names }: { names: Map<string, string> }) {
  const { mode } = useGrowth();
  const { stage, items, currency } = useStaged();
  const { data } = useGrowthData<Opportunity[]>((q, signal) => growthApi.opportunities(q, { signal }));
  const list = (data ?? []).filter((o) => o.action).slice(0, 4);
  if (!list.length) return null;
  const keyOfAction = (a: NonNullable<Opportunity['action']>) => (a.kind === 'scale' ? `scale:${a.campaignId}` : `${a.level}:${a.entityId}`);
  return (
    <div className="rounded-xl border border-violet-200/70 bg-gradient-to-r from-violet-50/80 to-surface p-3 dark:border-violet-900/60 dark:from-violet-950/30">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-violet-800 dark:text-violet-300"><Sparkles size={13} /> Suggested actions</div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {list.map((o) => {
          const a = o.action!;
          const staged = items.some((i) => i.key === keyOfAction(a));
          const id = a.kind === 'scale' ? a.campaignId : a.entityId;
          return (
            <div key={o.id} className="flex flex-col justify-between gap-2 rounded-lg border border-line bg-surface p-2.5">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-ink" title={o.title}>{o.title}</div>
                <div className="line-clamp-2 text-xs text-muted">{o.detail}</div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                  {o.impact != null ? `+${money(o.impact, currency, mode)}` : ''}
                  <span className="ml-1 font-normal text-muted">{o.impact != null ? o.impactLabel : ''}</span>
                </span>
                <button type="button" disabled={staged}
                  onClick={() => stage(a.kind === 'scale' ? { kind: 'scale', campaignId: a.campaignId, pct: a.pct } : { kind: 'patch', level: a.level, entityId: a.entityId, patch: a.patch },
                    `${names.get(id) ?? 'Suggestion'} · ${a.label.replace(/^Stage /, '')}`)}
                  className="shrink-0 rounded-md bg-ink px-2.5 py-1 text-xs font-bold text-surface disabled:bg-violet-100 disabled:text-violet-700 dark:disabled:bg-violet-900/50 dark:disabled:text-violet-200">
                  {staged ? 'Staged' : a.label}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CampaignsView() {
  const { pendingFor, scaleFor, setCurrency } = useStaged();
  const [access, setAccess] = useState<AccessRow[] | null>(null);
  const [inspect, setInspect] = useState<CampaignNode | null>(null);
  useEffect(() => {
    growthManageApi.access().then(setAccess).catch(() => setAccess([]));
  }, []);
  const canEdit = (platform: string) => !!access?.some((a) => a.platform === platform && a.canManage);
  const anyEditable = !!access?.some((a) => a.canManage);
  const { filters, mode } = useGrowth();
  const theme = useChartTheme();
  const { data, loading, error } = useGrowthData<Campaigns>((q, signal) => growthApi.campaigns(q, { signal }));
  const { data: ov } = useGrowthData<Overview>((q, signal) => growthApi.overview({ ...q, compare: 'none' }, { signal }));
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [cols, setCols] = useState<ColId[]>(DEFAULT_COLS);
  const [picker, setPicker] = useState(false);
  const [sort, setSort] = useState<{ id: ColId; dir: 1 | -1 }>({ id: 'spend', dir: -1 });
  const [platform, setPlatform] = useState<string>('all');
  const [onlyActive, setOnlyActive] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_KEY) ?? 'null') as ColId[] | null;
      if (Array.isArray(saved) && saved.length) setCols(saved.filter((c) => COLS.some((x) => x.id === c)));
      setOnlyActive(localStorage.getItem(ACTIVE_KEY) === '1');
    } catch {
      /* ignore */
    }
  }, []);
  const toggleActive = (v: boolean) => {
    setOnlyActive(v);
    try {
      localStorage.setItem(ACTIVE_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
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
  useEffect(() => setCurrency(cur), [cur, setCurrency]);
  const visible = COLS.filter((c) => cols.includes(c.id));
  const modelCol: ColId = filters.model === 'first' ? 'firstRoas' : filters.model === 'last' ? 'lastRoas' : 'roas';

  const rows = useMemo(() => {
    const byPlatform = (data?.rows ?? []).filter((r) => platform === 'all' || r.platform === platform);
    const list = onlyActive ? activeOnly(byPlatform) : byPlatform;
    const col = COLS.find((c) => c.id === sort.id)!;
    return [...list].sort((a, b) => ((col.get(a) ?? -Infinity) - (col.get(b) ?? -Infinity)) * sort.dir);
  }, [data, platform, sort, onlyActive]);
  const total = useMemo(() => (rows.length ? totalOf(rows) : null), [rows]);

  const names = useMemo(() => {
    const m = new Map<string, string>();
    const walk = (n: CampaignNode) => {
      m.set(n.id, n.name);
      n.children.forEach(walk);
    };
    (data?.rows ?? []).forEach(walk);
    return m;
  }, [data]);
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
    if (total) walk(total);
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
    const isStaged = !!pendingFor(n.level, n.id) || (n.level === 'campaign' && scaleFor(n.id) != null);
    return (
      <Fragment key={key}>
        <tr className={cn('border-b border-line', depth === 0 ? 'hover:bg-sunken/70' : 'bg-sunken/40')}>
          <td className={cn('sticky left-0 z-[1] max-w-[360px] bg-inherit py-2 pr-3', isStaged && 'shadow-[inset_3px_0_0_0_rgb(139_92_246)]')} style={{ paddingLeft: 12 + depth * 22 }}>
            <div className="flex items-center gap-2">
              <span className="w-8 shrink-0">{n.matched && <StatusSwitch n={n} canEdit={canEdit(n.platform)} />}</span>
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
                {n.matched ? (
                  <button type="button" onClick={() => setInspect(n)} title={`${n.name} (open settings)`}
                    className="block max-w-full truncate text-left font-semibold text-ink hover:text-violet-700 hover:underline dark:hover:text-violet-300">{n.name}</button>
                ) : (
                  <div className="truncate font-semibold text-ink" title={n.name}>{n.name}</div>
                )}
                <div className="flex items-center gap-1.5 text-[11px] text-muted">
                  <span className="capitalize">{n.level === 'adset' ? 'ad set' : n.level}</span>
                  {statusPill(n.status)}
                  {!n.matched && n.level === 'campaign' && <span title="Order UTMs name a campaign that isn't in the connected ad account">UTM only</span>}
                </div>
              </div>
            </div>
          </td>
          <td className="whitespace-nowrap px-3 py-2 text-right">{n.matched ? <BudgetCell n={n} canEdit={canEdit(n.platform)} /> : <span className="text-muted">—</span>}</td>
          <td className="whitespace-nowrap px-3 py-2 text-xs text-muted">{bidLabel(n, pendingFor(n.level, n.id)?.bidStrategy)}</td>
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
      {access && !anyEditable && access.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-line bg-sunken/60 px-4 py-3 text-sm text-muted">
          <Lock size={16} className="mt-0.5 shrink-0" />
          <span>Read-only. To pause, change budgets or create ads from CodesApp, give the ad account token the <b className="text-ink">ads_management</b> permission. See <Link href="/growth/connections" className="font-semibold text-ink underline">Connections</Link>.</span>
        </div>
      )}
      {anyEditable && <SuggestedActions names={names} />}
      {inspect && <Inspector node={inspect} breakEven={be} canEdit={canEdit(inspect.platform)} onClose={() => setInspect(null)} />}
      <Panel
        title="Campaigns → ad sets → ads"
        hint={<>Highlighted column follows the attribution model ({MODEL_LABEL[filters.model]}). Expected ROAS subtracts predicted cancellations and returns{be != null ? `; break-even is ${be.toFixed(2)}×` : ''}.</>}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Campaign status" className="inline-flex rounded-lg border border-line bg-surface p-0.5 shadow-sm">
              {([[false, 'All'], [true, 'Active only']] as Array<[boolean, string]>).map(([v, l]) => (
                <button key={l} type="button" onClick={() => toggleActive(v)} aria-pressed={onlyActive === v}
                  className={cn('rounded-md px-2 py-1 text-xs font-semibold', onlyActive === v ? 'bg-ink text-surface' : 'text-muted hover:text-ink')}>
                  {l}
                </button>
              ))}
            </div>
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
            <Link href="/growth/activity" className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink hover:bg-sunken">
              <History size={14} /> Activity
            </Link>
            {anyEditable && (
              <Link href="/growth/campaigns/new" className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-2.5 py-1.5 text-xs font-bold text-surface">
                <Plus size={14} /> Create campaign
              </Link>
            )}
            <button type="button" onClick={exportCsv} disabled={!rows.length} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink disabled:opacity-50">
              <Download size={14} /> CSV
            </button>
          </div>
        }
      >
        {loading && !data ? (
          <SkeletonRows rows={8} />
        ) : !rows.length ? (
          onlyActive && (data?.rows ?? []).length ? (
            <EmptyState icon={Megaphone} title="No active campaigns in this period" description="Switch to All to see paused and finished campaigns." compact />
          ) : (
            <EmptyState icon={Megaphone} title="No campaign data for this period" description="Connect an ad account, or widen the period. Orders with UTM campaigns also appear here." compact />
          )
        ) : (
          <div className="-mx-3 max-h-[70vh] overflow-auto sm:-mx-4">
            <table className="w-full min-w-[960px] border-collapse text-sm">
              <thead className="sticky top-0 z-[2] bg-surface">
                <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                  <th className="sticky left-0 z-[3] bg-surface py-2 pl-3 text-left font-bold"><span className="inline-block w-10" />Name</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right font-bold">Budget</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left font-bold">Bid strategy</th>
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
              {total && (
                <tfoot className="sticky bottom-0 z-[2] bg-surface">
                  <tr className="border-t-2 border-line font-bold text-ink">
                    <td className="sticky left-0 z-[3] bg-surface py-2.5 pl-3 pr-3">
                      <div>Total · {rows.length} campaign{rows.length === 1 ? '' : 's'}</div>
                      <div className="text-[11px] font-normal text-muted" title="Reach is summed across campaigns, so frequency is approximate (Meta de-duplicates people across campaigns)">{onlyActive ? 'Active only' : 'All statuses'}{platform !== 'all' ? ` · ${platform}` : ''}</div>
                    </td>
                    <td className="px-3 py-2.5" />
                    <td className="px-3 py-2.5" />
                    {visible.map((c) => (
                      <td key={c.id} className={cn('whitespace-nowrap px-3 py-2.5 text-right tabular-nums', c.id === modelCol && 'bg-brand-50/60 dark:bg-brand-900/20')}
                        title={c.kind === 'money' ? fullMoney(c.get(total), cur) : undefined}>
                        {c.kind === 'spark' ? <MiniSpark values={total.spark} /> : fmt(c, total)}
                      </td>
                    ))}
                    <td className="px-3 py-2.5" />
                  </tr>
                </tfoot>
              )}
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
