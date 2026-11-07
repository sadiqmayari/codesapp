'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  TrendingUp,
  TrendingDown,
  Download,
  ArrowUpDown,
  Search,
  Boxes,
} from 'lucide-react';
import {
  ResponsiveContainer,
  ComposedChart,
  BarChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  Cell,
  PieChart,
  Pie,
  ScatterChart,
  Scatter,
  ReferenceLine,
} from 'recharts';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import {
  cn,
  zonedTodayRange,
  zonedYesterdayRange,
  zonedMonthRange,
  zonedQuarterToDate,
  zonedHalfYearToDate,
  zonedYearToDate,
  zonedPresetRange,
  zonedStartOfDay,
} from '@/lib/utils';
import {
  getInventoryProductAnalytics,
  QUADRANT_META,
  ABC_META,
  type InventoryProductAnalytics,
  type ProductAnalyticsRow,
  type Kpi,
  type Quadrant,
} from '@/lib/inventory-analytics';

type Preset =
  | 'today' | 'yesterday' | 'month' | 'last_month'
  | 'qtd' | 'half' | 'ytd' | 'last7' | 'last30' | 'custom';

const PRESETS: [Preset, string][] = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['month', 'This month'],
  ['last_month', 'Last month'],
  ['qtd', 'This quarter (QTD)'],
  ['half', 'This half-year'],
  ['ytd', 'This year (YTD)'],
  ['last7', 'Last 7 days'],
  ['last30', 'Last 30 days'],
  ['custom', 'Custom…'],
];

interface StoreRow {
  id: number;
  label: string | null;
  shopDomain: string;
  isPrimary: boolean;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const money = (n: number | null) =>
  n == null ? '—' : 'Rs ' + Math.round(n).toLocaleString('en-PK');
const compact = (n: number | null) => {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return 'Rs ' + (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return 'Rs ' + (n / 1e3).toFixed(1) + 'k';
  return 'Rs ' + Math.round(n);
};
const intFmt = (n: number | null) => (n == null ? '—' : Math.round(n).toLocaleString('en-PK'));
const pct = (n: number | null) => (n == null ? '—' : `${n.toFixed(1)}%`);
const mult = (n: number | null) => (n == null ? '—' : `${n.toFixed(1)}×`);
const days = (n: number | null) => (n == null ? '—' : `${Math.round(n)}d`);

const QUAD_COLOR: Record<Quadrant, string> = {
  star: '#f59e0b',
  workhorse: '#2563eb',
  niche: '#7c3aed',
  dog: '#ef4444',
  dead: '#9ca3af',
};

type SortKey =
  | 'revenueNet' | 'unitsSold' | 'margin' | 'onHand' | 'sellThrough'
  | 'returnRate' | 'daysOfCover' | 'grossProfit' | 'stockValue';

export default function InventoryAnalyticsPage() {
  const toast = useToast();
  const router = useRouter();

  const [stores, setStores] = useState<StoreRow[]>([]);
  const [storeId, setStoreId] = useState<number | undefined>(undefined);
  const [preset, setPreset] = useState<Preset>('month');
  const [customFrom, setCustomFrom] = useState(() => ymd(new Date(Date.now() - 30 * 864e5)));
  const [customTo, setCustomTo] = useState(() => ymd(new Date()));
  const [compare, setCompare] = useState(true);

  const [data, setData] = useState<InventoryProductAnalytics | null>(null);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('revenueNet');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    apiFetch<StoreRow[]>('/shopify/stores')
      .then((list) => setStores(Array.isArray(list) ? list : []))
      .catch(() => undefined);
  }, []);

