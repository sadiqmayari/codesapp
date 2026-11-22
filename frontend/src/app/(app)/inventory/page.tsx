'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Boxes, Download, MapPin, Plus, RefreshCw, Store, Tags, Upload } from 'lucide-react';
import { useSocket } from '@/context/socket-context';
import { useToast } from '@/components/toast';
import { ApiError, apiFetch } from '@/lib/api';
import { cn, fmtDateTime } from '@/lib/utils';
import { useLatestRequest, useSearchBox, useUrlFilters } from '@/lib/use-list-query';
import { DataTable, type Column, type SortState } from '@/components/ui/data-table';
import { SearchInput } from '@/components/ui/search-input';
import { ActiveFilters, FilterSelect, StatusChips } from '@/components/ui/filter-bar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { NoResults, EmptyState } from '@/components/ui/empty-state';
import { Modal } from '@/components/ui/modal';
import { StorePill } from '@/components/store-pill';
import {
  ADJUST_REASONS,
  bulkInventory,
  downloadInventoryCsv,
  getCategories,
  getConflicts,
  getInventoryPushHealth,
  getLocations,
  getSummary,
  getSyncStatus,
  listItems,
  requestInventorySync,
  resolveConflict,
  setItemAvailable,
  updateItem,
  type Conflict,
  type InventoryItem,
  type InventoryLocation,
  type InventorySummary,
  PRODUCT_STATUS_META,
  type ProductStatus,
} from '@/lib/inventory';
import { previewStatus, setProductStatus } from '@/lib/inventory-products';
import { ItemSheet } from '@/components/inventory/item-sheet';
import { BundleBadge, inputCls, itemName, money, parseMoney, PushChip, setInventoryCurrency, StockBadge, Thumb } from '@/components/inventory/shared';

interface StoreRow {
  id: number;
  label: string | null;
  shopDomain?: string | null;
  provider?: string;
  isPrimary?: boolean;
}

const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'low', label: 'Low' },
  { value: 'out', label: 'Out' },
  { value: 'in', label: 'In stock' },
  { value: 'incoming', label: 'Incoming' },
  { value: 'unlinked', label: 'In one store only' },
  { value: 'attention', label: 'Push failed' },
  { value: 'bundle', label: 'Bundles' },
  { value: 'untracked', label: 'Not tracked' },
] as const;

const SORT_KEYS: Record<string, string> = { product: 'title', available: 'available', committed: 'committed', incoming: 'incoming', cost: 'cost', sku: 'sku' };

