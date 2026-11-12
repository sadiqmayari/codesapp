'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Download, RefreshCw } from 'lucide-react';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import {
  cn,
  fmtDateTime,
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
  getAdsSummary,
  getMetaAdsSchedule,
  setMetaAdsSchedule,
  triggerMetaAdsSync,
  SYNC_INTERVAL_OPTIONS,
  type AdsSummary,
  type MetaAdsSchedule,
} from '@/lib/ad-report';

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

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

export default function AdReportPage() {
  const toast = useToast();
  const [preset, setPreset] = useState<Preset>('month');
  const [customFrom, setCustomFrom] = useState(() => ymd(new Date(Date.now() - 30 * 864e5)));
  const [customTo, setCustomTo] = useState(() => ymd(new Date()));
  const [mode, setMode] = useState<'gross' | 'net'>('gross');
  const [data, setData] = useState<AdsSummary | null>(null);
  const [sched, setSched] = useState<MetaAdsSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

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
      setData(await getAdsSummary(range));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load the report');
    } finally {
      setLoading(false);
    }
  }, [range, toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    getMetaAdsSchedule().then(setSched).catch(() => setSched(null));
  }, []);

  const cur = data?.currency ?? '';
  const money = (a: number | null | undefined, full = false) => {
    if (a == null) return '—';
    const v = Math.abs(a);
    const s = full
      ? Math.round(a).toLocaleString()
      : v >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (a / 1e3).toFixed(1) + 'k' : Math.round(a).toLocaleString();
    return `${cur ? cur + ' ' : ''}${s}`;
  };
  const pct = (p: number | null | undefined) => (p == null ? '—' : `${p.toFixed(1)}%`);
  const roas = (r: number | null | undefined) => (r == null ? '—' : `${r.toFixed(2)}×`);
  const roasCls = (r: number | null | undefined) =>
    r == null ? '' : r >= 3 ? 'text-green-600' : r >= 1.5 ? 'text-amber-600' : 'text-red-600';

  const refresh = async () => {
    setSyncing(true);
    try {
      await triggerMetaAdsSync();
      toast.success('Syncing spend from Meta…');
      setTimeout(() => { load(); setSyncing(false); }, 4500);
    } catch (e) {
      setSyncing(false);
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not start a sync');
    }
  };

  const s = data?.summary;
  const roasHeadline = mode === 'gross' ? s?.blendedRoasGross : s?.blendedRoasNet;

  const exportCsv = () => {
    if (!s) return;
    const rows = Object.entries(s).map(([k, v]) => `"${k}","${v ?? ''}"`);
    const blob = new Blob([['metric,value', ...rows].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `ad-report-summary.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Ad Report</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Blended ads &amp; profit — gross / net across the order lifecycle
            {sched?.lastRunAt ? ` · synced ${fmtDateTime(sched.lastRunAt)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value as Preset)}
            className="rounded-lg border border-gray-300 bg-white py-1.5 pl-2.5 pr-7 text-xs text-gray-700 cursor-pointer"
          >
            {PRESETS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {preset === 'custom' && (
            <>
              <input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)}
                className="rounded-lg border border-gray-300 bg-white py-1 px-2 text-xs" />
              <input type="date" value={customTo} min={customFrom} max={ymd(new Date())} onChange={(e) => setCustomTo(e.target.value)}
                className="rounded-lg border border-gray-300 bg-white py-1 px-2 text-xs" />
            </>
          )}
          <div className="flex rounded-full border border-gray-200 p-0.5">
            {(['gross', 'net'] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)}
                className={cn('px-3 py-1 text-xs rounded-full capitalize', mode === m ? 'bg-gray-900 text-white' : 'text-gray-600 hover:text-gray-900')}>
                {m}
              </button>
            ))}
          </div>
          <button onClick={refresh} disabled={syncing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-60">
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />{syncing ? 'Syncing…' : 'Refresh'}
          </button>
          <select
            value={sched?.intervalMinutes == null ? '' : String(sched.intervalMinutes)}
            onChange={async (e) => {
              const v = e.target.value === '' ? null : Number(e.target.value);
              try { await setMetaAdsSchedule(v); toast.success('Auto-sync updated'); getMetaAdsSchedule().then(setSched).catch(() => undefined); }
              catch { toast.error('Could not update schedule'); }
            }}
            disabled={!sched}
            className="rounded-lg border border-gray-300 bg-white py-1.5 pl-2.5 pr-7 text-xs text-gray-700 cursor-pointer disabled:opacity-50"
            title="How often spend auto-syncs"
          >
            {SYNC_INTERVAL_OPTIONS.map(([v, l]) => <option key={l} value={v === null ? '' : String(v)}>{l}</option>)}
          </select>
          <button onClick={exportCsv} disabled={!s}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            <Download size={14} /> CSV
          </button>
        </div>
      </div>

      {loading ? (
        <div className="p-16 flex justify-center">
          <div className="w-6 h-6 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : !s || !data ? (
        <div className="p-16 text-center text-gray-400 text-sm">No data for this period.</div>
      ) : (
        <>
          {/* Summary tiles */}
          <div className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-2 px-1">Summary — blended store</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 mb-5">
            <Tile k="Gross Sales" v={money(s.grossSales)} d="all orders placed" />
            <Tile k="Net Sales" v={money(s.netSales)} d="delivered & kept" />
            <Tile k="Ad Spend" v={money(s.adSpend)} d="Meta" />
            <Tile k="MER" v={pct(s.mer)} d="spend ÷ gross" />
            <Tile k="Blended ROAS" v={roas(roasHeadline)} vcls={roasCls(roasHeadline)} d={`${mode} ÷ spend`} />
            <Tile k="Meta ROAS" v={roas(s.metaRoas)} vcls="text-blue-600" d="pixel-reported" />
            <Tile k="Gross Profit" v={money(s.grossProfit)} d={`margin ${pct(s.grossMargin)}`} />
            <Tile k="Net Profit" v={money(s.netProfit)} vcls={s.netProfit >= 0 ? 'text-green-600' : 'text-red-600'} d="after ads+ship+fees" />
            <Tile k="Net Margin" v={pct(s.netMargin)} d="net profit ÷ sales" />
            <Tile k="AOV" v={money(s.aov, true)} d={`${s.orders.toLocaleString()} orders`} />
            <Tile k="New Customers" v={s.newCustomers.toLocaleString()} d="first-time buyers" />
            <Tile k="nCAC" v={money(s.ncac, true)} d="spend ÷ new cust" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            {/* Funnel */}
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="text-xs font-semibold text-gray-700 mb-3">Order funnel — gross value</div>
              <Funnel f={data.funnel} money={money} maxV={s.grossSales || 1} />
            </div>
            {/* Waterfall */}
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="text-xs font-semibold text-gray-700 mb-3">Profit waterfall</div>
              <Waterfall steps={data.waterfall} money={money} />
            </div>
          </div>

          {/* Trend */}
          {data.trend.length > 1 && (
            <div className="rounded-xl border border-gray-200 bg-white p-3 pr-4 mb-4">
              <div className="text-xs font-semibold text-gray-700 px-1 mb-1">Trend — gross vs net sales &amp; ad spend</div>
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={data.trend.map((t) => ({ ...t, label: t.date.slice(5) }))} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef1f5" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} minTickGap={16} />
                  <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} width={44}
                    tickFormatter={(v: number) => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'k' : String(v))} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }} formatter={(v: number) => money(v)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="gross" name="Gross" fill="#0d9488" radius={[2, 2, 0, 0]} maxBarSize={16} />
                  <Bar dataKey="net" name="Net" fill="#7c3aed" radius={[2, 2, 0, 0]} maxBarSize={16} />
                  <Line dataKey="spend" name="Ad spend" stroke="#d97706" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50/60 p-3 text-xs text-gray-500 leading-relaxed">
            <b>Per-product attribution</b> (which ad drove which product) lives in its own module — this dashboard is store-level/blended only.{' '}
            <b>Gross</b> = pre-discount value of all placed orders; <b>Net</b> = post-discount, delivered-and-kept. <b>Gross Profit</b> = Net − COGS (Shopify cost); <b>Net Profit</b> = − ad spend − shipping − fees.
            Discounts &amp; COGS are forward-accurate (backfill in Settings → Meta Ads); shipping/fees come from uploaded courier/gateway statements (approximate where not uploaded).
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ k, v, d, vcls }: { k: string; v: string; d?: string; vcls?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-3 py-2.5">
      <div className="text-[10.5px] text-gray-500">{k}</div>
      <div className={cn('text-[18px] font-bold mt-0.5 leading-none', vcls ?? 'text-gray-900')}>{v}</div>
      {d && <div className="text-[10.5px] text-gray-400 mt-1">{d}</div>}
    </div>
  );
}

