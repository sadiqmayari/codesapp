'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Boxes,
  RefreshCw,
  Download,
  Search,
  Package,
  Layers,
  AlertTriangle,
  XCircle,
  Wallet,
  ArrowUp,
  ArrowUpCircle,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Check,
  Clock,
  X,
  ArrowUpDown,
} from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { fmtDateTime } from '@/lib/utils';
import {
  InventoryStats,
  InventoryVariant,
  InventorySortKey,
  PushStatus,
  STOCK_STATUS_META,
  listInventory,
  getInventoryStats,
  getInventoryCategories,
  getInventorySyncStatus,
  getInventoryPushHealth,
  syncInventory,
  pushChanged as pushChangedApi,
  updateInventoryVariant,
  pushInventoryVariant,
  exportInventory,
} from '@/lib/inventory';

interface StoreRow {
  id: number;
  label: string | null;
  shopDomain: string;
  isPrimary: boolean;
  provider?: 'shopify' | 'woocommerce';
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'in', label: 'In stock' },
  { key: 'low', label: 'Low' },
  { key: 'out', label: 'Out' },
];
const LIMIT = 50;
const money = (n: number | null) =>
  n == null ? '—' : 'Rs ' + Math.round(n).toLocaleString('en-PK');

export default function InventoryPage() {
  const toast = useToast();

  const [stores, setStores] = useState<StoreRow[]>([]);
  const [storeId, setStoreId] = useState<number | undefined>(undefined);

  const [rows, setRows] = useState<InventoryVariant[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<InventoryStats | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  const [filter, setFilter] = useState('all');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<InventorySortKey>('product');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');

  // Pre-fill the search box from ?q= (deep-link from the Analytics tab).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q');
    if (q) {
      setSearch(q);
      setDebounced(q.trim());
    }
  }, []);

  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [pushingAll, setPushingAll] = useState(false);
  // write_inventory scope health (drives the "can't push" banner).
  const [writeInventory, setWriteInventory] = useState<boolean | null>(null);
  const [healthDismissed, setHealthDismissed] = useState(false);

  // debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setPage(1), [debounced, filter, category, storeId, sort, dir]);

  const toggleSort = (k: InventorySortKey) => {
    if (k === sort) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSort(k);
      // sensible first direction: text asc, numbers desc
      setDir(['price', 'cost', 'shopify', 'codesapp'].includes(k) ? 'desc' : 'asc');
    }
  };

  // connected stores (selector only shows when >1)
  useEffect(() => {
    apiFetch<StoreRow[]>('/shopify/stores')
      .then((list) => {
        const arr = Array.isArray(list) ? list : [];
        setStores(arr);
        const primary = arr.find((s) => s.isPrimary) ?? arr[0];
        if (primary) setStoreId(primary.id);
      })
      .catch(() => undefined);
  }, []);

  const loadAux = useCallback(() => {
    getInventoryStats(storeId).then(setStats).catch(() => undefined);
    getInventoryCategories(storeId).then(setCategories).catch(() => undefined);
    getInventorySyncStatus(storeId)
      .then((s) => setLastSyncedAt(s.lastSyncedAt))
      .catch(() => undefined);
    getInventoryPushHealth(storeId)
      .then((h) => setWriteInventory(h.writeInventory))
      .catch(() => setWriteInventory(null));
  }, [storeId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { rows: r, total: t } = await listInventory({
        storeId,
        search: debounced,
        status: filter,
        category,
        page,
        limit: LIMIT,
        sort,
        dir,
      });
      setRows(r);
      setTotal(t);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load inventory');
    } finally {
      setLoading(false);
    }
  }, [storeId, debounced, filter, category, page, sort, dir, toast]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    loadAux();
  }, [loadAux]);

  const patchRow = (id: number, patch: Partial<InventoryVariant>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const saveField = async (
    row: InventoryVariant,
    field: 'item_code' | 'alias',
    value: string,
  ) => {
    const current = field === 'item_code' ? row.itemCode : row.alias;
    if ((current ?? '') === value) return;
    try {
      const updated = await updateInventoryVariant(row.id, { [field]: value || null });
      patchRow(row.id, { itemCode: updated.itemCode, alias: updated.alias });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save');
    }
  };

  const saveQty = async (row: InventoryVariant, value: number) => {
    if (value === row.localQty) return;
    try {
      const updated = await updateInventoryVariant(row.id, { local_qty: value });
      patchRow(row.id, {
        localQty: updated.localQty,
        status: updated.status,
        dirty: updated.dirty,
        qtyPushStatus: updated.qtyPushStatus,
        qtyPushError: updated.qtyPushError,
      });
      loadAux();
      toast.success('Saved — queued push to Shopify');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not update quantity');
    }
  };

  const saveCost = async (row: InventoryVariant, value: number | null) => {
    if ((row.costPrice ?? null) === value) return;
    try {
      const updated = await updateInventoryVariant(row.id, { cost_price: value });
      patchRow(row.id, {
        costPrice: updated.costPrice,
        costPushStatus: updated.costPushStatus,
        costPushError: updated.costPushError,
      });
      toast.success('Saved — queued cost push to Shopify');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not update cost');
    }
  };

  const [pushingId, setPushingId] = useState<number | null>(null);
  const pushOne = async (row: InventoryVariant) => {
    setPushingId(row.id);
    try {
      await pushInventoryVariant(row.id);
      // Optimistic: the push job will set Shopify to localQty.
      patchRow(row.id, {
        shopifyQty: row.localQty,
        dirty: false,
        qtyPushStatus: 'pending',
        qtyPushError: null,
      });
      toast.success('Queued push to Shopify');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Push failed');
    } finally {
      setPushingId(null);
    }
  };

  const doSync = async () => {
    setSyncing(true);
    try {
      await syncInventory(storeId);
      toast.info('Sync started — pulling your catalogue from Shopify…');
      // Give the background job a head start, then refresh.
      setTimeout(() => {
        void load();
        loadAux();
        setSyncing(false);
      }, 4000);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not start sync');
      setSyncing(false);
    }
  };

  const doPushChanged = async () => {
    setPushingAll(true);
    try {
      const { queued } = await pushChangedApi(storeId);
      setRows((rs) => rs.map((r) => ({ ...r, shopifyQty: r.localQty, dirty: false })));
      toast.success(
        queued > 0 ? `Queued ${queued} change${queued === 1 ? '' : 's'} to Shopify` : 'Nothing to push',
      );
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Push failed');
    } finally {
      setPushingAll(false);
    }
  };

  const doExport = async () => {
    try {
      const { filename, csv } = await exportInventory(storeId);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Export failed');
    }
  };

  const dirtyCount = rows.filter((r) => r.dirty).length;
  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* Title row */}
      <div className="flex flex-wrap items-start gap-3 justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Boxes className="w-6 h-6 text-green-600" />
            Inventory
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Products synced from Shopify, enriched with your own codes &amp; stock.
            {lastSyncedAt && (
              <span className="ml-1 text-gray-400">
                Last synced {fmtDateTime(lastSyncedAt)}.
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {stores.length > 1 && (
            <select
              value={storeId ?? ''}
              onChange={(e) => setStoreId(Number(e.target.value) || undefined)}
              className="bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label || s.shopDomain}
                  {s.isPrimary ? ' — primary' : ''}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={doSync}
            disabled={syncing}
            className="inline-flex items-center gap-2 bg-green-600 hover:bg-green-700 disabled:opacity-60 text-white rounded-lg px-4 py-2 text-sm font-medium"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing…' : 'Sync from Shopify'}
          </button>
          <button
            onClick={doExport}
            className="inline-flex items-center gap-2 bg-white border border-gray-300 hover:bg-gray-50 rounded-lg px-3 py-2 text-sm font-medium text-gray-700"
          >
            <Download className="w-4 h-4" />
            Export
          </button>
        </div>
      </div>

      {/* write_inventory scope banner — stock/cost pushes can't reach Shopify */}
      {writeInventory === false && !healthDismissed && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
          <div className="text-sm">
            <div className="font-semibold text-red-800">
              Stock &amp; cost changes can’t reach Shopify
            </div>
            <div className="text-red-700 mt-0.5">
              Your Shopify Admin token is missing the{' '}
              <code className="bg-red-100 px-1 rounded">write_inventory</code> scope.
              Reconnect the store in <b>Settings → Shopify</b> with Products +
              Inventory write access, then re-push.
            </div>
          </div>
          <button
            onClick={() => setHealthDismissed(true)}
            className="ml-auto text-red-400 hover:text-red-600 shrink-0"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Stat tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatTile icon={Package} label="SKUs" value={stats?.skus ?? 0} />
        <StatTile icon={Layers} label="In stock" value={stats?.units ?? 0} />
        <StatTile
          icon={AlertTriangle}
          label="Low"
          value={stats?.lowCount ?? 0}
          tone="amber"
        />
        <StatTile icon={XCircle} label="Out" value={stats?.outCount ?? 0} tone="red" />
        <div className="bg-white rounded-xl border border-gray-200 p-4 col-span-2 lg:col-span-1">
          <div className="flex items-center gap-2 text-gray-500 text-xs font-medium uppercase tracking-wide">
            <Wallet className="w-4 h-4" />
            Stock value
          </div>
          <div className="text-2xl font-bold text-gray-900 mt-1 tabular-nums">
            {money(stats?.stockValue ?? 0)}
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg p-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                filter === f.key
                  ? 'bg-green-600 text-white'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {categories.length > 0 && (
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sku / item code / alias"
              className="w-64 max-w-[55vw] bg-white border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-gray-500 text-left text-xs uppercase tracking-wide">
                <th className="font-semibold px-4 py-3 w-14"></th>
                <SortTh label="Product / Variant" col="product" sort={sort} dir={dir} onSort={toggleSort} />
                <SortTh label="SKU" col="sku" sort={sort} dir={dir} onSort={toggleSort} />
                <SortTh label="Item Code" col="item_code" sort={sort} dir={dir} onSort={toggleSort} className="text-green-700" />
                <SortTh label="Alias" col="alias" sort={sort} dir={dir} onSort={toggleSort} className="text-green-700" />
                <SortTh label="Price" col="price" sort={sort} dir={dir} onSort={toggleSort} align="right" />
                <SortTh label="Cost" col="cost" sort={sort} dir={dir} onSort={toggleSort} align="right" className="text-green-700" />
                <SortTh label="Shopify" col="shopify" sort={sort} dir={dir} onSort={toggleSort} align="center" />
                <SortTh label="CodesApp" col="codesapp" sort={sort} dir={dir} onSort={toggleSort} align="center" />
                <th className="font-semibold px-2 py-3">Status</th>
                <th className="font-semibold px-2 py-3 text-right pr-4">Sync</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-16 text-center text-gray-400">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto" />
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-16 text-center text-gray-500">
                    No products yet. Click <b>Sync from Shopify</b> to import your
                    catalogue.
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const meta = STOCK_STATUS_META[row.status];
                  return (
                    <tr key={row.id} className="hover:bg-gray-50/70">
                      <td className="px-4 py-3">
                        <Link href={`/inventory/${row.id}`}>
                          {row.image ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={row.image}
                              alt=""
                              className="w-9 h-9 rounded-lg object-cover bg-gray-100"
                            />
                          ) : (
                            <span className="w-9 h-9 rounded-lg bg-gray-100 grid place-items-center text-gray-300">
                              <Package className="w-4 h-4" />
                            </span>
                          )}
                        </Link>
                      </td>
                      <td className="px-2 py-3">
                        <Link
                          href={`/inventory/${row.id}`}
                          className="font-medium text-gray-900 hover:text-green-700"
                        >
                          {row.productTitle}
                        </Link>
                        <div className="text-gray-400 text-xs flex items-center gap-1.5">
                          {row.isBundle && (
                            <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 bg-violet-50 border border-violet-200">
                              <Boxes className="w-3 h-3" />
                              Bundle
                            </span>
                          )}
                          <span>
                            {[row.variantTitle, row.category].filter(Boolean).join(' · ') ||
                              '—'}
                          </span>
                        </div>
                      </td>
                      <td className="px-2 py-3 text-gray-500 tabular-nums">
                        {row.sku || '—'}
                      </td>
                      <td className="px-2 py-3">
                        <EditableCell
                          value={row.itemCode ?? ''}
                          placeholder="—"
                          className="w-28 font-medium text-gray-900"
                          onSave={(v) => saveField(row, 'item_code', v)}
                        />
                      </td>
                      <td className="px-2 py-3">
                        <EditableCell
                          value={row.alias ?? ''}
                          placeholder="—"
                          className="w-24 text-gray-600"
                          onSave={(v) => saveField(row, 'alias', v)}
                        />
                      </td>
                      <td className="px-2 py-3 text-right tabular-nums text-gray-900">
                        {money(row.price)}
                      </td>
                      <td className="px-2 py-3 text-right">
                        <CostCell
                          value={row.costPrice}
                          state={
                            row.costPushStatus === 'error'
                              ? 'error'
                              : row.costPushStatus === 'pending'
                              ? 'pending'
                              : null
                          }
                          title={row.costPushError ?? undefined}
                          onSave={(v) => saveCost(row, v)}
                        />
                      </td>
                      <td className="px-2 py-3 text-center tabular-nums text-gray-500">
                        {row.isBundle ? '—' : row.shopifyQty}
                      </td>
                      <td className="px-2 py-3 text-center">
                        {row.isBundle ? (
                          <span
                            className="inline-block tabular-nums text-violet-700 font-semibold"
                            title="Buildable from component stock"
                          >
                            ≈{row.buildable ?? 0}
                          </span>
                        ) : (
                          <QtyCell
                            value={row.localQty}
                            dirty={row.dirty}
                            onSave={(v) => saveQty(row, v)}
                          />
                        )}
                      </td>
                      <td className="px-2 py-3">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium border ${meta.chip}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-2 py-3 text-right pr-4">
                        {row.isBundle ? (
                          <span className="text-xs text-gray-400" title="Shopify derives a bundle's stock from its components — nothing to push">
                            auto
                          </span>
                        ) : (
                          <div className="inline-flex items-center gap-2 justify-end">
                            <PushStatusChip row={row} />
                            <button
                              onClick={() => pushOne(row)}
                              disabled={pushingId === row.id}
                              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium ${
                                row.dirty
                                  ? 'bg-green-600 text-white hover:bg-green-700'
                                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                              }`}
                            >
                              {pushingId === row.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <ArrowUp className="w-3.5 h-3.5" />
                              )}
                              Push
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-gray-100 text-sm text-gray-500">
          <span>
            <b className="text-green-700">Item Code</b> &amp;{' '}
            <b className="text-green-700">Alias</b> are CodesApp-only — never sent to
            Shopify.
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={doPushChanged}
              disabled={pushingAll || dirtyCount === 0}
              className="inline-flex items-center gap-2 bg-gray-900 hover:bg-black disabled:opacity-40 text-white rounded-lg px-3 py-1.5 text-xs font-medium"
            >
              {pushingAll ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ArrowUpCircle className="w-4 h-4" />
              )}
              Push changed{dirtyCount > 0 ? ` (${dirtyCount})` : ''}
            </button>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="w-8 h-8 grid place-items-center rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="px-2 tabular-nums">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="w-8 h-8 grid place-items-center rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SortTh({
  label,
  col,
  sort,
  dir,
  onSort,
  align,
  className,
}: {
  label: string;
  col: InventorySortKey;
  sort: InventorySortKey;
  dir: 'asc' | 'desc';
  onSort: (k: InventorySortKey) => void;
  align?: 'right' | 'center';
  className?: string;
}) {
  const active = sort === col;
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  const justify = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start';
  return (
    <th className={`font-semibold px-2 py-3 ${alignCls} ${className ?? ''}`}>
      <button
        onClick={() => onSort(col)}
        className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-gray-700 ${justify} ${
          active ? 'text-gray-800' : ''
        }`}
      >
        {label}
        <ArrowUpDown className={`w-3 h-3 ${active ? 'opacity-100' : 'opacity-30'}`} />
        {active && <span className="sr-only">{dir === 'asc' ? 'ascending' : 'descending'}</span>}
      </button>
    </th>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  tone?: 'amber' | 'red';
}) {
  const border =
    tone === 'amber'
      ? 'border-amber-200 bg-amber-50/40'
      : tone === 'red'
      ? 'border-red-200 bg-red-50/40'
      : 'border-gray-200';
  const labelColor =
    tone === 'amber' ? 'text-amber-600' : tone === 'red' ? 'text-red-600' : 'text-gray-500';
  const valueColor =
    tone === 'amber' ? 'text-amber-700' : tone === 'red' ? 'text-red-700' : 'text-gray-900';
  return (
    <div className={`bg-white rounded-xl border p-4 ${border}`}>
      <div
        className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wide ${labelColor}`}
      >
        <Icon className="w-4 h-4" />
        {label}
      </div>
      <div className={`text-2xl font-bold mt-1 tabular-nums ${valueColor}`}>
        {value.toLocaleString('en-PK')}
      </div>
    </div>
  );
}

function EditableCell({
  value,
  placeholder,
  className,
  onSave,
}: {
  value: string;
  placeholder?: string;
  className?: string;
  onSave: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onSave(v.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className={`bg-transparent border border-transparent hover:border-gray-200 focus:border-green-500 focus:bg-white rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-green-500/15 ${className ?? ''}`}
    />
  );
}

function QtyCell({
  value,
  dirty,
  onSave,
}: {
  value: number;
  dirty: boolean;
  onSave: (v: number) => void;
}) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <input
      value={v}
      inputMode="numeric"
      onChange={(e) => setV(e.target.value.replace(/[^0-9]/g, ''))}
      onBlur={() => onSave(Math.max(0, parseInt(v, 10) || 0))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className={`w-16 text-center tabular-nums font-semibold bg-transparent border border-transparent hover:border-gray-200 focus:border-green-500 focus:bg-white rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-green-500/15 ${
        dirty ? 'text-amber-700' : 'text-gray-900'
      }`}
    />
  );
}

function CostCell({
  value,
  state,
  title,
  onSave,
}: {
  value: number | null;
  state: 'pending' | 'error' | null;
  title?: string;
  onSave: (v: number | null) => void;
}) {
  const [v, setV] = useState(value == null ? '' : String(value));
  useEffect(() => setV(value == null ? '' : String(value)), [value]);
  const tone =
    state === 'error' ? 'text-red-700' : state === 'pending' ? 'text-amber-700' : 'text-gray-900';
  return (
    <input
      value={v}
      inputMode="decimal"
      placeholder="—"
      title={title}
      onChange={(e) => setV(e.target.value.replace(/[^0-9.]/g, ''))}
      onBlur={() => {
        const t = v.trim();
        onSave(t === '' ? null : parseFloat(t) || 0);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className={`w-20 text-right tabular-nums bg-transparent border border-transparent hover:border-gray-200 focus:border-green-500 focus:bg-white rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-green-500/15 ${tone}`}
    />
  );
}

/**
 * Per-row push outcome chip (stock + cost). Error wins, then pending, then ok;
 * nothing shown before the first push. Hover an error for the Shopify message.
 */
function PushStatusChip({ row }: { row: InventoryVariant }) {
  const statuses: (PushStatus | null)[] = [row.qtyPushStatus, row.costPushStatus];
  const err = row.qtyPushError || row.costPushError || undefined;
  if (statuses.includes('error')) {
    return (
      <span
        title={err}
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-red-50 text-red-700 border border-red-200 cursor-help"
      >
        <XCircle className="w-3 h-3" />
        failed
      </span>
    );
  }
  if (statuses.includes('pending')) {
    return (
      <span
        title="Queued — syncing to Shopify"
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200"
      >
        <Clock className="w-3 h-3" />
        pending
      </span>
    );
  }
  if (statuses.includes('ok')) {
    return (
      <span
        title="Pushed to Shopify"
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-green-50 text-green-700 border border-green-200"
      >
        <Check className="w-3 h-3" />
        synced
      </span>
    );
  }
  return null;
}
