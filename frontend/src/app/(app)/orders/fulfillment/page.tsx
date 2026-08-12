'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
  ExternalLink,
  MapPinOff,
  Package,
  Landmark,
  CreditCard,
  CheckCircle2,
  XCircle,
  Clock,
} from 'lucide-react';
import { EditItemsModal } from '@/components/orders/edit-items-modal';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtDateTime, cn } from '@/lib/utils';
import { useToast } from '@/components/toast';
import { Modal, ConfirmDialog } from '@/components/ui/modal';
import { CityAutocomplete } from '@/components/ui/city-autocomplete';
import { COUNTRIES } from '@/lib/countries';
import {
  listShipments,
  listLoadsheets,
  generateLoadsheet,
  resolveAddressIssue,
  markShipmentReceived,
  sendShipperAdvice,
  cancelBooking,
  generateLabels,
  downloadSlips,
  loadsheetPicklist,
  generateLoadsheetsForSelection,
  bookShipment,
  listFulfillmentQueue,
  importShopifyOrders,
  reconcileShopifyOrders,
  bulkBookShipments,
  bookingProgress,
  type BookingProgressRow,
  updateOrderAddress,
  getCourierPerformance,
  getCourierPendingPayments,
  listPendingPayments,
  settlePayments,
  getPrepaidPayments,
  listPrepaidPayments,
  reconcileCardPayments,
  getQueueIds,
  archiveOrders,
  markOrderConfirmed,
  markWrongAddress,
  resendConfirmation,
  bulkReceiveShipments,
  syncCourierStatuses,
  getTrackingHistory,
  COURIER_TYPES,
  COURIER_LABELS,
  type TrackingCheckpoint,
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
  type PrepaidPaymentsSummary,
  type PrepaidPaymentRow,
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
  // Label printing: selected shipment ids (must be one courier) + busy flag.
  const [labelSel, setLabelSel] = useState<Set<number>>(new Set());
  const [labelBusy, setLabelBusy] = useState(false);
  const [slipBusy, setSlipBusy] = useState(false);
  const [picklistBusyId, setPicklistBusyId] = useState<number | null>(null);
  const [loadsheetBusy, setLoadsheetBusy] = useState(false);
  // Per-courier filter (mirrors the Orders board).
  const [courierFilter, setCourierFilter] = useState<CourierType | 'all'>('all');

  // The Shipments tab is now the LOADSHEET worklist — only booked shipments not
  // yet on a loadsheet. Every other shipment status lives on the Orders board
  // (its status chips). Server-filtered + paginated.
  const load = useCallback(async () => {
    try {
      const [res, loadsheetBatches] = await Promise.all([
        listShipments({
          loadsheetPending: true,
          courierType: courierFilter === 'all' ? undefined : courierFilter,
          page,
          pageSize,
        }),
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
  }, [toast, page, pageSize, courierFilter]);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-poll while any loadsheet is still generating: the worker takes a few
  // seconds per courier, so without this the "generating" chip never updates to
  // ready/failed until a manual refresh (looked like nothing happened). Self-
  // terminating — reschedules only while a batch is still generating.
  useEffect(() => {
    if (!batches.some((b) => b.status === 'generating')) return;
    const id = setTimeout(() => load(), 2500);
    return () => clearTimeout(id);
  }, [batches, load]);

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

  // Courier of the current label selection (all selected rows must share one).
  const selCourier: CourierType | null = (() => {
    const chosen = (rows ?? []).filter((s) => labelSel.has(s.id));
    if (!chosen.length) return null;
    const c = chosen[0].courier_type;
    return chosen.every((s) => s.courier_type === c) ? c : null;
  })();
  const selMultiCourier =
    labelSel.size > 0 &&
    new Set((rows ?? []).filter((s) => labelSel.has(s.id)).map((s) => s.courier_type)).size > 1;

  const printLabels = async (ids: number[]) => {
    if (!ids.length) return;
    setLabelBusy(true);
    try {
      const res = await generateLabels(ids);
      const w = window.open('', '_blank');
      if (!w) {
        toast.error('Allow pop-ups to print labels.');
        return;
      }
      const frames = res.labels
        .map(
          (l) =>
            `<div class="lbl"><iframe src="${l.url}" title="${l.trackingNumber}"></iframe></div>`,
        )
        .join('');
      w.document.write(`<!doctype html><html><head><title>Labels — ${res.courier}</title>
<style>
  body{margin:0;font-family:system-ui,sans-serif}
  .bar{position:sticky;top:0;background:#111;color:#fff;padding:8px 12px;display:flex;gap:12px;align-items:center}
  .bar button{background:#22c55e;color:#fff;border:0;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px}
  .lbl{page-break-after:always;height:100vh}
  .lbl iframe{width:100%;height:100%;border:0}
  @media print{.bar{display:none}.lbl{height:auto}}
</style></head><body>
<div class="bar"><strong>${res.courier} labels (${res.labels.length})</strong>
<button onclick="window.print()">Print all</button></div>
${frames}</body></html>`);
      w.document.close();
      setLabelSel(new Set());
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to fetch labels');
    } finally {
      setLabelBusy(false);
    }
  };

  // One downloadable PDF of the courier's slips, 2 per A4 page (Trax/PostEx/Rocket).
  const downloadSlipSheet = async (ids: number[]) => {
    if (!ids.length) return;
    setSlipBusy(true);
    try {
      const res = await downloadSlips(ids);
      // Trigger a download of the merged PDF (served from /storage).
      const a = document.createElement('a');
      a.href = res.url;
      a.download = `slips-${res.courier}-${res.parcels}.pdf`;
      a.target = '_blank';
      a.rel = 'noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success(`${res.courier}: ${res.parcels} slips (2 per page)`);
      setLabelSel(new Set());
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to build slips');
    } finally {
      setSlipBusy(false);
    }
  };

  // One click → a loadsheet per courier for the selected parcels (parallel).
  const runSelectionLoadsheets = async (ids: number[]) => {
    if (!ids.length) return;
    setLoadsheetBusy(true);
    try {
      const res = await generateLoadsheetsForSelection(ids);
      const summary = res.batches
        .map((b) => `${COURIER_LABELS[b.courier]} (${b.count})`)
        .join(', ');
      toast.success(
        res.batches.length
          ? `Generating loadsheets: ${summary}`
          : 'No loadsheet-eligible parcels in the selection.',
      );
      setLabelSel(new Set());
      load();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to generate loadsheets',
      );
    } finally {
      setLoadsheetBusy(false);
    }
  };

  // Downloadable product pick sheet for a loadsheet batch.
  const downloadPicklist = async (batchId: number) => {
    setPicklistBusyId(batchId);
    try {
      const res = await loadsheetPicklist(batchId);
      const a = document.createElement('a');
      a.href = res.url;
      a.download = `picklist-loadsheet-${batchId}.pdf`;
      a.target = '_blank';
      a.rel = 'noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success(`Picklist: ${res.skus} SKUs · ${res.totalUnits} units`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to build picklist');
    } finally {
      setPicklistBusyId(null);
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
        <PrepaidPaymentsPanel toast={toast} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ViewTabs view={view} setView={setView} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-gray-600">
            Booked &amp; ready-for-pickup parcels awaiting a loadsheet.
          </p>
          <p className="text-xs text-gray-400">
            Select parcels and generate loadsheets (one per courier, in parallel),
            then download slips. Every other status lives on the{' '}
            <span className="font-medium">Orders</span> tab.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={courierFilter}
            onChange={(e) => {
              setPage(1);
              setCourierFilter(e.target.value as CourierType | 'all');
            }}
            className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-700"
            title="Filter by courier"
          >
            <option value="all">All couriers</option>
            {COURIER_TYPES.map((c) => (
              <option key={c} value={c}>
                {COURIER_LABELS[c]}
              </option>
            ))}
          </select>
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
            {batches.slice(0, 8).map((b) => (
              <div
                key={b.id}
                className="flex items-center gap-3 text-xs text-gray-600"
              >
                <span className="font-medium">{COURIER_LABELS[b.courier_type]}</span>
                <span>{b.shipment_count} shipments</span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 px-1.5 py-0.5 rounded',
                    b.status === 'ready'
                      ? 'bg-green-50 text-green-700'
                      : b.status === 'failed'
                        ? 'bg-red-50 text-red-700'
                        : 'bg-amber-50 text-amber-700',
                  )}
                  title={b.status === 'failed' && b.error ? b.error : undefined}
                >
                  {b.status === 'generating' && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  )}
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
                <button
                  onClick={() => downloadPicklist(b.id)}
                  disabled={picklistBusyId === b.id}
                  className="inline-flex items-center gap-1 text-gray-500 hover:text-gray-800 disabled:opacity-50"
                  title="Download product pick sheet for this loadsheet"
                >
                  {picklistBusyId === b.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Package className="h-3 w-3" />
                  )}
                  Picklist
                </button>
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
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2">
            <p className="text-xs text-gray-500">
              {labelSel.size > 0
                ? `${labelSel.size} selected${selCourier ? ` · ${COURIER_LABELS[selCourier]}` : ''}`
                : 'Select parcels to print shipping labels (one courier at a time).'}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => runSelectionLoadsheets(Array.from(labelSel))}
                disabled={loadsheetBusy || labelSel.size === 0}
                title="Generate a loadsheet per courier for the selected parcels (parallel)"
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700 disabled:opacity-40"
              >
                {loadsheetBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileText className="h-3.5 w-3.5" />
                )}
                Generate loadsheets
              </button>
              {selMultiCourier && (
                <span className="text-[11px] text-amber-600">
                  Slips/labels print per courier — select one courier.
                </span>
              )}
              <button
                onClick={() => downloadSlipSheet(Array.from(labelSel))}
                disabled={
                  slipBusy ||
                  labelSel.size === 0 ||
                  !selCourier ||
                  selCourier === 'leopards'
                }
                title={
                  selCourier === 'leopards'
                    ? 'Leopards slips come as one combined file — use Print labels'
                    : 'Download one PDF, 2 slips per page'
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs text-white hover:bg-green-700 disabled:opacity-40"
              >
                {slipBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                Download slips (2-up)
              </button>
              <button
                onClick={() => printLabels(Array.from(labelSel))}
                disabled={labelBusy || labelSel.size === 0 || !selCourier}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-40"
              >
                {labelBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileText className="h-3.5 w-3.5" />
                )}
                Print labels
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-3 w-8">
                    <input
                      type="checkbox"
                      checked={visible.length > 0 && visible.every((s) => labelSel.has(s.id))}
                      onChange={(e) =>
                        setLabelSel(
                          e.target.checked ? new Set(visible.map((s) => s.id)) : new Set(),
                        )
                      }
                    />
                  </th>
                  <th className="px-4 py-3 font-medium">Order</th>
                  <th className="px-4 py-3 font-medium">Customer</th>
                  <th className="px-4 py-3 font-medium">City</th>
                  <th className="px-4 py-3 font-medium">Items</th>
                  <th className="px-4 py-3 font-medium text-right">COD / Value</th>
                  <th className="px-4 py-3 font-medium">Courier</th>
                  <th className="px-4 py-3 font-medium">Tracking</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visible.map((s) => {
                  const cod =
                    s.total_outstanding != null && s.total_outstanding > 0
                      ? s.total_outstanding
                      : s.total_price ?? null;
                  const cur = s.currency || 'Rs';
                  return (
                    <tr key={s.id} className="hover:bg-gray-50 align-top">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={labelSel.has(s.id)}
                          onChange={(e) =>
                            setLabelSel((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(s.id);
                              else next.delete(s.id);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-800 whitespace-nowrap">
                        {s.shopify_order_name || '—'}
                        <div className="text-[11px] font-normal text-gray-400">
                          {fmtDate(s.created_at)}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        <div>{s.customer_name || '—'}</div>
                        {s.phone && (
                          <div className="text-[11px] text-gray-400">{s.phone}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                        {s.order_city || s.destination_city || '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-600 max-w-[220px]">
                        <span className="line-clamp-2">{s.items_summary || '—'}</span>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700 whitespace-nowrap">
                        {cod != null ? `${cur} ${Number(cod).toLocaleString()}` : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                        {COURIER_LABELS[s.courier_type]}
                      </td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                        {s.courier_tracking_number || '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            'px-2 py-0.5 rounded-full text-xs whitespace-nowrap',
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
                          <p className="text-[11px] text-red-600 mt-1">{s.booking_error}</p>
                        )}
                      </td>
                    </tr>
                  );
                })}
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
  ['all', 'All'],
  ['unfulfilled', 'Unfulfilled'],
  ['booked', 'Booked'],
  ['in_transit', 'In transit'],
  ['out_for_delivery', 'Out for delivery'],
  ['delivered', 'Delivered'],
  ['attempted', 'Attempted'],
  ['failed', 'Failed'],
  ['returned', 'Returned'],
  ['address_issue', 'Address issue'],
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
  const [status, setStatus] = useState<QueueStatusFilter>('all');
  // Filter the board to a single courier (or 'all'). Applies under every tab.
  const [courierFilter, setCourierFilter] = useState<CourierType | 'all'>('all');
  // To-book sub-tab: all | confirmed | awaiting confirmation.
  const [confSub, setConfSub] = useState<'all' | 'confirmed' | 'unconfirmed'>('all');
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(true);
  const [wrongAddrGid, setWrongAddrGid] = useState<string | null>(null);
  // Bulk RTO receive: comma-separated order-number box + confirm state.
  const [receiveInput, setReceiveInput] = useState('');
  const [bulkReceiveBusy, setBulkReceiveBusy] = useState(false);
  const [confirmBulkReceive, setConfirmBulkReceive] = useState<
    { kind: 'selected'; ids: number[] } | { kind: 'names'; names: string[] } | null
  >(null);
  const [importing, setImporting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [bookingGid, setBookingGid] = useState<string | null>(null);
  const [confirmingGid, setConfirmingGid] = useState<string | null>(null);
  const [resendGid, setResendGid] = useState<string | null>(null);
  // Row whose parcel we're viewing on the courier's own portal (iframe modal).
  const [trackRow, setTrackRow] = useState<QueueOrder | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  // Per-row courier override (gid → courier); falls back to the city suggestion.
  const [rowCourier, setRowCourier] = useState<Record<string, CourierType>>({});
  // Bulk courier override ('' = each order uses its own city suggestion).
  const [bulkCourier, setBulkCourier] = useState<CourierType | ''>('');
  // Live bulk-book progress panel (null = closed).
  const [progress, setProgress] = useState<{
    gids: string[];
    meta: Record<string, { orderName: string; courier?: CourierType }>;
  } | null>(null);
  // Order whose shipping address is being edited (modal), or null.
  const [editRow, setEditRow] = useState<QueueOrder | null>(null);
  // Order whose line items are being edited (modal), or null.
  const [editItemsRow, setEditItemsRow] = useState<QueueOrder | null>(null);
  // Shipment-status actions (moved here from the Shipments tab): a busy row +
  // the RTO "mark received" confirm target.
  const [actBusyGid, setActBusyGid] = useState<string | null>(null);
  const [receiveRow, setReceiveRow] = useState<QueueOrder | null>(null);
  const [receiving, setReceiving] = useState(false);
  // Shipper-advice modal target (an attempted parcel), or null.
  const [adviceRow, setAdviceRow] = useState<QueueOrder | null>(null);
  // Cancel-booking confirm target, or null.
  const [cancelRow, setCancelRow] = useState<QueueOrder | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // A row can be selected/booked only if it's still unfulfilled, not already
  // booked, and a courier serves its city. (Fulfilled/All views are read-only
  // records — no Book action.)
  const bookable = (r: QueueOrder) =>
    !r.archived &&
    r.fulfillmentStatus === 'unfulfilled' &&
    !r.shipment &&
    !!r.suggestedCourier;

  // `silent` refetches without the full-table spinner (keeps the table mounted
  // so the user's scroll position survives); `keepSelection` leaves the
  // checkbox selection intact. Both default OFF — used for in-place single-row
  // edits (e.g. correcting an address) so the user isn't thrown back to the top
  // with their selection cleared. Defensive `=== true` reads mean a stray arg
  // (an event object from a bare `onClick={load}`) behaves exactly as before.
  const load = useCallback(
    async (opts?: { silent?: boolean; keepSelection?: boolean }) => {
      const silent = opts?.silent === true;
      const keepSelection = opts?.keepSelection === true;
      if (!silent) setLoading(true);
      try {
        const res = await listFulfillmentQueue({
          search,
          page,
          pageSize,
          status,
          // Confirmation sub-tab only applies to the To-book (unfulfilled) view.
          confirmation:
            status === 'unfulfilled' && confSub !== 'all' ? confSub : undefined,
          courier: courierFilter === 'all' ? undefined : courierFilter,
        });
        setRows(res.rows);
        setTotal(res.total);
        if (!keepSelection) setSelected(new Set()); // clear on reload/page change
      } catch (e) {
        toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load orders');
        if (!silent) setRows([]);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [search, page, pageSize, status, confSub, courierFilter, toast],
  );

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

  const [reconciling, setReconciling] = useState(false);
  const runReconcile = async () => {
    setReconciling(true);
    try {
      await reconcileShopifyOrders();
      toast.success(
        'Reconcile started — orders archived/cancelled in Shopify will drop off shortly.',
      );
      setTimeout(load, 6000);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Reconcile failed to start');
    } finally {
      setReconciling(false);
    }
  };

  const runSyncStatuses = async () => {
    setSyncing(true);
    try {
      await syncCourierStatuses();
      toast.success(
        'Courier status sync started — statuses refresh in the background.',
      );
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Could not start status sync',
      );
    } finally {
      setSyncing(false);
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

  const resendConfirm = async (r: QueueOrder) => {
    setResendGid(r.orderGid);
    try {
      await resendConfirmation(r.orderGid);
      toast.success(`Confirmation template resent for ${r.orderName ?? 'order'}`);
      load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to resend confirmation');
    } finally {
      setResendGid(null);
    }
  };

  // Statuses whose parcels can be "received back" (RTO) — i.e. the courier is
  // sending the parcel back to the tenant. Attempted is NOT one: an attempted
  // delivery is still in progress (re-attempt / shipper advice), it hasn't
  // been returned yet, so it gets no "receive" action.
  const RECEIVABLE_STATUSES = ['failed', 'returned'];
  const isReceivableView = status === 'failed' || status === 'returned';
  // Selected rows that have a receivable shipment → their shipment ids.
  const selectedReceivableIds = rows
    .filter(
      (r) =>
        selected.has(r.orderGid) &&
        r.shipment &&
        RECEIVABLE_STATUSES.includes(r.shipment.status),
    )
    .map((r) => r.shipment!.id);

  const runBulkReceive = async (
    body: { shipmentIds?: number[]; orderNames?: string[] },
  ) => {
    setBulkReceiveBusy(true);
    try {
      const res = await bulkReceiveShipments(body);
      const bits = [
        `${res.received} received`,
        res.skipped ? `${res.skipped} skipped` : null,
        res.notFound.length ? `${res.notFound.length} not found` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      toast.success(`Bulk receive — ${bits}`);
      if (res.notFound.length) {
        toast.info(`Not found: ${res.notFound.slice(0, 20).join(', ')}`);
      }
      setReceiveInput('');
      setConfirmBulkReceive(null);
      setSelected(new Set());
      load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Bulk receive failed');
    } finally {
      setBulkReceiveBusy(false);
    }
  };

  const parseOrderNames = (raw: string) =>
    raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  // Fetch + open the courier slip/label for a single booked parcel.
  const [slipBusy, setSlipBusy] = useState<number | null>(null);
  const openSlip = async (shipmentId: number) => {
    setSlipBusy(shipmentId);
    try {
      const res = await generateLabels([shipmentId]);
      if (!res.labels.length) {
        toast.info('No slip available for this parcel yet.');
        return;
      }
      const urls = Array.from(new Set(res.labels.map((l) => l.url)));
      urls.forEach((u) => window.open(u, '_blank'));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to fetch the courier slip');
    } finally {
      setSlipBusy(null);
    }
  };

  const wrongAddrRow = rows.find((r) => r.orderGid === wrongAddrGid) ?? null;
  const [wrongAddrBusy, setWrongAddrBusy] = useState(false);
  const doMarkWrongAddress = async () => {
    if (!wrongAddrGid) return;
    setWrongAddrBusy(true);
    try {
      await markWrongAddress(wrongAddrGid);
      toast.success('Flagged as wrong address — customer asked to confirm');
      setWrongAddrGid(null);
      load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to flag address');
    } finally {
      setWrongAddrBusy(false);
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

  const doCancelBooking = async () => {
    if (!cancelRow?.shipment) return;
    setCancelling(true);
    try {
      const res = await cancelBooking(cancelRow.shipment.id);
      const bits = [
        res.cancelledAtCourier ? 'cancelled at courier' : 'courier cancel skipped',
        res.unfulfilled ? 'Shopify unfulfilled' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      toast.success(`Booking cancelled — ${bits}. Order is back in To book.`);
      setCancelRow(null);
      load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to cancel booking');
    } finally {
      setCancelling(false);
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
      const ids = await getQueueIds({
        search,
        status,
        courier: courierFilter === 'all' ? undefined : courierFilter,
      });
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

  // The effective courier the board shows for each row (explicit per-row pick →
  // else the city suggestion). Sent so bulk-book honors exactly what's on screen
  // instead of re-deriving one courier for the whole batch.
  const courierMapFor = (gids: string[]): Record<string, CourierType> => {
    const m: Record<string, CourierType> = {};
    for (const r of rows) {
      if (gids.includes(r.orderGid)) {
        const c = rowCourier[r.orderGid] ?? r.suggestedCourier;
        if (c) m[r.orderGid] = c;
      }
    }
    return m;
  };

  const bulkBook = async () => {
    const gids = selectedBookableGids;
    if (!gids.length) return;
    setBulkBusy(true);
    try {
      await bulkBookShipments(
        gids,
        bulkCourier || undefined,
        bulkCourier ? undefined : courierMapFor(gids),
      );
      // Capture per-order display info (name + courier) so the live-progress
      // panel can label rows before their shipment rows even exist.
      const meta: Record<string, { orderName: string; courier?: CourierType }> = {};
      for (const r of rows) {
        if (gids.includes(r.orderGid)) {
          meta[r.orderGid] = {
            orderName: r.orderName ?? r.orderGid,
            courier:
              bulkCourier || rowCourier[r.orderGid] || r.suggestedCourier || undefined,
          };
        }
      }
      setProgress({ gids, meta });
      setSelected(new Set());
      // Bulk runs in the background; the progress panel polls, then refresh.
      setTimeout(load, 6000);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Bulk booking failed');
    } finally {
      setBulkBusy(false);
    }
  };

  const retryFailedBookings = async (failedGids: string[]) => {
    if (!failedGids.length) return;
    await bulkBookShipments(
      failedGids,
      bulkCourier || undefined,
      bulkCourier ? undefined : courierMapFor(failedGids),
    );
    setTimeout(load, 6000);
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
          {/* To-book confirmation sub-tabs. */}
          {status === 'unfulfilled' && (
            <div className="mt-2 flex w-fit overflow-hidden rounded-lg border border-gray-200 bg-white">
              {(
                [
                  ['all', 'All'],
                  ['confirmed', 'Confirmed'],
                  ['unconfirmed', 'Awaiting confirmation'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => {
                    setPage(1);
                    setConfSub(k);
                  }}
                  className={cn(
                    'px-3 py-1 text-xs',
                    confSub === k
                      ? 'bg-emerald-600 text-white'
                      : 'text-gray-600 hover:bg-gray-50',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <p className="mt-1 text-sm text-gray-600">
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
          {/* Courier filter — applies under every tab. */}
          <div className="relative">
            <Truck
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <select
              value={courierFilter}
              onChange={(e) => {
                setPage(1);
                setSelected(new Set());
                setCourierFilter(e.target.value as CourierType | 'all');
              }}
              className="rounded-lg border border-gray-300 bg-white py-1.5 pl-8 pr-7 text-sm text-gray-700"
              title="Filter orders by courier"
            >
              <option value="all">All couriers</option>
              {COURIER_TYPES.map((c) => (
                <option key={c} value={c}>
                  {COURIER_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
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
            onClick={runReconcile}
            disabled={reconciling}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            title="Reconcile open orders vs Shopify — drop ones archived/cancelled directly in Shopify"
          >
            {reconciling ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            Reconcile
          </button>
          <button
            onClick={runSyncStatuses}
            disabled={syncing}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            title="Pull fresh delivery statuses from the couriers for in-progress parcels"
          >
            {syncing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Truck size={14} />
            )}
            Sync statuses
          </button>
          <button
            onClick={() => load()}
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
                {isReceivableView && selectedReceivableIds.length > 0 && (
                  <button
                    onClick={() =>
                      setConfirmBulkReceive({ kind: 'selected', ids: selectedReceivableIds })
                    }
                    disabled={bulkReceiveBusy}
                    className="flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                    title="Mark selected parcels received (RTO) — blacklist, cancel & archive"
                  >
                    {bulkReceiveBusy ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <ArchiveRestore size={14} />
                    )}
                    Mark received {selectedReceivableIds.length}
                  </button>
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

      {/* Comma-separated bulk receive box (RTO views). */}
      {isReceivableView && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-200 bg-rose-50/50 px-4 py-2">
          <span className="text-xs font-medium text-rose-800">Bulk receive by order #:</span>
          <input
            value={receiveInput}
            onChange={(e) => setReceiveInput(e.target.value)}
            placeholder="e.g. 30994, #30871, 30765"
            className="min-w-[220px] flex-1 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs"
          />
          <button
            onClick={() => {
              const names = parseOrderNames(receiveInput);
              if (!names.length) return;
              const wanted = new Set(names.map((n) => `#${n.replace(/^#+/, '')}`));
              const gids = rows
                .filter((r) => r.orderName && wanted.has(r.orderName))
                .map((r) => r.orderGid);
              setSelected(new Set(gids));
              toast.info(`Selected ${gids.length} of ${names.length} on this page`);
            }}
            disabled={!receiveInput.trim()}
            className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-40"
            title="Tick matching rows on this page"
          >
            Select these
          </button>
          <button
            onClick={() => {
              const names = parseOrderNames(receiveInput);
              if (names.length) setConfirmBulkReceive({ kind: 'names', names });
            }}
            disabled={bulkReceiveBusy || !receiveInput.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-40"
            title="Mark all entered orders received (RTO)"
          >
            {bulkReceiveBusy ? <Loader2 size={14} className="animate-spin" /> : <ArchiveRestore size={14} />}
            Receive these
          </button>
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
                <th className="px-4 py-3 font-medium">Confirmation</th>
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
                // A voided/refunded/cancelled order has 0 outstanding but is NOT
                // "Paid" — don't let a zero balance mislabel closed orders.
                const fin = (r.financialStatus ?? '').toLowerCase();
                const notPaid =
                  fin === 'voided' ||
                  fin === 'refunded' ||
                  fin === 'partially_refunded' ||
                  fin === 'pending' ||
                  fin === 'authorized';
                const moneyLabel = isCod
                  ? 'COD'
                  : notPaid
                  ? fin.replace(/_/g, ' ') || 'Unpaid'
                  : 'Paid';
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
                      <span className="inline-flex items-center gap-1">
                        {r.orderName || '—'}
                        {r.adminUrl && (
                          <a
                            href={r.adminUrl}
                            target="_blank"
                            rel="noreferrer"
                            title="Open this order in Shopify admin"
                            className="text-gray-300 hover:text-green-600"
                          >
                            <ExternalLink size={13} />
                          </a>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {r.customerName || '—'}
                      {r.phone && (
                        <span className="block text-xs text-gray-400">
                          {r.phone}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {CONF_BADGE[r.confirmationStatus] && (
                        <span className="flex flex-col items-start gap-1">
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
                              <span className="flex items-center gap-2">
                                <button
                                  onClick={() => confirmOrder(r)}
                                  disabled={confirmingGid === r.orderGid}
                                  className="text-[10px] font-medium text-green-700 hover:underline disabled:opacity-50"
                                  title="Manually mark this order confirmed and apply the confirm tag in Shopify"
                                >
                                  {confirmingGid === r.orderGid ? 'Marking…' : 'Mark confirmed'}
                                </button>
                                <button
                                  onClick={() => resendConfirm(r)}
                                  disabled={resendGid === r.orderGid}
                                  className="text-[10px] font-medium text-blue-700 hover:underline disabled:opacity-50"
                                  title="Resend the confirmation template to the customer"
                                >
                                  {resendGid === r.orderGid ? 'Sending…' : 'Resend'}
                                </button>
                              </span>
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
                            <>
                              <button
                                onClick={() => setEditRow(r)}
                                title="Edit shipping address (updates Shopify too)"
                                className="text-gray-300 hover:text-green-600"
                              >
                                <Pencil size={13} />
                              </button>
                              <button
                                onClick={() => setWrongAddrGid(r.orderGid)}
                                title="Flag this address as wrong (asks the customer to confirm)"
                                className="text-gray-300 hover:text-orange-600"
                              >
                                <MapPinOff size={13} />
                              </button>
                            </>
                          )}
                      </div>
                      {r.address && (
                        // Full address shown (wrapped) so the agent can verify it
                        // without opening the edit modal; the pencil is only for
                        // correcting it.
                        <span className="block max-w-[240px] whitespace-normal break-words text-[11px] text-gray-400">
                          {r.address}
                        </span>
                      )}
                    </td>
                    <td
                      className="px-4 py-3 text-gray-600 max-w-[220px]"
                      title={r.itemsSummary ?? ''}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="truncate">
                          {itemCount
                            ? `${itemCount} item${itemCount === 1 ? '' : 's'}`
                            : '—'}
                        </span>
                        {!r.archived &&
                          r.fulfillmentStatus === 'unfulfilled' &&
                          !r.shipment && (
                            <button
                              onClick={() => setEditItemsRow(r)}
                              title="Edit order items (updates Shopify)"
                              className="shrink-0 text-gray-300 hover:text-green-600"
                            >
                              <Package size={13} />
                            </button>
                          )}
                      </div>
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
                          'block text-[11px] capitalize',
                          isCod
                            ? 'text-amber-600'
                            : notPaid
                            ? 'text-gray-500'
                            : 'text-green-600',
                        )}
                      >
                        {moneyLabel}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {r.shipment ? (
                        // Booked → show the ACTUAL courier it was booked with (not
                        // the city suggestion) + its tracking number.
                        <div className="flex flex-col gap-0.5">
                          <span className="inline-flex w-fit items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                            <Truck size={12} />
                            {COURIER_LABELS[r.shipment.courierType]}
                          </span>
                          {r.shipment.trackingNumber &&
                            (r.shipment.trackingUrl ? (
                              <button
                                onClick={() => setTrackRow(r)}
                                className="inline-flex w-fit items-center gap-1 font-mono text-[11px] text-blue-700 hover:underline"
                                title="View this parcel on the courier's portal"
                              >
                                {r.shipment.trackingNumber}
                                <ExternalLink size={10} />
                              </button>
                            ) : (
                              <span className="font-mono text-[11px] text-gray-500">
                                {r.shipment.trackingNumber}
                              </span>
                            ))}
                        </div>
                      ) : r.archived || r.fulfillmentStatus !== 'unfulfilled' ? (
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
                          {/* Courier slip / label for a booked parcel. */}
                          {r.shipment.trackingNumber && (
                            <button
                              onClick={() => openSlip(r.shipment!.id)}
                              disabled={slipBusy === r.shipment.id}
                              className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-700 hover:underline disabled:opacity-50"
                              title="Open the courier slip / shipping label for this parcel"
                            >
                              {slipBusy === r.shipment.id ? (
                                <Loader2 size={11} className="animate-spin" />
                              ) : (
                                <FileText size={11} />
                              )}
                              Slip
                            </button>
                          )}
                          {/* Courier reason for attempted/failed parcels. */}
                          {(r.shipment.lastStatusReason ||
                            (r.shipment.shipperAdviceStatus &&
                              (r.shipment.status === 'attempted' ||
                                r.shipment.status === 'in_transit'))) && (
                            <p className="max-w-[220px] text-right text-[11px] text-gray-500">
                              {r.shipment.lastStatusReason && (
                                <span className="text-amber-700">
                                  {r.shipment.lastStatusReason}
                                </span>
                              )}
                              {r.shipment.shipperAdviceStatus && (
                                <span className="ml-1 text-gray-400">
                                  (advice:{' '}
                                  {r.shipment.shipperAdviceStatus === 'return'
                                    ? 'return'
                                    : 're-attempt'}
                                  )
                                </span>
                              )}
                            </p>
                          )}
                          {r.shipment.status === 'address_issue' && (
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => setEditRow(r)}
                                className="inline-flex items-center gap-0.5 text-[11px] font-medium text-blue-700 hover:underline"
                                title="Correct the shipping address (updates Shopify too)"
                              >
                                <Pencil size={11} /> Edit
                              </button>
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
                                title="Address is correct — queue the booking"
                              >
                                Resolve &amp; book
                              </button>
                            </div>
                          )}
                          {(r.shipment.status === 'attempted' ||
                            r.shipment.status === 'failed') && (
                            <div className="flex items-center gap-2">
                              <button
                                disabled={actBusyGid === r.orderGid}
                                onClick={() => setAdviceRow(r)}
                                className="text-[11px] font-medium text-green-700 hover:underline disabled:opacity-50"
                                title="Tell the courier to re-attempt or return this parcel"
                              >
                                Shipper advice
                              </button>
                              {r.shipment.status === 'failed' && (
                                <button
                                  disabled={actBusyGid === r.orderGid}
                                  onClick={() => setReceiveRow(r)}
                                  className="text-[11px] font-medium text-rose-700 hover:underline disabled:opacity-50"
                                  title="Parcel returned & received back — blacklist customer, cancel & archive"
                                >
                                  Mark received
                                </button>
                              )}
                            </div>
                          )}
                          {/* Cancel/undo a booking that's still in-flight. */}
                          {['booked', 'in_transit', 'ready_for_pickup', 'picked_up'].includes(
                            r.shipment.status,
                          ) && (
                            <button
                              disabled={actBusyGid === r.orderGid}
                              onClick={() => setCancelRow(r)}
                              className="text-[11px] font-medium text-gray-500 hover:text-rose-700 hover:underline disabled:opacity-50"
                              title="Cancel this booking at the courier and return the order to To book"
                            >
                              Cancel booking
                            </button>
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
            // In-place refresh: keep scroll position + checkbox selection.
            load({ silent: true, keepSelection: true });
            onChanged?.();
          }}
          toast={toast}
        />
      )}

      {editItemsRow && (
        <EditItemsModal
          orderGid={editItemsRow.orderGid}
          orderName={editItemsRow.orderName}
          onClose={() => setEditItemsRow(null)}
          onSaved={() => {
            setEditItemsRow(null);
            // In-place refresh: keep scroll position + checkbox selection.
            load({ silent: true, keepSelection: true });
            onChanged?.();
          }}
        />
      )}

      {progress && (
        <BulkBookProgressModal
          gids={progress.gids}
          meta={progress.meta}
          onRetry={retryFailedBookings}
          onClose={() => {
            setProgress(null);
            load();
          }}
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

      <ConfirmDialog
        open={confirmBulkReceive !== null}
        danger
        busy={bulkReceiveBusy}
        title="Mark parcels received (RTO)?"
        message={`This will blacklist the customers and cancel + archive ${
          confirmBulkReceive?.kind === 'selected'
            ? `${confirmBulkReceive.ids.length} selected parcel(s)`
            : `${confirmBulkReceive?.kind === 'names' ? confirmBulkReceive.names.length : 0} order(s)`
        } in Shopify. Only failed/returned parcels are received. This can't be undone.`}
        confirmLabel="Mark received"
        onConfirm={() => {
          if (!confirmBulkReceive) return;
          if (confirmBulkReceive.kind === 'selected') {
            runBulkReceive({ shipmentIds: confirmBulkReceive.ids });
          } else {
            runBulkReceive({ orderNames: confirmBulkReceive.names });
          }
        }}
        onCancel={() => {
          if (!bulkReceiveBusy) setConfirmBulkReceive(null);
        }}
      />

      <ConfirmDialog
        open={wrongAddrGid !== null}
        busy={wrongAddrBusy}
        title="Flag address as wrong?"
        message={`This moves ${
          wrongAddrRow?.orderName ?? 'the order'
        } to Address issue and asks the customer to confirm their address. Correct the address (Edit) then Resolve & book.`}
        confirmLabel="Flag wrong address"
        onConfirm={doMarkWrongAddress}
        onCancel={() => {
          if (!wrongAddrBusy) setWrongAddrGid(null);
        }}
      />

      <ConfirmDialog
        open={cancelRow !== null}
        danger
        busy={cancelling}
        title="Cancel this booking?"
        message={`This cancels ${
          cancelRow?.orderName ?? 'the order'
        } at the courier, unfulfills it in Shopify, removes the courier tag, and returns it to the To book list so you can re-book.`}
        confirmLabel="Cancel booking"
        onConfirm={doCancelBooking}
        onCancel={() => {
          if (!cancelling) setCancelRow(null);
        }}
      />

      {adviceRow?.shipment && (
        <ShipperAdviceModal
          row={adviceRow}
          onClose={() => setAdviceRow(null)}
          onDone={() => {
            setAdviceRow(null);
            load();
            onChanged?.();
          }}
          toast={toast}
        />
      )}

      {trackRow?.shipment?.trackingUrl && (
        <CourierTrackModal row={trackRow} onClose={() => setTrackRow(null)} />
      )}
    </div>
  );
}

/** Shows a parcel's tracking as a NATIVE checkpoint timeline, pulled live from
 *  the courier's own tracking API (all four couriers expose a history array).
 *  This avoids embedding the couriers' fragile public pages in an iframe (some
 *  block it / need a same-site session). An "Open on courier portal" link is
 *  always offered; the empty-state falls back to it. */
function CourierTrackModal({ row, onClose }: { row: QueueOrder; onClose: () => void }) {
  const ship = row.shipment!;
  const url = ship.trackingUrl!;
  const [loading, setLoading] = useState(true);
  const [checkpoints, setCheckpoints] = useState<TrackingCheckpoint[] | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getTrackingHistory(ship.id)
      .then((res) => {
        if (alive) setCheckpoints(res.supported ? res.checkpoints : null);
      })
      .catch(() => {
        if (alive) setCheckpoints(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [ship.id]);

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`${COURIER_LABELS[ship.courierType]} tracking — ${row.orderName ?? 'order'}`}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono text-xs text-gray-500">{ship.trackingNumber}</span>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-gray-50"
          >
            <ExternalLink size={12} /> Open on courier portal
          </a>
        </div>

        {loading ? (
          <div className="flex h-40 items-center justify-center text-gray-400">
            <Loader2 size={22} className="animate-spin" />
          </div>
        ) : checkpoints && checkpoints.length ? (
          // Courier APIs return oldest → newest; show newest first.
          <ol className="relative ml-1 space-y-4 border-l border-gray-200 pl-5">
            {[...checkpoints].reverse().map((c, i) => (
              <li key={i} className="relative">
                <span
                  className={cn(
                    'absolute -left-[23px] top-1 h-2.5 w-2.5 rounded-full',
                    i === 0 ? 'bg-green-600 ring-2 ring-green-100' : 'bg-gray-300',
                  )}
                />
                <div className="text-sm font-medium text-gray-800">{c.status}</div>
                {c.detail && <div className="text-xs text-gray-500">{c.detail}</div>}
                {c.at && <div className="text-[11px] text-gray-400">{fmtDateTime(c.at)}</div>}
              </li>
            ))}
          </ol>
        ) : (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
            No tracking history available yet — use “Open on courier portal”.
          </div>
        )}
      </div>
    </Modal>
  );
}

function ShipperAdviceModal({
  row,
  onClose,
  onDone,
  toast,
}: {
  row: QueueOrder;
  onClose: () => void;
  onDone: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [action, setAction] = useState<'reattempt' | 'return'>('reattempt');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!row.shipment) return;
    setBusy(true);
    try {
      await sendShipperAdvice(row.shipment.id, action, remarks.trim());
      toast.success(
        action === 'reattempt'
          ? 'Re-attempt requested with the courier'
          : 'Return requested with the courier',
      );
      onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to send shipper advice');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Shipper advice — ${row.orderName ?? 'order'}`}>
      <div className="space-y-4">
        <p className="text-xs text-gray-500">
          {row.shipment && COURIER_LABELS[row.shipment.courierType]} ·{' '}
          {row.shipment?.trackingNumber || '—'}
          {row.shipment?.lastStatusReason && (
            <span className="mt-1 block text-amber-700">
              Courier reason: {row.shipment.lastStatusReason}
            </span>
          )}
        </p>
        <div className="grid grid-cols-2 gap-2">
          {(['reattempt', 'return'] as const).map((a) => (
            <button
              key={a}
              onClick={() => setAction(a)}
              className={cn(
                'rounded-lg border px-3 py-2 text-sm font-medium',
                action === a
                  ? a === 'return'
                    ? 'border-rose-500 bg-rose-50 text-rose-700'
                    : 'border-green-500 bg-green-50 text-green-700'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50',
              )}
            >
              {a === 'reattempt' ? 'Request re-attempt' : 'Request return'}
            </button>
          ))}
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Remarks</label>
          <textarea
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            rows={3}
            placeholder={
              action === 'reattempt'
                ? 'e.g. Customer confirmed address, please redeliver.'
                : 'e.g. Customer not responding, return the parcel.'
            }
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
          />
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50',
              action === 'return' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-green-600 hover:bg-green-700',
            )}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            Send advice
          </button>
        </div>
      </div>
    </Modal>
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
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="City">
            <CityAutocomplete
              value={city}
              onChange={setCity}
              inputClassName="text-base"
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

const ADVANCED_BOOKED = [
  'in_transit',
  'out_for_delivery',
  'delivered',
  'attempted',
  'failed',
  'returned',
  'picked_up',
  'ready_for_pickup',
];
function classifyProgress(
  row?: BookingProgressRow,
): 'pending' | 'booked' | 'failed' {
  if (!row) return 'pending'; // shipment row not created yet → queued
  if (row.trackingNumber) return 'booked'; // courier accepted it
  if (row.status && ADVANCED_BOOKED.includes(row.status)) return 'booked'; // webhook advanced it
  // address_issue = booking blocked; a synthetic pre-flight row carries `error`
  // (order already fulfilled/cancelled, no address, …) with no status/tracking.
  if (row.status === 'address_issue' || row.error) return 'failed';
  return 'pending'; // 'booked' status w/o a tracking number = still in the lane
}

/** Live per-order ticker for a bulk-book batch. Polls booking-progress every 2s
 *  (parallel per-courier lanes update each row as they book), shows booked /
 *  in-progress / failed, and offers a one-click retry of the failures. */
function BulkBookProgressModal({
  gids,
  meta,
  onRetry,
  onClose,
}: {
  gids: string[];
  meta: Record<string, { orderName: string; courier?: CourierType }>;
  onRetry: (failedGids: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Record<string, BookingProgressRow>>({});
  const [retrying, setRetrying] = useState(false);
  // Bumped on retry to restart the (self-terminating) poll loop.
  const [nonce, setNonce] = useState(0);
  const startedRef = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0); // seconds since this batch started

  // A booking that never even creates a shipment row (order already
  // fulfilled/cancelled, no address, order not found) is a PRE-FLIGHT failure.
  // The backend surfaces the real reason as a synthetic row within a poll or two,
  // but as a safety net we also give up on an eternally row-less order after this
  // grace window (scaled a little by batch size, since bulk creates rows serially).
  const STALL_MS = Math.min(180_000, Math.max(45_000, gids.length * 4000));

  // 1s ticker for the elapsed timer (restarts with the poll loop on retry).
  useEffect(() => {
    const id = setInterval(
      () => setElapsed(Math.max(0, Math.floor((Date.now() - startedRef.current) / 1000))),
      1000,
    );
    return () => clearInterval(id);
  }, [nonce]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const res = await bookingProgress(gids);
        if (!alive) return;
        const map: Record<string, BookingProgressRow> = {};
        for (const r of res.rows) map[r.orderGid] = r;
        setRows(map);
        const pending = gids.some((g) => classifyProgress(map[g]) === 'pending');
        // Keep polling while anything is genuinely in a courier lane, up to 5 min
        // (backend HTTP timeouts guarantee a lane resolves well within that).
        if (pending && Date.now() - startedRef.current < 300_000) {
          timer = setTimeout(poll, 2000);
        }
      } catch {
        if (alive) timer = setTimeout(poll, 3000);
      }
    };
    poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // Re-runs on retry (nonce bump) to restart the loop after it self-terminated.
  }, [gids, nonce]);

  const elapsedMs = elapsed * 1000;
  const view = gids.map((g) => {
    const row = rows[g];
    let state = classifyProgress(row);
    // Safety net: a row-less order still "queued" past the grace window → treat as
    // failed so it can't spin forever (the backend usually already reported why).
    const stalled = state === 'pending' && !row && elapsedMs > STALL_MS;
    if (stalled) state = 'failed';
    return {
      gid: g,
      name: meta[g]?.orderName ?? row?.orderName ?? g,
      courier: row?.courier ?? meta[g]?.courier,
      state,
      error:
        row?.error ??
        (stalled
          ? 'Couldn’t start — the order may already be fulfilled or cancelled. Open the order to check.'
          : null),
      tracking: row?.trackingNumber ?? null,
      hasRow: !!row,
    };
  });
  const booked = view.filter((v) => v.state === 'booked').length;
  const failed = view.filter((v) => v.state === 'failed');
  const pending = view.filter((v) => v.state === 'pending').length;
  const done = pending === 0;

  return (
    <Modal open title="Booking progress" onClose={onClose}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="inline-flex items-center gap-1 text-green-700">
            <CheckCircle2 size={15} /> {booked} booked
          </span>
          {failed.length > 0 && (
            <span className="inline-flex items-center gap-1 text-red-600">
              <XCircle size={15} /> {failed.length} failed
            </span>
          )}
          {pending > 0 && (
            <span className="inline-flex items-center gap-1 text-gray-500">
              <Loader2 size={14} className="animate-spin" /> {pending} in progress
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-1 font-mono tabular-nums text-gray-400">
            <Clock size={13} />
            {String(Math.floor(elapsed / 60)).padStart(2, '0')}:
            {String(elapsed % 60).padStart(2, '0')}
          </span>
        </div>
        {!done && (
          <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-700">
            You can close this window and keep working — booking runs in the
            background across all couriers at once. The orders board updates on its
            own, and reopening the batch will show the latest progress.
          </p>
        )}
        <div className="max-h-80 divide-y divide-gray-100 overflow-y-auto rounded-lg border border-gray-200">
          {view.map((v) => (
            <div key={v.gid} className="flex items-start gap-2 px-3 py-2 text-sm">
              <span className="mt-0.5 shrink-0">
                {v.state === 'booked' ? (
                  <CheckCircle2 size={16} className="text-green-600" />
                ) : v.state === 'failed' ? (
                  <XCircle size={16} className="text-red-500" />
                ) : (
                  <Loader2 size={15} className="animate-spin text-gray-400" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-gray-800">
                    {v.name}
                  </span>
                  {v.courier && (
                    <span className="shrink-0 text-xs text-gray-500">
                      {COURIER_LABELS[v.courier]}
                    </span>
                  )}
                </div>
                {v.state === 'failed' && v.error && (
                  <p className="mt-0.5 text-xs text-red-500">{v.error}</p>
                )}
                {v.state === 'booked' && v.tracking && (
                  <p className="mt-0.5 text-xs text-gray-400">
                    Tracking {v.tracking}
                  </p>
                )}
                {v.state === 'pending' && (
                  <p className="mt-0.5 text-xs text-gray-400">
                    {v.hasRow ? 'Booking…' : 'Queued…'}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-xs text-gray-400">
            {done ? 'All done.' : 'Booking in parallel per courier…'}
          </span>
          <div className="flex items-center gap-2">
            {failed.length > 0 && (
              <button
                type="button"
                disabled={retrying || pending > 0}
                onClick={async () => {
                  setRetrying(true);
                  try {
                    await onRetry(failed.map((f) => f.gid));
                    startedRef.current = Date.now();
                    setElapsed(0);
                    setRows({});
                    setNonce((n) => n + 1);
                  } finally {
                    setRetrying(false);
                  }
                }}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {retrying ? 'Retrying…' : `Retry ${failed.length} failed`}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-green-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-700"
            >
              {done ? 'Done' : 'Close'}
            </button>
          </div>
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
  const [cityQuery, setCityQuery] = useState('');

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

          {data.cities.length > 0 && (() => {
            const q = cityQuery.trim().toLowerCase();
            const visibleCities = q
              ? data.cities.filter((c) => c.city.toLowerCase().includes(q))
              : data.cities.slice(0, 40);
            return (
            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
              <div className="flex flex-col gap-2 border-b border-gray-100 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-gray-800">
                    Best courier by city
                  </h3>
                  <p className="text-xs text-gray-400">
                    Delivery rate per courier where you&apos;ve shipped —{' '}
                    {q ? 'search results' : 'busiest cities first'}.
                  </p>
                </div>
                <div className="relative w-full sm:w-64">
                  <Search
                    size={14}
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
                  />
                  <input
                    value={cityQuery}
                    onChange={(e) => setCityQuery(e.target.value)}
                    placeholder="Search any city…"
                    className="w-full rounded-lg border border-gray-200 py-1.5 pl-8 pr-3 text-xs focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
                  />
                </div>
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
                    {visibleCities.length === 0 && (
                      <tr>
                        <td colSpan={3} className="px-4 py-8 text-center text-xs text-gray-400">
                          No city matches &ldquo;{cityQuery.trim()}&rdquo; in this window.
                        </td>
                      </tr>
                    )}
                    {visibleCities.map((city) => {
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
            );
          })()}
        </>
      )}
    </div>
  );
}

// ── Courier pending payments (COD receivable + reconciliation) ──

// Bank Deposit + Card Payments — prepaid (non-COD) orders. Bank Deposit is
// informational (money already in the bank); Card Payments needs the gateway
// payout reconciled. Both show a delivered vs with-courier split + totals.
function PrepaidPaymentsPanel({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [summary, setSummary] = useState<PrepaidPaymentsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<'bank' | 'card' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSummary(await getPrepaidPayments());
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load prepaid payments');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const bank = summary?.bankDeposit;
  const card = summary?.cardPayments;
  const bankTotal = (bank?.deliveredValue ?? 0) + (bank?.inTransitValue ?? 0);
  const bankCount = (bank?.deliveredCount ?? 0) + (bank?.inTransitCount ?? 0);
  const cardTotal = (card?.deliveredValue ?? 0) + (card?.inTransitValue ?? 0);
  const cardCount = (card?.deliveredCount ?? 0) + (card?.inTransitCount ?? 0);

  return (
    <div className="space-y-3 border-t border-gray-100 pt-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-700">Prepaid orders</p>
        {loading && <Loader2 size={16} className="animate-spin text-gray-400" />}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* Bank Deposit — informational only. */}
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-gray-500">
              <Landmark size={16} />
              <span className="text-xs uppercase tracking-wide">Bank deposit</span>
            </div>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-500">
              In bank
            </span>
          </div>
          <p className="mt-1 text-3xl font-bold text-gray-800">
            {qmoney(bankTotal, bank?.currency ?? null)}
          </p>
          <p className="text-xs text-gray-400">
            {bankCount.toLocaleString()} prepaid parcel{bankCount === 1 ? '' : 's'} · already paid
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-gray-100 pt-3 text-xs">
            <div>
              <p className="font-semibold text-gray-700">
                {(bank?.inTransitCount ?? 0).toLocaleString()}
              </p>
              <p className="text-gray-400">with courier</p>
            </div>
            <div>
              <p className="font-semibold text-gray-700">
                {(bank?.deliveredCount ?? 0).toLocaleString()}
              </p>
              <p className="text-gray-400">delivered</p>
            </div>
          </div>
          {bankCount > 0 && (
            <button
              onClick={() => setOpen('bank')}
              className="mt-3 text-xs font-medium text-green-700 hover:underline"
            >
              View parcels →
            </button>
          )}
        </div>

        {/* Card Payments — needs reconciliation. */}
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-gray-500">
              <CreditCard size={16} />
              <span className="text-xs uppercase tracking-wide">Card payments</span>
            </div>
            {cardCount > 0 && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-700">
                Reconcile
              </span>
            )}
          </div>
          <p className="mt-1 text-3xl font-bold text-green-600">
            {qmoney(cardTotal, card?.currency ?? null)}
          </p>
          <p className="text-xs text-gray-400">
            {cardCount.toLocaleString()} order{cardCount === 1 ? '' : 's'} · awaiting gateway payout
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-gray-100 pt-3 text-xs">
            <div>
              <p className="font-semibold text-gray-700">
                {(card?.inTransitCount ?? 0).toLocaleString()}
              </p>
              <p className="text-gray-400">with courier</p>
            </div>
            <div>
              <p className="font-semibold text-gray-700">
                {(card?.deliveredCount ?? 0).toLocaleString()}
              </p>
              <p className="text-gray-400">delivered</p>
            </div>
          </div>
          {cardCount > 0 && (
            <button
              onClick={() => setOpen('card')}
              className="mt-3 text-xs font-medium text-green-700 hover:underline"
            >
              Reconcile payments →
            </button>
          )}
        </div>
      </div>

      {open && (
        <PrepaidDrilldownModal
          bucket={open}
          onClose={() => setOpen(null)}
          onReconciled={load}
          toast={toast}
        />
      )}
    </div>
  );
}

// Drill-down modal for a prepaid card. 'bank' = read-only parcel list; 'card' =
// checkboxes + comma-separated order-number paste → Mark as paid (reconcile).
function PrepaidDrilldownModal({
  bucket,
  onClose,
  onReconciled,
  toast,
}: {
  bucket: 'bank' | 'card';
  onClose: () => void;
  onReconciled: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [rows, setRows] = useState<PrepaidPaymentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const isCard = bucket === 'card';
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listPrepaidPayments({ bucket, page, pageSize });
      setRows(res.rows);
      setTotal(res.total);
      setSelected(new Set());
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load list');
    } finally {
      setLoading(false);
    }
  }, [bucket, page, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const reconcile = async () => {
    const ids = Array.from(selected);
    const orderNumbers = pasted
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length && !orderNumbers.length) {
      toast.error('Select orders or paste order numbers first');
      return;
    }
    setBusy(true);
    try {
      const r = await reconcileCardPayments({ shipmentIds: ids, orderNumbers });
      if (r.reconciled === 0) {
        toast.info('No matching card orders to reconcile');
      } else {
        toast.success(`Marked ${r.reconciled} order${r.reconciled === 1 ? '' : 's'} paid`);
      }
      setPasted('');
      onReconciled();
      if (r.reconciled > 0 && r.reconciled >= rows.length && page > 1) {
        setPage((p) => Math.max(1, p - 1));
      } else {
        load();
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to reconcile');
    } finally {
      setBusy(false);
    }
  };

  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.shipmentId));

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={isCard ? 'Card payments — reconcile' : 'Bank deposit — prepaid parcels'}
    >
      <div className="space-y-3">
        <p className="text-xs text-gray-500">
          {isCard
            ? 'These prepaid orders were paid via an online gateway. Once the gateway payout lands (usually ~1 day later), tick the orders — or paste their order numbers — and mark them paid to clear them.'
            : 'Prepaid orders paid by bank deposit / manual method — the money is already in your bank. This list is informational; nothing to reconcile.'}
        </p>

        {isCard && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-gray-600">
              Paste order numbers (comma or space separated)
            </label>
            <textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="e.g. 33409, 33410, 33412"
              rows={2}
              className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
            />
          </div>
        )}

        {isCard && (selected.size > 0 || pasted.trim()) && (
          <div className="flex items-center justify-between rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800">
            <span>
              {selected.size > 0 ? `${selected.size} selected` : ''}
              {selected.size > 0 && pasted.trim() ? ' + ' : ''}
              {pasted.trim() ? 'pasted numbers' : ''}
            </span>
            <button
              onClick={reconcile}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              Mark as paid
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16 text-gray-400">
            <Loader2 className="animate-spin" size={22} />
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
            {isCard ? 'No card payments awaiting reconciliation.' : 'No prepaid parcels.'}
          </div>
        ) : (
          <div className="max-h-[50vh] overflow-auto rounded-xl border border-gray-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  {isCard && (
                    <th className="px-3 py-3 w-8">
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
                  )}
                  <th className="px-3 py-3 font-medium">Order</th>
                  <th className="px-3 py-3 font-medium">Courier</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-3 py-3 font-medium">Gateway</th>
                  <th className="px-3 py-3 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <tr key={r.shipmentId} className="hover:bg-gray-50">
                    {isCard && (
                      <td className="px-3 py-2.5">
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
                    )}
                    <td className="px-3 py-2.5 font-medium text-gray-800">
                      {r.orderName ?? `#${r.orderNumber ?? '—'}`}
                    </td>
                    <td className="px-3 py-2.5 text-gray-600">
                      {COURIER_LABELS[r.courier]}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={cn(
                          'inline-block rounded-full px-2 py-0.5 text-xs',
                          STATUS_STYLES[r.status] ?? 'bg-gray-100 text-gray-600',
                        )}
                      >
                        {STATUS_LABELS[r.status] ?? r.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-gray-500">{r.gateway ?? '—'}</td>
                    <td className="px-3 py-2.5 text-right font-medium text-gray-800">
                      {qmoney(r.value, r.currency ?? null)}
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
    </Modal>
  );
}

function PendingPaymentsPanel({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [summary, setSummary] = useState<PendingPaymentsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [courier, setCourier] = useState<CourierType | null>(null);
  const [bucket, setBucket] = useState<'receivable' | 'transit'>('receivable');
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
      setSummary({
        couriers: [],
        totals: {
          receivable: 0,
          receivableCount: 0,
          inTransitCount: 0,
          inTransitExpected: 0,
        },
        currency: null,
      });
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
      const res = await listPendingPayments({
        courierType: courier,
        bucket,
        page,
        pageSize,
      });
      setRows(res.rows);
      setTotal(res.total);
      setSelected(new Set());
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load list');
    } finally {
      setListLoading(false);
    }
  }, [courier, bucket, page, toast]);

  useEffect(() => {
    if (courier) loadList();
  }, [courier, bucket, page, loadList]);

  const cur = summary?.currency ?? null;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  const openCourier = (c: CourierType) => {
    setPage(1);
    setBucket('receivable');
    setCourier(c);
  };

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

  // Drill-down: one courier, two buckets (Receivable / With courier).
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
          <span className="text-sm font-semibold text-gray-800">
            {COURIER_LABELS[courier]}
          </span>
        </div>

        <div className="flex w-fit overflow-hidden rounded-lg border border-gray-200 bg-white">
          {([
            ['receivable', 'Receivable'],
            ['transit', 'With courier'],
          ] as Array<['receivable' | 'transit', string]>).map(([k, label]) => (
            <button
              key={k}
              onClick={() => {
                setPage(1);
                setBucket(k);
              }}
              className={cn(
                'px-3 py-1.5 text-xs',
                bucket === k
                  ? 'bg-green-600 text-white'
                  : 'text-gray-600 hover:bg-gray-50',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {bucket === 'receivable' && (
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-gray-500">
              Delivered parcels the courier owes you. Tick the ones they&apos;ve
              remitted, or settle the whole courier at once.
            </p>
            <button
              onClick={settleAll}
              disabled={busy}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <Check size={14} /> Mark ALL paid
            </button>
          </div>
        )}
        {bucket === 'transit' && (
          <p className="text-xs text-gray-500">
            Parcels still with the courier — expected COD once delivered. Nothing
            to reconcile yet.
          </p>
        )}

        {bucket === 'receivable' && selected.size > 0 && (
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
            {bucket === 'receivable'
              ? `Nothing outstanding from ${COURIER_LABELS[courier]}.`
              : `No ${COURIER_LABELS[courier]} parcels in transit.`}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  {bucket === 'receivable' && (
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
                  )}
                  <th className="px-4 py-3 font-medium">Order</th>
                  <th className="px-4 py-3 font-medium">City</th>
                  {bucket === 'receivable' ? (
                    <th className="px-4 py-3 font-medium">Delivered</th>
                  ) : (
                    <th className="px-4 py-3 font-medium">Status</th>
                  )}
                  <th className="px-4 py-3 font-medium text-right">
                    {bucket === 'receivable' ? 'Receivable' : 'Expected COD'}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <tr key={r.shipmentId} className="hover:bg-gray-50">
                    {bucket === 'receivable' && (
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
                    )}
                    <td className="px-4 py-2.5 font-medium text-gray-900">
                      {r.orderName || '—'}
                      {r.phone && (
                        <span className="block text-xs text-gray-400">{r.phone}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{r.city || '—'}</td>
                    {bucket === 'receivable' ? (
                      <td className="px-4 py-2.5 text-gray-400 text-xs">
                        {r.deliveredAt ? fmtDate(r.deliveredAt) : '—'}
                      </td>
                    ) : (
                      <td className="px-4 py-2.5">
                        <span
                          className={cn(
                            'inline-block rounded-full px-2 py-0.5 text-xs',
                            STATUS_STYLES[r.status] ?? 'bg-gray-100 text-gray-600',
                          )}
                        >
                          {STATUS_LABELS[r.status] ?? r.status}
                        </span>
                      </td>
                    )}
                    <td className="px-4 py-2.5 text-right font-medium text-gray-800">
                      {r.receivable > 0 ? (
                        qmoney(r.receivable, r.currency ?? cur)
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
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

  // Summary: per-courier receivable + in-transit buckets.
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-600">
          COD the couriers owe you. <span className="font-medium">Receivable</span>{' '}
          = delivered parcels awaiting remittance; parcels still in transit are
          shown separately (not yet collectable).
        </p>
        <button
          onClick={loadSummary}
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center gap-2 text-gray-500">
            <Wallet size={16} />
            <span className="text-xs uppercase tracking-wide">Receivable now</span>
          </div>
          <p className="mt-1 text-3xl font-bold text-green-600">
            {qmoney(summary?.totals.receivable ?? 0, cur)}
          </p>
          <p className="text-xs text-gray-400">
            {(summary?.totals.receivableCount ?? 0).toLocaleString()} delivered
            parcels awaiting remittance
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center gap-2 text-gray-500">
            <Truck size={16} />
            <span className="text-xs uppercase tracking-wide">With courier</span>
          </div>
          <p className="mt-1 text-3xl font-bold text-gray-800">
            {(summary?.totals.inTransitCount ?? 0).toLocaleString()}
            <span className="ml-1 text-sm font-normal text-gray-400">parcels</span>
          </p>
          <p className="text-xs text-gray-400">
            {qmoney(summary?.totals.inTransitExpected ?? 0, cur)} expected on
            delivery
          </p>
        </div>
      </div>

      {!summary || summary.couriers.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
          Nothing outstanding — every delivered parcel is settled.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {summary.couriers
            .slice()
            .sort((a, b) => b.receivable - a.receivable)
            .map((c) => (
              <button
                key={c.courier}
                onClick={() => openCourier(c.courier)}
                className="rounded-xl border border-gray-200 bg-white p-4 text-left hover:border-green-300 hover:shadow-sm"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-semibold text-gray-800">
                    {COURIER_LABELS[c.courier]}
                  </span>
                </div>
                <p className="text-2xl font-bold text-green-600">
                  {qmoney(c.receivable, c.currency ?? cur)}
                </p>
                <p className="text-xs text-gray-500">
                  {c.receivableCount.toLocaleString()} delivered · receivable
                </p>
                <p className="mt-2 border-t border-gray-100 pt-2 text-xs text-gray-500">
                  <span className="font-medium text-gray-700">
                    {c.inTransitCount.toLocaleString()}
                  </span>{' '}
                  with courier · {qmoney(c.inTransitExpected, c.currency ?? cur)}{' '}
                  expected
                </p>
                <p className="mt-2 text-xs font-medium text-green-700">Reconcile →</p>
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