  const range = useMemo(() => {
    switch (preset) {
      case 'today': return zonedTodayRange();
      case 'yesterday': return zonedYesterdayRange();
      case 'month': return zonedMonthRange(0);
      case 'last_month': return zonedMonthRange(-1);
      case 'qtd': return zonedQuarterToDate();
      case 'half': return zonedHalfYearToDate();
      case 'ytd': return zonedYearToDate();
      case 'last7': return zonedPresetRange(7);
      case 'last30': return zonedPresetRange(30);
      case 'custom': {
        const from = zonedStartOfDay(new Date(customFrom + 'T12:00:00Z'));
        const toStart = zonedStartOfDay(new Date(customTo + 'T12:00:00Z'));
        return { from: from.toISOString(), to: new Date(toStart.getTime() + 864e5 - 1).toISOString() };
      }
    }
  }, [preset, customFrom, customTo]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getInventoryProductAnalytics({ ...range, compare, storeId }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [range, compare, storeId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const compareLabel = 'vs prev';
  const rows = data?.rows ?? [];

  const tableRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let r = rows;
    if (q) {
      r = r.filter(
        (x) =>
          x.title.toLowerCase().includes(q) ||
          (x.sku ?? '').toLowerCase().includes(q) ||
          (x.category ?? '').toLowerCase().includes(q),
      );
    }
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...r].sort((a, b) => {
      const av = (a[sortKey] ?? -Infinity) as number;
      const bv = (b[sortKey] ?? -Infinity) as number;
      return (av - bv) * dir;
    });
  }, [rows, search, sortKey, sortDir]);

  const topSellers = useMemo(
    () => [...rows].sort((a, b) => b.revenueNet - a.revenueNet).slice(0, 5),
    [rows],
  );
  const gainers = useMemo(
    () =>
      rows
        .filter((r) => r.revDeltaPct != null)
        .sort((a, b) => (b.revDeltaPct ?? 0) - (a.revDeltaPct ?? 0))
        .slice(0, 5),
    [rows],
  );
  const reorderRows = useMemo(
    () => rows.filter((r) => r.reorderFlag).sort((a, b) => (a.daysOfCover ?? 1e9) - (b.daysOfCover ?? 1e9)).slice(0, 8),
    [rows],
  );
  const deadRows = useMemo(
    () => rows.filter((r) => r.quadrant === 'dead').sort((a, b) => b.stockValue - a.stockValue).slice(0, 8),
    [rows],
  );

  // Pareto (top 12 by net revenue + cumulative % over the whole catalogue)
  const pareto = useMemo(() => {
    const sorted = [...rows].sort((a, b) => b.revenueNet - a.revenueNet);
    const total = sorted.reduce((s, r) => s + Math.max(0, r.revenueNet), 0) || 1;
    let cum = 0;
    return sorted.slice(0, 12).map((r) => {
      cum += Math.max(0, r.revenueNet);
      return {
        name: r.title.length > 14 ? r.title.slice(0, 13) + '…' : r.title,
        revenue: r.revenueNet,
        cumPct: Math.round((cum / total) * 100),
      };
    });
  }, [rows]);

  const quadData = useMemo(
    () =>
      rows
        .filter((r) => r.revenueNet > 0)
        .map((r) => ({ x: r.revenueNet, y: r.margin, title: r.title, quadrant: r.quadrant })),
    [rows],
  );
  const medians = useMemo(() => {
    const med = (xs: number[]) => {
      if (!xs.length) return 0;
      const s = [...xs].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    return {
      rev: med(quadData.map((d) => d.x)),
      margin: med(quadData.map((d) => d.y)),
    };
  }, [quadData]);

  const cat = useMemo(() => (data?.categoryBreakdown ?? []).slice(0, 8), [data]);

  const abcPie = useMemo(() => {
    const a = data?.abc;
    if (!a) return [];
    return [
      { name: 'A', value: a.aCount, fill: '#16a34a' },
      { name: 'B', value: a.bCount, fill: '#f59e0b' },
      { name: 'C', value: a.cCount, fill: '#cbd5e1' },
    ];
  }, [data]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(k);
      setSortDir('desc');
    }
  };