type FunnelData = AdsSummary['funnel'];
function Funnel({ f, money, maxV }: { f: FunnelData; money: (n: number) => string; maxV: number }) {
  const rows: [string, { orders: number; gross: number }, string, boolean][] = [
    ['Placed', f.placed, '#0d9488', false],
    ['− Cancelled', f.cancelled, '#dc2626', true],
    ['Confirmed', f.confirmed, '#059669', false],
    ['Fulfilled', f.fulfilled, '#2563eb', false],
    ['· Delivered', f.delivered, '#16a34a', false],
    ['· In transit', f.inTransit, '#d97706', false],
    ['− Returned (RTO)', f.returned, '#dc2626', true],
    ['= Net realized', f.net, '#7c3aed', false],
  ];
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(([name, st, col, minus]) => (
        <div key={name} className="grid grid-cols-[108px_1fr_84px] gap-2.5 items-center text-xs">
          <div className="text-gray-500 min-w-0">
            <div className="font-semibold text-gray-800 truncate">{name}</div>
            <div className="text-xs text-gray-400">{st.orders.toLocaleString()} orders</div>
          </div>
          <div className="h-5 rounded bg-gray-100 overflow-hidden">
            <span className="block h-full rounded" style={{ width: `${Math.max(3, (st.gross / maxV) * 100)}%`, background: col }} />
          </div>
          <div className={cn('text-right font-semibold tabular-nums', minus && 'text-red-600')}>
            {minus ? '−' : ''}{money(st.gross)}
          </div>
        </div>
      ))}
    </div>
  );
}

