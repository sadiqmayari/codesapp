'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Rows3, Rows4, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SkeletonRows } from './skeleton';
import { EmptyState } from './empty-state';

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  render: (row: T) => React.ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Tailwind width/min-width classes for the column. */
  className?: string;
  /** Client-side sort value. Omit = not sortable. */
  sortValue?: (row: T) => string | number | null | undefined;
  /** Server-side sortable (with `onSortChange`); the key is sent to the caller. */
  sortable?: boolean;
}

export type SortState = { key: string; dir: 'asc' | 'desc' } | null;

type Density = 'comfortable' | 'compact';
const DENSITY_KEY = 'ca_table_density';

/**
 * Shared data table (UI Phase C): sticky header, comfortable/compact density
 * (remembered per device), optional client-side column sort, skeleton +
 * empty states, row click, and optional row selection with a floating bulk
 * action bar. Server-side paging/sorting stays the caller's job — pass the
 * rows you want shown.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  loading = false,
  empty,
  onRowClick,
  selectable = false,
  bulkActions,
  toolbar,
  emptyNode,
  className,
  maxHeight = '70vh',
  selectedKeys,
  onSelectedKeysChange,
  sortState,
  onSortChange,
  rowLabel,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string | number;
  loading?: boolean;
  empty?: { icon?: React.ElementType; title: string; description?: React.ReactNode; action?: React.ReactNode };
  /** Replaces the default empty state (e.g. `<NoResults>` when a filter is active). */
  emptyNode?: React.ReactNode;
  onRowClick?: (row: T) => void;
  selectable?: boolean;
  /** Rendered in the floating bar when ≥1 row is selected. */
  bulkActions?: (selected: T[], clear: () => void) => React.ReactNode;
  /** Extra controls rendered left of the density toggle. */
  toolbar?: React.ReactNode;
  className?: string;
  maxHeight?: string;
  /** Controlled selection (optional) — lets the caller offer "select all matching". */
  selectedKeys?: Set<string | number>;
  onSelectedKeysChange?: (next: Set<string | number>) => void;
  /** Server-side sort (optional): when `onSortChange` is set rows are NOT re-sorted locally. */
  sortState?: SortState;
  onSortChange?: (next: SortState) => void;
  /** Accessible name for a row's checkbox, e.g. the contact name. */
  rowLabel?: (row: T) => string;
}) {
  const [density, setDensity] = useState<Density>('comfortable');
  const [localSort, setLocalSort] = useState<SortState>(null);
  const [localSelected, setLocalSelected] = useState<Set<string | number>>(new Set());
  const serverSort = !!onSortChange;
  const sort = serverSort ? sortState ?? null : localSort;
  const setSort = (next: SortState) => (serverSort ? onSortChange!(next) : setLocalSort(next));
  const selected = selectedKeys ?? localSelected;
  const setSelected = (
    next: Set<string | number> | ((cur: Set<string | number>) => Set<string | number>),
  ) => {
    const value = typeof next === 'function' ? next(selected) : next;
    if (onSelectedKeysChange) onSelectedKeysChange(value);
    else setLocalSelected(value);
  };

  useEffect(() => {
    try {
      if (localStorage.getItem(DENSITY_KEY) === 'compact') setDensity('compact');
    } catch {
      /* ignore */
    }
  }, []);
  const toggleDensity = () =>
    setDensity((d) => {
      const n = d === 'compact' ? 'comfortable' : 'compact';
      try {
        localStorage.setItem(DENSITY_KEY, n);
      } catch {
        /* ignore */
      }
      return n;
    });

  // Drop selections that disappeared from the current rows (uncontrolled only —
  // a controlled caller owns its selection, e.g. across pages).
  useEffect(() => {
    if (selectedKeys) return;
    setLocalSelected((cur) => {
      if (cur.size === 0) return cur;
      const live = new Set(rows.map(rowKey));
      const next = new Set(Array.from(cur).filter((k) => live.has(k)));
      return next.size === cur.size ? cur : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, rowKey]);

  const shown = useMemo(() => {
    if (!sort || serverSort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const sv = col.sortValue;
    return [...rows].sort((a, b) => {
      const x = sv(a);
      const y = sv(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      // Strings: case-insensitive, locale + numeric aware ("#2" < "#10").
      const c =
        typeof x === 'string' && typeof y === 'string'
          ? x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' })
          : x < y
            ? -1
            : x > y
              ? 1
              : 0;
      return sort.dir === 'asc' ? c : -c;
    });
  }, [rows, columns, sort, serverSort]);

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(rowKey(r)));
  const someSelected = rows.some((r) => selected.has(rowKey(r)));
  const clear = () => setSelected(new Set());
  const selectedRows = rows.filter((r) => selected.has(rowKey(r)));
  const cell = density === 'compact' ? 'px-3 py-1.5' : 'px-4 py-3';
  const align = (a?: Column<T>['align']) =>
    a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left';

  return (
    <div className={cn('relative bg-white border border-gray-200 rounded-xl overflow-hidden', className)}>
      <div className="flex items-center justify-end gap-2 px-3 py-2 border-b border-gray-100">
        {toolbar}
        <button
          type="button"
          onClick={toggleDensity}
          className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs font-semibold text-gray-500 hover:bg-gray-100"
          title="Row density"
        >
          {density === 'compact' ? <Rows4 size={14} /> : <Rows3 size={14} />}
          {density === 'compact' ? 'Compact' : 'Comfortable'}
        </button>
      </div>

      {loading ? (
        <SkeletonRows rows={6} />
      ) : rows.length === 0 ? (
        emptyNode ?? <EmptyState
          compact
          icon={empty?.icon}
          title={empty?.title ?? 'Nothing here yet'}
          description={empty?.description}
          action={empty?.action}
        />
      ) : (
        <div className="overflow-auto" style={{ maxHeight }}>
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-[1] bg-gray-50">
              <tr className="text-gray-500 border-b border-gray-200">
                {selectable && (
                  <th className={cn(cell, 'w-10')}>
                    <input
                      type="checkbox"
                      aria-label="Select all rows"
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someSelected && !allSelected;
                      }}
                      onChange={() => {
                        const n = new Set(selected);
                        for (const r of rows) {
                          if (allSelected) n.delete(rowKey(r));
                          else n.add(rowKey(r));
                        }
                        setSelected(n);
                      }}
                      className="rounded border-gray-300 accent-brand-600"
                    />
                  </th>
                )}
                {columns.map((c) => {
                  const active = sort?.key === c.key;
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                      className={cn(cell, 'font-semibold text-xs uppercase tracking-wide', align(c.align), c.className)}
                    >
                      {c.sortValue || (serverSort && c.sortable) ? (
                        <button
                          type="button"
                          onClick={() =>
                            setSort(
                              !active
                                ? { key: c.key, dir: 'asc' }
                                : sort!.dir === 'asc'
                                  ? { key: c.key, dir: 'desc' }
                                  : null,
                            )
                          }
                          className={cn(
                            'inline-flex items-center gap-1 hover:text-gray-900',
                            active && 'text-gray-900',
                          )}
                        >
                          {c.header}
                          {active &&
                            (sort!.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                        </button>
                      ) : (
                        c.header
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const k = rowKey(r);
                const isSel = selected.has(k);
                return (
                  <tr
                    key={k}
                    onClick={onRowClick ? () => onRowClick(r) : undefined}
                    className={cn(
                      'border-b border-gray-100 last:border-0',
                      onRowClick && 'cursor-pointer hover:bg-gray-50',
                      isSel && 'bg-brand-50',
                    )}
                  >
                    {selectable && (
                      <td className={cell} onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={rowLabel ? `Select ${rowLabel(r)}` : 'Select row'}
                          checked={isSel}
                          onChange={() =>
                            setSelected((cur) => {
                              const n = new Set(cur);
                              if (n.has(k)) n.delete(k);
                              else n.add(k);
                              return n;
                            })
                          }
                          className="rounded border-gray-300 accent-brand-600"
                        />
                      </td>
                    )}
                    {columns.map((c) => (
                      <td key={c.key} className={cn(cell, align(c.align), c.className)}>
                        {c.render(r)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selectable && selectedRows.length > 0 && bulkActions && (
        <div className="sticky bottom-3 z-[2] flex justify-center pointer-events-none">
          <div className="pointer-events-auto my-3 flex items-center gap-2 rounded-xl bg-gray-900 text-white shadow-2xl px-3 py-2 text-sm">
            <span className="font-semibold tabular-nums px-1">
              {selectedRows.length} selected
            </span>
            <span className="w-px h-5 bg-white/20" />
            {bulkActions(selectedRows, clear)}
            <button
              type="button"
              onClick={clear}
              className="w-7 h-7 inline-flex items-center justify-center rounded-md text-white/70 hover:text-white hover:bg-white/10"
              aria-label="Clear selection"
            >
              <X size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