  const exportCsv = () => {
    const head = [
      'Product', 'SKU', 'Category', 'Units sold', 'Revenue (net)', 'Discount',
      'COGS', 'Gross profit', 'Margin %', 'On hand', 'Stock value',
      'Sell-through %', 'Return %', 'Velocity/day', 'Days cover', 'ABC', 'Class',
    ];
    const lines = tableRows.map((r) =>
      [
        `"${r.title.replace(/"/g, '""')}"`, r.sku ?? '', r.category ?? '',
        r.unitsSold, r.revenueNet, r.discount, r.cogs, r.grossProfit, r.margin,
        r.onHand, r.stockValue, r.sellThrough, r.returnRate, r.velocityPerDay,
        r.daysOfCover ?? '', r.abcClass, r.quadrant,
      ].join(','),
    );
    const csv = [head.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventory-analytics-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const s = data?.summary;

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-5 space-y-5">
      {/* Controls */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Boxes className="w-6 h-6 text-green-600" />
            Product Analytics
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Sell-through, margins, turnover &amp; star products — vs the previous period.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {stores.length > 1 && (
            <select
              value={storeId ?? ''}
              onChange={(e) => setStoreId(Number(e.target.value) || undefined)}
              className="bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm font-medium"
            >
              <option value="">All stores</option>
              {stores.map((st) => (
                <option key={st.id} value={st.id}>
                  {st.label || st.shopDomain}
                  {st.isPrimary ? ' — primary' : ''}
                </option>
              ))}
            </select>
          )}
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value as Preset)}
            className="bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm font-medium"
          >
            {PRESETS.map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
          {preset === 'custom' && (
            <>
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
                className="bg-white border border-gray-300 rounded-lg px-2 py-2 text-sm" />
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
                className="bg-white border border-gray-300 rounded-lg px-2 py-2 text-sm" />
            </>
          )}
          <label className="inline-flex items-center gap-1.5 text-sm text-gray-600 bg-white border border-gray-300 rounded-lg px-3 py-2 cursor-pointer">
            <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} className="accent-green-600" />
            Compare
          </label>
          <button onClick={exportCsv}
            className="inline-flex items-center gap-2 bg-white border border-gray-300 hover:bg-gray-50 rounded-lg px-3 py-2 text-sm font-medium text-gray-700">
            <Download className="w-4 h-4" /> Export
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="p-16 text-center">
          <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin mx-auto" />
        </div>
      ) : !s ? (
        <div className="p-16 text-center text-gray-500">No data for this period.</div>
      ) : (
        <div className={cn('space-y-5', loading && 'opacity-60 pointer-events-none')}>
          {/* KPI grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiCard label="Net revenue" kpi={s.revenueNet} fmt={compact} compareLabel={compareLabel} tone="green" />
            <KpiCard label="Units sold" kpi={s.unitsSold} fmt={intFmt} compareLabel={compareLabel} />
            <KpiCard label="Gross profit" kpi={s.grossProfit} fmt={compact} compareLabel={compareLabel} tone="green"
              sub={`${pct(s.grossMargin.value)} margin`} />
            <KpiCard label="Sell-through" kpi={s.sellThrough} fmt={pct} compareLabel={compareLabel} />
            <KpiCard label="Inv. turnover" kpi={s.turnover} fmt={mult} compareLabel={compareLabel}
              sub={`${days(s.daysOnHand.value)} on hand`} />
            <KpiCard label="GMROI" kpi={s.gmroi} fmt={mult} compareLabel={compareLabel} sub="profit per Re of stock" />
            <KpiCard label="Return rate" kpi={s.returnRate} fmt={pct} compareLabel={compareLabel} invertDelta tone="amber" />
            <KpiCard label="Stock value" kpi={s.stockValue} fmt={compact} compareLabel={compareLabel}
              sub={`${intFmt(s.onHandUnits.value)} units`} />
            <KpiCard label="SKUs" kpi={s.skus} fmt={intFmt} compareLabel={compareLabel} />
            <KpiCard label="Dead stock" kpi={s.deadStockCount} fmt={intFmt} compareLabel={compareLabel} invertDelta tone="red"
              sub={`${compact(s.deadStockValue.value)} idle`} />
            <KpiCard label="Out of stock" kpi={s.outOfStock} fmt={intFmt} compareLabel={compareLabel} invertDelta tone="red" />
            <KpiCard label="Low stock" kpi={s.lowStock} fmt={intFmt} compareLabel={compareLabel} invertDelta tone="amber" />
          </div>

          {/* Charts row 1 */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card title="Sales trend" className="lg:col-span-2">
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={data!.trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef1f5" />
                  <XAxis dataKey="d" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="l" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar yAxisId="l" dataKey="revenue" name="Net revenue" fill="#0d9488" radius={[2, 2, 0, 0]} maxBarSize={18} />
                  <Line yAxisId="r" type="monotone" dataKey="units" name="Units" stroke="#7c3aed" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </Card>
            <Card title="ABC classification">
              <ResponsiveContainer width="100%" height={210}>
                <PieChart>
                  <Pie data={abcPie} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                    {abcPie.map((e) => <Cell key={e.name} fill={e.fill} />)}
                  </Pie>
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
              <p className="text-xs text-gray-500 text-center -mt-1">
                Class A = {data!.abc.aCount} SKUs drive {pct(data!.abc.aRevShare)} of revenue
              </p>
            </Card>
          </div>

          {/* Charts row 2 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Star-product quadrant · revenue × margin">
              <ResponsiveContainer width="100%" height={300}>
                <ScatterChart margin={{ top: 10, right: 16, left: 0, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef1f5" />
                  <XAxis type="number" dataKey="x" name="Net revenue" tick={{ fontSize: 10, fill: '#94a3b8' }}
                    tickLine={false} axisLine={false} tickFormatter={(v) => compact(v).replace('Rs ', '')} />
                  <YAxis type="number" dataKey="y" name="Margin %" unit="%" tick={{ fontSize: 10, fill: '#94a3b8' }}
                    tickLine={false} axisLine={false} />
                  <ReferenceLine x={medians.rev} stroke="#e5e7eb" strokeDasharray="4 4" />
                  <ReferenceLine y={medians.margin} stroke="#e5e7eb" strokeDasharray="4 4" />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
                    formatter={(v: number, nm) => (nm === 'Margin %' ? `${v}%` : money(v))}
                    labelFormatter={() => ''}
                    content={({ payload }) => {
                      const p = payload?.[0]?.payload as { title: string; x: number; y: number } | undefined;
                      if (!p) return null;
                      return (
                        <div className="bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs shadow-sm">
                          <div className="font-medium text-gray-800">{p.title}</div>
                          <div className="text-gray-500">{money(p.x)} · {p.y.toFixed(1)}% margin</div>
                        </div>
                      );
                    }}
                  />
                  <Scatter data={quadData}>
                    {quadData.map((d, i) => <Cell key={i} fill={QUAD_COLOR[d.quadrant]} />)}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap gap-3 justify-center text-[11px] text-gray-500 -mt-1">
                <span><i className="inline-block w-2 h-2 rounded-full align-middle" style={{ background: QUAD_COLOR.star }} /> Stars</span>
                <span><i className="inline-block w-2 h-2 rounded-full align-middle" style={{ background: QUAD_COLOR.workhorse }} /> Workhorses</span>
                <span><i className="inline-block w-2 h-2 rounded-full align-middle" style={{ background: QUAD_COLOR.niche }} /> Niche</span>
                <span><i className="inline-block w-2 h-2 rounded-full align-middle" style={{ background: QUAD_COLOR.dog }} /> Low</span>
              </div>
            </Card>
            <Card title="Pareto — revenue concentration">
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={pareto} margin={{ top: 10, right: 8, left: 0, bottom: 30 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef1f5" />
                  <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#94a3b8' }} tickLine={false} axisLine={false}
                    angle={-30} textAnchor="end" interval={0} height={50} />
                  <YAxis yAxisId="l" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="r" orientation="right" domain={[0, 100]} unit="%" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
                    formatter={(v: number, nm) => (nm === 'Cumulative %' ? `${v}%` : money(v))} />
                  <Bar yAxisId="l" dataKey="revenue" name="Net revenue" fill="#16a34a" radius={[2, 2, 0, 0]} maxBarSize={22} />
                  <Line yAxisId="r" type="monotone" dataKey="cumPct" name="Cumulative %" stroke="#d97706" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </Card>
          </div>

          {/* Category breakdown */}
          <Card title="Revenue by category">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={cat} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef1f5" />
                <XAxis dataKey="key" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
                  formatter={(v: number) => money(v)} />
                <Bar dataKey="revenue" name="Net revenue" fill="#0d9488" radius={[3, 3, 0, 0]} maxBarSize={44} />
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* Insight panels */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card title="⭐ Top sellers">
              <ListPanel rows={topSellers} onClick={(r) => r.productId && router.push(`/inventory`)}
                right={(r) => money(r.revenueNet)} />
            </Card>
            <Card title={`📈 Biggest movers ${compare ? '(vs prev)' : ''}`}>
              {compare ? (
                <ListPanel rows={gainers} onClick={() => undefined}
                  right={(r) => (
                    <span className={cn('font-medium', (r.revDeltaPct ?? 0) >= 0 ? 'text-green-600' : 'text-red-600')}>
                      {(r.revDeltaPct ?? 0) >= 0 ? '▲' : '▼'} {Math.abs(r.revDeltaPct ?? 0)}%
                    </span>
                  )} />
              ) : (
                <p className="text-sm text-gray-400">Turn on Compare to see period-over-period movers.</p>
              )}
            </Card>
            <Card title="🔁 Reorder suggestions">
              {reorderRows.length ? (
                <ListPanel rows={reorderRows} onClick={() => undefined}
                  sub={(r) => (r.daysOfCover == null ? 'out' : `${Math.round(r.daysOfCover)}d cover`)}
                  right={(r) => <span className="text-amber-700 font-medium">+{r.suggestedReorderQty}</span>} />
              ) : (
                <p className="text-sm text-gray-400">Nothing needs reordering in stock terms.</p>
              )}
            </Card>
          </div>

          {/* Product table */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-700">All products ({tableRows.length})</h3>
              <div className="relative">
                <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…"
                  className="border border-gray-300 rounded-lg pl-8 pr-3 py-1.5 text-sm w-48" />
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-gray-500 text-left text-[11px] uppercase tracking-wide">
                    <th className="px-3 py-2.5">Product</th>
                    <Th label="Units" k="unitsSold" {...{ sortKey, sortDir, toggleSort }} />
                    <Th label="Net rev" k="revenueNet" {...{ sortKey, sortDir, toggleSort }} />
                    <Th label="Profit" k="grossProfit" {...{ sortKey, sortDir, toggleSort }} />
                    <Th label="Margin" k="margin" {...{ sortKey, sortDir, toggleSort }} />
                    <Th label="On hand" k="onHand" {...{ sortKey, sortDir, toggleSort }} />
                    <Th label="Stock val" k="stockValue" {...{ sortKey, sortDir, toggleSort }} />
                    <Th label="Sell-thru" k="sellThrough" {...{ sortKey, sortDir, toggleSort }} />
                    <Th label="Return" k="returnRate" {...{ sortKey, sortDir, toggleSort }} />
                    <Th label="Days cover" k="daysOfCover" {...{ sortKey, sortDir, toggleSort }} />
                    <th className="px-2 py-2.5 text-center">ABC</th>
                    <th className="px-2 py-2.5 text-center">Class</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 tabular-nums">
                  {tableRows.map((r) => (
                    <tr
                      key={r.key}
                      className="hover:bg-gray-50/70 cursor-pointer"
                      onClick={() => r.productId && router.push('/inventory')}
                    >
                      <td className="px-3 py-2.5">
                        <div className="font-medium text-gray-900 flex items-center gap-1.5">
                          {r.isBundle && (
                            <span className="text-[9px] text-violet-700 bg-violet-50 border border-violet-200 rounded px-1">bundle</span>
                          )}
                          <span className="line-clamp-1">{r.title}</span>
                        </div>
                        <div className="text-gray-400 text-xs">{[r.sku, r.category].filter(Boolean).join(' · ') || '—'}</div>
                      </td>
                      <td className="px-2 text-right">{intFmt(r.unitsSold)}</td>
                      <td className="px-2 text-right">{compact(r.revenueNet)}</td>
                      <td className="px-2 text-right">{compact(r.grossProfit)}</td>
                      <td className={cn('px-2 text-right', r.margin >= 0 ? 'text-green-600' : 'text-red-600')}>{r.unitsSold ? pct(r.margin) : '—'}</td>
                      <td className="px-2 text-right">{r.isBundle ? '—' : intFmt(r.onHand)}</td>
                      <td className="px-2 text-right">{compact(r.stockValue)}</td>
                      <td className="px-2 text-right">{r.unitsSold || r.onHand ? pct(r.sellThrough) : '—'}</td>
                      <td className={cn('px-2 text-right', r.returnRate >= 10 ? 'text-red-600' : r.returnRate > 0 ? 'text-amber-600' : 'text-gray-400')}>
                        {r.returnedUnits ? pct(r.returnRate) : '—'}
                      </td>
                      <td className={cn('px-2 text-right', r.reorderFlag ? 'text-amber-600 font-medium' : '')}>
                        {r.daysOfCover == null ? (r.onHand > 0 ? '∞' : '—') : `${r.daysOfCover}d`}
                      </td>
                      <td className="px-2 text-center">
                        <span className={cn('rounded px-1.5 text-xs font-semibold', ABC_META[r.abcClass])}>{r.abcClass}</span>
                      </td>
                      <td className="px-2 text-center">
                        <span className={cn('rounded px-1.5 text-xs font-semibold', QUADRANT_META[r.quadrant].chip)}>
                          {QUADRANT_META[r.quadrant].label}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {!tableRows.length && (
                    <tr><td colSpan={12} className="px-4 py-12 text-center text-gray-400">No products match.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-xs text-gray-400 pb-4">
            Excludes cancelled orders &amp; physically-returned parcels · COGS = your cost (or Shopify cost-per-item) ·
            turnover/GMROI based on current on-hand stock · bundles counted once.
          </p>
        </div>
      )}
    </div>
  );
}

/* ---- local presentational components (copied convention from orders/analytics) ---- */

function KpiCard({
  label, kpi, fmt, compareLabel, tone, invertDelta, sub,
}: {
  label: string;
  kpi: Kpi;
  fmt: (v: number | null) => string;
  compareLabel: string;
  tone?: 'green' | 'red' | 'amber';
  invertDelta?: boolean;
  sub?: string;
}) {
  const valueColor =
    tone === 'green' ? 'text-green-600' : tone === 'red' ? 'text-red-600' : tone === 'amber' ? 'text-amber-600' : 'text-gray-900';
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <p className="text-[11px] text-gray-500 uppercase tracking-wide">{label}</p>
      <p className={cn('text-xl font-bold mt-1 tabular-nums', valueColor)}>{fmt(kpi.value)}</p>
      <Delta deltaPct={kpi.deltaPct} prev={kpi.prev} fmt={fmt} compareLabel={compareLabel} invert={invertDelta} sub={sub} />
    </div>
  );
}

function Delta({
  deltaPct, prev, fmt, compareLabel, invert, sub,
}: {
  deltaPct: number | null;
  prev: number | null;
  fmt: (v: number | null) => string;
  compareLabel: string;
  invert?: boolean;
  sub?: string;
}) {
  if (deltaPct == null) {
    return <p className="text-[11px] text-gray-400 mt-1">{sub ?? (prev != null ? `${compareLabel} ${fmt(prev)}` : ' ')}</p>;
  }
  const up = deltaPct >= 0;
  const good = invert ? !up : up;
  const color = deltaPct === 0 ? 'text-gray-400' : good ? 'text-green-600' : 'text-red-600';
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <div className={cn('flex items-center gap-1 mt-1 text-[11px]', color)}>
      <Icon className="w-3.5 h-3.5" />
      <span className="font-medium">{up ? '+' : ''}{deltaPct}%</span>
      <span className="text-gray-400 truncate">{sub ?? compareLabel}</span>
    </div>
  );
}

function Card({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('bg-white border border-gray-200 rounded-xl p-5', className)}>
      <h3 className="text-sm font-semibold text-gray-700 mb-3">{title}</h3>
      {children}
    </div>
  );
}

function ListPanel({
  rows, right, sub, onClick,
}: {
  rows: ProductAnalyticsRow[];
  right: (r: ProductAnalyticsRow) => React.ReactNode;
  sub?: (r: ProductAnalyticsRow) => string;
  onClick: (r: ProductAnalyticsRow) => void;
}) {
  if (!rows.length) return <p className="text-sm text-gray-400">Nothing yet.</p>;
  return (
    <ol className="space-y-2 text-sm">
      {rows.map((r) => (
        <li key={r.key} className="flex items-center justify-between gap-2">
          <button onClick={() => onClick(r)} className="text-left truncate hover:text-green-700">
            <span className="line-clamp-1">{r.title}</span>
            {sub && <span className="text-gray-400 text-xs"> · {sub(r)}</span>}
          </button>
          <span className="tabular-nums shrink-0">{right(r)}</span>
        </li>
      ))}
    </ol>
  );
}

function Th({
  label, k, sortKey, sortDir, toggleSort,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  toggleSort: (k: SortKey) => void;
}) {
  const active = sortKey === k;
  return (
    <th className="px-2 py-2.5 text-right">
      <button onClick={() => toggleSort(k)} className={cn('inline-flex items-center gap-1 hover:text-gray-700', active && 'text-gray-800')}>
        {label}
        <ArrowUpDown className={cn('w-3 h-3', active ? 'opacity-100' : 'opacity-30')} />
        {active && <span className="sr-only">{sortDir}</span>}
      </button>
    </th>
  );
}
