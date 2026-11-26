'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, Sparkles, Star, Upload, X } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  COURIER_LABELS,
  COURIER_TYPES,
  bulkSetDefaultCourier,
  clearDefaultCourier,
  getCityCoverage,
  getCityPerformance,
  type CityCourierPerf,
  type CityCoverageRow,
  type CourierType,
} from '@/lib/couriers';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SideSheet } from '@/components/ui/side-sheet';
import { SkeletonRows } from '@/components/ui/skeleton';
import { CourierLogo, isCourierBrand } from '@/components/icons/brand-logo';
import { Callout, SettingsCard, inputCls } from './shared';

/** A courier needs at least this many settled parcels in a city to be ranked. */
const MIN_PARCELS = 30;
/** "Better courier available" = best beats the current default by ≥ 5 points. */
const BETTER_PTS = 0.05;
const PAGE = 50;

type Filter = 'all' | 'unmapped' | 'better' | 'none';
type Sort = 'orders' | 'value' | 'name' | 'rate';

interface Row {
  key: string;
  city: string;
  orders: number;
  value: number;
  defaultCourier: CourierType | null;
  serves: Set<CourierType>;
  perf: Map<CourierType, CityCourierPerf>;
  best: CourierType | null;
  gain: number;
  anyServes: boolean;
}

function rateTone(p: CityCourierPerf | undefined) {
  if (!p || p.rate == null || p.parcels < MIN_PARCELS) return 'few';
  if (p.rate >= 0.85) return 'good';
  if (p.rate >= 0.7) return 'mid';
  return 'bad';
}

