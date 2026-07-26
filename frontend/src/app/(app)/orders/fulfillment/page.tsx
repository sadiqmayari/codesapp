'use client';

import { useCallback, useEffect, useState } from 'react';
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
  Archive,
  ArchiveRestore,
  Wallet,
  Check,
} from 'lucide-react';
import { ApiError } from '@/lib/api';
import { fmtDate, cn } from '@/lib/utils';
import { useToast } from '@/components/toast';
import { Modal, ConfirmDialog } from '@/components/ui/modal';
import { COUNTRIES } from '@/lib/countries';
import {
  listShipments,
  listLoadsheets,
  generateLoadsheet,
  resolveAddressIssue,
  redeliverShipment,
  markShipmentReceived,
  bookShipment,
  listFulfillmentQueue,
  importShopifyOrders,
  bulkBookShipments,
  updateOrderAddress,
  getCourierPerformance,
  getCourierPendingPayments,
  listPendingPayments,
  settlePayments,
  getQueueIds,
  archiveOrders,
  markOrderConfirmed,
  COURIER_TYPES,
  COURIER_LABELS,
  STATUS_LABELS,
  type Shipment,
  type ShipmentStatus,
  type CourierType,
  type LoadsheetBatch,
  type QueueOrder,
  type QueueStatusFilter,
  type CourierPerformance,
  type PendingPaymentsSummary,
  type PendingPaymentRow,
} from '@/lib/couriers';

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
  const [view, setView] = useState<'queue' | 'shipments' | 'performance' | 'payments'>('queue');
  const [rows, setRows] = useState<Shipment[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [batches, setBatches] = useState<LoadsheetBatch[]>([]);
  const [bookOpen, setBookOpen] = useState(false);

  // The Shipments tab is now the LOADSHEET worklist — only booked shipments not
  // yet on a loadsheet. Every other shipment status lives on the Orders board
  // (its status chips). Server-filtered + paginated.
  const load = useCallback(async () => {
    try {
      const [res, loadsheetBatches] = await Promise.all([
        listShipments({ loadsheetPending: true, page, pageSize }),
        listLoadsheets().catch(() => []),
      ]);
      setRows(res.rows);
      setTotal(res.total);
      setBatches(loadsheetBatches);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load shipments',
      );
      setRows([]);
      setTotal(0);
    }
  }, [toast, page, pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  // Server already filtered/paged; render rows as-is.
  const visible = rows ?? [];
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

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

  if (view === 'queue') {
    return (
      <div className="space-y-4">
        <ViewTabs view={view} setView={setView} />
        <FulfillmentQueue toast={toast} onChanged={load} />
      </div>
    );
  }

  if (view === 'performance') {
    return (
      <div className="space-y-4">
        <ViewTabs view={view} setView={setView} />
        <CourierPerformancePanel toast={toast} />
      </div>
    );
  }

  if (view === 'payments') {
    return (
      <div className="space-y-4">
        <ViewTabs view={view} setView={setView} />
        <PendingPaymentsPanel toast={toast} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ViewTabs view={view} setView={setView} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-gray-600">
            Booked shipments awaiting a loadsheet.
          </p>
          <p className="text-xs text-gray-400">
            Generate a courier loadsheet below, then hand the parcels over. Track
            every other status on the <span className="font-medium">Orders</span> tab.
          </p>
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
          <p className="text-sm text-gray-500">
            No shipments waiting for a loadsheet.
          </p>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {rows !== null && total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-gray-600">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Rows per page</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPage(1);
                setPageSize(Number(e.target.value));
              }}
              className="rounded-lg border border-gray-200 px-2 py-1 text-sm"
            >
              {[25, 50, 100, 200].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className="text-xs text-gray-400">
              {(total === 0 ? 0 : (page - 1) * pageSize + 1).toLocaleString()}–
              {Math.min(page * pageSize, total).toLocaleString()} of{' '}
              {total.toLocaleString()}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(1)}
              disabled={page <= 1}
              className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs disabled:opacity-40"
            >
              First
            </button>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-lg border border-gray-200 p-1.5 disabled:opacity-40"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="flex items-center gap-1">
              Page
              <select
                value={page}
                onChange={(e) => setPage(Number(e.target.value))}
                className="rounded-lg border border-gray-200 px-2 py-1 text-sm"
              >
                {Array.from({ length: lastPage }, (_, i) => i + 1).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              of {lastPage}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
              disabled={page >= lastPage}
              className="rounded-lg border border-gray-200 p-1.5 disabled:opacity-40"
            >
              <ChevronRight size={16} />
            </button>
            <button
              onClick={() => setPage(lastPage)}
              disabled={page >= lastPage}
              className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs disabled:opacity-40"
            >
              Last
            </button>
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
  view: 'queue' | 'shipments' | 'performance' | 'payments';
  setView: (v: 'queue' | 'shipments' | 'performance' | 'payments') => void;
}) {
  const tabs: Array<['queue' | 'shipments' | 'performance' | 'payments', string]> = [
    ['queue', 'Orders'],
    ['shipments', 'Shipments'],
    ['performance', 'Courier performance'],
    ['payments', 'Courier payments'],
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

// Soft confirmation flag shown on queue rows. 'confirmed' orders show a small
// green tick; everything else surfaces WHY it isn't confirmed so the agent can
// decide (booking stays enabled — this is advisory, not a gate).
const CONF_BADGE: Record<
  QueueOrder['confirmationStatus'],
  { label: string; cls: string } | null
> = {
  confirmed: { label: 'Confirmed', cls: 'bg-green-50 text-green-700' },
  pending: { label: 'Awaiting confirm', cls: 'bg-amber-50 text-amber-700' },
  undeliverable: { label: 'No WhatsApp', cls: 'bg-red-50 text-red-700' },
  cancelled: { label: 'Customer cancelled', cls: 'bg-rose-50 text-rose-700' },
  none: { label: 'Not confirmed', cls: 'bg-gray-100 text-gray-600' },
};

// The Orders board: order-state slices + shipment-lifecycle statuses. A
// shipment-status chip shows orders whose CodesApp shipment has that status.
const STATUS_TABS: Array<[QueueStatusFilter, string]> = [
  ['unfulfilled', 'To book'],
  ['booked', 'Booked'],
  ['in_transit', 'In transit'],
  ['out_for_delivery', 'Out for delivery'],
  ['delivered', 'Delivered'],
  ['attempted', 'Attempted'],
  ['failed', 'Failed'],
  ['returned', 'Returned'],
  ['address_issue', 'Address issue'],
  ['all', 'All'],
  ['archived', 'Archived'],
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
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [bookingGid, setBookingGid] = useState<string | null>(null);
  const [confirmingGid, setConfirmingGid] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  // Per-row courier override (gid → courier); falls back to the city suggestion.
  const [rowCourier, setRowCourier] = useState<Record<string, CourierType>>({});
  // Bulk courier override ('' = each order uses its own city suggestion).
  const [bulkCourier, setBulkCourier] = useState<CourierType | ''>('');
  // Order whose shipping address is being edited (modal), or null.
  const [editRow, setEditRow] = useState<QueueOrder | null>(null);
  // Shipment-status actions (moved here from the Shipments tab): a busy row +
  // the RTO "mark received" confirm target.
  const [actBusyGid, setActBusyGid] = useState<string | null>(null);
  const [receiveRow, setReceiveRow] = useState<QueueOrder | null>(null);
  const [receiving, setReceiving] = useState(false);

  // A row can be selected/booked only if it's still unfulfilled, not already
  // booked, and a courier serves its city. (Fulfilled/All views are read-only
  // records — no Book action.)
  const bookable = (r: QueueOrder) =>
    !r.archived &&
    r.fulfillmentStatus === 'unfulfilled' &&
    !r.shipment &&
    !!r.suggestedCourier;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listFulfillmentQueue({
        search,
        page,
        pageSize,
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
  }, [search, page, pageSize, status, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const runImport = async () => {
    setImporting(true);
    try {
      await importShopifyOrders();
      toast.success(
        'Sync started — open orders refresh and archived ones drop off shortly.',
      );
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

  const confirmOrder = async (r: QueueOrder) => {
    setConfirmingGid(r.orderGid);
    try {
      await markOrderConfirmed(r.orderGid);
      toast.success(`Marked ${r.orderName ?? 'order'} confirmed`);
      load();
      onChanged?.();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to mark confirmed',
      );
    } finally {
      setConfirmingGid(null);
    }
  };

  // Shipment-lifecycle actions on a board row (address_issue / attempted /
  // failed). Reload after so the row moves to its new status chip.
  const shipmentAct = async (
    r: QueueOrder,
    fn: () => Promise<unknown>,
    msg: string,
  ) => {
    setActBusyGid(r.orderGid);
    try {
      await fn();
      toast.success(msg);
      load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Action failed');
    } finally {
      setActBusyGid(null);
    }
  };

  const doMarkReceived = async () => {
    if (!receiveRow?.shipment) return;
    setReceiving(true);
    try {
      const res = await markShipmentReceived(receiveRow.shipment.id);
      const bits = [
        res.blacklisted ? 'customer blacklisted' : 'no matching customer',
        res.cancelled ? 'order cancelled' : 'cancel skipped',
        res.archived ? 'archived' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      toast.success(`Return processed — ${bits}`);
      setReceiveRow(null);
      load();
      onChanged?.();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to process return',
      );
    } finally {
      setReceiving(false);
    }
  };

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  };

  // Every displayed row is selectable now (so fulfilled orders can be archived
  // too). Booking still only applies to the bookable subset of the selection.
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.orderGid));
  const selectedBookableGids = rows
    .filter((r) => selected.has(r.orderGid) && bookable(r))
    .map((r) => r.orderGid);

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
      if (rows.every((r) => prev.has(r.orderGid))) return new Set();
      return new Set(rows.map((r) => r.orderGid));
    });
  };

  // Select every order matching the current filter, across all pages.
  const selectAllMatching = async () => {
    setSelectingAll(true);
    try {
      const ids = await getQueueIds({ search, status });
      setSelected(new Set(ids));
      toast.info(`Selected ${ids.length.toLocaleString()} orders`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not select all');
    } finally {
      setSelectingAll(false);
    }
  };

  const bulkArchive = async (archive: boolean) => {
    const gids = Array.from(selected);
    if (!gids.length) return;
    setBulkBusy(true);
    try {
      const res = await archiveOrders(gids, archive);
      toast.success(
        `${archive ? 'Archived' : 'Unarchived'} ${res.done} order${res.done === 1 ? '' : 's'}` +
          (res.failed ? ` · ${res.failed} failed` : ''),
      );
      setSelected(new Set());
      load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Archive failed');
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkBook = async () => {
    const gids = selectedBookableGids;
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

  const lastPage = Math.max(1, Math.ceil(total / pageSize));

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
              ? 'Orders to book — pick a courier without typing order numbers.'
              : status === 'fulfilled'
                ? 'Fulfilled orders — kept on record.'
                : status === 'archived'
                  ? 'Orders archived in Shopify — kept for records.'
                  : status === 'all'
                    ? 'All open orders on record.'
                    : 'Orders whose shipment is at this status.'}
          </p>
          <p className="text-xs text-gray-400">
            {total.toLocaleString()}{' '}
            {status === 'unfulfilled' ? 'to book' : 'orders'}
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
            title="Sync open Shopify orders and reconcile archived ones"
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
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-2">
          <div className="flex flex-wrap items-center gap-2 text-sm text-green-800">
            <span>
              {selected.size.toLocaleString()} order{selected.size === 1 ? '' : 's'} selected
            </span>
            {allSelected && selected.size < total && (
              <button
                onClick={selectAllMatching}
                disabled={selectingAll}
                className="text-xs font-medium text-green-700 underline hover:text-green-900 disabled:opacity-50"
              >
                {selectingAll ? 'Selecting…' : `Select all ${total.toLocaleString()} matching`}
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-gray-600 hover:underline"
            >
              Clear
            </button>

            {status === 'archived' ? (
              <button
                onClick={() => bulkArchive(false)}
                disabled={bulkBusy}
                className="flex items-center gap-1.5 rounded-lg bg-gray-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50"
              >
                {bulkBusy ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <ArchiveRestore size={14} />
                )}
                Unarchive {selected.size}
              </button>
            ) : (
              <>
                {selectedBookableGids.length > 0 && (
                  <>
                    <select
                      value={bulkCourier}
                      onChange={(e) => setBulkCourier(e.target.value as CourierType | '')}
                      className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs text-gray-700"
                      title="Courier to book with"
                    >
                      <option value="">Suggested per city</option>
                      {COURIER_TYPES.map((c) => (
                        <option key={c} value={c}>
                          {COURIER_LABELS[c]}
                        </option>
                      ))}
                    </select>
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
                      Book {selectedBookableGids.length}{' '}
                      {bulkCourier ? `with ${COURIER_LABELS[bulkCourier]}` : 'with suggested'}
                    </button>
                  </>
                )}
                <button
                  onClick={() => bulkArchive(true)}
                  disabled={bulkBusy}
                  className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  title="Archive selected orders in Shopify"
                >
                  {bulkBusy ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Archive size={14} />
                  )}
                  Archive {selected.size}
                </button>
              </>
            )}
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
                    disabled={rows.length === 0}
                    title="Select all orders on this page"
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
                        title={
                          bookable(r)
                            ? 'Select (book and/or archive)'
                            : 'Select (archive)'
                        }
                        className="cursor-pointer"
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
                      {CONF_BADGE[r.confirmationStatus] && (
                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span
                            className={cn(
                              'inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                              CONF_BADGE[r.confirmationStatus]!.cls,
                            )}
                          >
                            {CONF_BADGE[r.confirmationStatus]!.label}
                          </span>
                          {r.confirmationStatus !== 'confirmed' &&
                            !r.archived &&
                            r.fulfillmentStatus === 'unfulfilled' && (
                              <button
                                onClick={() => confirmOrder(r)}
                                disabled={confirmingGid === r.orderGid}
                                className="text-[10px] font-medium text-green-700 hover:underline disabled:opacity-50"
                                title="Manually mark this order confirmed and apply the confirm tag in Shopify"
                              >
                                {confirmingGid === r.orderGid
                                  ? 'Marking…'
                                  : 'Mark confirmed'}
                              </button>
                            )}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      <div className="flex items-center gap-1.5">
                        <span>{r.city || '—'}</span>
                        {!r.archived &&
                          r.fulfillmentStatus === 'unfulfilled' &&
                          !r.shipment && (
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
                      {r.archived || r.shipment || r.fulfillmentStatus !== 'unfulfilled' ? (
                        !r.archived && r.suggestedCourier ? (
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
                      {r.archived ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-500">
                          Archived
                        </span>
                      ) : r.shipment ? (
                        <div className="flex flex-col items-end gap-1">
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs',
                              STATUS_STYLES[r.shipment.status] ??
                                'bg-blue-50 text-blue-700',
                            )}
                          >
                            {STATUS_LABELS[r.shipment.status] ?? r.shipment.status}
                          </span>
                          {r.shipment.status === 'address_issue' && (
                            <button
                              disabled={actBusyGid === r.orderGid}
                              onClick={() =>
                                shipmentAct(
                                  r,
                                  () => resolveAddressIssue(r.shipment!.id),
                                  'Address confirmed — booking queued',
                                )
                              }
                              className="text-[11px] font-medium text-green-700 hover:underline disabled:opacity-50"
                            >
                              Resolve &amp; book
                            </button>
                          )}
                          {(r.shipment.status === 'attempted' ||
                            r.shipment.status === 'failed') && (
                            <div className="flex items-center gap-2">
                              {r.shipment.courierType === 'postex' && (
                                <button
                                  disabled={actBusyGid === r.orderGid}
                                  onClick={() =>
                                    shipmentAct(
                                      r,
                                      () => redeliverShipment(r.shipment!.id),
                                      'Redelivery requested',
                                    )
                                  }
                                  className="text-[11px] font-medium text-green-700 hover:underline disabled:opacity-50"
                                >
                                  Redeliver
                                </button>
                              )}
                              <button
                                disabled={actBusyGid === r.orderGid}
                                onClick={() => setReceiveRow(r)}
                                className="text-[11px] font-medium text-rose-700 hover:underline disabled:opacity-50"
                                title="Parcel returned & received back — blacklist customer, cancel & archive"
                              >
                                Mark received
                              </button>
                            </div>
                          )}
                        </div>
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

      {rows.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-gray-600">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Rows per page</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPage(1);
                setPageSize(Number(e.target.value));
              }}
              className="rounded-lg border border-gray-200 px-2 py-1 text-sm"
            >
              {[25, 50, 100, 200].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className="text-xs text-gray-400">
              {(total === 0 ? 0 : (page - 1) * pageSize + 1).toLocaleString()}–
              {Math.min(page * pageSize, total).toLocaleString()} of{' '}
              {total.toLocaleString()}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(1)}
              disabled={page <= 1}
              className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs disabled:opacity-40"
            >
              First
            </button>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-lg border border-gray-200 p-1.5 disabled:opacity-40"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="flex items-center gap-1">
              Page
              <select
                value={page}
                onChange={(e) => setPage(Number(e.target.value))}
                className="rounded-lg border border-gray-200 px-2 py-1 text-sm"
              >
                {Array.from({ length: lastPage }, (_, i) => i + 1).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              of {lastPage}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
              disabled={page >= lastPage}
              className="rounded-lg border border-gray-200 p-1.5 disabled:opacity-40"
            >
              <ChevronRight size={16} />
            </button>
            <button
              onClick={() => setPage(lastPage)}
              disabled={page >= lastPage}
              className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs disabled:opacity-40"
            >
              Last
            </button>
          </div>
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

      <ConfirmDialog
        open={receiveRow !== null}
        danger
        busy={receiving}
        title="Mark parcel received (RTO)?"
        message={`This blacklists the customer and cancels + archives ${
          receiveRow?.orderName ?? 'the order'
        } in Shopify. Refunds are NOT issued automatically. This can't be undone from here.`}
        confirmLabel="Mark received"
        onConfirm={doMarkReceived}
        onCancel={() => {
          if (!receiving) setReceiveRow(null);
        }}
      />
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

// ── Courier performance (aggregation over the shipments lifecycle) ──

const PERF_RANGES: Array<[string, number]> = [
  ['7d', 7],
  ['30d', 30],
  ['90d', 90],
];

function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

function CourierPerformancePanel({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [data, setData] = useState<CourierPerformance | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    getCourierPerformance({ from })
      .then((d) => !cancelled && setData(d))
      .catch((e) => {
        if (!cancelled) {
          toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load performance');
          setData({ couriers: [], cities: [] });
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [days, toast]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-600">
          Delivery performance by courier — orders placed in the selected window,
          from Shopify tracking updates (covers every order).
        </p>
        <div className="flex overflow-hidden rounded-lg border border-gray-200 bg-white">
          {PERF_RANGES.map(([label, d]) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={cn(
                'px-3 py-1 text-xs',
                days === d ? 'bg-green-600 text-white' : 'text-gray-600 hover:bg-gray-50',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : !data || data.couriers.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
          No delivery data in this window yet. It builds up as Shopify sends
          tracking updates for your fulfilled orders.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {data.couriers
              .slice()
              .sort((a, b) => b.total - a.total)
              .map((c) => (
                <div
                  key={c.courier}
                  className="rounded-xl border border-gray-200 bg-white p-4"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-semibold text-gray-800">{c.courier}</span>
                    <span className="text-xs text-gray-400">{c.total} orders</span>
                  </div>
                  <div className="mb-1 flex items-baseline gap-1">
                    <span className="text-2xl font-bold text-green-600">
                      {pct(c.deliveryRate)}
                    </span>
                    <span className="text-xs text-gray-500">delivered</span>
                  </div>
                  <dl className="mt-2 space-y-1 text-xs text-gray-600">
                    <Stat label="Delivered" value={c.delivered} tone="green" />
                    <Stat
                      label="Returned"
                      value={`${c.returned} (${pct(c.returnRate)})`}
                      tone="rose"
                    />
                    <Stat label="Failed / attempted" value={c.failed} tone="amber" />
                    <Stat label="In progress" value={c.inProgress} />
                    <Stat
                      label="Avg order→delivery"
                      value={c.avgLeadDays == null ? '—' : `${c.avgLeadDays.toFixed(1)} days`}
                    />
                  </dl>
                </div>
              ))}
          </div>

          {data.cities.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
              <div className="border-b border-gray-100 px-4 py-2.5">
                <h3 className="text-sm font-semibold text-gray-800">
                  Best courier by city
                </h3>
                <p className="text-xs text-gray-400">
                  Delivery rate per courier where you&apos;ve shipped — busiest cities first.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-left text-xs text-gray-500">
                    <tr>
                      <th className="px-4 py-2 font-medium">City</th>
                      <th className="px-4 py-2 font-medium text-right">Shipments</th>
                      <th className="px-4 py-2 font-medium">By courier (delivery rate)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {data.cities.slice(0, 40).map((city) => {
                      const best = city.couriers
                        .filter(
                          (c) =>
                            c.deliveryRate != null &&
                            c.delivered + c.returned + c.failed >= 3,
                        )
                        .sort((a, b) => (b.deliveryRate ?? 0) - (a.deliveryRate ?? 0))[0];
                      return (
                        <tr key={city.city} className="hover:bg-gray-50">
                          <td className="px-4 py-2 font-medium text-gray-800">
                            {city.city}
                          </td>
                          <td className="px-4 py-2 text-right text-gray-500">
                            {city.total}
                          </td>
                          <td className="px-4 py-2">
                            <div className="flex flex-wrap gap-1.5">
                              {city.couriers
                                .slice()
                                .sort((a, b) => b.total - a.total)
                                .map((c) => (
                                  <span
                                    key={c.courier}
                                    className={cn(
                                      'rounded-full px-2 py-0.5 text-xs',
                                      best && c.courier === best.courier
                                        ? 'bg-green-100 text-green-800 font-medium'
                                        : 'bg-gray-100 text-gray-600',
                                    )}
                                    title={`${c.delivered} delivered / ${c.returned} returned / ${c.failed} failed of ${c.total}`}
                                  >
                                    {c.courier} {pct(c.deliveryRate)}
                                  </span>
                                ))}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Courier pending payments (COD receivable + reconciliation) ──

function PendingPaymentsPanel({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [summary, setSummary] = useState<PendingPaymentsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [courier, setCourier] = useState<CourierType | null>(null);
  const [rows, setRows] = useState<PendingPaymentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const [listLoading, setListLoading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    try {
      setSummary(await getCourierPendingPayments());
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load payments');
      setSummary({ couriers: [], totals: { shipments: 0, receivable: 0 }, currency: null });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  const loadList = useCallback(async () => {
    if (!courier) return;
    setListLoading(true);
    try {
      const res = await listPendingPayments({ courierType: courier, page, pageSize });
      setRows(res.rows);
      setTotal(res.total);
      setSelected(new Set());
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load list');
    } finally {
      setListLoading(false);
    }
  }, [courier, page, toast]);

  useEffect(() => {
    if (courier) loadList();
  }, [courier, page, loadList]);

  const cur = summary?.currency ?? null;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  const settleSelected = async () => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    setBusy(true);
    try {
      const r = await settlePayments({ shipmentIds: ids });
      toast.success(`Marked ${r.settled} shipment${r.settled === 1 ? '' : 's'} paid`);
      loadSummary();
      loadList();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to settle');
    } finally {
      setBusy(false);
    }
  };

  const settleAll = async () => {
    if (!courier) return;
    setBusy(true);
    try {
      const r = await settlePayments({ courierType: courier });
      toast.success(
        `Marked all ${r.settled} ${COURIER_LABELS[courier]} shipment${r.settled === 1 ? '' : 's'} paid`,
      );
      setCourier(null);
      loadSummary();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to settle');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-400">
        <Loader2 className="animate-spin" size={22} />
      </div>
    );
  }

  // Drill-down: one courier's delivered, unsettled shipments.
  if (courier) {
    const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.shipmentId));
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            onClick={() => setCourier(null)}
            className="text-sm text-gray-600 hover:underline"
          >
            ← All couriers
          </button>
          <button
            onClick={settleAll}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <Check size={14} /> Mark ALL {COURIER_LABELS[courier]} paid
          </button>
        </div>

        {selected.size > 0 && (
          <div className="flex items-center justify-between rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800">
            <span>{selected.size} selected</span>
            <button
              onClick={settleSelected}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              Mark selected paid
            </button>
          </div>
        )}

        {listLoading ? (
          <div className="flex items-center justify-center py-16 text-gray-400">
            <Loader2 className="animate-spin" size={22} />
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
            No pending payments for {COURIER_LABELS[courier]}.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-3 w-8">
                    <input
                      type="checkbox"
                      checked={allOnPage}
                      onChange={() =>
                        setSelected((prev) =>
                          rows.every((r) => prev.has(r.shipmentId))
                            ? new Set()
                            : new Set(rows.map((r) => r.shipmentId)),
                        )
                      }
                      className="cursor-pointer"
                    />
                  </th>
                  <th className="px-4 py-3 font-medium">Order</th>
                  <th className="px-4 py-3 font-medium">City</th>
                  <th className="px-4 py-3 font-medium">Delivered</th>
                  <th className="px-4 py-3 font-medium text-right">Receivable</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <tr key={r.shipmentId} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(r.shipmentId)}
                        onChange={() =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(r.shipmentId)) next.delete(r.shipmentId);
                            else next.add(r.shipmentId);
                            return next;
                          })
                        }
                        className="cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-2.5 font-medium text-gray-900">
                      {r.orderName || '—'}
                      {r.phone && (
                        <span className="block text-xs text-gray-400">{r.phone}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{r.city || '—'}</td>
                    <td className="px-4 py-2.5 text-gray-400 text-xs">
                      {r.deliveredAt ? fmtDate(r.deliveredAt) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium text-gray-800">
                      {r.receivable > 0 ? qmoney(r.receivable, r.currency ?? cur) : (
                        <span className="text-xs text-gray-400">Prepaid / paid</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > pageSize && (
          <div className="flex items-center justify-end gap-2 text-sm text-gray-600">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-lg border border-gray-200 p-1.5 disabled:opacity-40"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-xs">
              Page {page} of {lastPage}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
              disabled={page >= lastPage}
              className="rounded-lg border border-gray-200 p-1.5 disabled:opacity-40"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        )}
      </div>
    );
  }

  // Summary: per-courier receivable + counts.
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-600">
          COD collected by couriers on delivered parcels, pending remittance.
          Prepaid parcels are counted but add nothing to the balance.
        </p>
        <button
          onClick={loadSummary}
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex items-center gap-2 text-gray-500">
          <Wallet size={16} />
          <span className="text-xs uppercase tracking-wide">Total receivable</span>
        </div>
        <p className="mt-1 text-3xl font-bold text-green-600">
          {qmoney(summary?.totals.receivable ?? 0, cur)}
        </p>
        <p className="text-xs text-gray-400">
          across {(summary?.totals.shipments ?? 0).toLocaleString()} delivered parcels
        </p>
      </div>

      {!summary || summary.couriers.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
          No pending courier payments — everything delivered is settled.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {summary.couriers
            .slice()
            .sort((a, b) => b.receivable - a.receivable)
            .map((c) => (
              <button
                key={c.courier}
                onClick={() => {
                  setPage(1);
                  setCourier(c.courier);
                }}
                className="rounded-xl border border-gray-200 bg-white p-4 text-left hover:border-green-300 hover:shadow-sm"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-semibold text-gray-800">
                    {COURIER_LABELS[c.courier]}
                  </span>
                  <span className="text-xs text-gray-400">{c.shipments} parcels</span>
                </div>
                <p className="text-2xl font-bold text-green-600">
                  {qmoney(c.receivable, c.currency ?? cur)}
                </p>
                <p className="mt-1 text-xs text-green-700">Reconcile →</p>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: 'green' | 'rose' | 'amber' | 'orange';
}) {
  const toneClass =
    tone === 'green'
      ? 'text-green-700'
      : tone === 'rose'
        ? 'text-rose-700'
        : tone === 'amber'
          ? 'text-amber-700'
          : tone === 'orange'
            ? 'text-orange-700'
            : 'text-gray-700';
  return (
    <div className="flex items-center justify-between">
      <dt className="text-gray-500">{label}</dt>
      <dd className={cn('font-medium', toneClass)}>{value}</dd>
    </div>
  );
}
