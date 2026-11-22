'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Download, MapPin, ListFilter } from 'lucide-react';
import { useUrlFilters, useLatestRequest } from '@/lib/use-list-query';
import { DataTable, type Column } from '@/components/ui/data-table';
import { FilterSelect, ActiveFilters, DateRangeFilter } from '@/components/ui/filter-bar';
import { Button } from '@/components/ui/button';
import { NoResults, EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { cn, fmtDateTime } from '@/lib/utils';
import { periodRange, type PeriodKey } from '@/lib/date-period';
import { downloadLedgerCsv, getLocations, listMovements, MOVEMENT_REASON_LABEL, type InventoryLocation, type Movement } from '@/lib/inventory';
import { RefLink } from '@/components/inventory/item-sheet';

const REASONS = Object.entries(MOVEMENT_REASON_LABEL)
  .filter(([k]) => !['order_sale', 'order_cancel', 'return_restock', 'manual_adjust'].includes(k))
  .map(([value, label]) => ({ value, label }));

/** Company-wide stock ledger: every movement, who did it, why, with filters + CSV. */
export default function InventoryLedgerPage() {
  const toast = useToast();
  const { values, set, clearAll, ready } = useUrlFilters({ reason: '', loc: '', period: '30d', from: '', to: '', page: '1' });
  const run = useLatestRequest();
  const [rows, setRows] = useState<Movement[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const page = Math.max(1, Number(values.page) || 1);

  const range = useMemo(
    () => periodRange(values.period as PeriodKey, { from: values.from, to: values.to }),
    [values.period, values.from, values.to],
  );
  const q = useMemo(
    () => ({
      reason: values.reason || undefined,
      locationId: Number(values.loc) || undefined,
      from: range?.from,
      to: range?.to,
    }),
    [values.reason, values.loc, range],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await run((signal) => listMovements({ ...q, page, limit: 50 }, signal));
      if (r === undefined) return;
      setRows(r.rows);
      setTotal(r.total);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not load the ledger');
    } finally {
      setLoading(false);
    }
  }, [q, page, run, toast]);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);
  useEffect(() => {
    getLocations().then(setLocations).catch(() => undefined);
  }, []);

  const columns: Column<Movement>[] = [
    { key: 'at', header: 'When', render: (m) => <span className="whitespace-nowrap text-muted">{fmtDateTime(m.at)}</span> },
    {
      key: 'item',
      header: 'Item',
      render: (m) =>
        m.itemId ? (
          <Link href={`/inventory?item=${m.itemId}`} className="font-semibold text-ink hover:underline">
            {m.item}
          </Link>
        ) : (
          '—'
        ),
    },
    { key: 'loc', header: 'Location', render: (m) => m.location ?? '—' },
    {
      key: 'delta',
      header: 'Change',
      align: 'right',
      render: (m) => (
        <span className={cn('font-extrabold tabular-nums', m.delta < 0 ? 'text-red-700' : 'text-brand-700')}>
          {m.delta > 0 ? `+${m.delta}` : m.delta < 0 ? `−${Math.abs(m.delta)}` : '0'}
        </span>
      ),
    },
    { key: 'after', header: 'After', align: 'right', render: (m) => <span className="tabular-nums">{m.after}</span> },
    { key: 'reason', header: 'Reason', render: (m) => MOVEMENT_REASON_LABEL[m.reason] ?? m.reason },
    { key: 'ref', header: 'Reference', render: (m) => (m.ref ? <RefLink ref_={m.ref} /> : '—') },
    { key: 'by', header: 'By', render: (m) => m.by ?? <span className="text-muted">System</span> },
    { key: 'note', header: 'Note', render: (m) => <span className="text-muted">{m.note ?? ''}</span> },
  ];

  const filters = [
    ...(values.reason ? [{ key: 'reason', label: MOVEMENT_REASON_LABEL[values.reason] ?? values.reason, onRemove: () => set({ reason: '' }) }] : []),
    ...(values.loc ? [{ key: 'loc', label: locations.find((l) => String(l.id) === values.loc)?.name ?? 'Location', onRemove: () => set({ loc: '' }) }] : []),
  ];

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-ink">Stock ledger</h1>
          <p className="mt-1 text-sm text-muted">Every stock change — sales, returns, receiving, counts and adjustments — with who made it.</p>
        </div>
        <Button variant="secondary" onClick={() => void downloadLedgerCsv(q)}>
          <Download className="h-4 w-4" aria-hidden="true" /> Export CSV
        </Button>
      </header>
      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          <DateRangeFilter
            period={values.period as PeriodKey}
            from={values.from}
            to={values.to}
            onChange={(n) => set({ period: n.period, from: n.from, to: n.to })}
          />
          <FilterSelect icon={ListFilter} label="Reason" value={values.reason} options={[{ value: '', label: 'All reasons' }, ...REASONS]} onChange={(v) => set({ reason: v })} />
          {locations.length > 1 && (
            <FilterSelect
              icon={MapPin}
              label="Location"
              value={values.loc}
              options={[{ value: '', label: 'All locations' }, ...locations.map((l) => ({ value: String(l.id), label: l.name }))]}
              onChange={(v) => set({ loc: v })}
            />
          )}
        </div>
        {filters.length > 0 && <ActiveFilters filters={filters} onClearAll={() => clearAll(['period', 'from', 'to'])} />}
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(m) => m.id}
          loading={loading && !rows.length}
          maxHeight="none"
          emptyNode={
            filters.length ? (
              <NoResults noun="movements" onClear={() => clearAll(['period', 'from', 'to'])} />
            ) : (
              <EmptyState title="No stock movements in this period" />
            )
          }
        />
        {total > 50 && (
          <div className="flex items-center justify-between px-1 text-sm text-muted">
            <span>{(page - 1) * 50 + 1}–{Math.min(page * 50, total)} of {total}</span>
            <span className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>Previous</Button>
              <Button size="sm" variant="secondary" disabled={page * 50 >= total} onClick={() => set({ page: String(page + 1) })}>Next</Button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
