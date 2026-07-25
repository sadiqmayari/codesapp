'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  RefreshCw,
  Truck,
  AlertTriangle,
  FileText,
  Plus,
  Search,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Download,
  Pencil,
} from 'lucide-react';
import { ApiError } from '@/lib/api';
import { fmtDate, cn } from '@/lib/utils';
import { useToast } from '@/components/toast';
import { Modal } from '@/components/ui/modal';
import { COUNTRIES } from '@/lib/countries';
import {
  listShipments,
  listLoadsheets,
  generateLoadsheet,
  resolveAddressIssue,
  redeliverShipment,
  bookShipment,
  listFulfillmentQueue,
  importShopifyOrders,
  bulkBookShipments,
  updateOrderAddress,
  COURIER_TYPES,
  COURIER_LABELS,
  STATUS_LABELS,
  type Shipment,
  type ShipmentStatus,
  type CourierType,
  type LoadsheetBatch,
  type QueueOrder,
  type QueueStatusFilter,
} from '@/lib/couriers';

type Filter = 'all' | ShipmentStatus | 'needs_attention';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'booked', label: 'Booked' },
  { key: 'in_transit', label: 'In transit' },
  { key: 'out_for_delivery', label: 'Out for delivery' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'attempted', label: 'Attempted' },
  { key: 'failed', label: 'Failed' },
  { key: 'address_issue', label: 'Address issue' },
  { key: 'needs_attention', label: 'Needs attention' },
];

const STATUS_STYLES: Record<ShipmentStatus, string> = {
  booked: 'bg-blue-50 text-blue-700',
  in_transit: 'bg-indigo-50 text-indigo-700',
  out_for_delivery: 'bg-violet-50 text-violet-700',
  picked_up: 'bg-sky-50 text-sky-700',
  ready_for_pickup: 'bg-cyan-50 text-cyan-700',
  delivered: 'bg-green-50 text-green-700',
  attempted: 'bg-amber-50 text-amber-700',
  failed: 'bg-red-50 text-red-700',
  address_issue: 'bg-orange-50 text-orange-700',
  cancelled: 'bg-gray-100 text-gray-600',
  returned: 'bg-rose-50 text-rose-700',
};

