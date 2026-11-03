'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Download,
  Pencil,
  RefreshCw,
  ChevronRight,
  Package,
} from 'lucide-react';
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
import { cn, fmtDateTime } from '@/lib/utils';
import {
  getMetaAdsSchedule,
  setMetaAdsSchedule,
  triggerMetaAdsSync,
  SYNC_INTERVAL_OPTIONS,
  type MetaAdsSchedule,
} from '@/lib/ad-report';

interface Campaign {
  name: string;
  spend: number;
  metaValue: number;
  metaRoas: number | null;
  advertised: boolean;
}
interface RoasRow {
  product: string;
  unmapped: boolean;
  isBundle: boolean;
  contains?: { title: string; qty: number }[];
  adSpendToday: number;
  salesValueToday: number;
  salesUnitsToday: number;
  roasToday: number | null;
  adSpendMtd: number;
  salesValueMtd: number;
  salesUnitsMtd: number;
  roasMtd: number | null;
  metaValueMtd: number;
  metaRoasMtd: number | null;
  avgUnitValue: number | null;
  targetValue: number;
  targetUnits: number;
  achValuePct: number | null;
  achUnitsPct: number | null;
  projectionValue: number;
  projectionUnits: number;
  campaigns: Campaign[];
}
interface RoasReport {
  month: string;
  currency: string | null;
  daysElapsed: number;
  daysInMonth: number;
  generatedAt: string;
  totals: {
    adSpendToday: number;
    salesValueToday: number;
    salesUnitsToday: number;
    roasToday: number | null;
    adSpendMtd: number;
    salesValueMtd: number;
    salesUnitsMtd: number;
    roasMtd: number | null;
    metaConversionValue: number;
    metaRoas: number | null;
    targetValue: number;
    targetUnits: number;
    projectionValue: number;
    projectionUnits: number;
  };
  rows: RoasRow[];
  trend: { date: string; spend: number; sales: number; metaValue: number }[];
}
interface Connection {
  connected: boolean;
  lastSyncAt: string | null;
}

