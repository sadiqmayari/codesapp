'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Info } from 'lucide-react';
import { ApiError, isAbortError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { count, fullMoney, money, pct, ratio, type NumberMode } from '@/lib/format-number';
import type { GrowthQuery, MetricDef } from '@/lib/growth';
import { useGrowth } from './growth-filters';

/** Fetch with abort + stale guard, re-run on filter change and on live updates. */
export function useGrowthData<T>(fetcher: (q: GrowthQuery, signal: AbortSignal) => Promise<T>, extraKey = '') {
  const { query, version } = useGrowth();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const queryRef = useRef(query);
  queryRef.current = query;
  const key = `${JSON.stringify(query)}|${extraKey}`;
  const lastKey = useRef('');

  useEffect(() => {
    const ctrl = new AbortController();
    // Live refreshes keep the current view on screen (no skeleton flash).
    if (lastKey.current !== key) setLoading(true);
    lastKey.current = key;
    fetchRef
      .current(queryRef.current, ctrl.signal)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (isAbortError(e)) return;
        setError(e instanceof ApiError ? e.userMessage : 'Could not load this view.');
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [key, version]);

  return { data, loading, error };
}

export function fmtMetric(v: number | null | undefined, unit: MetricDef['unit'], cur: string | null, mode: NumberMode) {
  switch (unit) {
    case 'money':
      return money(v, cur, mode);
    case 'ratio':
      return ratio(v);
    case 'pct':
      return pct(v);
    case 'days':
      return v == null ? '—' : `${Math.round(v)} d`;
    default:
      return count(v, mode);
  }
}

/** Info popover: formula + plain-English definition from the metric catalogue. */
export function MetricInfo({ def }: { def?: MetricDef }) {
  if (!def) return null;
  return (
    <span className="group relative inline-flex" onClick={(e) => e.stopPropagation()}>
      <button type="button" aria-label={`How ${def.label} is calculated`} className="rounded-full text-muted hover:text-ink focus-visible:text-ink">
        <Info size={13} />
      </button>
      <span role="tooltip" className="pointer-events-none invisible absolute right-0 top-5 z-30 w-64 rounded-lg bg-gray-900 p-2.5 text-left text-xs font-normal leading-relaxed text-white opacity-0 shadow-xl transition group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
        {def.description}
        <span className="mt-1.5 block font-mono text-[11px] text-white/70">{def.formula}</span>
      </span>
    </span>
  );
}

function Spark({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <div className="h-8" />;
  const w = 160;
  const h = 32;
  const mn = Math.min(...values);
  const mx = Math.max(...values);
  const r = mx - mn || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 3 - ((v - mn) / r) * (h - 8)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const id = `sp${color.replace(/\W/g, '')}${values.length}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="mt-1 h-8 w-full" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity={0.28} />
          <stop offset="1" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${d} L${w} ${h} L0 ${h} Z`} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r={2.6} fill={color} />
    </svg>
  );
}

export function KpiCard({
  def,
  value,
  prev,
  cur,
  mode,
  spark,
  color = '#16a34a',
  active,
  onClick,
  compareLabel,
}: {
  def?: MetricDef;
  value: number | null;
  prev: number | null;
  cur: string | null;
  mode: NumberMode;
  spark?: number[];
  color?: string;
  active?: boolean;
  onClick?: () => void;
  compareLabel?: string | null;
}) {
  const delta = value != null && prev != null && prev !== 0 ? ((value - prev) / Math.abs(prev)) * 100 : null;
  const good = delta == null ? null : def?.higherIsBetter === false ? delta < 0 : delta > 0;
  const text = fmtMetric(value, def?.unit ?? 'count', cur, mode);
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => onClick && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick())}
      className={cn(
        'relative min-w-0 rounded-xl border bg-surface px-3.5 pb-2 pt-3 text-left shadow-sm transition',
        onClick && 'cursor-pointer hover:border-brand-300',
        active ? 'border-brand-500 ring-1 ring-brand-500' : 'border-line',
      )}
    >
      <div className="flex items-center justify-between gap-2 text-xs font-semibold text-muted">
        <span className="truncate">{def?.label ?? '—'}</span>
        <MetricInfo def={def} />
      </div>
      <div className="mt-1 truncate text-[22px] font-extrabold leading-tight tracking-tight text-ink tabular-nums" title={def?.unit === 'money' ? fullMoney(value, cur) : undefined}>
        {text}
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-2 text-xs">
        {delta != null && compareLabel ? (
          <span className={cn('inline-flex items-center gap-0.5 font-bold tabular-nums', good ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
            {delta >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
            {Math.abs(delta).toFixed(1)}%
          </span>
        ) : (
          <span className="text-muted">&nbsp;</span>
        )}
        {compareLabel && delta != null && <span className="truncate text-muted">vs {compareLabel}</span>}
      </div>
      {spark && <Spark values={spark} color={color} />}
    </div>
  );
}

export function Panel({
  title,
  hint,
  action,
  children,
  className,
}: {
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('min-w-0 rounded-xl border border-line bg-surface shadow-sm', className)}>
      <header className="flex flex-wrap items-start justify-between gap-2 px-4 pb-1 pt-3.5">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-ink">{title}</h3>
          {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
        </div>
        {action}
      </header>
      <div className="px-3 pb-3 sm:px-4">{children}</div>
    </section>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{message}</div>;
}

export const COMPARE_LABEL = { prev: 'prev. period', yoy: 'last year', none: null } as const;
