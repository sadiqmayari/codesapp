'use client';

import { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AnimatedNumber } from '@/components/ui/animated-number';
import { PERIOD_OPTIONS, PeriodKey } from '@/lib/date-period';

/* ─────────────────────────── Pipeline lanes ─────────────────────────── */

export interface PipelineLane {
  key: string;
  label: string;
  value: number | null | undefined;
  sub?: string | null;
  /** Hex colour for the dot, number and active underline. */
  color: string;
  /** Small alert pill beside the label (e.g. "6 need advice"). */
  alert?: string | null;
}

/**
 * The board's primary navigation: the order lifecycle as one connected
 * pipeline (To book → In transit → Needs attention → Delivered) with live
 * counts. Clicking a lane loads it.
 */
export function PipelineLanes({
  lanes,
  activeKey,
  onSelect,
}: {
  lanes: PipelineLane[];
  activeKey: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Workload lanes"
      className="grid grid-cols-2 overflow-hidden rounded-2xl border border-line bg-surface shadow-sm lg:grid-cols-4"
    >
      {lanes.map((l, i) => {
        const active = activeKey === l.key;
        return (
          <button
            key={l.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(l.key)}
            className={cn(
              'relative flex min-w-0 flex-col gap-0.5 px-4 py-3 text-left transition-colors sm:px-5',
              'border-line [&:nth-child(odd)]:border-r lg:border-r lg:last:border-r-0',
              i < 2 && 'border-b lg:border-b-0',
              active ? 'bg-sunken' : 'hover:bg-sunken/60',
            )}
          >
            <span className="flex min-w-0 items-center gap-2 text-xs font-bold uppercase tracking-wide text-muted">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: l.color }} />
              <span className="truncate">{l.label}</span>
              {l.alert && (
                <span className="ml-auto hidden shrink-0 rounded-full bg-rose-50 px-2 py-px text-[10px] font-bold normal-case tracking-normal text-rose-700 sm:inline">
                  {l.alert}
                </span>
              )}
            </span>
            <span
              className="text-2xl font-extrabold leading-tight tracking-tight tabular-nums sm:text-[28px]"
              style={{ color: l.color }}
            >
              {l.value == null ? '—' : <AnimatedNumber value={l.value} />}
            </span>
            <span className="truncate text-xs text-muted">{l.sub ?? ' '}</span>
            <span
              aria-hidden
              className="absolute inset-x-0 bottom-0 h-[3px] transition-colors"
              style={{ background: active ? l.color : 'transparent' }}
            />
          </button>
        );
      })}
    </div>
  );
}

/* ─────────────────────────── Status chips ─────────────────────────── */

export interface StatusChip<K extends string> {
  key: K;
  label: string;
  count?: number | null;
  /** Highlight the count (something is waiting on the operator). */
  warn?: boolean;
}

/**
 * One row of chips for the statuses inside the active lane (replaces the old
 * refine <select>, which hid them). `records` render dashed at the end.
 */
export function StatusChips<K extends string>({
  chips,
  records,
  value,
  onChange,
}: {
  chips: StatusChip<K>[];
  records: StatusChip<K>[];
  value: K;
  onChange: (key: K) => void;
}) {
  const chip = (c: StatusChip<K>, dashed: boolean) => {
    const on = c.key === value;
    return (
      <button
        key={c.key}
        type="button"
        aria-pressed={on}
        onClick={() => onChange(c.key)}
        className={cn(
          'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] font-semibold transition-colors',
          on
            ? 'border-ink bg-ink text-surface'
            : cn(
                'bg-surface text-ink hover:bg-sunken',
                dashed ? 'border-dashed border-line text-muted' : 'border-line',
              ),
        )}
      >
        {c.label}
        {c.count != null && (
          <span
            className={cn(
              'text-xs font-bold tabular-nums',
              on ? 'text-surface/75' : c.warn && c.count > 0 ? 'text-amber-700' : 'text-muted',
            )}
          >
            {c.count.toLocaleString()}
          </span>
        )}
      </button>
    );
  };
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 sm:flex-wrap sm:overflow-visible">
      {chips.map((c) => chip(c, false))}
      {records.length > 0 && <span className="hidden flex-1 sm:block" />}
      {records.map((c) => chip(c, true))}
    </div>
  );
}

/* ─────────────────────────── Filter chips ─────────────────────────── */

/**
 * A filter rendered as a chip that shows its current value. A native <select>
 * sits invisibly on top (keyboard + mobile pickers for free); when the value
 * differs from `defaultValue` the chip turns brand-tinted and shows a clear ×.
 */