function money(v: number): string {
  if (v >= 1e7) return `Rs ${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `Rs ${(v / 1e5).toFixed(1)} L`;
  if (v >= 1e3) return `Rs ${Math.round(v / 1e3)}K`;
  return `Rs ${Math.round(v)}`;
}

function csvCell(v: string | number): string {
  const s = String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Settings → Couriers → City → courier. A city × courier grid: each cell is
 * that courier's settled delivery rate in that city; click a cell to make it
 * the city's default. ★ = best pick (highest rate with ≥ MIN_PARCELS settled
 * parcels among couriers offered for booking). Writes go through the existing
 * bulk-default / clear-default endpoints.
 */
export function CityCourierGrid() {
  const toast = useToast();
  const [coverage, setCoverage] = useState<CityCoverageRow[] | null>(null);
  const [perfMap, setPerfMap] = useState<Map<string, { orders90d: number; value90d: number; couriers: CityCourierPerf[] }>>(new Map());
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('orders');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [cov, perf] = await Promise.all([getCityCoverage().catch(() => [] as CityCoverageRow[]), getCityPerformance().catch(() => null)]);
    setCoverage(cov);
    const m = new Map<string, { orders90d: number; value90d: number; couriers: CityCourierPerf[] }>();
    for (const c of perf?.cities ?? []) m.set(c.cityName, c);
    setPerfMap(m);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Couriers offered for booking (coverage marks them `active`). */
  const columns = useMemo<CourierType[]>(() => {
    const act = new Set<CourierType>();
    for (const r of coverage ?? []) for (const c of r.couriers) if (c.active) act.add(c.courierType);
    return COURIER_TYPES.filter((c) => act.has(c));
  }, [coverage]);

  const rows = useMemo<Row[]>(() => {
    return (coverage ?? []).map((r) => {
      const p = perfMap.get(r.cityName);
      const perf = new Map<CourierType, CityCourierPerf>();
      for (const c of p?.couriers ?? []) perf.set(c.courierType, c);
      const serves = new Set<CourierType>(r.couriers.filter((c) => c.serves && c.active).map((c) => c.courierType));
      let best: CourierType | null = null;
      let bestRate = -1;
      serves.forEach((c) => {
        const x = perf.get(c);
        if (x && x.rate != null && x.parcels >= MIN_PARCELS && x.rate > bestRate) {
          bestRate = x.rate;
          best = c;
        }
      });
      const def = r.defaultCourier;
      const dp = def ? perf.get(def) : undefined;
      const gain =
        best && def && best !== def && dp && dp.rate != null && dp.parcels >= MIN_PARCELS ? bestRate - dp.rate : 0;
      return {
        key: r.cityName,
        city: r.city,
        orders: p?.orders90d ?? 0,
        value: p?.value90d ?? 0,
        defaultCourier: def,
        serves,
        perf,
        best,
        gain,
        anyServes: serves.size > 0,
      };
    });
  }, [coverage, perfMap]);

  const stats = useMemo(() => {
    const unmapped = rows.filter((r) => !r.defaultCourier && r.anyServes);
    const better = rows.filter((r) => r.gain >= BETTER_PTS);
    const none = rows.filter((r) => !r.anyServes);
    const mapped = rows.filter((r) => r.defaultCourier).length;
    // Extra delivered orders / month if every "better" city switched.
    const lift = better.reduce((s, r) => s + (r.orders / 3) * r.gain, 0);
    return {
      unmapped: unmapped.length,
      unmappedValue: unmapped.reduce((s, r) => s + r.value, 0),
      better: better.length,
      lift: Math.round(lift),
      none: none.length,
      mapped,
      total: rows.length,
      fixable: rows.filter((r) => r.best && (!r.defaultCourier || r.gain >= BETTER_PTS)),
    };
  }, [rows]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (needle && !r.city.toLowerCase().includes(needle)) return false;
      if (filter === 'unmapped') return !r.defaultCourier && r.anyServes;
      if (filter === 'better') return r.gain >= BETTER_PTS;
      if (filter === 'none') return !r.anyServes;
      return true;
    });
    const defRate = (r: Row) => (r.defaultCourier ? r.perf.get(r.defaultCourier)?.rate ?? 1 : 0);
    list.sort((a, b) => {
      if (sort === 'name') return a.city.localeCompare(b.city);
      if (sort === 'value') return b.value - a.value;
      if (sort === 'rate') return defRate(a) - defRate(b);
      return b.orders - a.orders || a.city.localeCompare(b.city);
    });
    return list;
  }, [rows, filter, sort, q]);

  useEffect(() => setPage(0), [filter, sort, q]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const pageRows = shown.slice(page * PAGE, page * PAGE + PAGE);

  /* ---------- writes ---------- */
  const assign = async (byCourier: Map<CourierType, string[]>, msg?: string) => {
    setBusy(true);
    let set = 0;
    const skipped: string[] = [];
    try {
      for (const [c, cities] of Array.from(byCourier.entries())) {
        if (!cities.length) continue;
        const r = await bulkSetDefaultCourier(c, cities);
        set += r.set;
        skipped.push(...r.skipped);
      }
      toast.success(
        (msg ?? `Default set for ${set} cit${set === 1 ? 'y' : 'ies'}`) +
          (skipped.length ? ` · ${skipped.length} skipped (courier doesn’t deliver there)` : ''),
      );
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Couldn’t update the default courier');
    } finally {
      setBusy(false);
    }
  };

  const setOne = (r: Row, c: CourierType) => {
    if (r.defaultCourier === c || busy) return;
    // Optimistic: the grid updates instantly, then reloads.
    setCoverage((cov) => cov?.map((x) => (x.cityName === r.key ? { ...x, defaultCourier: c } : x)) ?? cov);
    assign(new Map([[c, [r.key]]]), `${COURIER_LABELS[c]} is now the default for ${r.city}`);
  };

  const selectedRows = rows.filter((r) => sel.has(r.key));
  const bulkSet = async (c: CourierType) => {
    await assign(new Map([[c, selectedRows.map((r) => r.key)]]));
    setSel(new Set());
  };
  const bulkBest = async () => {
    const m = new Map<CourierType, string[]>();
    for (const r of selectedRows) if (r.best) m.set(r.best, [...(m.get(r.best) ?? []), r.key]);
    await assign(m, 'Best courier applied');
    setSel(new Set());
  };
  const bulkClear = async () => {
    setBusy(true);
    try {
      const r = await clearDefaultCourier(selectedRows.map((x) => x.key));
      toast.success(`Default cleared for ${r.cleared} cit${r.cleared === 1 ? 'y' : 'ies'}`);
      setSel(new Set());
      await load();
    } catch {
      toast.error('Clear failed');
    } finally {
      setBusy(false);
    }
  };

  /* ---------- CSV ---------- */
  const exportCsv = () => {
    const head = ['City', 'Orders (90d)', 'Order value (90d)', 'Default courier', 'Best pick', ...columns.map((c) => `${COURIER_LABELS[c]} delivered %`)];
    const lines = [head.map(csvCell).join(',')];
    for (const r of shown) {
      lines.push(
        [
          r.city,
          r.orders,
          r.value,
          r.defaultCourier ? COURIER_LABELS[r.defaultCourier] : '',
          r.best ? COURIER_LABELS[r.best] : '',
          ...columns.map((c) => {
            const p = r.perf.get(c);
            if (!r.serves.has(c)) return 'n/a';
            return p && p.rate != null ? `${Math.round(p.rate * 100)}% (${p.parcels})` : '';
          }),
        ]
          .map(csvCell)
          .join(','),
      );
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'city-courier-mapping.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const importCsv = async (file: File) => {
    const text = (await file.text()).replace(/^﻿/, '');
    const byName = new Map<string, CourierType>();
    for (const c of COURIER_TYPES) {
      byName.set(c.toLowerCase(), c);
      byName.set(COURIER_LABELS[c].toLowerCase(), c);
    }
    const m = new Map<CourierType, string[]>();
    let bad = 0;
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const cells = raw.split(/[,;\t]/).map((s) => s.trim().replace(/^"|"$/g, ''));
      const city = cells[0]?.toLowerCase();
      // Accept "city,courier" or this grid's own export (default in column 4).
      const courierText = (cells.length >= 4 ? cells[3] : cells[1])?.toLowerCase();
      if (!city || city === 'city') continue;
      const c = courierText ? byName.get(courierText) : undefined;
      if (!c) {
        if (courierText) bad++;
        continue;
      }
      m.set(c, [...(m.get(c) ?? []), city]);
    }
    if (m.size === 0) {
      toast.error('No “city, courier” rows found in that file');
      return;
    }
    await assign(m, 'Import applied');
    if (bad) toast.info(`${bad} row${bad === 1 ? '' : 's'} had an unknown courier name and were skipped`);
  };

  /* ---------- render ---------- */
  if (coverage === null) {
    return (
      <SettingsCard title="City → courier">
        <SkeletonRows rows={6} />
      </SettingsCard>
    );
  }
  if (rows.length === 0) {
    return (
      <SettingsCard
        title="City → courier"
        description="Pick a default courier for each city your orders go to. Cities appear here once orders arrive."
      />
    );
  }

  const allOnPage = pageRows.length > 0 && pageRows.every((r) => sel.has(r.key));
  const tiles: Array<{ f?: Filter; label: string; value: string; sub: string; tone: string }> = [
    { f: 'unmapped', label: 'Unmapped cities', value: String(stats.unmapped), sub: `${money(stats.unmappedValue)} of orders · 90d`, tone: 'text-ink' },
    { f: 'better', label: 'Better courier available', value: String(stats.better), sub: stats.lift ? `≈ +${stats.lift} delivered orders / month` : 'Switch to the ★ courier', tone: 'text-amber-600' },
    { f: 'none', label: 'No courier delivers', value: String(stats.none), sub: 'Connect a courier that serves them', tone: 'text-red-600' },
    { label: 'Mapped', value: `${stats.mapped} / ${stats.total}`, sub: `${stats.total ? Math.round((stats.mapped / stats.total) * 100) : 0}% of cities`, tone: 'text-brand-700 dark:text-brand-300' },
  ];

  return (
    <SettingsCard
      flush
      title="City → courier"
      description="Each cell is how that courier delivered in that city (settled parcels, 3 weeks – 6 months old). Click a cell to make it the city’s default."
      action={
        <>
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
            <Upload size={13} /> Import CSV
          </Button>
          <Button variant="secondary" size="sm" onClick={exportCsv}>
            <Download size={13} /> Export CSV
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) importCsv(f);
            }}
          />
        </>
      }
    >
      <div className="flex flex-col gap-3.5 px-5 py-4">
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          {tiles.map((t) => (
            <button
              key={t.label}
              type="button"
              disabled={!t.f}
              onClick={() => t.f && setFilter(filter === t.f ? 'all' : t.f)}
              aria-pressed={t.f ? filter === t.f : undefined}
              className={cn(
                'flex flex-col gap-0.5 rounded-xl border px-3 py-2.5 text-left disabled:cursor-default',
                t.f && 'hover:border-brand-400',
                t.f && filter === t.f ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/30' : 'border-line',
              )}
            >
              <span className="text-xs font-semibold text-muted">{t.label}</span>
              <span className={cn('text-xl font-extrabold tabular-nums', t.tone)}>{t.value}</span>
              <span className="text-xs text-muted">{t.sub}</span>
            </button>
          ))}
        </div>

        {stats.fixable.length > 0 && (
          <Callout
            tone="brand"
            icon={<Star size={15} className="fill-amber-400 text-amber-500" />}
            action={
              <Button size="sm" onClick={() => setReview(true)}>
                Review &amp; apply
              </Button>
            }
          >
            <b>Best pick ready for {stats.fixable.length} cit{stats.fixable.length === 1 ? 'y' : 'ies'}.</b> We choose the
            courier with the highest delivery rate that has at least {MIN_PARCELS} settled parcels there.
          </Callout>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1 rounded-xl border border-line bg-sunken p-1" role="group" aria-label="Filter cities">
            {(
              [
                ['all', 'All'],
                ['unmapped', 'Unmapped'],
                ['better', 'Better available'],
                ['none', 'No courier'],
              ] as Array<[Filter, string]>
            ).map(([f, label]) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-[13px] font-semibold',
                  filter === f ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search city…"
            aria-label="Search city"
            className={cn(inputCls, 'ml-auto w-full sm:w-48')}
          />
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort cities" className={cn(inputCls, 'w-auto')}>
            <option value="orders">Most orders</option>
            <option value="value">Most order value</option>
            <option value="name">City A–Z</option>
            <option value="rate">Lowest delivery rate</option>
          </select>
        </div>
      </div>

      <div className="overflow-x-auto border-t border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs font-bold text-muted">
              <th className="w-10 px-4 py-2.5">
                <input
                  type="checkbox"
                  aria-label="Select all on this page"
                  checked={allOnPage}
                  onChange={(e) =>
                    setSel((s) => {
                      const n = new Set(s);
                      pageRows.forEach((r) => (e.target.checked ? n.add(r.key) : n.delete(r.key)));
                      return n;
                    })
                  }
                  className="accent-brand-600"
                />
              </th>
              <th className="px-2 py-2.5">City</th>
              <th className="px-2 py-2.5 text-right">Orders · 90d</th>
              {columns.map((c) => (
                <th key={c} className="px-1.5 py-2 text-center">
                  {isCourierBrand(c) ? (
                    <CourierLogo courier={c} size="xs" className="mx-auto" />
                  ) : (
                    COURIER_LABELS[c]
                  )}
                  <span className="mt-1 block text-[11px] font-semibold">{COURIER_LABELS[c]}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={3 + columns.length} className="px-4 py-10 text-center text-sm text-muted">
                  No cities match this filter.
                </td>
              </tr>
            ) : (
              pageRows.map((r) => (
                <tr key={r.key} className="border-b border-line last:border-b-0">
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.city}`}
                      checked={sel.has(r.key)}
                      onChange={(e) =>
                        setSel((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(r.key);
                          else n.delete(r.key);
                          return n;
                        })
                      }
                      className="accent-brand-600"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <div className="font-semibold capitalize text-ink">{r.city}</div>
                    <div className="text-xs text-muted">{r.value ? money(r.value) : '—'}</div>
                    {!r.anyServes ? (
                      <span className="mt-1 inline-block rounded-full bg-red-50 px-2 py-0.5 text-xs font-bold text-red-700 dark:bg-red-900/30 dark:text-red-300">
                        No courier delivers here
                      </span>
                    ) : !r.defaultCourier ? (
                      <span className="mt-1 inline-block rounded-full bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                        No default
                      </span>
                    ) : r.gain >= BETTER_PTS && r.best ? (
                      <button
                        type="button"
                        onClick={() => setOne(r, r.best!)}
                        className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-700 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-300"
                      >
                        Switch to {COURIER_LABELS[r.best]} · +{Math.round(r.gain * 100)}% delivered
                      </button>
                    ) : null}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-ink">{r.orders.toLocaleString()}</td>
                  {columns.map((c) => {
                    const served = r.serves.has(c);
                    const p = r.perf.get(c);
                    const isDef = r.defaultCourier === c;
                    if (!served) {
                      return (
                        <td key={c} className="px-1.5 py-1.5">
                          <span
                            title={`${COURIER_LABELS[c]} doesn’t deliver to ${r.city}`}
                            className="flex h-[58px] min-w-[84px] flex-col items-center justify-center rounded-xl border border-line text-[11px] text-muted [background:repeating-linear-gradient(135deg,rgb(var(--sunken))_0_6px,transparent_6px_12px)]"
                          >
                            doesn’t
                            <br />
                            deliver
                          </span>
                        </td>
                      );
                    }
                    const tone = rateTone(p);
                    const few = tone === 'few';
                    return (
                      <td key={c} className="px-1.5 py-1.5">
                        <button
                          type="button"
                          onClick={() => setOne(r, c)}
                          aria-pressed={isDef}
                          aria-label={`Make ${COURIER_LABELS[c]} the default for ${r.city}${p?.rate != null ? ` (${Math.round(p.rate * 100)}% delivered)` : ''}`}
                          title={
                            p && p.parcels
                              ? `${p.parcels} settled parcels · ${Math.round((p.rate ?? 0) * 100)}% delivered · ${p.returned} returned${few ? ' · too few to rank' : ''}`
                              : 'No settled parcels yet'
                          }
                          className={cn(
                            'relative flex h-[58px] w-full min-w-[84px] flex-col items-center justify-center rounded-xl border bg-surface tabular-nums transition-colors hover:border-brand-500',
                            isDef ? 'border-2 border-brand-600 bg-brand-50 dark:bg-brand-900/30' : 'border-line',
                          )}
                        >
                          {r.best === c && <Star size={11} className="absolute left-1.5 top-1.5 fill-amber-400 text-amber-500" aria-label="Best pick" />}
                          {isDef && (
                            <span className="absolute -right-1.5 -top-1.5 grid h-[18px] w-[18px] place-items-center rounded-full bg-brand-600 text-white">
                              <Check size={11} strokeWidth={3} />
                            </span>
                          )}
                          <span
                            className={cn(
                              'text-sm font-extrabold',
                              tone === 'good' && 'text-brand-700 dark:text-brand-300',
                              tone === 'mid' && 'text-amber-600',
                              tone === 'bad' && 'text-red-600',
                              few && 'text-muted',
                            )}
                          >
                            {few || p?.rate == null ? '—' : `${Math.round(p.rate * 100)}%`}
                          </span>
                          <span className="text-[11px] text-muted">{p?.parcels ? `${p.parcels} parcels` : 'no data'}</span>
                          <span
                            className={cn(
                              'mt-1 h-[3px] w-3/5 rounded-full',
                              tone === 'good' && 'bg-brand-500',
                              tone === 'mid' && 'bg-amber-500',
                              tone === 'bad' && 'bg-red-500',
                              few && 'bg-line',
                            )}
                          />
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-5 py-3 text-xs text-muted">
        <span className="inline-flex flex-wrap items-center gap-2">
          <i className="h-2.5 w-2.5 rounded-sm bg-brand-500" /> ≥ 85%
          <i className="h-2.5 w-2.5 rounded-sm bg-amber-500" /> 70–84%
          <i className="h-2.5 w-2.5 rounded-sm bg-red-500" /> &lt; 70%
          <i className="h-2.5 w-2.5 rounded-sm bg-line" /> fewer than {MIN_PARCELS} parcels
          <Star size={11} className="fill-amber-400 text-amber-500" /> best pick
        </span>
        <span className="ml-auto tabular-nums">
          {shown.length ? `${page * PAGE + 1}–${Math.min(shown.length, (page + 1) * PAGE)} of ${shown.length}` : '0'} cities
        </span>
        <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
          ‹
        </Button>
        <Button variant="secondary" size="sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
          ›
        </Button>
      </div>

      {/* Bulk bar */}
      <div
        role="status"
        aria-hidden={sel.size === 0}
        className={cn(
          'fixed bottom-20 left-1/2 z-30 flex max-w-[calc(100%-24px)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-2xl bg-gray-900 py-2 pl-4 pr-2 text-sm text-gray-100 shadow-2xl transition-all md:bottom-6',
          sel.size ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-6 opacity-0',
        )}
      >
        <b className="tabular-nums">
          {sel.size} cit{sel.size === 1 ? 'y' : 'ies'}
        </b>
        <span className="text-gray-400">Set default:</span>
        {columns.map((c) => (
          <button
            key={c}
            type="button"
            disabled={busy}
            onClick={() => bulkSet(c)}
            className="h-8 rounded-lg border border-gray-700 px-2.5 text-xs font-semibold hover:bg-gray-800 disabled:opacity-50"
          >
            {COURIER_LABELS[c]}
          </button>
        ))}
        <button type="button" disabled={busy} onClick={bulkBest} className="inline-flex h-8 items-center gap-1 rounded-lg bg-brand-600 px-2.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
          <Sparkles size={12} /> Best pick
        </button>
        <button type="button" disabled={busy} onClick={bulkClear} className="h-8 rounded-lg border border-gray-700 px-2.5 text-xs font-semibold hover:bg-gray-800 disabled:opacity-50">
          Clear default
        </button>
        <button type="button" onClick={() => setSel(new Set())} aria-label="Clear selection" className="grid h-8 w-8 place-items-center rounded-lg hover:bg-gray-800">
          <X size={14} />
        </button>
      </div>

      <ApplyBestSheet
        open={review}
        rows={stats.fixable}
        lift={stats.lift}
        busy={busy}
        onClose={() => setReview(false)}
        onApply={async (picked) => {
          const m = new Map<CourierType, string[]>();
          for (const r of picked) if (r.best) m.set(r.best, [...(m.get(r.best) ?? []), r.key]);
          await assign(m, `Best courier applied to ${picked.length} cit${picked.length === 1 ? 'y' : 'ies'}`);
          setReview(false);
        }}
      />
    </SettingsCard>
  );
}

function ApplyBestSheet({
  open,
  rows,
  lift,
  busy,
  onClose,
  onApply,
}: {
  open: boolean;
  rows: Row[];
  lift: number;
  busy: boolean;
  onClose: () => void;
  onApply: (picked: Row[]) => Promise<void>;
}) {
  const [skip, setSkip] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (open) setSkip(new Set());
  }, [open]);
  const picked = rows.filter((r) => !skip.has(r.key));
  const pct = (r: Row, c: CourierType | null) => {
    const p = c ? r.perf.get(c) : undefined;
    return p?.rate != null ? `${Math.round(p.rate * 100)}%` : '';
  };

  return (
    <SideSheet
      open={open}
      onClose={onClose}
      width="lg"
      icon={
        <span className="grid h-12 w-12 place-items-center rounded-xl bg-amber-50 text-amber-500 dark:bg-amber-900/30">
          <Star size={22} className="fill-amber-400" />
        </span>
      }
      title="Apply best courier"
      subtitle={<span className="text-[13px] text-muted">{rows.length} cities · untick any you want to keep as they are</span>}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={picked.length === 0} onClick={() => onApply(picked)}>
            Apply to {picked.length} cit{picked.length === 1 ? 'y' : 'ies'}
          </Button>
        </>
      }
    >
      <p className="text-[13px] text-muted">
        Each city gets the courier with the best delivery rate there (at least {MIN_PARCELS} settled parcels). Parcels
        already booked are not touched.
      </p>
      <ul className="flex flex-col divide-y divide-line">
        {rows.map((r) => (
          <li key={r.key}>
            <label className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
              <input
                type="checkbox"
                checked={!skip.has(r.key)}
                onChange={(e) =>
                  setSkip((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.delete(r.key);
                    else n.add(r.key);
                    return n;
                  })
                }
                className="accent-brand-600"
              />
              <span className="min-w-[140px] flex-1">
                <span className="font-semibold capitalize text-ink">{r.city}</span>{' '}
                <span className="text-xs text-muted">· {r.orders.toLocaleString()} orders</span>
              </span>
              <span className="text-[13px] text-muted">
                {r.defaultCourier ? (
                  <s>
                    {COURIER_LABELS[r.defaultCourier]} {pct(r, r.defaultCourier)}
                  </s>
                ) : (
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">none</span>
                )}
              </span>
              <span className="text-muted">→</span>
              <span className="font-bold text-brand-700 dark:text-brand-300">
                {r.best ? `${COURIER_LABELS[r.best]} ${pct(r, r.best)}` : ''}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {lift > 0 && (
        <Callout tone="brand">
          <b>Expected: about +{lift} more delivered orders a month</b> from the under-performing cities, at your current
          order volume.
        </Callout>
      )}
    </SideSheet>
  );
}