function prevMonthStr(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function AdReportPage() {
  const toast = useToast();
  const [preset, setPreset] = useState<'this' | 'last'>('this');
  const [data, setData] = useState<RoasReport | null>(null);
  const [conn, setConn] = useState<Connection | null>(null);
  const [sched, setSched] = useState<MetaAdsSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [sort, setSort] = useState<'roas' | 'spend' | 'sales'>('roas');
  const [draft, setDraft] = useState<
    Record<string, { value: number; units: number }>
  >({});

  const monthParam = preset === 'last' ? prevMonthStr() : undefined;

  const loadMeta = useCallback(() => {
    apiFetch<Connection>('/meta-ads/connection').then(setConn).catch(() => setConn(null));
    getMetaAdsSchedule().then(setSched).catch(() => setSched(null));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setEditing(false);
    try {
      const d = await apiFetch<RoasReport>('/analytics/product-roas', {
        params: monthParam ? { month: monthParam } : {},
      });
      setData(d);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load the report');
    } finally {
      setLoading(false);
    }
  }, [monthParam, toast]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);
  useEffect(() => {
    load();
  }, [load]);

  const cur = data?.currency ?? '';
  const money = (amt: number | null | undefined) =>
    amt == null ? '—' : `${cur ? cur + ' ' : ''}${Math.round(amt).toLocaleString()}`;
  const moneyC = (amt: number | null | undefined) => {
    if (amt == null) return '—';
    const a = Math.abs(amt);
    const s = a >= 1e6 ? (amt / 1e6).toFixed(2) + 'M' : Math.round(amt).toLocaleString();
    return `${cur ? cur + ' ' : ''}${s}`;
  };
  const roasCls = (r: number | null) =>
    r == null ? 'text-gray-400' : r >= 3 ? 'text-green-600' : r >= 1.5 ? 'text-amber-600' : 'text-red-600';
  const roas = (r: number | null) => (r == null ? '—' : `${r.toFixed(2)}×`);
  const barCls = (p: number) => (p >= 90 ? 'bg-green-500' : p >= 60 ? 'bg-amber-500' : 'bg-red-500');

  const refresh = async () => {
    setSyncing(true);
    try {
      await triggerMetaAdsSync();
      toast.success('Syncing spend from Meta…');
      setTimeout(() => {
        loadMeta();
        load();
        setSyncing(false);
      }, 4500);
    } catch (e) {
      setSyncing(false);
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not start a sync');
    }
  };

  const changeSchedule = async (raw: string) => {
    const val = raw === '' ? null : Number(raw);
    try {
      await setMetaAdsSchedule(val);
      toast.success('Auto-sync schedule updated');
      getMetaAdsSchedule().then(setSched).catch(() => undefined);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not update schedule');
    }
  };

  const startEdit = () => {
    if (!data) return;
    const d: Record<string, { value: number; units: number }> = {};
    for (const r of data.rows)
      if (!r.unmapped) d[r.product] = { value: r.targetValue, units: r.targetUnits };
    setDraft(d);
    setEditing(true);
  };
  const saveTargets = async () => {
    if (!data) return;
    setSaving(true);
    try {
      const items = Object.entries(draft).map(([productKey, v]) => ({
        productKey,
        targetValue: Number(v.value) || 0,
        targetUnits: Math.round(Number(v.units) || 0),
      }));
      await apiFetch('/meta-ads/targets', {
        method: 'PUT',
        body: { month: data.month, items },
      });
      toast.success('Targets saved');
      setEditing(false);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const sortedRows = useMemo(() => {
    if (!data) return [];
    const key = (r: RoasRow) =>
      sort === 'roas' ? r.roasMtd ?? 0 : sort === 'spend' ? r.adSpendMtd : r.salesValueMtd;
    return [...data.rows].sort((a, b) => {
      if (a.unmapped !== b.unmapped) return a.unmapped ? 1 : -1;
      return key(b) - key(a);
    });
  }, [data, sort]);

  const chartData = useMemo(
    () =>
      (data?.trend ?? []).map((t) => ({
        date: t.date.slice(5),
        spend: Math.round(t.spend),
        sales: Math.round(t.sales),
        netRoas: t.spend > 0 ? +(t.sales / t.spend).toFixed(2) : null,
        metaRoas: t.spend > 0 ? +(t.metaValue / t.spend).toFixed(2) : null,
      })),
    [data],
  );

  const exportCsv = () => {
    if (!data) return;
    const head = ['Product', 'Ad Spend MTD', 'Net Sales MTD', 'Units MTD', 'Net ROAS', 'Meta ROAS', 'Avg Unit', 'Target Value', 'Ach %', 'Projection Value'];
    const lines = sortedRows.map((r) =>
      [r.product, Math.round(r.adSpendMtd), Math.round(r.salesValueMtd), r.salesUnitsMtd, r.roasMtd ?? '', r.metaRoasMtd ?? '', Math.round(r.avgUnitValue ?? 0), r.targetValue, r.achValuePct == null ? '' : Math.round(r.achValuePct), Math.round(r.projectionValue)]
        .map((c) => `"${String(c).replace(/"/g, '""')}"`)
        .join(','),
    );
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ad-report-${data.month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const t = data?.totals;
  const attributedPct = useMemo(() => {
    if (!data || !t || t.adSpendMtd <= 0) return null;
    const un = data.rows.find((r) => r.unmapped)?.adSpendMtd ?? 0;
    return Math.round((1 - un / t.adSpendMtd) * 100);
  }, [data, t]);

  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Ad Report</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Spend × sales × ROAS{data ? ` · ${data.month}` : ''}
            {data ? ` · day ${data.daysElapsed} of ${data.daysInMonth}` : ''}
            {conn?.lastSyncAt ? ` · synced ${fmtDateTime(conn.lastSyncAt)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-full border border-gray-200 p-0.5">
            {(['this', 'last'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setPreset(k)}
                className={cn(
                  'px-3 py-1 text-xs rounded-full transition-colors',
                  preset === k ? 'bg-green-600 text-white' : 'text-gray-600 hover:text-gray-900',
                )}
              >
                {k === 'this' ? 'This month' : 'Last month'}
              </button>
            ))}
          </div>
          <button
            onClick={refresh}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing…' : 'Refresh'}
          </button>
          <select
            value={sched?.intervalMinutes == null ? '' : String(sched.intervalMinutes)}
            onChange={(e) => changeSchedule(e.target.value)}
            disabled={!sched}
            className="rounded-lg border border-gray-300 bg-white py-1.5 pl-2.5 pr-7 text-xs text-gray-700 cursor-pointer disabled:opacity-50"
            title="How often spend auto-syncs"
          >
            {SYNC_INTERVAL_OPTIONS.map(([v, label]) => (
              <option key={label} value={v === null ? '' : String(v)}>
                {label}
              </option>
            ))}
          </select>
          <button
            onClick={exportCsv}
            disabled={!data}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <Download size={14} /> CSV
          </button>
          {!editing ? (
            <button
              onClick={startEdit}
              disabled={!data}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <Pencil size={14} /> Edit targets
            </button>
          ) : (
            <>
              <button
                onClick={saveTargets}
                disabled={saving}
                className="px-3 py-1.5 text-xs rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save targets'}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="px-3 py-1.5 text-xs rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {conn && !conn.connected && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Meta Ads isn&apos;t connected, so ad-spend and ROAS are empty. Connect it in{' '}
          <Link href="/settings" className="underline font-medium">Settings → Meta Ads</Link>. Sales still show below.
        </div>
      )}

      {loading ? (
        <div className="p-16 flex justify-center">
          <div className="w-6 h-6 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : !data || data.rows.length === 0 ? (
        <div className="p-16 text-center text-gray-400 text-sm">
          No products with sales or ad spend in this period yet.
        </div>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
            <Kpi label="Ad Spend · MTD" value={moneyC(t!.adSpendMtd)} sub={`Today ${money(t!.adSpendToday)}`} />
            <Kpi label="Net Sales · MTD" value={moneyC(t!.salesValueMtd)} sub={`${t!.salesUnitsMtd.toLocaleString()} units · net`} />
            <Kpi label="Net ROAS" value={roas(t!.roasMtd)} valueCls={roasCls(t!.roasMtd)} sub="real · Shopify net" />
            <Kpi label="Meta ROAS" value={roas(t!.metaRoas)} valueCls="text-blue-600" sub="Meta pixel (placed)" />
            <Kpi label="Attributed" value={attributedPct == null ? '—' : `${attributedPct}%`} sub="spend mapped" />
          </div>

          {/* Trend chart */}
          {chartData.length > 1 && (
            <div className="mb-4 rounded-xl border border-gray-200 bg-white p-3 pr-4">
              <div className="text-xs font-semibold text-gray-700 px-1 mb-1">Daily spend vs net sales &amp; ROAS</div>
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef1f5" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="money" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} width={44}
                    tickFormatter={(v: number) => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'k' : String(v))} />
                  <YAxis yAxisId="roas" orientation="right" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} width={30} tickFormatter={(v: number) => v + '×'} />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
                    formatter={(val: number, name: string) =>
                      name.includes('ROAS') ? [val + '×', name] : [money(val), name]
                    }
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar yAxisId="money" dataKey="spend" name="Spend" fill="#059669" radius={[2, 2, 0, 0]} maxBarSize={14} />
                  <Bar yAxisId="money" dataKey="sales" name="Net sales" fill="#93c5fd" radius={[2, 2, 0, 0]} maxBarSize={14} />
                  <Line yAxisId="roas" type="monotone" dataKey="netRoas" name="Net ROAS" stroke="#7c3aed" strokeWidth={2} dot={false} connectNulls />
                  <Line yAxisId="roas" type="monotone" dataKey="metaRoas" name="Meta ROAS" stroke="#2563eb" strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Product list */}
          <div className="flex items-center justify-between mb-2 px-1">
            <div className="text-sm font-semibold text-gray-700">
              Products <span className="text-gray-400 font-normal text-xs">— Net ROAS (solid) · Meta ROAS (dashed)</span>
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as 'roas' | 'spend' | 'sales')}
              className="rounded-lg border border-gray-300 bg-white py-1.5 pl-2.5 pr-7 text-xs text-gray-700 cursor-pointer"
            >
              <option value="roas">Sort: Net ROAS</option>
              <option value="spend">Sort: Ad Spend</option>
              <option value="sales">Sort: Sales</option>
            </select>
          </div>

          <div className="space-y-2">
            {sortedRows.map((r) => {
              const isOpen = !!open[r.product];
              return (
                <div
                  key={r.product}
                  className={cn('rounded-xl border bg-white overflow-hidden', r.isBundle ? 'border-purple-200' : 'border-gray-200')}
                >
                  <button
                    onClick={() => setOpen((o) => ({ ...o, [r.product]: !o[r.product] }))}
                    className="w-full grid grid-cols-[18px_1fr_auto_auto] sm:grid-cols-[18px_1.7fr_1fr_0.8fr_64px_60px] gap-2 sm:gap-3 items-center px-3 py-2.5 text-left hover:bg-gray-50"
                  >
                    <ChevronRight size={15} className={cn('text-gray-400 transition-transform', isOpen && 'rotate-90')} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={cn('font-semibold text-[13px] truncate', r.unmapped && 'italic text-gray-400')}>
                          {r.unmapped ? 'Unattributed' : r.product}
                        </span>
                        {r.isBundle && (
                          <span className="flex-none inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">
                            <Package size={9} /> bundle
                          </span>
                        )}
                      </div>
                      {r.unmapped ? (
                        <div className="text-[11px] text-gray-400">spend with no order / product link</div>
                      ) : editing ? (
                        <div className="mt-1.5 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                          <span className="text-[11px] text-gray-500">Target</span>
                          <input
                            type="number"
                            value={draft[r.product]?.value ?? 0}
                            onChange={(e) =>
                              setDraft((d) => ({ ...d, [r.product]: { value: Number(e.target.value), units: d[r.product]?.units ?? 0 } }))
                            }
                            className="w-24 border border-gray-300 rounded px-1.5 py-0.5 text-xs text-right"
                          />
                          <input
                            type="number"
                            value={draft[r.product]?.units ?? 0}
                            onChange={(e) =>
                              setDraft((d) => ({ ...d, [r.product]: { value: d[r.product]?.value ?? 0, units: Number(e.target.value) } }))
                            }
                            className="w-16 border border-gray-300 rounded px-1.5 py-0.5 text-xs text-right"
                            placeholder="units"
                          />
                        </div>
                      ) : r.achValuePct != null ? (
                        <div className="mt-1">
                          <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden max-w-[220px]">
                            <span className={cn('block h-full rounded-full', barCls(r.achValuePct))} style={{ width: `${Math.min(100, r.achValuePct)}%` }} />
                          </div>
                          <div className="text-[10.5px] text-gray-400 mt-0.5">{Math.round(r.achValuePct)}% of {moneyC(r.targetValue)} target</div>
                        </div>
                      ) : (
                        <div className="text-[10.5px] text-gray-400 mt-0.5">no target set</div>
                      )}
                    </div>
                    <div className="hidden sm:block text-right">
                      <div className="text-[11px] text-gray-400">Net sales</div>
                      <div className="text-[13px] font-semibold text-gray-800">{r.salesValueMtd ? moneyC(r.salesValueMtd) : '—'}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[11px] text-gray-400">Spend</div>
                      <div className="text-[13px] font-semibold text-gray-800">{moneyC(r.adSpendMtd)}</div>
                    </div>
                    <div className={cn('justify-self-end text-center rounded-full px-2 py-0.5 text-xs font-bold min-w-[52px]',
                      r.roasMtd == null ? 'text-gray-400' : r.roasMtd >= 3 ? 'bg-green-100 text-green-700' : r.roasMtd >= 1.5 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700')}>
                      {roas(r.roasMtd)}
                    </div>
                    <div className="hidden sm:block justify-self-end text-center rounded-full px-2 py-0.5 text-xs font-bold text-blue-600 border border-dashed border-blue-300 min-w-[52px]">
                      {roas(r.metaRoasMtd)}
                    </div>
                  </button>

                  {isOpen && (
                    <div className="border-t border-gray-100 bg-gray-50/70 px-4 py-3">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-5 gap-y-2.5">
                        <Detail k="Net ROAS · Meta ROAS" v={<><span className={roasCls(r.roasMtd)}>{roas(r.roasMtd)}</span> <span className="text-gray-400">·</span> <span className="text-blue-600">{roas(r.metaRoasMtd)}</span></>} />
                        <Detail k="Spend · Today" v={money(r.adSpendToday)} />
                        <Detail k="Net sales · Today" v={r.salesValueToday ? money(r.salesValueToday) : '—'} />
                        <Detail k="Units · Today / MTD" v={`${r.salesUnitsToday || '—'} / ${r.salesUnitsMtd || '—'}`} />
                        <Detail k="Avg unit value" v={money(r.avgUnitValue)} />
                        <Detail k="Projection · value" v={r.salesValueMtd ? money(r.projectionValue) : '—'} />
                        <Detail k="Projection · units" v={r.salesUnitsMtd ? r.projectionUnits.toLocaleString() : '—'} />
                        <Detail k="Target" v={r.targetValue ? `${moneyC(r.targetValue)} / ${r.targetUnits}u` : '—'} />
                      </div>

                      {r.isBundle && r.contains && r.contains.length > 0 && (
                        <div className="mt-3 text-xs text-gray-500 rounded-lg border border-purple-200 bg-purple-50/50 px-3 py-2">
                          Sold as one <b className="text-purple-700">bundle</b> — its sales stay on this row (not split).{' '}
                          <b>Contains:</b> {r.contains.map((c) => `${c.title} ×${c.qty}`).join(', ')}. Standalone sales of those products count on their own rows.
                        </div>
                      )}

                      {r.campaigns.length > 0 && (
                        <div className="mt-3">
                          <div className="flex items-center justify-between text-[10.5px] uppercase tracking-wide text-gray-400 mb-1">
                            <span>Campaigns</span>
                            <span>Meta ROAS · spend</span>
                          </div>
                          {r.campaigns.map((c) => (
                            <div key={c.name} className="grid grid-cols-[1fr_auto_auto] gap-3 items-center text-xs py-1 border-t border-dashed border-gray-200">
                              <span className="truncate flex items-center gap-1.5">
                                {c.name || '—'}
                                {c.advertised && (
                                  <span className="flex-none text-[8.5px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">advertised</span>
                                )}
                              </span>
                              <span className="text-blue-600 font-semibold text-right min-w-[44px]">{roas(c.metaRoas)}</span>
                              <span className="text-gray-400 text-right min-w-[60px]">{moneyC(c.spend)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <p className="mt-4 text-[11px] text-gray-400 leading-relaxed max-w-3xl">
            <b>Net ROAS</b> = real Shopify net sales (cancelled &amp; returned removed) ÷ spend, attributed per product via each web order&apos;s first-touch UTM.{' '}
            <b className="text-blue-600">Meta ROAS</b> = Meta pixel-attributed value ÷ spend (counts placed orders — runs higher for COD). Spend from campaigns with no tracked orders is mapped to the product their ad links to; whatever can&apos;t be resolved shows as &ldquo;Unattributed.&rdquo;
          </p>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, valueCls }: { label: string; value: string; sub?: string; valueCls?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-3.5 py-3">
      <div className="text-[11.5px] text-gray-500">{label}</div>
      <div className={cn('text-[22px] font-bold mt-1 leading-none', valueCls ?? 'text-gray-900')}>{value}</div>
      {sub && <div className="text-[11px] text-gray-400 mt-1.5">{sub}</div>}
    </div>
  );
}
function Detail({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10.5px] text-gray-400">{k}</div>
      <div className="text-sm font-semibold text-gray-800 mt-0.5">{v}</div>
    </div>
  );
}