export default function InventoryPage() {
  const toast = useToast();
  const { on, reconnectSeq } = useSocket();
  const { values, set, clearAll, ready } = useUrlFilters({
    q: '',
    status: '',
    store: '',
    loc: '',
    category: '',
    sort: '',
    dir: '',
    page: '1',
    item: '',
  });
  const [input, setInput] = useSearchBox(values.q, ready, (q) => set({ q }));
  const run = useLatestRequest();
  const runSummary = useLatestRequest();

  const [rows, setRows] = useState<InventoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [summary, setSummary] = useState<InventorySummary | null>(null);
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [missingScopes, setMissingScopes] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string | number>>(new Set());
  const [bulk, setBulk] = useState<null | 'adjust' | 'category' | 'reorder'>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [sheetVersion, setSheetVersion] = useState(0);
  const limit = 50;
  const page = Math.max(1, Number(values.page) || 1);

  const query = useMemo(
    () => ({
      search: values.q,
      status: values.status,
      category: values.category,
      storeId: Number(values.store) || undefined,
      locationId: Number(values.loc) || undefined,
      sort: values.sort || undefined,
      dir: (values.dir as 'asc' | 'desc') || undefined,
      page,
      limit,
    }),
    [values.q, values.status, values.category, values.store, values.loc, values.sort, values.dir, page],
  );

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const r = await run((signal) => listItems(query, signal));
        if (r === undefined) return;
        setRows(r.rows);
        setTotal(r.total);
        setLoaded(true);
      } catch (e) {
        toast.error(e instanceof ApiError ? e.userMessage : 'Could not load inventory');
      } finally {
        setLoading(false);
      }
    },
    [query, run, toast],
  );

  const loadSummary = useCallback(async () => {
    const s = await runSummary((signal) => getSummary(query.storeId, query.locationId, signal)).catch(() => undefined);
    if (s) {
      setInventoryCurrency(s.currency);
      setSummary(s);
    }
  }, [query.storeId, query.locationId, runSummary]);

  // first load waits for URL hydrate
  useEffect(() => {
    if (!ready) return;
    void load();
  }, [ready, load]);
  useEffect(() => {
    if (ready) void loadSummary();
  }, [ready, loadSummary]);

  // aux data once
  useEffect(() => {
    apiFetch<StoreRow[]>('/shopify/stores')
      .then((s) => {
        setStores(s);
        // scope banner: any Shopify store missing a write scope
        Promise.all(
          s.filter((x) => (x.provider ?? 'shopify') === 'shopify').map((x) =>
            getInventoryPushHealth(x.id)
              .then((h) => [
                ...(h.writeInventory === false ? [`write_inventory (${x.label || x.shopDomain})`] : []),
                ...(h.writeProducts === false ? [`write_products (${x.label || x.shopDomain})`] : []),
              ])
              .catch(() => [] as string[]),
          ),
        ).then((all) => setMissingScopes(all.flat()));
      })
      .catch(() => setStores([]));
    getLocations().then(setLocations).catch(() => setLocations([]));
    getCategories().then(setCategories).catch(() => setCategories([]));
    getSyncStatus()
      .then((s) => {
        setSyncing(s.running);
        const last = s.stores.map((x) => x.lastSyncedAt).filter(Boolean).sort().pop() ?? null;
        setLastSync(last);
      })
      .catch(() => undefined);
  }, []);

  // live: any stock change / push result / sync → silent refresh (coalesced)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const summaryRef = useRef(loadSummary);
  summaryRef.current = loadSummary;
  useEffect(() => {
    return on('inventory.changed', (p: { sync?: boolean; bootstrap?: boolean }) => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        void loadRef.current(true);
        void summaryRef.current();
        setSheetVersion((v) => v + 1);
        if (p?.sync || p?.bootstrap) {
          setSyncing(false);
          setLastSync(new Date().toISOString());
          getLocations().then(setLocations).catch(() => undefined);
        }
      }, 700);
    });
  }, [on]);
  const seq0 = useRef(reconnectSeq);
  useEffect(() => {
    if (reconnectSeq === seq0.current) return;
    void loadRef.current(true);
    void summaryRef.current();
  }, [reconnectSeq]);

  const sortState: SortState = values.sort
    ? { key: Object.keys(SORT_KEYS).find((k) => SORT_KEYS[k] === values.sort) ?? 'product', dir: (values.dir as 'asc' | 'desc') || 'asc' }
    : null;

  const doSync = async () => {
    setSyncing(true);
    try {
      const r = await requestInventorySync(query.storeId);
      toast.info(r.bootstrap ? 'Setting up shared stock — this takes a minute' : 'Syncing stores in the background');
    } catch (e) {
      setSyncing(false);
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not start the sync');
    }
  };

  const saveAvailable = async (row: InventoryItem, value: number) => {
    if (value === row.available) return;
    try {
      await setItemAvailable(row.id, { available: value, seen: row.available, locationId: query.locationId });
      setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, available: value, status: value <= 0 ? 'out' : value <= r.reorderLevel ? 'low' : 'in' } : r)));
      void loadSummary();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.error(e.userMessage);
        void load(true);
        throw e;
      }
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not update stock');
      throw e;
    }
  };

  const saveCost = async (row: InventoryItem, value: number | null) => {
    if (value === row.avgCost) return;
    try {
      await updateItem(row.id, { avg_cost: value });
      setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, avgCost: value } : r)));
      void loadSummary();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save cost');
      throw e;
    }
  };

  const storeOptions = stores.map((s) => ({ value: String(s.id), label: s.label || s.shopDomain || `Store ${s.id}` }));
  const multiStore = stores.length > 1;
  const activeFilters = [
    ...(values.q ? [{ key: 'q', label: `Search: ${values.q}`, onRemove: () => set({ q: '' }) }] : []),
    ...(values.status ? [{ key: 'status', label: STATUS_OPTIONS.find((o) => o.value === values.status)?.label ?? values.status, onRemove: () => set({ status: '' }) }] : []),
    ...(values.store ? [{ key: 'store', label: `Store: ${storeOptions.find((o) => o.value === values.store)?.label ?? values.store}`, onRemove: () => set({ store: '' }) }] : []),
    ...(values.loc ? [{ key: 'loc', label: `Location: ${locations.find((l) => String(l.id) === values.loc)?.name ?? values.loc}`, onRemove: () => set({ loc: '' }) }] : []),
    ...(values.category ? [{ key: 'category', label: `Category: ${values.category}`, onRemove: () => set({ category: '' }) }] : []),
  ];
  const filtered = activeFilters.length > 0;

  const columns: Column<InventoryItem>[] = [
    {
      key: 'product',
      header: 'Product / variant',
      sortable: true,
      render: (r) => (
        <div className="flex min-w-[220px] items-center gap-3">
          <Thumb src={r.image} alt="" />
          <div className="min-w-0">
            <div className="truncate font-bold text-ink">{r.title}</div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
              {r.variantTitle && r.variantTitle !== 'Default Title' && <span>{r.variantTitle}</span>}
              {r.itemCode && <span className="rounded bg-sunken px-1.5 font-semibold text-ink">#{r.itemCode}</span>}
              {r.shelfLocation && <span>Shelf {r.shelfLocation}</span>}
              {r.isBundle && <BundleBadge />}
              {!r.track && <Badge tone="neutral">Not tracked</Badge>}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'sku',
      header: 'SKU',
      sortable: true,
      render: (r) => <span className="font-mono text-xs text-muted">{r.sku ?? '—'}</span>,
    },
    ...(multiStore
      ? [
          {
            key: 'stores',
            header: 'Stores',
            render: (r: InventoryItem) => (
              <div className="flex flex-wrap items-center gap-1">
                {r.listings.map((l) => (
                  <StorePill key={l.id} storeId={l.storeId} label={l.storeLabel} size="xs" />
                ))}
                {r.listings.length > 1 && <span className="text-xs font-bold text-brand-700">shared</span>}
                {r.conflict && (
                  <span title="The stores show different stock than CodesApp" className="text-amber-700">
                    <AlertTriangle className="h-3.5 w-3.5" aria-label="Stores disagree" />
                  </span>
                )}
              </div>
            ),
          } as Column<InventoryItem>,
        ]
      : []),
    {
      key: 'available',
      header: 'Available',
      align: 'right',
      sortable: true,
      render: (r) =>
        r.isBundle ? (
          <span className="font-extrabold tabular-nums text-violet-700" title="Built from its parts">≈ {r.available}</span>
        ) : (
          <NumberCell value={r.available} label={`Available for ${itemName(r)}`} onSave={(v) => saveAvailable(r, v)} disabled={!r.track} />
        ),
    },
    { key: 'committed', header: 'Committed', align: 'right', sortable: true, render: (r) => <span className="tabular-nums text-muted">{r.isBundle ? '—' : r.committed}</span> },
    {
      key: 'incoming',
      header: 'Incoming',
      align: 'right',
      sortable: true,
      render: (r) => <span className="tabular-nums text-sky-700">{r.incoming ? `+${r.incoming}` : ''}</span>,
    },
    {
      key: 'cost',
      header: 'Cost',
      align: 'right',
      sortable: true,
      render: (r) => <MoneyCell value={r.avgCost} label={`Unit cost for ${itemName(r)}`} onSave={(v) => saveCost(r, v)} />,
    },
    {
      key: 'price',
      header: 'Price',
      align: 'right',
      render: (r) => (
        <span className="tabular-nums">
          {r.priceMin == null ? '—' : r.priceMin === r.priceMax ? money(r.priceMin) : `${money(r.priceMin)}–${money(r.priceMax)}`}
        </span>
      ),
    },
    { key: 'status', header: 'Status', render: (r) => (r.track ? <StockBadge status={r.status} /> : <span className="text-xs text-muted">—</span>) },
    { key: 'sync', header: 'Sync', render: (r) => <PushChip listings={r.listings} compact /> },
  ];

  const selectedIds = Array.from(selected).map(Number);

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-extrabold text-ink">
            <Boxes className="h-6 w-6 text-brand-600" aria-hidden="true" /> Inventory
          </h1>
          <p className="mt-1 text-sm text-muted">
            {stores.length} store{stores.length === 1 ? '' : 's'} · {locations.length} location{locations.length === 1 ? '' : 's'}
            {lastSync && <> · synced {fmtDateTime(lastSync)}</>}
            {syncing && <> · syncing…</>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/inventory/counts?import=1">
            <Button variant="secondary"><Upload className="h-4 w-4" aria-hidden="true" /> Import CSV</Button>
          </Link>
          <Button variant="secondary" onClick={() => void downloadInventoryCsv({ ...query, page: undefined, limit: undefined })}>
            <Download className="h-4 w-4" aria-hidden="true" /> Export view
          </Button>
          <Button variant="secondary" onClick={doSync} loading={syncing}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> {multiStore ? 'Sync all stores' : 'Sync store'}
          </Button>
          <Link href="/inventory/products/new">
            <Button variant="secondary"><Plus className="h-4 w-4" aria-hidden="true" /> New product</Button>
          </Link>
          <Link href="/inventory/purchase-orders/new">
            <Button>New purchase order</Button>
          </Link>
        </div>
      </header>

      {summary && !summary.ready && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <span>
            <b>Inventory is moving to shared stock.</b> CodesApp links the same product across your stores and keeps one stock count per location.
          </span>
          <Button size="sm" onClick={doSync} loading={syncing}>Set up now</Button>
        </div>
      )}

      {missingScopes.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            CodesApp can’t update Shopify for some stores: the token is missing <b>{missingScopes.join(', ')}</b>. Re-issue the token with
            those scopes in <Link href="/settings/stores" className="font-bold underline">Settings → Stores</Link>.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Available units" value={summary?.availableUnits} sub={`${summary?.skus ?? 0} items`} onClick={() => set({ status: '' })} />
        <Tile
          label="Stock value"
          value={summary ? money(summary.stockValue) : undefined}
          sub={summary?.itemsWithoutCost ? `${summary.itemsWithoutCost} items have no cost` : 'at unit cost'}
        />
        <Tile label="Low stock" tone="warn" value={summary?.lowCount} sub="at or under reorder point" onClick={() => set({ status: 'low' })} active={values.status === 'low'} />
        <Tile label="Out of stock" tone="danger" value={summary?.outCount} sub="tracked items at 0" onClick={() => set({ status: 'out' })} active={values.status === 'out'} />
        <Tile label="Incoming" tone="info" value={summary?.incomingUnits} sub="on open purchase orders" onClick={() => set({ status: 'incoming' })} active={values.status === 'incoming'} />
        <Tile
          label="Needs attention"
          tone="danger"
          value={summary ? summary.pushFailed + summary.conflicts : undefined}
          sub={summary ? `${summary.pushFailed} push failed · ${summary.conflicts} disagree` : ''}
          onClick={() => (summary?.conflicts ? setConflictsOpen(true) : set({ status: 'attention' }))}
          active={values.status === 'attention'}
        />
      </div>

      {summary && summary.conflicts > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span>
            <b>{summary.conflicts} linked item{summary.conflicts === 1 ? '' : 's'} show different stock in your stores.</b> Pick the right number once and
            CodesApp pushes it everywhere.
          </span>
          <Button size="sm" variant="secondary" onClick={() => setConflictsOpen(true)}>Review</Button>
        </div>
      )}

      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={input}
            onChange={setInput}
            slashShortcut
            loading={loading && loaded}
            placeholder="Search title, SKU, item code, barcode, shelf"
            aria-label="Search inventory"
            className="min-w-[220px] flex-1"
          />
          {multiStore && (
            <FilterSelect icon={Store} label="Store" value={values.store} options={[{ value: '', label: 'All stores' }, ...storeOptions]} onChange={(v) => set({ store: v })} />
          )}
          {locations.length > 1 && (
            <FilterSelect
              icon={MapPin}
              label="Location"
              value={values.loc}
              options={[{ value: '', label: 'All locations' }, ...locations.map((l) => ({ value: String(l.id), label: l.name }))]}
              onChange={(v) => set({ loc: v })}
            />
          )}
          {categories.length > 0 && (
            <FilterSelect
              icon={Tags}
              label="Category"
              value={values.category}
              options={[{ value: '', label: 'All categories' }, ...categories.map((c) => ({ value: c, label: c }))]}
              onChange={(v) => set({ category: v })}
            />
          )}
        </div>
        <StatusChips
          options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          value={values.status as (typeof STATUS_OPTIONS)[number]['value']}
          onChange={(v) => set({ status: v })}
        />
        {filtered && <ActiveFilters filters={activeFilters} onClearAll={() => clearAll(['item'])} />}

        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(r) => r.id}
          rowLabel={(r) => itemName(r)}
          loading={loading && !loaded}
          onRowClick={(r) => set({ item: String(r.id), page: values.page })}
          selectable
          selectedKeys={selected}
          onSelectedKeysChange={setSelected}
          sortState={sortState}
          onSortChange={(s) => set({ sort: s ? SORT_KEYS[s.key] ?? '' : '', dir: s?.dir ?? '' })}
          maxHeight="none"
          emptyNode={
            filtered ? (
              <NoResults query={values.q} noun="items" onClear={() => clearAll(['item'])} />
            ) : (
              <EmptyState
                icon={Boxes}
                title="No products yet"
                description="Sync your store to bring in products and stock, or create a product here."
                action={<Button onClick={doSync} loading={syncing}>Sync store</Button>}
              />
            )
          }
          bulkActions={(sel, clear) => (
            <>
              <Button size="sm" onClick={() => setBulk('adjust')}>Adjust stock…</Button>
              <Button size="sm" variant="ghost" className="text-white hover:bg-white/10" onClick={() => setBulk('category')}>Category</Button>
              <Button size="sm" variant="ghost" className="text-white hover:bg-white/10" onClick={() => setBulk('reorder')}>Reorder point</Button>
              <Button size="sm" variant="ghost" className="text-white hover:bg-white/10" onClick={() => setStatusOpen(true)}>Set status</Button>
              <Link href={`/inventory/purchase-orders/new?items=${sel.map((s) => s.id).join(',')}`}>
                <Button size="sm" variant="ghost" className="text-white hover:bg-white/10">Add to PO</Button>
              </Link>
              <Button
                size="sm"
                variant="ghost"
                className="text-white hover:bg-white/10"
                onClick={async () => {
                  await bulkInventory({ itemIds: sel.map((s) => s.id), action: 'push' }).catch(() => undefined);
                  toast.info(`Pushing ${sel.length} items to every store`);
                  clear();
                }}
              >
                Push now
              </Button>
            </>
          )}
        />

        {total > limit && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-sm text-muted">
            <span>
              {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}
            </span>
            <span className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={page <= 1} aria-label="Previous page" onClick={() => set({ page: String(page - 1) })}>Previous</Button>
              <Button size="sm" variant="secondary" disabled={page * limit >= total} aria-label="Next page" onClick={() => set({ page: String(page + 1) })}>Next</Button>
            </span>
          </div>
        )}
      </div>

      <ItemSheet
        itemId={values.item ? Number(values.item) : null}
        onClose={() => set({ item: '', page: values.page })}
        onChanged={() => {
          void load(true);
          void loadSummary();
        }}
        version={sheetVersion}
      />

      <BulkModal
        kind={bulk}
        itemIds={selectedIds}
        locations={locations}
        categories={categories}
        onClose={() => setBulk(null)}
        onDone={() => {
          setBulk(null);
          setSelected(new Set());
          void load(true);
          void loadSummary();
        }}
      />

      <StatusModal
        open={statusOpen}
        itemIds={selectedIds}
        stores={stores}
        onClose={() => setStatusOpen(false)}
        onDone={() => {
          setStatusOpen(false);
          setSelected(new Set());
          void load(true);
        }}
      />

      <ConflictsModal
        open={conflictsOpen}
        stores={stores}
        onClose={() => setConflictsOpen(false)}
        onResolved={() => {
          void load(true);
          void loadSummary();
        }}
      />
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  tone,
  onClick,
  active,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'warn' | 'danger' | 'info';
  onClick?: () => void;
  active?: boolean;
}) {
  const color = tone === 'warn' ? 'text-amber-700' : tone === 'danger' ? 'text-red-700' : tone === 'info' ? 'text-sky-700' : 'text-ink';
  const body = (
    <>
      <span className="text-xs font-semibold text-muted">{label}</span>
      <span className={cn('text-xl font-extrabold tabular-nums', color)}>{value ?? '—'}</span>
      {sub && <span className="text-xs text-muted">{sub}</span>}
    </>
  );
  const cls = cn(
    'flex flex-col gap-1 rounded-2xl border bg-surface p-3 text-left',
    active ? 'border-brand-500 ring-2 ring-brand-500/20' : 'border-line',
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(cls, 'hover:border-brand-300')}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Inline integer edit: Enter/blur save, Esc cancels, failed save reverts, "Saving…" state. */
function NumberCell({ value, label, onSave, disabled }: { value: number; label: string; onSave: (v: number) => Promise<void>; disabled?: boolean }) {
  const [v, setV] = useState(String(value));
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  const cur = useRef(value);
  cur.current = value;
  useEffect(() => setV(String(value)), [value]);
  const commit = async () => {
    const t = v.trim();
    if (t === '' || !/^\d+$/.test(t)) return setV(String(cur.current));
    const n = Number(t);
    if (n === cur.current) return;
    setState('saving');
    try {
      await onSave(n);
      setState('idle');
    } catch {
      setState('error');
      setV(String(cur.current));
      setTimeout(() => setState('idle'), 2500);
    }
  };
  return (
    <span onClick={(e) => e.stopPropagation()} className="inline-flex flex-col items-end">
      <input
        value={v}
        disabled={disabled || state === 'saving'}
        aria-label={label}
        inputMode="numeric"
        onChange={(e) => setV(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setV(String(cur.current));
            requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
          }
        }}
        className={cn(
          'w-20 rounded-lg border bg-surface px-2 py-1 text-right text-sm font-extrabold tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/20',
          state === 'error' ? 'border-red-400' : 'border-transparent hover:border-line focus:border-brand-500',
        )}
      />
      {state === 'saving' && <span className="text-xs text-sky-700">Saving…</span>}
      {state === 'error' && <span className="text-xs text-red-700">Not saved</span>}
    </span>
  );
}

