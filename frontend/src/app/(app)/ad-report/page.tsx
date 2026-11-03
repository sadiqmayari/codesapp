'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Download, Pencil, RefreshCw } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { cn, fmtDateTime } from '@/lib/utils';

interface RoasRow {
  product: string;
  unmapped: boolean;
  adSpendToday: number;
  salesValueToday: number;
  salesUnitsToday: number;
  roasToday: number | null;
  adSpendMtd: number;
  salesValueMtd: number;
  salesUnitsMtd: number;
  roasMtd: number | null;
  avgUnitValue: number | null;
  targetValue: number;
  targetUnits: number;
  achValue: number;
  achUnits: number;
  achValuePct: number | null;
  achUnitsPct: number | null;
  projectionValue: number;
  projectionUnits: number;
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
    targetValue: number;
    targetUnits: number;
    projectionValue: number;
    projectionUnits: number;
  };
  rows: RoasRow[];
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
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<
    Record<string, { value: number; units: number }>
  >({});

  useEffect(() => {
    apiFetch<Connection>('/meta-ads/connection')
      .then(setConn)
      .catch(() => setConn(null));
  }, []);

  const monthParam = preset === 'last' ? prevMonthStr() : undefined;

  const load = useCallback(async () => {
    setLoading(true);
    setEditing(false);
    try {
      const d = await apiFetch<RoasReport>('/analytics/product-roas', {
        params: monthParam ? { month: monthParam } : {},
      });
      setData(d);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load the report',
      );
    } finally {
      setLoading(false);
    }
  }, [monthParam, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const cur = data?.currency ?? '';
  const money = (amt: number | null | undefined) =>
    amt == null
      ? '—'
      : `${cur ? cur + ' ' : ''}${Math.round(amt).toLocaleString()}`;
  const roasCls = (r: number | null) =>
    r == null
      ? 'text-gray-400'
      : r >= 3
      ? 'text-green-600'
      : r >= 1.5
      ? 'text-amber-600'
      : 'text-red-600';
  const roas = (r: number | null) => (r == null ? '—' : `${r.toFixed(2)}×`);
  const pctCls = (p: number | null) =>
    p == null
      ? 'bg-gray-100 text-gray-400'
      : p >= 90
      ? 'bg-green-100 text-green-700'
      : p >= 60
      ? 'bg-amber-100 text-amber-700'
      : 'bg-red-100 text-red-700';
  const pct = (p: number | null) => (p == null ? '—' : `${Math.round(p)}%`);

  const startEdit = () => {
    if (!data) return;
    const d: Record<string, { value: number; units: number }> = {};
    for (const r of data.rows) {
      if (r.unmapped) continue;
      d[r.product] = { value: r.targetValue, units: r.targetUnits };
    }
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

  const exportCsv = () => {
    if (!data) return;
    const head = [
      'Product',
      'Ad Spend Today',
      'Sales Value Today',
      'Units Today',
      'ROAS Today',
      'Ad Spend MTD',
      'Sales Value MTD',
      'Units MTD',
      'ROAS MTD',
      'Avg Unit Value',
      'Target Value',
      'Target Units',
      'Ach Value %',
      'Ach Units %',
      'Projection Value',
      'Projection Units',
    ];
    const lines = data.rows.map((r) =>
      [
        r.product,
        r.adSpendToday,
        r.salesValueToday,
        r.salesUnitsToday,
        r.roasToday ?? '',
        r.adSpendMtd,
        r.salesValueMtd,
        r.salesUnitsMtd,
        r.roasMtd ?? '',
        r.avgUnitValue ?? '',
        r.targetValue,
        r.targetUnits,
        r.achValuePct == null ? '' : Math.round(r.achValuePct),
        r.achUnitsPct == null ? '' : Math.round(r.achUnitsPct),
        Math.round(r.projectionValue),
        r.projectionUnits,
      ]
        .map((c) => `"${String(c).replace(/"/g, '""')}"`)
        .join(','),
    );
    const blob = new Blob([[head.join(','), ...lines].join('\n')], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ad-roas-${data.month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const th = 'px-2.5 py-2 text-right font-semibold whitespace-nowrap';
  const td = 'px-2.5 py-2 text-right whitespace-nowrap border-t border-gray-100';
  const grp = 'border-l border-gray-200';

  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Ad Report</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Per-product ad spend, sales &amp; ROAS
            {data ? ` · ${data.month}` : ''}
            {data
              ? ` · day ${data.daysElapsed} of ${data.daysInMonth}`
              : ''}
            {conn?.lastSyncAt
              ? ` · spend synced ${fmtDateTime(conn.lastSyncAt)}`
              : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-full border border-gray-200 p-0.5">
            {(['this', 'last'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setPreset(k)}
                className={cn(
                  'px-3 py-1 text-xs rounded-full',
                  preset === k
                    ? 'bg-green-600 text-white'
                    : 'text-gray-600 hover:text-gray-900',
                )}
              >
                {k === 'this' ? 'This month' : 'Last month'}
              </button>
            ))}
          </div>
          <button
            onClick={load}
            className="p-2 text-gray-500 hover:text-gray-900"
            title="Refresh"
          >
            <RefreshCw size={16} />
          </button>
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
          Meta Ads isn&apos;t connected, so ad-spend and ROAS are empty. Connect
          it in{' '}
          <Link href="/settings" className="underline font-medium">
            Settings → Meta Ads
          </Link>
          . Sales figures below still work.
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
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="min-w-[1100px] w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-gray-500 bg-gray-50">
                <th rowSpan={2} className="px-2.5 py-2 text-left align-bottom">
                  Product
                </th>
                <th colSpan={4} className={cn('px-2.5 py-1.5 text-center', grp)}>
                  Today
                </th>
                <th colSpan={4} className={cn('px-2.5 py-1.5 text-center', grp)}>
                  Till Date (MTD)
                </th>
                <th colSpan={2} className={cn('px-2.5 py-1.5 text-center', grp)}>
                  Target
                </th>
                <th colSpan={2} className={cn('px-2.5 py-1.5 text-center', grp)}>
                  Achieved
                </th>
                <th colSpan={2} className={cn('px-2.5 py-1.5 text-center', grp)}>
                  Projection
                </th>
              </tr>
              <tr className="text-[10px] uppercase tracking-wide text-gray-500 bg-gray-50">
                <th className={cn(th, grp)}>Ad Spend</th>
                <th className={th}>Sales</th>
                <th className={th}>Units</th>
                <th className={th}>ROAS</th>
                <th className={cn(th, grp)}>Ad Spend</th>
                <th className={th}>Sales</th>
                <th className={th}>Avg Unit</th>
                <th className={th}>ROAS</th>
                <th className={cn(th, grp)}>Value</th>
                <th className={th}>Units</th>
                <th className={cn(th, grp)}>Value</th>
                <th className={th}>Units</th>
                <th className={cn(th, grp)}>Value</th>
                <th className={th}>Units</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr
                  key={r.product}
                  className={cn(
                    'hover:bg-gray-50',
                    r.unmapped && 'italic text-gray-400',
                  )}
                >
                  <td className="px-2.5 py-2 text-left font-medium border-t border-gray-100">
                    {r.unmapped ? 'Unmapped' : r.product}
                  </td>
                  <td className={cn(td, grp)}>{money(r.adSpendToday)}</td>
                  <td className={td}>{r.salesValueToday ? money(r.salesValueToday) : '—'}</td>
                  <td className={td}>{r.salesUnitsToday || '—'}</td>
                  <td className={cn(td, 'font-semibold', roasCls(r.roasToday))}>
                    {roas(r.roasToday)}
                  </td>
                  <td className={cn(td, grp)}>{money(r.adSpendMtd)}</td>
                  <td className={td}>{r.salesValueMtd ? money(r.salesValueMtd) : '—'}</td>
                  <td className={td}>{money(r.avgUnitValue)}</td>
                  <td className={cn(td, 'font-semibold', roasCls(r.roasMtd))}>
                    {roas(r.roasMtd)}
                  </td>
                  {/* Target */}
                  <td className={cn(td, grp)}>
                    {editing && !r.unmapped ? (
                      <input
                        type="number"
                        value={draft[r.product]?.value ?? 0}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            [r.product]: {
                              value: Number(e.target.value),
                              units: d[r.product]?.units ?? 0,
                            },
                          }))
                        }
                        className="w-24 border border-gray-300 rounded px-1.5 py-1 text-right"
                      />
                    ) : r.targetValue ? (
                      money(r.targetValue)
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className={td}>
                    {editing && !r.unmapped ? (
                      <input
                        type="number"
                        value={draft[r.product]?.units ?? 0}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            [r.product]: {
                              value: d[r.product]?.value ?? 0,
                              units: Number(e.target.value),
                            },
                          }))
                        }
                        className="w-16 border border-gray-300 rounded px-1.5 py-1 text-right"
                      />
                    ) : (
                      r.targetUnits || '—'
                    )}
                  </td>
                  {/* Achieved */}
                  <td className={cn(td, grp)}>
                    {r.achValuePct == null ? (
                      '—'
                    ) : (
                      <span
                        className={cn(
                          'inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold',
                          pctCls(r.achValuePct),
                        )}
                      >
                        {pct(r.achValuePct)}
                      </span>
                    )}
                  </td>
                  <td className={td}>
                    {r.achUnitsPct == null ? (
                      '—'
                    ) : (
                      <span
                        className={cn(
                          'inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold',
                          pctCls(r.achUnitsPct),
                        )}
                      >
                        {pct(r.achUnitsPct)}
                      </span>
                    )}
                  </td>
                  {/* Projection */}
                  <td className={cn(td, grp)}>
                    {r.salesValueMtd ? money(r.projectionValue) : '—'}
                  </td>
                  <td className={td}>
                    {r.salesUnitsMtd ? r.projectionUnits.toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold bg-gray-50 border-t-2 border-gray-200">
                <td className="px-2.5 py-2 text-left">All products</td>
                <td className={cn(td, grp)}>{money(data.totals.adSpendToday)}</td>
                <td className={td}>{money(data.totals.salesValueToday)}</td>
                <td className={td}>{data.totals.salesUnitsToday}</td>
                <td className={cn(td, roasCls(data.totals.roasToday))}>
                  {roas(data.totals.roasToday)}
                </td>
                <td className={cn(td, grp)}>{money(data.totals.adSpendMtd)}</td>
                <td className={td}>{money(data.totals.salesValueMtd)}</td>
                <td className={td}>—</td>
                <td className={cn(td, roasCls(data.totals.roasMtd))}>
                  {roas(data.totals.roasMtd)}
                </td>
                <td className={cn(td, grp)}>{money(data.totals.targetValue)}</td>
                <td className={td}>{data.totals.targetUnits || '—'}</td>
                <td className={cn(td, grp)}>—</td>
                <td className={td}>—</td>
                <td className={cn(td, grp)}>{money(data.totals.projectionValue)}</td>
                <td className={td}>{data.totals.projectionUnits.toLocaleString()}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <p className="mt-3 text-[11px] text-gray-400 leading-relaxed max-w-3xl">
        Ad spend is pulled daily from the Meta Marketing API and matched to
        products by campaign name (unmatched spend shows as &ldquo;Unmapped&rdquo;). Sales
        are net of cancelled and physically-returned orders, bucketed by order
        date. ROAS = Sales ÷ Ad Spend. Projection = month-to-date ÷ days elapsed
        × days in month.
      </p>
    </div>
  );
}