function Waterfall({ steps, money }: { steps: AdsSummary['waterfall']; money: (n: number) => string }) {
  const W = 440, H = 230, padT = 6, padB = 40;
  const vals = steps.map((s) => Math.abs(s.value));
  const max = Math.max(1, ...vals);
  const n = steps.length, gap = (W - 16) / n, bw = gap * 0.66;
  const y = (v: number) => padT + (1 - v / max) * (H - padT - padB);
  let run = 0;
  const bars = steps.map((st, i) => {
    const x = 8 + i * gap + (gap - bw) / 2;
    let top: number, bot: number;
    if (st.kind === 'abs') { top = y(st.value); bot = y(0); run = st.value; }
    else { const start = run; run = run + st.value; top = y(Math.max(start, run)); bot = y(Math.min(start, run)); }
    const col = st.kind === 'abs'
      ? (st.label === 'Net Profit' ? '#7c3aed' : st.label === 'Gross Profit' ? '#16a34a' : '#0d9488')
      : (st.value < 0 ? '#ef4444' : '#16a34a');
    return { x, top, h: Math.max(2, bot - top), col, st };
  });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={220}>
      {bars.map((b, i) => (
        <g key={i}>
          <rect x={b.x} y={b.top} width={bw} height={b.h} rx={2} fill={b.col} />
          <text x={b.x + bw / 2} y={H - 22} textAnchor="middle" style={{ fontSize: 8, fill: 'var(--tw-prose-captions,#94a3b8)' }} className="fill-gray-400">{b.st.label}</text>
          <text x={b.x + bw / 2} y={H - 9} textAnchor="middle" style={{ fontSize: 8, fontWeight: 600 }} className="fill-gray-700">{money(Math.abs(b.st.value))}</text>
        </g>
      ))}
    </svg>
  );
}