function MoneyCell({ value, label, onSave }: { value: number | null; label: string; onSave: (v: number | null) => Promise<void> }) {
  const fmt = (x: number | null) => (x == null ? '' : String(x));
  const [v, setV] = useState(fmt(value));
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  const cur = useRef(value);
  cur.current = value;
  useEffect(() => setV(fmt(value)), [value]);
  const commit = async () => {
    const p = parseMoney(v);
    if (p === 'invalid') return setV(fmt(cur.current));
    if (p === cur.current) return;
    setState('saving');
    try {
      await onSave(p);
      setState('idle');
    } catch {
      setState('error');
      setV(fmt(cur.current));
      setTimeout(() => setState('idle'), 2500);
    }
  };
  return (
    <span onClick={(e) => e.stopPropagation()} className="inline-flex flex-col items-end">
      <input
        value={v}
        aria-label={label}
        placeholder="—"
        inputMode="decimal"
        disabled={state === 'saving'}
        onChange={(e) => setV(e.target.value.replace(/[^0-9.,]/g, ''))}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setV(fmt(cur.current));
            requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
          }
        }}
        className={cn(
          'w-24 rounded-lg border bg-surface px-2 py-1 text-right text-sm tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/20',
          state === 'error' ? 'border-red-400' : 'border-transparent hover:border-line focus:border-brand-500',
        )}
      />
      {state === 'saving' && <span className="text-xs text-sky-700">Saving…</span>}
    </span>
  );
}