export function FilterChip({
  icon: Icon,
  label,
  value,
  defaultValue,
  options,
  onChange,
  title,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  defaultValue: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
  title?: string;
}) {
  const set = value !== defaultValue;
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <span
      className={cn(
        'relative inline-flex h-9 shrink-0 items-center rounded-lg border text-[13px] font-semibold',
        set
          ? 'border-brand-200 bg-brand-50 text-brand-700'
          : 'border-dashed border-line text-ink hover:bg-sunken',
      )}
      title={title}
    >
      <span className="pointer-events-none flex items-center gap-1.5 pl-2.5 pr-2">
        <Icon size={14} className={set ? 'text-brand-700' : 'text-muted'} />
        <span className={set ? '' : 'text-muted'}>{label}</span>
        <span className="max-w-[140px] truncate font-bold">{current}</span>
        {!set && <ChevronDown size={13} className="opacity-60" />}
      </span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {set && (
        <button
          type="button"
          onClick={() => onChange(defaultValue)}
          aria-label={`Clear ${label.toLowerCase()} filter`}
          className="relative z-10 mr-1 rounded p-0.5 hover:bg-brand-100"
        >
          <X size={13} />
        </button>
      )}
    </span>
  );
}

/**
 * The date filter as a chip + popover (presets and a custom range). Same
 * contract as `PeriodSelect`, so callers swap one for the other.
 */
export function PeriodChip({
  period,
  customFrom,
  customTo,
  onChange,
}: {
  period: PeriodKey;
  customFrom: string;
  customTo: string;
  onChange: (next: { period: PeriodKey; customFrom: string; customTo: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const set = period !== 'all';
  const label =
    period === 'custom'
      ? customFrom || customTo
        ? `${customFrom || '…'} → ${customTo || '…'}`
        : 'Custom'
      : PERIOD_OPTIONS.find((o) => o.key === period)?.label ?? 'All time';

  return (
    <span ref={ref} className="relative inline-flex shrink-0">
      <span
        className={cn(
          'inline-flex h-9 items-center rounded-lg border text-[13px] font-semibold',
          set
            ? 'border-brand-200 bg-brand-50 text-brand-700'
            : 'border-dashed border-line text-ink hover:bg-sunken',
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="flex h-full items-center gap-1.5 pl-2.5 pr-2"
        >
          <CalendarDays size={14} className={set ? 'text-brand-700' : 'text-muted'} />
          <span className={set ? '' : 'text-muted'}>Date</span>
          <span className="max-w-[180px] truncate font-bold">{label}</span>
          {!set && <ChevronDown size={13} className="opacity-60" />}
        </button>
        {set && (
          <button
            type="button"
            onClick={() => onChange({ period: 'all', customFrom: '', customTo: '' })}
            aria-label="Clear date filter"
            className="mr-1 rounded p-0.5 hover:bg-brand-100"
          >
            <X size={13} />
          </button>
        )}
      </span>
      {open && (
        <div
          role="dialog"
          aria-label="Date range"
          className="absolute left-0 top-full z-30 mt-1 w-64 rounded-xl border border-line bg-surface p-2 shadow-lg"
        >
          <div className="grid grid-cols-2 gap-1">
            {PERIOD_OPTIONS.map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => {
                  onChange({ period: o.key, customFrom, customTo });
                  if (o.key !== 'custom') setOpen(false);
                }}
                className={cn(
                  'rounded-lg px-2.5 py-1.5 text-left text-[13px] font-semibold',
                  period === o.key ? 'bg-brand-50 text-brand-700' : 'text-ink hover:bg-sunken',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
          {period === 'custom' && (
            <div className="mt-2 grid grid-cols-2 gap-1.5 border-t border-line pt-2">
              <label className="text-xs font-semibold text-muted">
                From
                <input
                  type="date"
                  value={customFrom}
                  max={customTo || undefined}
                  onChange={(e) => onChange({ period: 'custom', customFrom: e.target.value, customTo })}
                  className="mt-0.5 w-full rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink"
                />
              </label>
              <label className="text-xs font-semibold text-muted">
                To
                <input
                  type="date"
                  value={customTo}
                  min={customFrom || undefined}
                  onChange={(e) => onChange({ period: 'custom', customFrom, customTo: e.target.value })}
                  className="mt-0.5 w-full rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink"
                />
              </label>
            </div>
          )}
        </div>
      )}
    </span>
  );
}

/* ─────────────────────────── Shortcuts hint ─────────────────────────── */

const SHORTCUTS: Array<[string, string]> = [
  ['j / k', 'Move down / up'],
  ['Enter', 'Open the order'],
  ['x', 'Select the row'],
  ['b', 'Book the row'],
  ['/', 'Search'],
];

/** Keyboard shortcuts behind a "?" button (they used to sit inline in the toolbar). */
export function ShortcutsHint() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <span ref={ref} className="relative hidden shrink-0 md:inline-flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Keyboard shortcuts"
        aria-expanded={open}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-ink"
      >
        <kbd className="rounded border border-b-2 border-line bg-surface px-1.5 font-mono text-xs">?</kbd>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-60 rounded-xl border border-line bg-surface p-2 shadow-lg">
          <p className="px-2 pb-1 text-xs font-bold uppercase tracking-wide text-muted">Keyboard</p>
          {SHORTCUTS.map(([k, label]) => (
            <div key={k} className="flex items-center justify-between rounded-lg px-2 py-1.5 text-[13px] text-ink">
              {label}
              <kbd className="rounded border border-b-2 border-line bg-sunken px-1.5 font-mono text-xs text-muted">{k}</kbd>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
