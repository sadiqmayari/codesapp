'use client';

import { CalendarDays, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PERIOD_OPTIONS, type PeriodKey } from '@/lib/date-period';

/**
 * Shared filter controls (Search & filter conventions). Use these instead of
 * hand-styled chip rows so every list looks and behaves the same:
 *  - `StatusChips`   — single-select tab chips with optional counts.
 *  - `FilterSelect`  — a chip that opens a native <select> (dashed when unset).
 *  - `ActiveFilters` — removable pills for every active filter + "Clear all".
 *  - `DateRangeFilter` — tenant-clock period presets + custom from/to.
 */

export function StatusChips<V extends string>({
  options,
  value,
  onChange,
  className,
  'aria-label': ariaLabel = 'Filter by status',
}: {
  options: Array<{ value: V; label: string; count?: number | null }>;
  value: V;
  onChange: (v: V) => void;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)} role="group" aria-label={ariaLabel}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold transition-colors',
              on
                ? 'border-brand-600 bg-brand-600 text-white'
                : 'border-line bg-surface text-ink hover:bg-sunken',
            )}
          >
            {o.label}
            {o.count != null && (
              <span className={cn('tabular-nums font-medium', on ? 'text-white/80' : 'text-muted')}>
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function FilterSelect({
  icon: Icon,
  label,
  value,
  defaultValue = '',
  options,
  onChange,
  title,
}: {
  icon?: React.ElementType;
  label: string;
  value: string;
  defaultValue?: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
  title?: string;
}) {
  const set = value !== defaultValue;
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <span
      className={cn(
        'relative inline-flex h-8 shrink-0 items-center rounded-lg border text-[13px] font-semibold',
        set
          ? 'border-brand-200 bg-brand-50 text-brand-700'
          : 'border-dashed border-line text-ink hover:bg-sunken',
      )}
      title={title}
    >
      <span className="pointer-events-none flex items-center gap-1.5 pl-2.5 pr-2">
        {Icon && <Icon size={14} className={set ? 'text-brand-700' : 'text-muted'} />}
        <span className={set ? '' : 'text-muted'}>{label}</span>
        <span className="max-w-[160px] truncate font-bold">{current}</span>
        <ChevronDown size={13} className="opacity-60" />
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
    </span>
  );
}

export interface ActiveFilter {
  key: string;
  label: string;
  onRemove: () => void;
}

/** Removable pills for each active filter + Clear all. Renders nothing when empty. */
export function ActiveFilters({
  filters,
  onClearAll,
  className,
}: {
  filters: ActiveFilter[];
  onClearAll?: () => void;
  className?: string;
}) {
  if (!filters.length) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5 text-[13px]', className)}>
      {filters.map((f) => (
        <span
          key={f.key}
          className="inline-flex items-center gap-1 rounded-full border border-brand-100 bg-brand-50 py-0.5 pl-2.5 pr-1 font-semibold text-brand-700"
        >
          <span className="max-w-[220px] truncate">{f.label}</span>
          <button
            type="button"
            onClick={f.onRemove}
            className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-brand-100"
            aria-label={`Remove filter ${f.label}`}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      {onClearAll && filters.length > 1 && (
        <button
          type="button"
          onClick={onClearAll}
          className="ml-1 text-muted underline underline-offset-2 hover:text-ink"
        >
          Clear all
        </button>
      )}
    </div>
  );
}

/**
 * Period presets + custom range on the TENANT clock. Emits the period key and
 * the raw `YYYY-MM-DD` custom bounds; resolve to instants with
 * `periodRange()` / `zonedDayRange()` (lib/date-period, lib/utils).
 * Blocks from > to.
 */
export function DateRangeFilter({
  period,
  from,
  to,
  onChange,
  options = PERIOD_OPTIONS,
  label = 'Period',
}: {
  period: PeriodKey;
  from: string;
  to: string;
  onChange: (next: { period: PeriodKey; from: string; to: string }) => void;
  options?: { key: PeriodKey; label: string }[];
  label?: string;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <FilterSelect
        icon={CalendarDays}
        label={label}
        value={period}
        defaultValue={options[0]?.key ?? 'all'}
        options={options.map((o) => ({ value: o.key, label: o.label }))}
        onChange={(v) => onChange({ period: v as PeriodKey, from, to })}
      />
      {period === 'custom' && (
        <span className="inline-flex items-center gap-1 text-[13px]">
          <input
            type="date"
            aria-label="From date"
            value={from}
            max={to || undefined}
            onChange={(e) => onChange({ period, from: e.target.value, to })}
            className="h-8 rounded-lg border border-line bg-surface px-2 text-ink"
          />
          <span className="text-muted">–</span>
          <input
            type="date"
            aria-label="To date"
            value={to}
            min={from || undefined}
            onChange={(e) => onChange({ period, from, to: e.target.value })}
            className="h-8 rounded-lg border border-line bg-surface px-2 text-ink"
          />
        </span>
      )}
    </span>
  );
}