function BulkModal({
  kind,
  itemIds,
  locations,
  categories,
  onClose,
  onDone,
}: {
  kind: null | 'adjust' | 'category' | 'reorder';
  itemIds: number[];
  locations: InventoryLocation[];
  categories: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [locationId, setLocationId] = useState<number>(0);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('adjust_recount');
  const [note, setNote] = useState('');
  const [category, setCategory] = useState('');
  const [reorder, setReorder] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (kind) {
      setLocationId(locations.find((l) => l.isDefault)?.id ?? locations[0]?.id ?? 0);
      setDelta('');
      setNote('');
    }
  }, [kind, locations]);
  const title = kind === 'adjust' ? `Adjust ${itemIds.length} items` : kind === 'category' ? `Set category for ${itemIds.length} items` : `Set reorder point for ${itemIds.length} items`;
  const submit = async () => {
    setBusy(true);
    try {
      if (kind === 'adjust') {
        const d = Number(delta);
        if (!/^-?\d+$/.test(delta.trim()) || !d) throw new Error('Type how many to add (5) or remove (-2).');
        await bulkInventory({ itemIds, action: 'adjust', locationId, delta: d, reason, note: note.trim() || undefined });
      } else if (kind === 'category') {
        await bulkInventory({ itemIds, action: 'category', category: category.trim() || null });
      } else if (kind === 'reorder') {
        await bulkInventory({ itemIds, action: 'reorder', reorderLevel: Math.max(0, Number(reorder) || 0) });
      }
      toast.success('Done');
      onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : (e as Error).message || 'Could not update');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={!!kind}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={busy}>Apply</Button>
        </>
      }
    >
      {kind === 'adjust' && (
        <div className="grid gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="b-loc" className="text-xs font-bold text-ink">Location</label>
            <select id="b-loc" className={inputCls} value={locationId} onChange={(e) => setLocationId(Number(e.target.value))}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="b-delta" className="text-xs font-bold text-ink">Change each item by</label>
            <input id="b-delta" className={inputCls} inputMode="numeric" value={delta} onChange={(e) => setDelta(e.target.value.replace(/[^0-9-]/g, ''))} placeholder="-2 or 5" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="b-reason" className="text-xs font-bold text-ink">Reason</label>
            <select id="b-reason" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)}>
              {ADJUST_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="b-note" className="text-xs font-bold text-ink">Note (optional)</label>
            <input id="b-note" className={inputCls} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
      )}
      {kind === 'category' && (
        <div className="flex flex-col gap-1">
          <label htmlFor="b-cat" className="text-xs font-bold text-ink">Category (leave blank to clear)</label>
          <input id="b-cat" list="b-cat-list" className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)} />
          <datalist id="b-cat-list">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </div>
      )}
      {kind === 'reorder' && (
        <div className="flex flex-col gap-1">
          <label htmlFor="b-reorder" className="text-xs font-bold text-ink">Show as Low at or below</label>
          <input id="b-reorder" className={inputCls} inputMode="numeric" value={reorder} onChange={(e) => setReorder(e.target.value.replace(/[^0-9]/g, ''))} />
        </div>
      )}
    </Modal>
  );
}