export default function FulfillmentPage() {
  const toast = useToast();
  const [view, setView] = useState<'queue' | 'shipments'>('queue');
  const [rows, setRows] = useState<Shipment[] | null>(null);
  const [batches, setBatches] = useState<LoadsheetBatch[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [bookOpen, setBookOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [shipments, loadsheetBatches] = await Promise.all([
        listShipments(),
        listLoadsheets().catch(() => []),
      ]);
      setRows(shipments);
      setBatches(loadsheetBatches);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load shipments',
      );
      setRows([]);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    if (!rows) return [];
    if (filter === 'all') return rows;
    // "Needs attention" surfaces rows whose courier sent a status we couldn't
    // map (the n8n Switch nodes silently dropped these) or that failed to book.
    if (filter === 'needs_attention') {
      return rows.filter(
        (r) =>
          (r.last_courier_status_raw && r.status === 'booked') || !!r.booking_error,
      );
    }
    return rows.filter((r) => r.status === filter);
  }, [rows, filter]);

  const runLoadsheet = async (courierType: CourierType) => {
    try {
      await generateLoadsheet(courierType);
      toast.success(`${COURIER_LABELS[courierType]} loadsheet queued`);
      load();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to generate loadsheet',
      );
    }
  };

  const act = async (id: number, fn: () => Promise<unknown>, msg: string) => {
    setBusyId(id);
    try {
      await fn();
      toast.success(msg);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  if (view === 'queue') {
    return (
      <div className="space-y-4">
        <ViewTabs view={view} setView={setView} />
        <FulfillmentQueue toast={toast} onChanged={load} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ViewTabs view={view} setView={setView} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                'px-3 py-1.5 text-xs rounded-lg border',
                filter === f.key
                  ? 'bg-green-600 border-green-600 text-white'
                  : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setBookOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-green-600 text-white hover:bg-green-700"
          >
            <Plus className="w-3.5 h-3.5" /> Book shipment
          </button>
          <button
            onClick={load}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-800 mb-2 flex items-center gap-1.5">
          <FileText className="w-4 h-4" /> Loadsheets
        </h3>
        <div className="flex flex-wrap gap-2 mb-3">
          {COURIER_TYPES.map((c) => (
            <button
              key={c}
              onClick={() => runLoadsheet(c)}
              className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50"
            >
              Generate {COURIER_LABELS[c]}
            </button>
          ))}
        </div>
        {batches.length === 0 ? (
          <p className="text-xs text-gray-400">No loadsheets generated yet.</p>
        ) : (
          <div className="space-y-1">
            {batches.slice(0, 5).map((b) => (
              <div
                key={b.id}
                className="flex items-center gap-3 text-xs text-gray-600"
              >
                <span className="font-medium">{COURIER_LABELS[b.courier_type]}</span>
                <span>{b.shipment_count} shipments</span>
                <span
                  className={cn(
                    'px-1.5 py-0.5 rounded',
                    b.status === 'ready'
                      ? 'bg-green-50 text-green-700'
                      : b.status === 'failed'
                        ? 'bg-red-50 text-red-700'
                        : 'bg-gray-100 text-gray-600',
                  )}
                >
                  {b.status}
                </span>
                {b.pdf_media_url && (
                  <a
                    href={b.pdf_media_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-green-700 hover:underline"
                  >
                    PDF
                  </a>
                )}
                <span className="text-gray-400">{fmtDate(b.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {rows === null ? (
        <div className="flex items-center justify-center py-12 text-gray-400">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : visible.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-10 text-center">
          <Truck className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500">No shipments in this view.</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Order</th>
                  <th className="text-left px-4 py-2 font-medium">Courier</th>
                  <th className="text-left px-4 py-2 font-medium">Tracking</th>
                  <th className="text-left px-4 py-2 font-medium">City</th>
                  <th className="text-left px-4 py-2 font-medium">Status</th>
                  <th className="text-left px-4 py-2 font-medium">Created</th>
                  <th className="text-right px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visible.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 font-medium text-gray-800">
                      {s.shopify_order_name || '—'}
                    </td>
                    <td className="px-4 py-2 text-gray-600">
                      {COURIER_LABELS[s.courier_type]}
                    </td>
                    <td className="px-4 py-2 text-gray-600">
                      {s.courier_tracking_number || '—'}
                    </td>
                    <td className="px-4 py-2 text-gray-600">
                      {s.destination_city || '—'}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={cn(
                          'px-2 py-0.5 rounded-full text-xs',
                          STATUS_STYLES[s.status],
                        )}
                      >
                        {STATUS_LABELS[s.status]}
                      </span>
                      {s.address_issue_reason && (
                        <p className="text-[11px] text-orange-600 mt-1 flex items-start gap-1">
                          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                          {s.address_issue_reason}
                        </p>
                      )}
                      {s.booking_error && (
                        <p className="text-[11px] text-red-600 mt-1">
                          {s.booking_error}
                        </p>
                      )}
                      {s.last_courier_status_raw && s.status === 'booked' && (
                        <p className="text-[11px] text-amber-600 mt-1">
                          Unmapped courier status: {s.last_courier_status_raw}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-2 text-gray-400 text-xs">
                      {fmtDate(s.created_at)}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {s.status === 'address_issue' && (
                        <button
                          disabled={busyId === s.id}
                          onClick={() =>
                            act(
                              s.id,
                              () => resolveAddressIssue(s.id),
                              'Address confirmed — booking queued',
                            )
                          }
                          className="text-xs text-green-700 hover:underline disabled:opacity-50"
                        >
                          Mark resolved &amp; book
                        </button>
                      )}
                      {(s.status === 'attempted' || s.status === 'failed') &&
                        s.courier_type === 'postex' && (
                          <button
                            disabled={busyId === s.id}
                            onClick={() =>
                              act(
                                s.id,
                                () => redeliverShipment(s.id),
                                'Redelivery requested',
                              )
                            }
                            className="text-xs text-green-700 hover:underline disabled:opacity-50 ml-3"
                          >
                            Request redelivery
                          </button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {bookOpen && (
        <BookShipmentModal
          onClose={() => setBookOpen(false)}
          onBooked={() => {
            setBookOpen(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function BookShipmentModal({
  onClose,
  onBooked,
}: {
  onClose: () => void;
  onBooked: () => void;
}) {
  const toast = useToast();
  const [orderName, setOrderName] = useState('');
  const [courierType, setCourierType] = useState<CourierType | ''>('');
  const [busy, setBusy] = useState(false);

  const submit = async (overrideAddressIssue = false) => {
    if (!orderName.trim()) {
      toast.error('Enter a Shopify order number');
      return;
    }
    setBusy(true);
    try {
      const shipment = await bookShipment({
        shopifyOrderName: orderName.trim(),
        courierType: courierType || undefined,
        overrideAddressIssue,
      });
      if (shipment.status === 'address_issue') {
        toast.info(
          `Address issue flagged: ${shipment.address_issue_reason ?? 'incomplete address'}. Review it in the Address issue tab.`,
        );
      } else {
        toast.success('Shipment booking queued');
      }
      onBooked();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to book shipment');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Book shipment">
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            Shopify order number
          </label>
          <input
            value={orderName}
            onChange={(e) => setOrderName(e.target.value)}
            placeholder="#14017"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Courier</label>
          <select
            value={courierType}
            onChange={(e) => setCourierType(e.target.value as CourierType | '')}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value="">Auto-suggest from destination city</option>
            {COURIER_TYPES.map((c) => (
              <option key={c} value={c}>
                {COURIER_LABELS[c]}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-gray-500 mt-1">
            Leave on auto to pick the courier that serves the order&apos;s city.
          </p>
        </div>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={() => submit(false)}
            disabled={busy}
            className="px-4 py-2 text-sm rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50"
          >
            {busy ? 'Booking…' : 'Book shipment'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Phase B: the fulfilment queue (unfulfilled orders from the local mirror) ──

function ViewTabs({
  view,
  setView,
}: {
  view: 'queue' | 'shipments';
  setView: (v: 'queue' | 'shipments') => void;
}) {
  const tabs: Array<['queue' | 'shipments', string]> = [
    ['queue', 'Orders to fulfil'],
    ['shipments', 'Shipments'],
  ];
  return (
    <div className="flex w-fit overflow-hidden rounded-lg border border-gray-200 bg-white">
      {tabs.map(([k, label]) => (
        <button
          key={k}
          onClick={() => setView(k)}
          className={cn(
            'px-4 py-1.5 text-sm',
            view === k
              ? 'bg-green-600 text-white'
              : 'text-gray-600 hover:bg-gray-50',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function qmoney(v: number | null, cur: string | null): string {
  if (v == null) return '—';
  return `${cur ? cur + ' ' : ''}${v.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}`;
}

const QUEUE_PAGE_SIZE = 50;

const STATUS_TABS: Array<[QueueStatusFilter, string]> = [
  ['unfulfilled', 'Unfulfilled'],
  ['fulfilled', 'Fulfilled'],
  ['all', 'All'],
];

function FulfillmentQueue({
  toast,
  onChanged,
}: {
  toast: ReturnType<typeof useToast>;
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<QueueOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<QueueStatusFilter>('unfulfilled');
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [bookingGid, setBookingGid] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Per-row courier override (gid → courier); falls back to the city suggestion.
  const [rowCourier, setRowCourier] = useState<Record<string, CourierType>>({});
  // Bulk courier override ('' = each order uses its own city suggestion).
  const [bulkCourier, setBulkCourier] = useState<CourierType | ''>('');
  // Order whose shipping address is being edited (modal), or null.
  const [editRow, setEditRow] = useState<QueueOrder | null>(null);

  // A row can be selected/booked only if it's still unfulfilled, not already
  // booked, and a courier serves its city. (Fulfilled/All views are read-only
  // records — no Book action.)
  const bookable = (r: QueueOrder) =>
    r.fulfillmentStatus === 'unfulfilled' && !r.shipment && !!r.suggestedCourier;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listFulfillmentQueue({
        search,
        page,
        pageSize: QUEUE_PAGE_SIZE,
        status,
      });
      setRows(res.rows);
      setTotal(res.total);
      setSelected(new Set()); // clear selection on any reload/page change
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load orders');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [search, page, status, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const runImport = async () => {
    setImporting(true);
    try {
      await importShopifyOrders();
      toast.success('Import started — open orders will appear shortly.');
      setTimeout(load, 5000);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Import failed to start');
    } finally {
      setImporting(false);
    }
  };

  const book = async (r: QueueOrder) => {
    if (!r.orderName) return;
    const courier = rowCourier[r.orderGid] ?? r.suggestedCourier ?? undefined;
    setBookingGid(r.orderGid);
    try {
      await bookShipment({
        shopifyOrderName: r.orderName,
        courierType: courier,
      });
      toast.success(
        `Booked ${r.orderName}${courier ? ` with ${COURIER_LABELS[courier]}` : ''}`,
      );
      load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Booking failed');
    } finally {
      setBookingGid(null);
    }
  };

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  };

  const bookableRows = rows.filter(bookable);
  const allSelected =
    bookableRows.length > 0 && bookableRows.every((r) => selected.has(r.orderGid));

  const toggleOne = (gid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => {
      if (bookableRows.every((r) => prev.has(r.orderGid))) return new Set();
      return new Set(bookableRows.map((r) => r.orderGid));
    });
  };

  const bulkBook = async () => {
    const gids = Array.from(selected);
    if (!gids.length) return;
    setBulkBusy(true);
    try {
      const res = await bulkBookShipments(gids, bulkCourier || undefined);
      toast.success(
        `Booking ${res.queued} order${res.queued === 1 ? '' : 's'}${
          bulkCourier ? ` with ${COURIER_LABELS[bulkCourier]}` : ' with suggested courier'
        } — statuses update shortly.`,
      );
      setSelected(new Set());
      // Bulk runs in the background; give the worker a head start then refresh.
      setTimeout(load, 6000);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Bulk booking failed');
    } finally {
      setBulkBusy(false);
    }
  };

  const lastPage = Math.max(1, Math.ceil(total / QUEUE_PAGE_SIZE));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="mb-1.5 flex w-fit overflow-hidden rounded-lg border border-gray-200 bg-white">
            {STATUS_TABS.map(([k, label]) => (
              <button
                key={k}
                onClick={() => {
                  setPage(1);
                  setStatus(k);
                }}
                className={cn(
                  'px-3 py-1 text-xs',
                  status === k
                    ? 'bg-green-600 text-white'
                    : 'text-gray-600 hover:bg-gray-50',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-sm text-gray-600">
            {status === 'unfulfilled'
              ? 'Unfulfilled Shopify orders — book a courier without typing order numbers.'
              : status === 'fulfilled'
                ? 'Fulfilled orders — kept on record (read-only).'
                : 'All open orders on record.'}
          </p>
          <p className="text-xs text-gray-400">
            {total.toLocaleString()}{' '}
            {status === 'unfulfilled' ? 'to fulfil' : 'orders'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <form onSubmit={submitSearch} className="relative">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Order #, name, phone, city"
              className="w-56 rounded-lg border border-gray-300 py-1.5 pl-8 pr-3 text-sm"
            />
          </form>
          <button
            onClick={runImport}
            disabled={importing}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            title="One-time import of all open Shopify orders"
          >
            {importing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            Import from Shopify
          </button>
          <button
            onClick={load}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-2">
          <span className="text-sm text-green-800">
            {selected.size} order{selected.size === 1 ? '' : 's'} selected
          </span>
          <div className="flex items-center gap-2">
            <select
              value={bulkCourier}
              onChange={(e) => setBulkCourier(e.target.value as CourierType | '')}
              className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs text-gray-700"
              title="Courier to book all selected orders with"
            >
              <option value="">Suggested per city</option>
              {COURIER_TYPES.map((c) => (
                <option key={c} value={c}>
                  {COURIER_LABELS[c]}
                </option>
              ))}
            </select>
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-gray-600 hover:underline"
            >
              Clear
            </button>
            <button
              onClick={bulkBook}
              disabled={bulkBusy}
              className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {bulkBusy ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Truck size={14} />
              )}
              Book {selected.size}{' '}
              {bulkCourier ? `with ${COURIER_LABELS[bulkCourier]}` : 'with suggested'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
          {search
            ? 'No orders match your search.'
            : 'No unfulfilled orders. Click “Import from Shopify” to pull your open orders.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3 w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    disabled={bookableRows.length === 0}
                    title="Select all bookable orders on this page"
                    className="cursor-pointer"
                  />
                </th>
                <th className="px-4 py-3 font-medium">Order</th>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">City</th>
                <th className="px-4 py-3 font-medium">Items</th>
                <th className="px-4 py-3 font-medium text-right">COD / Value</th>
                <th className="px-4 py-3 font-medium">Courier</th>
                <th className="px-4 py-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => {
                const itemCount = r.items.reduce(
                  (n, it) => n + (it.quantity || 0),
                  0,
                );
                const isCod = (r.totalOutstanding ?? 0) > 0;
                return (
                  <tr
                    key={r.orderGid}
                    className={cn(
                      'hover:bg-gray-50',
                      selected.has(r.orderGid) && 'bg-green-50/60',
                    )}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(r.orderGid)}
                        onChange={() => toggleOne(r.orderGid)}
                        disabled={!bookable(r)}
                        title={
                          bookable(r)
                            ? 'Select for bulk booking'
                            : r.shipment
                              ? 'Already booked'
                              : 'No courier serves this city'
                        }
                        className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                      />
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                      {r.orderName || '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {r.customerName || '—'}
                      {r.phone && (
                        <span className="block text-xs text-gray-400">
                          {r.phone}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      <div className="flex items-center gap-1.5">
                        <span>{r.city || '—'}</span>
                        {r.fulfillmentStatus === 'unfulfilled' && !r.shipment && (
                          <button
                            onClick={() => setEditRow(r)}
                            title="Edit shipping address (updates Shopify too)"
                            className="text-gray-300 hover:text-green-600"
                          >
                            <Pencil size={13} />
                          </button>
                        )}
                      </div>
                      {r.address && (
                        <span
                          className="block max-w-[180px] truncate text-[11px] text-gray-400"
                          title={r.address}
                        >
                          {r.address}
                        </span>
                      )}
                    </td>
                    <td
                      className="px-4 py-3 text-gray-600 max-w-[220px] truncate"
                      title={r.itemsSummary ?? ''}
                    >
                      {itemCount
                        ? `${itemCount} item${itemCount === 1 ? '' : 's'}`
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <span className="font-medium text-gray-800">
                        {qmoney(
                          isCod ? r.totalOutstanding : r.totalPrice,
                          r.currency,
                        )}
                      </span>
                      <span
                        className={cn(
                          'block text-[11px]',
                          isCod ? 'text-amber-600' : 'text-green-600',
                        )}
                      >
                        {isCod ? 'COD' : 'Paid'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {r.shipment || r.fulfillmentStatus !== 'unfulfilled' ? (
                        r.suggestedCourier ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                            <Truck size={12} />
                            {COURIER_LABELS[r.suggestedCourier]}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )
                      ) : r.availableCouriers.length > 0 ? (
                        <select
                          value={rowCourier[r.orderGid] ?? r.suggestedCourier ?? ''}
                          onChange={(e) =>
                            setRowCourier((prev) => ({
                              ...prev,
                              [r.orderGid]: e.target.value as CourierType,
                            }))
                          }
                          className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700"
                          title="Courier for this order"
                        >
                          {r.availableCouriers.map((c) => (
                            <option key={c} value={c}>
                              {COURIER_LABELS[c]}
                              {c === r.suggestedCourier ? ' (suggested)' : ''}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700"
                          title="No courier serves this city yet — add a city mapping in Settings → Courier"
                        >
                          <MapPin size={12} /> No mapping
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {r.shipment ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-xs text-blue-700">
                          {STATUS_LABELS[r.shipment.status] ?? r.shipment.status}
                        </span>
                      ) : r.fulfillmentStatus !== 'unfulfilled' ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2.5 py-1 text-xs capitalize text-green-700">
                          {r.fulfillmentStatus ?? 'fulfilled'}
                        </span>
                      ) : (
                        <button
                          onClick={() => book(r)}
                          disabled={
                            bookingGid === r.orderGid || !r.suggestedCourier
                          }
                          className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                          title={
                            (rowCourier[r.orderGid] ?? r.suggestedCourier)
                              ? `Book with ${COURIER_LABELS[rowCourier[r.orderGid] ?? r.suggestedCourier!]}`
                              : 'No courier configured for this city'
                          }
                        >
                          {bookingGid === r.orderGid ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Truck size={14} />
                          )}
                          Book
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {total > QUEUE_PAGE_SIZE && (
        <div className="flex items-center justify-end gap-2 text-sm text-gray-600">
          <span>
            Page {page} of {lastPage}
          </span>
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="rounded-lg border border-gray-200 p-1.5 disabled:opacity-40"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
            disabled={page >= lastPage}
            className="rounded-lg border border-gray-200 p-1.5 disabled:opacity-40"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}

      {editRow && (
        <EditAddressModal
          order={editRow}
          onClose={() => setEditRow(null)}
          onSaved={() => {
            setEditRow(null);
            load();
            onChanged?.();
          }}
          toast={toast}
        />
      )}
    </div>
  );
}

function EditAddressModal({
  order,
  onClose,
  onSaved,
  toast,
}: {
  order: QueueOrder;
  onClose: () => void;
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [name, setName] = useState(order.customerName ?? '');
  const [phone, setPhone] = useState(order.phone ?? '');
  const [address1, setAddress1] = useState(order.address ?? '');
  const [city, setCity] = useState(order.city ?? '');
  const [countryCode, setCountryCode] = useState('PK');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!address1.trim() || !city.trim()) {
      toast.error('Address and city are required');
      return;
    }
    setBusy(true);
    try {
      await updateOrderAddress({
        orderGid: order.orderGid,
        name: name.trim() || undefined,
        phone: phone.trim() || undefined,
        address1: address1.trim(),
        city: city.trim(),
        countryCode,
      });
      toast.success('Address updated in Shopify & CodesApp');
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to update address');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Edit address — ${order.orderName ?? 'order'}`}>
      <div className="space-y-3">
        <p className="text-xs text-gray-500">
          Saving updates the shipping address on the Shopify order and here, so
          the courier books to the corrected address.
        </p>
        <Field label="Customer name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Phone">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+92…"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Address">
          <textarea
            value={address1}
            onChange={(e) => setAddress1(e.target.value)}
            rows={2}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="City">
            <input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Country">
            <select
              value={countryCode}
              onChange={(e) => setCountryCode(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save address'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs text-gray-500">{label}</label>
      {children}
    </div>
  );
}
