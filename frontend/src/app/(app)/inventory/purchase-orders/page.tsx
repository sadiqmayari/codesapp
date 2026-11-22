'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ClipboardList, Lightbulb, Plus } from 'lucide-react';
import { useUrlFilters, useSearchBox } from '@/lib/use-list-query';
import { fmtDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SearchInput } from '@/components/ui/search-input';
import { StatusChips } from '@/components/ui/filter-bar';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState, NoResults } from '@/components/ui/empty-state';
import { getReorderSuggestions, listPOs, PO_STATUS_META, type PoSummary, type ReorderSuggestion } from '@/lib/inventory-ops';
import { money } from '@/components/inventory/shared';

/** Purchase orders + reorder suggestions (what to buy next, from sales velocity). */
export default function PurchaseOrdersPage() {
  const router = useRouter();
  const { values, set, ready } = useUrlFilters({ status: 'open', q: '' });
  const [input, setInput] = useSearchBox(values.q, ready, (q) => set({ q }));
  const [rows, setRows] = useState<PoSummary[] | null>(null);
  const [sugg, setSugg] = useState<ReorderSuggestion[] | null>(null);

  const load = useCallback(() => {
    setRows(null);
    listPOs({ status: values.status || undefined, q: values.q || undefined }).then(setRows).catch(() => setRows([]));
  }, [values.status, values.q]);
  useEffect(() => {
    if (ready) load();
  }, [ready, load]);
  useEffect(() => {
    getReorderSuggestions({}).then(setSugg).catch(() => setSugg([]));
  }, []);

  const columns: Column<PoSummary>[] = [
    { key: 'n', header: 'Order', render: (p) => <span className="font-bold">{p.number}</span> },
    { key: 'sup', header: 'Supplier', render: (p) => p.supplier ?? <span className="text-muted">—</span> },
    { key: 'loc', header: 'Deliver to', render: (p) => p.location },
    { key: 'units', header: 'Received', align: 'right', render: (p) => `${p.received} / ${p.units}` },
    { key: 'total', header: 'Total', align: 'right', render: (p) => money(p.total) },
    { key: 'exp', header: 'Expected', render: (p) => (p.expectedAt ? fmtDate(p.expectedAt) : '—') },
    { key: 'status', header: 'Status', render: (p) => <Badge tone={PO_STATUS_META[p.status].tone}>{PO_STATUS_META[p.status].label}</Badge> },
  ];

  const bySupplier = (sugg ?? []).reduce<Record<string, ReorderSuggestion[]>>((a, s) => {
    const k = s.supplierId ? String(s.supplierId) : 'none';
    (a[k] ??= []).push(s);
    return a;
  }, {});

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-ink">Purchase orders</h1>
          <p className="mt-1 text-sm text-muted">Order stock from suppliers, receive it in, and keep unit cost up to date.</p>
        </div>
        <Link href="/inventory/purchase-orders/new">
          <Button><Plus className="h-4 w-4" aria-hidden="true" /> New purchase order</Button>
        </Link>
      </header>

      {sugg && sugg.length > 0 && (
        <section className="flex flex-col gap-2 rounded-2xl border border-sky-200 bg-sky-50 p-4">
          <h2 className="flex items-center gap-2 text-sm font-extrabold text-sky-900">
            <Lightbulb className="h-4 w-4" aria-hidden="true" /> {sugg.length} items should be reordered
          </h2>
          <p className="text-sm text-sky-900">Based on the last 30 days of sales, lead time and your target cover.</p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(bySupplier).map(([k, list]) => (
              <Link
                key={k}
                href={`/inventory/purchase-orders/new?from=suggestions${k !== 'none' ? `&supplier=${k}` : ''}`}
                className="rounded-xl border border-sky-300 bg-surface px-3 py-2 text-sm font-semibold text-ink hover:border-sky-500"
              >
                {list[0].supplier ?? 'No supplier set'} · {list.length} items · {list.reduce((a, s) => a + s.suggested, 0)} units →
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput value={input} onChange={setInput} placeholder="Search PO number or supplier" aria-label="Search purchase orders" className="min-w-[220px] flex-1" />
        </div>
        <StatusChips
          options={[
            { value: 'open', label: 'Open' },
            { value: 'draft', label: 'Draft' },
            { value: 'partial', label: 'Partly received' },
            { value: 'received', label: 'Received' },
            { value: '', label: 'All' },
          ]}
          value={values.status}
          onChange={(v) => set({ status: v })}
        />
        <DataTable
          rows={rows ?? []}
          columns={columns}
          rowKey={(p) => p.id}
          loading={rows == null}
          onRowClick={(p) => router.push(`/inventory/purchase-orders/${p.id}`)}
          maxHeight="none"
          emptyNode={
            values.q ? (
              <NoResults query={values.q} noun="purchase orders" onClear={() => set({ q: '' })} />
            ) : (
              <EmptyState icon={ClipboardList} title="No purchase orders here" description="Raise one from the reorder suggestions above or from scratch." />
            )
          }
        />
      </div>
    </div>
  );
}