function StatusModal({ open, itemIds, stores, onClose, onDone }: { open: boolean; itemIds: number[]; stores: StoreRow[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState<ProductStatus>('active');
  const [storeId, setStoreId] = useState('');
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewStatus>> | null>(null);
  const [busy, setBusy] = useState(false);
  const idsKey = itemIds.join(',');
  useEffect(() => {
    if (!open) return;
    setPreview(null);
    previewStatus({ itemIds: idsKey.split(',').map(Number).filter(Boolean), status, storeId: Number(storeId) || undefined })
      .then(setPreview)
      .catch(() => setPreview(null));
  }, [open, idsKey, status, storeId]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Set status for ${itemIds.length} items`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            loading={busy}
            disabled={!preview?.changing}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await setProductStatus({ itemIds, status, storeId: Number(storeId) || undefined });
                toast.success(`${r.updated} products set to ${PRODUCT_STATUS_META[status].label}. Updating the stores.`);
                onDone();
              } catch (e) {
                toast.error(e instanceof ApiError ? e.userMessage : 'Could not change the status');
              } finally {
                setBusy(false);
              }
            }}
          >
            Change {preview?.changing ?? ''} products
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="New status">
          {(Object.keys(PRODUCT_STATUS_META) as ProductStatus[]).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={status === k}
              onClick={() => setStatus(k)}
              className={cn('flex flex-col rounded-xl border p-3 text-left text-sm', status === k ? 'border-brand-500 bg-brand-50' : 'border-line')}
            >
              <b>{PRODUCT_STATUS_META[k].label}</b>
              <span className="text-xs text-muted">{PRODUCT_STATUS_META[k].hint}</span>
            </button>
          ))}
        </div>
        {stores.length > 1 && (
          <div className="flex flex-col gap-1">
            <label htmlFor="st-store" className="text-xs font-bold text-ink">In which store</label>
            <select id="st-store" className={inputCls} value={storeId} onChange={(e) => setStoreId(e.target.value)}>
              <option value="">Every store the items sell in</option>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.label || s.shopDomain || `Store ${s.id}`}</option>)}
            </select>
          </div>
        )}
        {preview && (
          <div className="rounded-xl bg-sunken p-3 text-sm">
            {preview.changing ? (
              <>
                {preview.perStore.map((p) => `${p.count} in ${p.store}`).join(' · ')}
                {preview.unchanged > 0 && <span className="text-muted"> · {preview.unchanged} already {PRODUCT_STATUS_META[status].label.toLowerCase()}</span>}
              </>
            ) : (
              'Nothing to change.'
            )}
            {preview.withStock > 0 && (
              <p className="mt-1 font-semibold text-amber-800">{preview.withStock} of them still have stock — customers won’t be able to buy them.</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ConflictsModal({ open, stores, onClose, onResolved }: { open: boolean; stores: StoreRow[]; onClose: () => void; onResolved: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<Conflict[] | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    setRows(null);
    getConflicts()
      .then((r) => {
        setRows(r);
        setPick(Object.fromEntries(r.map((c) => [`${c.itemId}:${c.locationId}`, String(Math.min(c.pool, ...c.stores.map((s) => s.qty)))])));
      })
      .catch(() => setRows([]));
  }, [open]);
  const label = (id: number) => stores.find((s) => s.id === id)?.label || stores.find((s) => s.id === id)?.shopDomain || `Store ${id}`;
  return (
    <Modal open={open} onClose={onClose} title="Stores that disagree" size="lg">
      <p className="mb-3 text-sm text-muted">
        These items are linked across stores but the stores show different stock. Choose the real number — CodesApp saves it and pushes it to
        every store. The lowest number is picked by default so you never oversell.
      </p>
      {!rows ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState compact title="All stores agree" />
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((c) => {
            const k = `${c.itemId}:${c.locationId}`;
            return (
              <div key={k} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-3 text-sm">
                <div className="min-w-0">
                  <div className="font-bold">{c.title}</div>
                  <div className="text-xs text-muted">
                    {c.location} · CodesApp {c.pool} · {c.stores.map((s) => `${label(s.storeId)} ${s.qty}`).join(' · ')}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor={`cf-${k}`} className="sr-only">Real stock for {c.title}</label>
                  <input
                    id={`cf-${k}`}
                    className={cn(inputCls, 'w-20 text-right')}
                    inputMode="numeric"
                    value={pick[k] ?? ''}
                    onChange={(e) => setPick((p) => ({ ...p, [k]: e.target.value.replace(/[^0-9]/g, '') }))}
                  />
                  <Button
                    size="sm"
                    onClick={async () => {
                      try {
                        await resolveConflict({ itemId: c.itemId, locationId: c.locationId, available: Number(pick[k] || 0) });
                        setRows((rs) => (rs ?? []).filter((x) => `${x.itemId}:${x.locationId}` !== k));
                        toast.success('Saved — pushing to every store');
                        onResolved();
                      } catch (e) {
                        toast.error(e instanceof ApiError ? e.userMessage : 'Could not save');
                      }
                    }}
                  >
                    Use this
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
