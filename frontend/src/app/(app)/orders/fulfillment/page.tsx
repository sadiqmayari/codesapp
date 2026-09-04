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
  Eye,
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
  ChevronDown,
  Ban,
  Trash2,
  Upload,
  X,
  ScanLine,
  BarChart3,
} from 'lucide-react';
import Link from 'next/link';
import { EditItemsModal } from '@/components/orders/edit-items-modal';
import { CourierInvoiceModal } from '@/components/orders/courier-invoice-modal';
import { CourierInvoiceViewModal } from '@/components/orders/courier-invoice-view-modal';
import { PayfastSettlementModal } from '@/components/orders/payfast-settlement-modal';
import { PayfastStatementViewModal } from '@/components/orders/payfast-statement-view-modal';
import { listPayfastSettlements, payfastStatementPdf, type PayfastSettlement } from '@/lib/payfast';
import { OrderNameButton } from '@/components/orders/order-detail-view';
import { ItemsPopover, CustomerPopover } from '@/components/orders/queue-popovers';
import { OrdersKpiStrip } from '@/components/orders/orders-kpi-strip';
import ScanToFind from '@/components/orders/scan-to-find';
import SavedViews from '@/components/orders/saved-views';
import { EditAddressModal } from '@/components/orders/edit-address-modal';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtTime, cn } from '@/lib/utils';
import { useToast } from '@/components/toast';
import { useAuth } from '@/context/auth-context';
import { Modal, ConfirmDialog } from '@/components/ui/modal';
import { PeriodSelect } from '@/components/orders/period-select';
import { periodRange, PeriodKey } from '@/lib/date-period';
import {
  loadsheetStaging,
  listShipments,
  listLoadsheets,
  generateLoadsheet,
  revertAddressIssue,
  markShipmentReceived,
  sendShipperAdvice,
  cancelBooking,
  generateLabels,
  downloadSlips,
  loadsheetPicklist,
  loadsheetDispatchList,
  loadsheetSlips,
  generateLoadsheetsForSelection,
  loadsheetReadiness,
  bookShipment,
  fulfillmentLaneCounts,
  listFulfillmentQueue,
  importShopifyOrders,
  reconcileShopifyOrders,
  bulkBookShipments,
  bookingProgress,
  bulkCancelShipments,
  bulkCancelProgress,
  listCourierInvoices,
  type CourierInvoice,
  type BulkCancelMode,
  type BookingProgressRow,
  getCourierPerformance,
  getCourierPendingPayments,
  stampZeroValueDelivered,
  getCourierShortfalls,
  listPendingPayments,
  settlePayments,
  getPrepaidPayments,
  listPrepaidPayments,
  reconcileCardPayments,
  getQueueIds,
  listFulfillmentQueueByGids,
  archiveOrders,
  markOrderConfirmed,
  markOrderNoResponse,
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
  type StagingSummary,
  type ReceivableAging,
  type ShortfallsResult,
  type QueueStatusFilter,
  type QueueSort,
  type LaneCounts,
  type CourierPerformance,
  type CourierPerfCity,
  type CourierPerfRow,
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
  const [view, setView] = useState<
    'queue' | 'dispatch' | 'performance' | 'payments'
  >('queue');
  // Which payments sub-view is open (Courier payments tab).
  const [payTab, setPayTab] = useState<
    'cod' | 'prepaid' | 'statements' | 'shortfalls'
  >('cod');
  const [rows, setRows] = useState<Shipment[] | null>(null);
  const [total, setTotal] = useState(0);
  const [staging, setStaging] = useState<StagingSummary | null>(null);
  const [manifestBusy, setManifestBusy] = useState<CourierType | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  const [manifestsNonce, setManifestsNonce] = useState(0);
  const [refreshingDispatch, setRefreshingDispatch] = useState(false);
  // Cancel flow for the Dispatch staging table (booked parcels awaiting a
  // loadsheet). Reuses the same background bulk-cancel batch + progress modal as
  // the Orders board — 'unbook' returns a parcel to To-book, 'cancel' fully
  // cancels + archives the order.
  const [stgConfirmCancel, setStgConfirmCancel] = useState<BulkCancelMode | null>(null);
  const [stgCancelBusy, setStgCancelBusy] = useState(false);
  const [stgCancelBatch, setStgCancelBatch] = useState<{
    batchId: string;
    mode: BulkCancelMode;
    total: number;
  } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [bookOpen, setBookOpen] = useState(false);
  // Label printing: selected shipment ids (must be one courier) + busy flag.
  const [labelSel, setLabelSel] = useState<Set<number>>(new Set());
  const [labelBusy, setLabelBusy] = useState(false);
  const [slipBusy, setSlipBusy] = useState(false);
  const [loadsheetBusy, setLoadsheetBusy] = useState(false);
  // Per-courier filter (mirrors the Orders board).
  const [courierFilter, setCourierFilter] = useState<CourierType | 'all'>('all');
  // Time-period filter (by shipment created date).
  const [period, setPeriod] = useState<PeriodKey>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  // The Shipments tab is now the LOADSHEET worklist — only booked shipments not
  // yet on a loadsheet. Every other shipment status lives on the Orders board
  // (its status chips). Server-filtered + paginated.
  const load = useCallback(async () => {
    try {
      const range = periodRange(period, { from: customFrom, to: customTo });
      const res = await listShipments({
        loadsheetPending: true,
        courierType: courierFilter === 'all' ? undefined : courierFilter,
        from: range.from,
        to: range.to,
        page,
        pageSize,
      });
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load shipments',
      );
      setRows([]);
      setTotal(0);
    }
  }, [toast, page, pageSize, courierFilter, period, customFrom, customTo]);

  const loadStaging = useCallback(async () => {
    try {
      setStaging(await loadsheetStaging());
    } catch {
      setStaging(null);
    }
  }, []);

  // The Dispatch header Refresh reloads the WHOLE tab — staging lane, parcel
  // list AND the manifests below (bumping the nonce the panel watches) — with a
  // spinner so it's clearly doing something even when nothing changed.
  const refreshDispatch = useCallback(async () => {
    setRefreshingDispatch(true);
    try {
      await Promise.all([load(), loadStaging()]);
      setManifestsNonce((n) => n + 1);
    } finally {
      setRefreshingDispatch(false);
    }
  }, [load, loadStaging]);

  useEffect(() => {
    load();
    loadStaging();
  }, [load, loadStaging]);

  // One-click dispatch: manifest every ready parcel of a courier; the new batch
  // then appears in the Manifests list right below (no tab-switch). Guards the
  // still-booking case exactly as the parcel-table flow does.
  const manifestCourier = async (courierType: CourierType) => {
    setManifestBusy(courierType);
    try {
      const r = await loadsheetReadiness({ courierType }).catch(() => null);
      if (r && r.pending > 0 && r.ready === 0) {
        toast.info(
          `All ${r.pending} ${COURIER_LABELS[courierType]} parcel(s) are still booking — try again in a moment.`,
        );
        return;
      }
      if (r && r.pending > 0) {
        setGenConfirm({ ...r, run: () => doGenerateLoadsheet(courierType) });
        return;
      }
      await doGenerateLoadsheet(courierType);
    } finally {
      setManifestBusy(null);
    }
  };

  // Cancel the selected staging parcels (unbook / full cancel). Maps the
  // selected shipment ids to their order gids, runs the background batch, and
  // the progress modal refreshes staging + the list on close.
  const startStagingCancel = async (mode: BulkCancelMode) => {
    const gids = (rows ?? [])
      .filter((r) => labelSel.has(r.id))
      .map((r) => r.shopify_order_gid)
      .filter(Boolean);
    if (!gids.length) return;
    setStgCancelBusy(true);
    try {
      const res = await bulkCancelShipments({ mode, orderGids: gids });
      setStgCancelBatch({ batchId: res.batchId, mode, total: res.queued });
      setStgConfirmCancel(null);
      setLabelSel(new Set());
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Bulk cancel failed to start');
    } finally {
      setStgCancelBusy(false);
    }
  };

  // Server already filtered/paged; render rows as-is.
  const visible = rows ?? [];
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  // Loadsheet-generation guard: a parcel booked seconds ago may not have its
  // tracking ID back yet, and the generate query silently drops those — so warn
  // before manifesting or they get left behind (the "20 missing" case).
  const [genConfirm, setGenConfirm] = useState<{
    ready: number;
    pending: number;
    pendingNames: string[];
    run: () => Promise<void>;
  } | null>(null);

  const doGenerateLoadsheet = async (courierType: CourierType) => {
    try {
      await generateLoadsheet(courierType);
      toast.success(`${COURIER_LABELS[courierType]} loadsheet queued`);
      load();
      loadStaging();
      setManifestsNonce((n) => n + 1);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to generate loadsheet',
      );
    }
  };

  const runLoadsheet = async (courierType: CourierType) => {
    try {
      const r = await loadsheetReadiness({ courierType });
      if (r.pending > 0) {
        if (r.ready === 0) {
          toast.info(
            `All ${r.pending} ${COURIER_LABELS[courierType]} parcel(s) are still booking — try again in a moment.`,
          );
          return;
        }
        setGenConfirm({ ...r, run: () => doGenerateLoadsheet(courierType) });
        return;
      }
    } catch {
      // Readiness is best-effort; on error just proceed to generate.
    }
    await doGenerateLoadsheet(courierType);
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

  const doGenerateSelectionLoadsheets = async (ids: number[]) => {
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
      loadStaging();
      setManifestsNonce((n) => n + 1);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to generate loadsheets',
      );
    } finally {
      setLoadsheetBusy(false);
    }
  };

  // One click → a loadsheet per courier for the selected parcels (parallel).
  // Guards against still-booking parcels (no tracking yet) being left off.
  const runSelectionLoadsheets = async (ids: number[]) => {
    if (!ids.length) return;
    try {
      const r = await loadsheetReadiness({ shipmentIds: ids });
      if (r.pending > 0) {
        if (r.ready === 0) {
          toast.info(
            `All ${r.pending} selected parcel(s) are still booking — try again in a moment.`,
          );
          return;
        }
        setGenConfirm({ ...r, run: () => doGenerateSelectionLoadsheets(ids) });
        return;
      }
    } catch {
      // Readiness is best-effort; on error just proceed to generate.
    }
    await doGenerateSelectionLoadsheets(ids);
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
    // COD receivable, prepaid/gateway money, statement history and shortfalls
    // are four different questions with different owners. They used to stack on
    // one scroll with no navigation between them.
    const PAY_TABS: Array<[typeof payTab, string]> = [
      ['cod', 'COD receivable'],
      ['prepaid', 'Prepaid & gateway'],
      ['statements', 'Statements'],
      ['shortfalls', 'Shortfalls'],
    ];
    return (
      <div className="space-y-4">
        <ViewTabs view={view} setView={setView} />
        <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-gray-200 bg-gray-50 p-1">
          {PAY_TABS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => setPayTab(k)}
              className={cn(
                'shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition-colors',
                payTab === k
                  ? 'bg-white font-semibold text-gray-900 shadow-sm ring-1 ring-gray-200'
                  : 'text-gray-600 hover:bg-white/60 hover:text-gray-900',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {payTab === 'cod' && <PendingPaymentsPanel toast={toast} />}
        {payTab === 'prepaid' && <PrepaidPaymentsPanel toast={toast} />}
        {payTab === 'statements' && <StatementsPanel toast={toast} />}
        {payTab === 'shortfalls' && <ShortfallsPanel toast={toast} />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ViewTabs view={view} setView={setView} />

      <ConfirmDialog
        open={genConfirm !== null}
        title="Some parcels are still booking"
        message={
          genConfirm
            ? `${genConfirm.pending} parcel${genConfirm.pending === 1 ? '' : 's'} ${
                genConfirm.pending === 1 ? "doesn't" : "don't"
              } have a tracking ID yet (still booking with the courier) and will be LEFT OFF this loadsheet${
                genConfirm.pendingNames.length
                  ? `: ${genConfirm.pendingNames.slice(0, 8).join(', ')}${
                      genConfirm.pending > genConfirm.pendingNames.length ? '…' : ''
                    }`
                  : ''
              }. ${genConfirm.ready} ${
                genConfirm.ready === 1 ? 'is' : 'are'
              } ready now. Generate for the ready ones, or wait a moment and try again to include all of them.`
            : ''
        }
        confirmLabel={`Generate ${genConfirm?.ready ?? ''} ready`}
        onConfirm={() => {
          const g = genConfirm;
          setGenConfirm(null);
          void g?.run();
        }}
        onCancel={() => setGenConfirm(null)}
      />

      {/* ── Ready to manifest — the staging lane. One-click per courier: it
          manifests every ready parcel and the new batch drops into the
          Manifests list below, so there is no tab-switch mid-dispatch. ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-gray-800">Ready to manifest</p>
          <p className="text-xs text-gray-400">
            {(staging?.totals.total ?? 0).toLocaleString()} booked parcel
            {(staging?.totals.total ?? 0) === 1 ? '' : 's'} awaiting a loadsheet.
            Every other status lives on the{' '}
            <span className="font-medium">Orders</span> tab.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setBookOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-green-600 text-white hover:bg-green-700"
          >
            <Plus className="w-3.5 h-3.5" /> Book shipment
          </button>
          <button
            onClick={refreshDispatch}
            disabled={refreshingDispatch}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', refreshingDispatch && 'animate-spin')} /> Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {COURIER_TYPES.map((c) => {
          const st = staging?.couriers.find((x) => x.courier === c);
          const count = st?.total ?? 0;
          const manifestable = st?.withTracking ?? 0;
          const stillBooking = count - manifestable;
          const busy = manifestBusy === c;
          const stale = st?.oldestDays != null && st.oldestDays >= 7;
          return (
            <div
              key={c}
              className={cn(
                'relative overflow-hidden rounded-xl border bg-white p-3',
                count > 0 ? 'border-gray-200' : 'border-gray-200 opacity-60',
              )}
            >
              <span
                className={cn(
                  'absolute inset-y-0 left-0 w-1',
                  count > 0 ? 'bg-amber-500' : 'bg-gray-200',
                )}
              />
              <div className="pl-1.5">
                <p className="text-xs font-semibold text-gray-700">
                  {COURIER_LABELS[c]}
                </p>
                <p
                  className={cn(
                    'mt-1 text-3xl font-bold leading-none tabular-nums',
                    count > 0 ? 'text-amber-700' : 'text-gray-400',
                  )}
                >
                  {count}
                </p>
                <p className="mt-1 min-h-[16px] text-[11px] text-gray-500">
                  {count === 0
                    ? 'nothing waiting'
                    : stillBooking > 0
                      ? `${manifestable} ready · ${stillBooking} still booking`
                      : 'all have tracking'}
                </p>
                <p className="mt-1 min-h-[16px] text-[11px] font-medium">
                  {stale ? (
                    <span className="text-rose-600">
                      &#9888; oldest waiting {st!.oldestDays}d
                    </span>
                  ) : count === 1 ? (
                    <span className="text-gray-400">just 1 — wait to batch?</span>
                  ) : null}
                </p>
                <button
                  onClick={() => manifestCourier(c)}
                  disabled={count === 0 || busy}
                  title={
                    count === 1
                      ? 'Only 1 parcel is ready — you may want to wait until more are booked and manifest them together.'
                      : undefined
                  }
                  className={cn(
                    'mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors',
                    count === 0
                      ? 'cursor-default bg-gray-50 text-gray-400'
                      : count === 1
                        ? 'border border-green-600 text-green-700 hover:bg-green-50 disabled:opacity-60'
                        : 'bg-green-600 text-white hover:bg-green-700 disabled:opacity-60',
                  )}
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FileText className="h-3.5 w-3.5" />
                  )}
                  {count > 0 ? `Manifest ${count} & get docs` : 'Nothing to manifest'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Pick individual parcels — the old parcel-level worklist (subset
          manifesting + label/slip printing before dispatch), demoted below the
          one-click cards but fully preserved. */}
      <div>
        <button
          type="button"
          onClick={() => setPickOpen((o) => !o)}
          aria-expanded={pickOpen}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
        >
          <ChevronDown
            size={13}
            className={cn('opacity-60 transition-transform', pickOpen && 'rotate-180')}
          />
          {pickOpen ? 'Hide parcel list' : 'Pick individual parcels'}
          {(staging?.totals.total ?? 0) > 0 && (
            <span className="text-gray-400">
              ({(staging?.totals.total ?? 0).toLocaleString()})
            </span>
          )}
        </button>
      </div>

      {pickOpen && (
        <>
      <div className="flex flex-wrap items-center justify-end gap-2">
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
      </div>

      <PeriodSelect
        period={period}
        customFrom={customFrom}
        customTo={customTo}
        onChange={(n) => {
          setPage(1);
          setPeriod(n.period);
          setCustomFrom(n.customFrom);
          setCustomTo(n.customTo);
        }}
      />

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

              {/* Cancel actions — these are booked parcels, so unbooking (return
                  to To-book) and full order cancel both apply here. */}
              <span className="mx-0.5 h-5 w-px bg-gray-200" aria-hidden />
              <button
                onClick={() => setStgConfirmCancel('unbook')}
                disabled={stgCancelBusy || labelSel.size === 0}
                title="Cancel the courier booking + unfulfill in Shopify. The order stays open and returns to To-book."
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-40"
              >
                <Ban className="h-3.5 w-3.5" />
                Cancel booking {labelSel.size}
              </button>
              <button
                onClick={() => setStgConfirmCancel('cancel')}
                disabled={stgCancelBusy || labelSel.size === 0}
                title="Fully cancel the order in Shopify (cancel + archive) and CodesApp. Irreversible."
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Cancel order {labelSel.size}
              </button>
            </div>
          </div>
          {/* Phone: parcel cards instead of a 9-column sideways table. */}
          <div className="space-y-2 p-3 md:hidden">
            {visible.map((s) => {
              const cod =
                s.total_outstanding != null && s.total_outstanding > 0
                  ? s.total_outstanding
                  : s.total_price ?? null;
              const cur = s.currency || 'Rs';
              const picked = labelSel.has(s.id);
              return (
                <div
                  key={s.id}
                  className={cn(
                    'rounded-xl border p-3',
                    picked ? 'border-green-300 bg-green-50/60' : 'border-gray-200',
                  )}
                >
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={picked}
                      onChange={(e) =>
                        setLabelSel((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(s.id);
                          else next.delete(s.id);
                          return next;
                        })
                      }
                      className="mt-0.5 shrink-0 cursor-pointer"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <OrderNameButton
                          name={s.shopify_order_name}
                          number={s.shopify_order_name}
                        />
                        <span
                          className={cn(
                            'shrink-0 rounded-full px-2 py-0.5 text-[11px]',
                            STATUS_STYLES[s.status],
                          )}
                        >
                          {STATUS_LABELS[s.status]}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-sm font-medium text-gray-800">
                        {s.customer_name || '—'}
                      </span>
                      <span className="block truncate text-xs text-gray-500">
                        {[s.order_city || s.destination_city, s.phone]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </span>
                      <span className="mt-1.5 flex items-end justify-between gap-2 border-t border-gray-100 pt-1.5">
                        <span className="min-w-0 truncate text-xs text-gray-500">
                          {s.items_summary || '—'}
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block text-sm font-semibold tabular-nums text-gray-900">
                            {cod != null ? `${cur} ${Number(cod).toLocaleString()}` : '—'}
                          </span>
                          <span className="block font-mono text-[10px] text-gray-400">
                            {s.courier_tracking_number || COURIER_LABELS[s.courier_type]}
                          </span>
                        </span>
                      </span>
                      {s.address_issue_reason && (
                        <span className="mt-1 flex items-start gap-1 text-[11px] text-orange-600">
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                          {s.address_issue_reason}
                        </span>
                      )}
                    </span>
                  </label>
                </div>
              );
            })}
          </div>

          <div className="hidden overflow-x-auto md:block">
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
                        <OrderNameButton
                          name={s.shopify_order_name}
                          number={s.shopify_order_name}
                        />
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
        </>
      )}

      {/* ── Manifests — every loadsheet, grouped by day (today first). Embedded
          here so dispatch is one screen: manifest above, download below. ── */}
      <ManifestsPanel toast={toast} refreshNonce={manifestsNonce} />

      <ConfirmDialog
        open={stgConfirmCancel !== null}
        danger
        busy={stgCancelBusy}
        title={
          stgConfirmCancel === 'cancel'
            ? `Cancel ${labelSel.size} order${labelSel.size === 1 ? '' : 's'}?`
            : `Cancel booking on ${labelSel.size} parcel${labelSel.size === 1 ? '' : 's'}?`
        }
        message={
          stgConfirmCancel === 'cancel'
            ? 'This fully cancels the selected orders in Shopify (cancel + archive) and CodesApp. Any courier booking is cancelled too. This cannot be undone.'
            : 'This cancels the courier booking and unfulfills the selected orders in Shopify. The orders stay open and return to To-book so you can re-book them.'
        }
        confirmLabel={
          stgConfirmCancel === 'cancel'
            ? `Cancel ${labelSel.size} order${labelSel.size === 1 ? '' : 's'}`
            : `Cancel ${labelSel.size} booking${labelSel.size === 1 ? '' : 's'}`
        }
        onConfirm={() => stgConfirmCancel && startStagingCancel(stgConfirmCancel)}
        onCancel={() => {
          if (!stgCancelBusy) setStgConfirmCancel(null);
        }}
      />

      {stgCancelBatch && (
        <BulkCancelProgressModal
          batchId={stgCancelBatch.batchId}
          mode={stgCancelBatch.mode}
          total={stgCancelBatch.total}
          onClose={() => {
            setStgCancelBatch(null);
            load();
            loadStaging();
          }}
        />
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
  view: 'queue' | 'dispatch' | 'performance' | 'payments';
  setView: (
    v: 'queue' | 'dispatch' | 'performance' | 'payments',
  ) => void;
}) {
  const { user } = useAuth();
  // Fulfillment/dispatch role never sees payments or analytics.
  const isFulfillment = user?.role === 'fulfillment';
  const tabs: Array<
    ['queue' | 'dispatch' | 'performance' | 'payments', string]
  > = [
    ['queue', 'Orders'],
    ['dispatch', 'Dispatch'],
    ['performance', 'Courier performance'],
    ...(isFulfillment
      ? []
      : ([['payments', 'Courier payments']] as Array<
          ['payments', string]
        >)),
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-gray-200 bg-gray-50 p-1">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            onClick={() => setView(k)}
            className={cn(
              'shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition-colors',
              view === k
                ? 'bg-white font-semibold text-gray-900 shadow-sm ring-1 ring-gray-200'
                : 'text-gray-600 hover:bg-white/60 hover:text-gray-900',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {!isFulfillment && (
        <Link
          href="/orders/analytics"
          className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-gray-200 bg-white px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
        >
          <BarChart3 className="h-4 w-4" /> Analytics
        </Link>
      )}
    </div>
  );
}

// ── The Manifests list: every generated loadsheet, grouped by day (today
//    first), each with its documents — loadsheet PDF primary, the rest
//    secondary. Embedded in the Dispatch view below the staging lane. ──
function ManifestsPanel({
  toast,
  refreshNonce,
}: {
  toast: ReturnType<typeof useToast>;
  refreshNonce?: number;
}) {
  const [batches, setBatches] = useState<LoadsheetBatch[] | null>(null);
  const [courierFilter, setCourierFilter] = useState<CourierType | 'all'>('all');
  const [period] = useState<PeriodKey>('all');
  const [customFrom] = useState('');
  const [customTo] = useState('');
  const [busy, setBusy] = useState<string | null>(null); // `${id}:${kind}`
  const [showOlder, setShowOlder] = useState(false);

  const load = useCallback(async () => {
    try {
      const range = periodRange(period, { from: customFrom, to: customTo });
      const rows = await listLoadsheets({
        courier: courierFilter === 'all' ? undefined : courierFilter,
        from: range.from,
        to: range.to,
      });
      setBatches(rows);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load loadsheets');
      setBatches([]);
    }
  }, [toast, courierFilter, period, customFrom, customTo]);

  useEffect(() => {
    load();
  }, [load]);

  // A generate in the staging lane above bumps this — re-fetch so the new batch
  // shows without the operator refreshing.
  useEffect(() => {
    if (refreshNonce) load();
  }, [refreshNonce, load]);

  // Keep polling while any batch is still generating (self-terminating).
  useEffect(() => {
    if (!batches?.some((b) => b.status === 'generating')) return;
    const id = setTimeout(() => load(), 2500);
    return () => clearTimeout(id);
  }, [batches, load]);

  const openPdf = (url: string, filename: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.target = '_blank';
    a.rel = 'noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const run = async (
    id: number,
    kind: 'labels' | 'picklist' | 'alist',
    fn: () => Promise<{ url: string }>,
    filename: string,
    okMsg: string,
  ) => {
    setBusy(`${id}:${kind}`);
    try {
      const res = await fn();
      openPdf(res.url, filename);
      toast.success(okMsg);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Download failed');
    } finally {
      setBusy(null);
    }
  };

  const all = batches ?? [];

  const statusPill = (b: LoadsheetBatch) => (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize',
        b.status === 'ready'
          ? 'bg-green-50 text-green-700'
          : b.status === 'failed'
            ? 'bg-red-50 text-red-700'
            : 'bg-amber-50 text-amber-700',
      )}
      title={b.status === 'failed' && b.error ? b.error : undefined}
    >
      {b.status === 'generating' && <Loader2 className="h-3 w-3 animate-spin" />}
      {b.status}
    </span>
  );

  const TONES: Record<string, string> = {
    green: 'border-green-200 bg-green-50 text-green-700 hover:bg-green-100',
    blue: 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100',
    violet: 'border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100',
    amber: 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100',
  };
  const actionBtn = (opts: {
    onClick: () => void;
    disabled?: boolean;
    loading?: boolean;
    icon: React.ReactNode;
    label: string;
    tone: 'green' | 'blue' | 'violet' | 'amber';
  }) => (
    <button
      onClick={opts.onClick}
      disabled={opts.disabled || opts.loading}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-50 disabled:text-gray-400',
        TONES[opts.tone],
      )}
    >
      {opts.loading ? <Loader2 className="h-3 w-3 animate-spin" /> : opts.icon}
      {opts.label}
    </button>
  );

  // Group manifests by calendar day, most recent first, so today's dispatch
  // (the only thing usually touched) leads and old records sit below.
  const dayGroups = (() => {
    const map = new Map<string, LoadsheetBatch[]>();
    for (const b of all) {
      const key = new Date(b.created_at).toDateString();
      (map.get(key) ?? map.set(key, []).get(key)!).push(b);
    }
    const today = new Date().toDateString();
    const yst = new Date(Date.now() - 86_400_000).toDateString();
    return Array.from(map.entries()).map(([key, rows]) => ({
      key,
      label: key === today ? 'Today' : key === yst ? 'Yesterday' : fmtDate(rows[0].created_at),
      rows,
      parcels: rows.reduce((n, r) => n + r.shipment_count, 0),
    }));
  })();
  // Today + yesterday expanded; older days collapse behind a line.
  const RECENT = 2;
  const recentGroups = dayGroups.slice(0, RECENT);
  const olderGroups = dayGroups.slice(RECENT);
  const olderCount = olderGroups.reduce((n, g) => n + g.rows.length, 0);

  const cmarkBg: Record<CourierType, string> = {
    trax: '#1D4ED8',
    leopards: '#B45309',
    postex: '#7C3AED',
    rocket: '#0F766E',
  };

  const ManifestRow = ({ b }: { b: LoadsheetBatch }) => {
    const failed = b.status === 'failed';
    return (
      <div className="rounded-xl border border-gray-200 bg-white px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="flex items-center gap-2.5">
            <span
              className="grid h-6 w-6 place-items-center rounded-md text-[10px] font-bold text-white"
              style={{ background: cmarkBg[b.courier_type] }}
            >
              {COURIER_LABELS[b.courier_type].slice(0, 2).toUpperCase()}
            </span>
            <span>
              <span className="block text-sm font-semibold text-gray-800">
                {COURIER_LABELS[b.courier_type]}
              </span>
              <span className="block text-[11px] text-gray-500">
                <b className="font-semibold text-gray-700">{b.shipment_count}</b>{' '}
                parcel{b.shipment_count === 1 ? '' : 's'} · {fmtTime(b.created_at)}
              </span>
            </span>
          </span>

          {statusPill(b)}

          <span className="flex-1" />

          {failed ? (
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  setBusy(`${b.id}:retry`);
                  try {
                    await generateLoadsheet(b.courier_type);
                    toast.success(`${COURIER_LABELS[b.courier_type]} loadsheet re-queued`);
                    load();
                  } catch (e) {
                    toast.error(
                      e instanceof ApiError ? e.userMessage : 'Retry failed',
                    );
                  } finally {
                    setBusy(null);
                  }
                }}
                disabled={busy === `${b.id}:retry`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700 disabled:opacity-60"
              >
                {busy === `${b.id}:retry` ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                Retry
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {/* Loadsheet PDF — the courier's copy, reached on nearly every
                  manifest, so it's the one prominent action. */}
              {actionBtn({
                onClick: () =>
                  b.pdf_media_url &&
                  openPdf(b.pdf_media_url, `loadsheet-${b.courier_type}-${b.id}.pdf`),
                disabled: !b.pdf_media_url,
                icon: <Download className="h-3 w-3" />,
                label: 'Loadsheet',
                tone: 'green',
              })}
              {b.courier_type !== 'leopards' &&
                actionBtn({
                  onClick: () =>
                    run(
                      b.id,
                      'labels',
                      () => loadsheetSlips(b.id),
                      `labels-${b.courier_type}-${b.id}.pdf`,
                      'Labels ready',
                    ),
                  loading: busy === `${b.id}:labels`,
                  icon: <Package className="h-3 w-3" />,
                  label: 'Labels',
                  tone: 'blue',
                })}
              {actionBtn({
                onClick: () =>
                  run(
                    b.id,
                    'picklist',
                    () => loadsheetPicklist(b.id),
                    `picklist-${b.id}.pdf`,
                    'Picklist ready',
                  ),
                loading: busy === `${b.id}:picklist`,
                icon: <Package className="h-3 w-3" />,
                label: 'Picklist',
                tone: 'violet',
              })}
              {actionBtn({
                onClick: () =>
                  run(
                    b.id,
                    'alist',
                    () => loadsheetDispatchList(b.id),
                    `a-list-${b.id}.pdf`,
                    'A-List ready',
                  ),
                loading: busy === `${b.id}:alist`,
                icon: <FileText className="h-3 w-3" />,
                label: 'A-List',
                tone: 'amber',
              })}
            </div>
          )}
        </div>
        {/* A failed batch means a run that didn't go out — show the courier's
            actual reason inline instead of hiding it in a tooltip. */}
        {failed && b.error && (
          <p className="mt-2 flex items-start gap-1.5 text-[12px] text-rose-600">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="break-words">{b.error}</span>
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-gray-800">Manifests</p>
          <p className="text-xs text-gray-400">
            Every loadsheet you have generated. Download the loadsheet for the
            courier, or its labels, picklist and A-List.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={courierFilter}
            onChange={(e) =>
              setCourierFilter(e.target.value as CourierType | 'all')
            }
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
            onClick={load}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
      </div>

      {batches === null ? (
        <div className="flex items-center justify-center py-12 text-gray-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : all.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center">
          <FileText className="mx-auto mb-2 h-8 w-8 text-gray-300" />
          <p className="text-sm text-gray-500">No manifests yet.</p>
          <p className="mt-1 text-xs text-gray-400">
            Manifest a courier from the staging lane above to generate one.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {recentGroups.map((g) => (
            <div key={g.key}>
              <div className="mb-2 flex items-baseline gap-2.5">
                <span className="text-sm font-semibold text-gray-800">{g.label}</span>
                <span className="text-xs text-gray-400">
                  {g.rows.length} manifest{g.rows.length === 1 ? '' : 's'} ·{' '}
                  {g.parcels.toLocaleString()} parcels
                </span>
              </div>
              <div className="space-y-2">
                {g.rows.map((b) => (
                  <ManifestRow key={b.id} b={b} />
                ))}
              </div>
            </div>
          ))}

          {olderGroups.length > 0 && (
            <div>
              {!showOlder ? (
                <button
                  type="button"
                  onClick={() => setShowOlder(true)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl border border-dashed border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-600 hover:bg-gray-100"
                >
                  <span>
                    <b className="text-gray-800">{olderCount} earlier manifest{olderCount === 1 ? '' : 's'}</b>
                    {' · back to '}
                    {fmtDate(olderGroups[olderGroups.length - 1].rows[0].created_at)}
                  </span>
                  <span className="text-gray-400">Show all →</span>
                </button>
              ) : (
                <div className="space-y-5">
                  {olderGroups.map((g) => (
                    <div key={g.key}>
                      <div className="mb-2 flex items-baseline gap-2.5">
                        <span className="text-sm font-semibold text-gray-800">
                          {g.label}
                        </span>
                        <span className="text-xs text-gray-400">
                          {g.rows.length} manifest{g.rows.length === 1 ? '' : 's'} ·{' '}
                          {g.parcels.toLocaleString()} parcels
                        </span>
                      </div>
                      <div className="space-y-2">
                        {g.rows.map((b) => (
                          <ManifestRow key={b.id} b={b} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
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
  no_response: { label: 'No response', cls: 'bg-orange-50 text-orange-700' },
  pending: { label: 'Awaiting confirm', cls: 'bg-amber-50 text-amber-700' },
  undeliverable: { label: 'No WhatsApp', cls: 'bg-red-50 text-red-700' },
  cancelled: { label: 'Customer cancelled', cls: 'bg-rose-50 text-rose-700' },
  none: { label: 'Not confirmed', cls: 'bg-gray-100 text-gray-600' },
};

// ── Workload lanes ─────────────────────────────────────────────────────
// The board's four top-level buckets. This replaced eleven count-less status
// chips: a dispatcher's real question is "what needs me now?", and the finer
// statuses are a refinement WITHIN a lane, not eleven separate places to look.
// Every one of the old chips is still reachable through `REFINE_OPTIONS` below.
type LaneKey = 'tobook' | 'inflight' | 'attention' | 'delivered';

interface LaneDef {
  key: LaneKey;
  label: string;
  /** The queue filter this lane loads. */
  status: QueueStatusFilter;
  /** Finer statuses that still belong to this lane (keeps the lane highlighted). */
  members: QueueStatusFilter[];
  hint: string;
  /** Tailwind classes: accent text, tint background, active ring, rail. */
  tone: { text: string; bg: string; ring: string; rail: string };
}

const LANES: LaneDef[] = [
  {
    key: 'tobook',
    label: 'To book',
    status: 'unfulfilled',
    members: ['unfulfilled'],
    hint: 'Orders waiting on a courier booking.',
    tone: {
      text: 'text-orange-700',
      bg: 'bg-orange-50',
      ring: 'ring-orange-300 border-orange-300',
      rail: 'bg-orange-500',
    },
  },
  {
    key: 'inflight',
    label: 'In transit',
    status: 'in_flight',
    members: ['in_flight', 'booked', 'in_transit', 'out_for_delivery'],
    hint: 'Parcels with the courier right now.',
    tone: {
      text: 'text-sky-700',
      bg: 'bg-sky-50',
      ring: 'ring-sky-300 border-sky-300',
      rail: 'bg-sky-500',
    },
  },
  {
    key: 'attention',
    label: 'Needs attention',
    status: 'needs_attention',
    members: ['needs_attention', 'address_issue', 'attempted', 'failed', 'returned'],
    hint: 'Parcels a person has to intervene on.',
    tone: {
      text: 'text-rose-700',
      bg: 'bg-rose-50',
      ring: 'ring-rose-300 border-rose-300',
      rail: 'bg-rose-500',
    },
  },
  {
    key: 'delivered',
    label: 'Delivered',
    status: 'delivered',
    members: ['delivered'],
    hint: 'Completed — kept on record.',
    tone: {
      text: 'text-green-700',
      bg: 'bg-green-50',
      ring: 'ring-green-300 border-green-300',
      rail: 'bg-green-500',
    },
  },
];

// Per-lane refinements + the archive/record views that belong to no lane. Every
// status chip the board used to show is present here.
const REFINE_OPTIONS: Record<LaneKey, Array<[QueueStatusFilter, string]>> = {
  tobook: [['unfulfilled', 'All waiting']],
  inflight: [
    ['in_flight', 'All in transit'],
    ['booked', 'Booked'],
    ['in_transit', 'On the way'],
    ['out_for_delivery', 'Out for delivery'],
  ],
  attention: [
    ['needs_attention', 'Everything'],
    ['address_issue', 'Address issue'],
    ['attempted', 'Attempted'],
    ['failed', 'Failed'],
    ['returned', 'Returned'],
  ],
  delivered: [['delivered', 'All delivered']],
};

const OTHER_VIEWS: Array<[QueueStatusFilter, string]> = [
  ['all', 'All open orders'],
  ['fulfilled', 'Fulfilled'],
  ['archived', 'Archived'],
  ['cancelled', 'Cancelled'],
];

/** Which lane a filter belongs to (null for the record views). */
function laneForStatus(s: QueueStatusFilter): LaneKey | null {
  const hit = LANES.find((l) => l.members.includes(s));
  return hit ? hit.key : null;
}

const SORT_OPTIONS: Array<[QueueSort, string]> = [
  ['oldest', 'Longest waiting first'],
  ['newest', 'Newest first'],
  ['value', 'Highest value first'],
];

/**
 * How long an order has been waiting, with severity. The board previously showed
 * only a created-date, so an order confirmed 20 minutes ago and one sitting
 * unbooked since Tuesday looked identical — age is the most useful signal in a
 * dispatch queue. `live` styles the bar only where waiting is actionable
 * (To book / Needs attention); elsewhere it is neutral context.
 */
function WaitingCell({
  createdAt,
  live,
}: {
  createdAt: string | null;
  live: boolean;
}) {
  if (!createdAt) return <span className="text-xs text-gray-300">—</span>;
  const ms = Date.now() - new Date(createdAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    return <span className="text-xs text-gray-300">—</span>;
  }
  const hrs = ms / 3_600_000;
  const label =
    hrs < 1
      ? `${Math.max(1, Math.round(ms / 60_000))}m`
      : hrs < 24
        ? `${Math.floor(hrs)}h`
        : `${Math.floor(hrs / 24)}d`;
  const level = hrs >= 72 ? 'late' : hrs >= 24 ? 'due' : 'fresh';
  const bar =
    level === 'late'
      ? 'bg-rose-500'
      : level === 'due'
        ? 'bg-amber-500'
        : 'bg-sky-400';
  const width = level === 'late' ? 100 : level === 'due' ? 55 : 22;
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <span className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-gray-200">
        <span
          className={cn('block h-full rounded-full', live ? bar : 'bg-gray-300')}
          style={{ width: `${width}%` }}
        />
      </span>
      <span
        className={cn(
          'text-xs tabular-nums',
          live && level === 'late'
            ? 'font-semibold text-rose-600'
            : 'text-gray-500',
        )}
      >
        {label}
      </span>
    </span>
  );
}

function FulfillmentQueue({
  toast,
  onChanged,
}: {
  toast: ReturnType<typeof useToast>;
  onChanged?: () => void;
}) {
  const { user } = useAuth();
  const [rows, setRows] = useState<QueueOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  // The board opens on the work, not on "All" — To book is the job.
  const [status, setStatus] = useState<QueueStatusFilter>('unfulfilled');
  // Longest-waiting first: in a dispatch queue the oldest order is the urgent one.
  const [sort, setSort] = useState<QueueSort>('oldest');
  const [counts, setCounts] = useState<LaneCounts | null>(null);
  // Row density + the metrics strip's collapsed state persist per device: they
  // are personal working preferences, re-picked on every visit otherwise.
  const [dense, setDense] = useState(false);
  const [showMetrics, setShowMetrics] = useState(false);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  // Keyboard cursor: index of the focused row for j/k navigation (-1 = none).
  const [cursor, setCursor] = useState(-1);
  const cursorRef = useRef(-1);
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const syncMenuRef = useRef<HTMLDivElement>(null);
  // Filter the board to a single courier (or 'all'). Applies under every tab.
  const [courierFilter, setCourierFilter] = useState<CourierType | 'all'>('all');
  // Time-period filter (by order created date). Applies under every tab.
  const [period, setPeriod] = useState<PeriodKey>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  // To-book sub-tab: all | confirmed | awaiting confirmation.
  const [confSub, setConfSub] = useState<'all' | 'confirmed' | 'unconfirmed'>('all');
  const [pageSize, setPageSize] = useState<number | 'all'>(50);
  // 'selected' shows ONLY the currently-selected rows (fetched by gid, so it
  // covers a selection spanning pages not currently loaded); never touches
  // `selected` itself — purely which rows are displayed.
  const [rowView, setRowView] = useState<'all' | 'selected'>('all');
  const [rowViewMenuOpen, setRowViewMenuOpen] = useState(false);
  const rowViewMenuRef = useRef<HTMLDivElement>(null);
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
  const [noRespGid, setNoRespGid] = useState<string | null>(null);
  // Confirmation-actions dropdown: which row + where to anchor it. Rendered
  // FIXED (viewport-positioned) so it overlays instead of expanding the row and
  // is never clipped by the table's overflow-x-auto wrapper.
  const [confMenu, setConfMenu] = useState<{
    gid: string;
    x: number;
    y: number;
  } | null>(null);
  // Close the dropdown on any scroll/resize (a fixed menu would otherwise drift
  // away from its chevron) or an outside click. A click INSIDE the menu or on
  // the chevron (both tagged data-conf-menu) is ignored, so the mousedown-close
  // can't unmount a button before its own click fires.
  useEffect(() => {
    if (!confMenu) return;
    const onDown = (e: Event) => {
      if ((e.target as HTMLElement)?.closest?.('[data-conf-menu]')) return;
      setConfMenu(null);
    };
    const close = () => setConfMenu(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('mousedown', onDown);
    };
  }, [confMenu]);
  // "Send to another number" target row (No-WhatsApp orders).
  const [altPhoneRow, setAltPhoneRow] = useState<QueueOrder | null>(null);
  // Row whose parcel we're viewing on the courier's own portal (iframe modal).
  const [trackRow, setTrackRow] = useState<QueueOrder | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Mirrors `selected` for `load()` to read without being a callback dependency
  // — otherwise every checkbox click would give `load` a new identity and
  // retrigger the effect that calls it (an unwanted reload per click).
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    if (!rowViewMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (rowViewMenuRef.current && !rowViewMenuRef.current.contains(e.target as Node)) {
        setRowViewMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [rowViewMenuOpen]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  // Per-row courier override (gid → courier); falls back to the city suggestion.
  const [rowCourier, setRowCourier] = useState<Record<string, CourierType>>({});
  // Bulk courier override ('' = each order uses its own city suggestion).
  const [bulkCourier, setBulkCourier] = useState<CourierType | ''>('');
  // Live bulk-book progress (null = no active batch). Persists after the modal
  // is closed so a slim progress BAR can keep showing background booking.
  const [progress, setProgress] = useState<{
    gids: string[];
    meta: Record<string, { orderName: string; courier?: CourierType }>;
  } | null>(null);
  // Whether the full progress modal is open. When false but `progress` is set,
  // the minimized bar shows instead (click to reopen).
  const [progressOpen, setProgressOpen] = useState(false);
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
  // Bulk-cancel: which mode is pending confirmation ('unbook' | 'cancel'), the
  // busy flag, and the live progress batch (null = no modal).
  const [confirmBulkCancel, setConfirmBulkCancel] = useState<BulkCancelMode | null>(null);
  const [bulkCancelBusy, setBulkCancelBusy] = useState(false);
  const [cancelBatch, setCancelBatch] = useState<{
    batchId: string;
    mode: BulkCancelMode;
    total: number;
  } | null>(null);

  // A row can be selected/booked only if it's still unfulfilled, not already
  // booked, and a courier serves its city. (Fulfilled/All views are read-only
  // records — no Book action.)
  const bookable = (r: QueueOrder) =>
    !r.archived &&
    r.fulfillmentStatus === 'unfulfilled' &&
    !r.shipment &&
    !!r.suggestedCourier;

  // Hard safety cap when pageSize==='all' — mirrors the take:20000/50000 caps
  // used elsewhere in the backend queue-building code; a tenant with more open
  // orders than this should paginate instead of loading them all client-side.
  const ALL_ROWS_CAP = 5000;

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
        const range = periodRange(period, { from: customFrom, to: customTo });
        const baseParams = {
          search,
          status,
          sort,
          confirmation:
            status === 'unfulfilled' && confSub !== 'all' ? confSub : undefined,
          courier: courierFilter === 'all' ? undefined : courierFilter,
          from: range.from,
          to: range.to,
        } as const;

        // "Show selected" restricts to exactly the selected gids — fetched via
        // the gid-scoped endpoint so it covers a selection spanning pages that
        // aren't currently loaded. Nothing selected → skip the request.
        const selectedGids = rowView === 'selected' ? Array.from(selectedRef.current) : null;
        if (selectedGids && selectedGids.length === 0) {
          setRows([]);
          setTotal(0);
          if (!keepSelection) setSelected(new Set());
          return;
        }
        const fetchPage = (p: number, ps: number) =>
          selectedGids
            ? listFulfillmentQueueByGids({ ...baseParams, gids: selectedGids, page: p, pageSize: ps })
            : listFulfillmentQueue({ ...baseParams, page: p, pageSize: ps });

        if (pageSize === 'all') {
          // Server caps a single request at 200 — loop pages of 200 and stitch
          // them into one client-side view, up to a safety cap.
          let all: QueueOrder[] = [];
          let grandTotal = 0;
          let p = 1;
          for (;;) {
            const res = await fetchPage(p, 200);
            grandTotal = res.total;
            all = all.concat(res.rows);
            if (all.length >= res.total || res.rows.length < 200 || all.length >= ALL_ROWS_CAP) break;
            p++;
          }
          if (all.length > ALL_ROWS_CAP) all = all.slice(0, ALL_ROWS_CAP);
          if (grandTotal > ALL_ROWS_CAP) {
            toast.info(`Showing the first ${ALL_ROWS_CAP.toLocaleString()} of ${grandTotal.toLocaleString()} — narrow the filters to see the rest.`);
          }
          setRows(all);
          setTotal(grandTotal);
        } else {
          const res = await fetchPage(page, pageSize);
          setRows(res.rows);
          setTotal(res.total);
        }
        if (!keepSelection) setSelected(new Set()); // clear on reload/page change
      } catch (e) {
        toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load orders');
        if (!silent) setRows([]);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [search, page, pageSize, status, sort, confSub, courierFilter, period, customFrom, customTo, rowView, toast],
  );

  // Lane counts follow the board's own filters (search / courier / period) but
  // NOT the active lane — the whole point is seeing the other lanes' workload
  // without opening them. Best-effort: a counts failure must never blank the board.
  const loadCounts = useCallback(async () => {
    try {
      const range = periodRange(period, { from: customFrom, to: customTo });
      setCounts(
        await fulfillmentLaneCounts({
          search,
          courier: courierFilter === 'all' ? undefined : courierFilter,
          from: range.from,
          to: range.to,
        }),
      );
    } catch {
      setCounts(null);
    }
  }, [search, courierFilter, period, customFrom, customTo]);

  useEffect(() => {
    loadCounts();
  }, [loadCounts]);

  // Restore per-device preferences once on mount.
  useEffect(() => {
    try {
      setDense(localStorage.getItem('orders.queue.dense') === '1');
      setShowMetrics(localStorage.getItem('orders.queue.metrics') === '1');
    } catch {
      /* storage blocked — defaults are fine */
    }
  }, []);
  const persist = (key: string, on: boolean) => {
    try {
      localStorage.setItem(key, on ? '1' : '0');
    } catch {
      /* storage blocked */
    }
  };

  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  // Reset the keyboard cursor whenever the visible rows change underneath it.
  useEffect(() => {
    setCursor(-1);
  }, [rows]);

  useEffect(() => {
    if (!syncMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!syncMenuRef.current?.contains(e.target as Node)) setSyncMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [syncMenuOpen]);

  // Reload whenever a real filter/tab/rowView changes, or the page/pageSize
  // changes — but only CLEAR the selection when something other than
  // page/pageSize/rowView/SEARCH changed. Search is deliberately NOT in the
  // signature: a common workflow is to search one order number, tick it, search
  // the next, tick it — building a basket to bulk-cancel/archive. Clearing the
  // selection on every search made that impossible (and hid the selection action
  // bar, so the Cancel buttons "disappeared"). Selection is gid-based and the
  // "Show selected" view can retrieve rows off-screen, so keeping it across a
  // search is safe. Switching status/courier/period still clears (those onClick
  // handlers reset it explicitly) — a different view is a fresh basket.
  const filterSignature = [status, sort, confSub, courierFilter, period, customFrom, customTo].join(' ');
  const prevFilterSigRef = useRef(filterSignature);
  useEffect(() => {
    const filtersChanged = prevFilterSigRef.current !== filterSignature;
    prevFilterSigRef.current = filterSignature;
    load({ keepSelection: !filtersChanged });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      load({ silent: true, keepSelection: true });
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
      load({ silent: true, keepSelection: true });
      onChanged?.();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to mark confirmed',
      );
    } finally {
      setConfirmingGid(null);
    }
  };

  const noResponseOrder = async (r: QueueOrder) => {
    setNoRespGid(r.orderGid);
    try {
      await markOrderNoResponse(r.orderGid);
      toast.success(`Marked ${r.orderName ?? 'order'} no response`);
      load({ silent: true, keepSelection: true });
      onChanged?.();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to mark no response',
      );
    } finally {
      setNoRespGid(null);
    }
  };

  const resendConfirm = async (r: QueueOrder) => {
    setResendGid(r.orderGid);
    try {
      await resendConfirmation(r.orderGid);
      toast.success(`Confirmation template resent for ${r.orderName ?? 'order'}`);
      load({ silent: true, keepSelection: true });
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
      load({ silent: true, keepSelection: true });
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
      load({ silent: true, keepSelection: true });
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
      load({ silent: true, keepSelection: true });
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
      load({ silent: true, keepSelection: true });
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
      const range = periodRange(period, { from: customFrom, to: customTo });
      const ids = await getQueueIds({
        search,
        status,
        courier: courierFilter === 'all' ? undefined : courierFilter,
        from: range.from,
        to: range.to,
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

  // Kick off a bulk cancel (unbook / full cancel). Runs as a background batch;
  // the progress modal polls until it's done, then refreshes the board.
  const startBulkCancel = async (mode: BulkCancelMode) => {
    const gids = Array.from(selected);
    if (!gids.length) return;
    setBulkCancelBusy(true);
    try {
      const res = await bulkCancelShipments({ mode, orderGids: gids });
      setCancelBatch({ batchId: res.batchId, mode, total: res.queued });
      setConfirmBulkCancel(null);
      setSelected(new Set());
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Bulk cancel failed to start');
    } finally {
      setBulkCancelBusy(false);
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
      setProgressOpen(true);
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

  // ── Keyboard: j/k move, x select, b book, / search, Esc clear ────────
  // Dispatch is a repetitive queue; hands stay on the keyboard. Ignored while
  // typing in a field so it can never swallow a search term or an address edit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        !!el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable);
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === '/' && !typing) {
        e.preventDefault();
        document.getElementById('queue-search')?.focus();
        return;
      }
      if (typing) return;

      const max = rows.length - 1;
      if (max < 0) return;
      const cur = cursorRef.current;

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(max, c + 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => (c <= 0 ? 0 : c - 1));
      } else if (e.key === 'x' || e.key === ' ') {
        if (cur < 0 || cur > max) return;
        e.preventDefault();
        toggleOne(rows[cur].orderGid);
      } else if (e.key === 'b') {
        if (cur < 0 || cur > max) return;
        const r = rows[cur];
        if (!bookable(r)) return;
        e.preventDefault();
        book(r);
      } else if (e.key === 'Escape') {
        setCursor(-1);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // `book`/`toggleOne`/`bookable` are stable enough for this handler's life;
    // rows is the only value it must track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  // Keep the keyboard-focused row in view as the cursor moves.
  useEffect(() => {
    if (cursor < 0) return;
    document
      .querySelector(`[data-row-index="${cursor}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  // ── What exactly did I just select? ─────────────────────────────────
  // Before booking hundreds of parcels the operator should be able to read the
  // set back. Describes only what is TRUE of every selected row on this page.
  const selectionSummary = (() => {
    const picked = rows.filter((r) => selected.has(r.orderGid));
    if (!picked.length) return null;
    const bits: string[] = [];
    const cities = new Set(picked.map((r) => (r.city ?? '').trim()).filter(Boolean));
    const cityList = Array.from(cities);
    if (cities.size === 1) bits.push(`all ${cityList[0]}`);
    else if (cities.size > 1) bits.push(`${cities.size} cities`);
    if (picked.every((r) => r.confirmationStatus === 'confirmed')) {
      bits.push('all confirmed');
    }
    const cod = picked.reduce((n, r) => n + (r.totalOutstanding ?? 0), 0);
    if (cod > 0) bits.push(`${qmoney(cod, picked[0]?.currency ?? null)} COD`);
    const couriers = new Set(
      picked
        .map((r) => rowCourier[r.orderGid] ?? r.suggestedCourier)
        .filter(Boolean) as CourierType[],
    );
    const courierList = Array.from(couriers);
    if (courierList.length === 1) {
      bits.push(`→ ${COURIER_LABELS[courierList[0]]}`);
    }
    const unbookable = picked.filter((r) => !bookable(r)).length;
    if (unbookable) bits.push(`${unbookable} not bookable`);
    return bits.join(' · ');
  })();

  /** The board's filter snapshot for a saved view. */
  const viewState = {
    status,
    sort,
    confSub,
    courierFilter,
    period,
    customFrom,
    customTo,
    search,
  };

  const applyView = (v: Record<string, unknown>) => {
    setPage(1);
    setSelected(new Set());
    if (typeof v.status === 'string') setStatus(v.status as QueueStatusFilter);
    if (typeof v.sort === 'string') setSort(v.sort as QueueSort);
    if (typeof v.confSub === 'string') {
      setConfSub(v.confSub as 'all' | 'confirmed' | 'unconfirmed');
    }
    if (typeof v.courierFilter === 'string') {
      setCourierFilter(v.courierFilter as CourierType | 'all');
    }
    if (typeof v.period === 'string') setPeriod(v.period as PeriodKey);
    if (typeof v.customFrom === 'string') setCustomFrom(v.customFrom);
    if (typeof v.customTo === 'string') setCustomTo(v.customTo);
    if (typeof v.search === 'string') {
      setSearch(v.search);
      setSearchInput(v.search);
    }
  };

  const lastPage = pageSize === 'all' ? 1 : Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-3">
      {user?.role !== 'fulfillment' && (
        <div>
          <button
            type="button"
            onClick={() => {
              const next = !showMetrics;
              setShowMetrics(next);
              persist('orders.queue.metrics', next);
            }}
            aria-expanded={showMetrics}
            className="mb-2 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
          >
            <BarChart3 size={14} />
            {showMetrics ? 'Hide metrics' : 'Metrics'}
            <ChevronDown
              size={13}
              className={cn('opacity-60 transition-transform', showMetrics && 'rotate-180')}
            />
          </button>
          {showMetrics && <OrdersKpiStrip />}
        </div>
      )}
      {/* ── Workload lanes: the board's primary navigation. Each carries a live
          count, so the operator can see where the day's work is without opening
          a tab. The finer statuses live in the Refine control beside them. ── */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {LANES.map((lane) => {
          const active = laneForStatus(status) === lane.key;
          const c = counts;
          const value =
            lane.key === 'tobook'
              ? c?.toBook.total
              : lane.key === 'inflight'
                ? c?.inFlight.total
                : lane.key === 'attention'
                  ? c?.needsAttention.total
                  : c?.delivered.total;
          const sub =
            lane.key === 'tobook'
              ? c && `${c.toBook.confirmed.toLocaleString()} confirmed · ${c.toBook.awaiting.toLocaleString()} awaiting`
              : lane.key === 'inflight'
                ? c && `${c.inFlight.outForDelivery.toLocaleString()} out for delivery`
                : lane.key === 'attention'
                  ? c &&
                    `${c.needsAttention.addressIssue.toLocaleString()} address · ${c.needsAttention.failed.toLocaleString()} failed · ${c.needsAttention.returned.toLocaleString()} RTO`
                  : lane.hint;
          return (
            <button
              key={lane.key}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setPage(1);
                setSelected(new Set());
                setConfSub('all');
                setStatus(lane.status);
              }}
              className={cn(
                'relative overflow-hidden rounded-xl border p-3 text-left transition-colors',
                active
                  ? cn('ring-1', lane.tone.bg, lane.tone.ring)
                  : 'border-gray-200 bg-white hover:bg-gray-50',
              )}
            >
              <span
                className={cn('absolute inset-y-0 left-0 w-1', lane.tone.rail)}
              />
              <span className="block pl-1.5 text-xs font-semibold text-gray-600">
                {lane.label}
              </span>
              <span
                className={cn(
                  'mt-0.5 block pl-1.5 text-2xl font-bold leading-tight tabular-nums',
                  lane.tone.text,
                )}
              >
                {value == null ? '—' : value.toLocaleString()}
              </span>
              <span className="mt-0.5 block truncate pl-1.5 text-[11px] text-gray-500">
                {sub ?? lane.hint}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 max-w-full">
          {/* Refine within the lane — every status chip the board used to show. */}
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={status}
              onChange={(e) => {
                setPage(1);
                setSelected(new Set());
                setStatus(e.target.value as QueueStatusFilter);
              }}
              className="rounded-lg border border-gray-300 bg-white py-1.5 pl-3 pr-7 text-sm text-gray-700"
              title="Refine this lane"
            >
              {(() => {
                const lk = laneForStatus(status);
                const opts = lk ? REFINE_OPTIONS[lk] : [];
                return (
                  <>
                    {opts.length > 1 && (
                      <optgroup label="Refine">
                        {opts.map(([k, label]) => (
                          <option key={k} value={k}>
                            {label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {opts.length === 1 && (
                      <option value={opts[0][0]}>{opts[0][1]}</option>
                    )}
                    <optgroup label="Records">
                      {OTHER_VIEWS.map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                    </optgroup>
                  </>
                );
              })()}
            </select>

            <select
              value={sort}
              onChange={(e) => {
                setPage(1);
                setSort(e.target.value as QueueSort);
              }}
              className="rounded-lg border border-gray-300 bg-white py-1.5 pl-3 pr-7 text-sm text-gray-700"
              title="Sort the queue"
            >
              {SORT_OPTIONS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {/* To-book confirmation sub-tabs. */}
          {status === 'unfulfilled' && (
            <div className="mt-2 flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-gray-200 bg-gray-50 p-1">
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
                    'shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs transition-colors',
                    confSub === k
                      ? 'bg-white font-semibold text-gray-900 shadow-sm ring-1 ring-gray-200'
                      : 'text-gray-600 hover:bg-white/60 hover:text-gray-900',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <p className="mt-1.5 text-xs text-gray-400">
            {total.toLocaleString()}{' '}
            {status === 'unfulfilled' ? 'to book' : 'orders'}
            {laneForStatus(status) &&
              ` · ${LANES.find((l) => l.key === laneForStatus(status))!.hint}`}
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
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
          <form onSubmit={submitSearch} className="relative min-w-0 flex-1 sm:flex-none">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              id="queue-search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Order #, name, phone, city"
              className="w-full rounded-lg border border-gray-300 py-1.5 pl-8 pr-3 text-sm sm:w-56"
            />
          </form>
          <ScanToFind
            onScan={(code) => {
              setPage(1);
              setSearchInput(code);
              setSearch(code);
            }}
            className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
          />
          {/* One Sync control. These were four same-looking buttons whose
              differences lived only in tooltips — they are one intent with
              three scopes, so they collapse into a menu. */}
          <div className="relative" ref={syncMenuRef}>
            <button
              type="button"
              onClick={() => setSyncMenuOpen((o) => !o)}
              disabled={importing || reconciling || syncing}
              aria-haspopup="menu"
              aria-expanded={syncMenuOpen}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              {importing || reconciling || syncing ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <RefreshCw size={14} />
              )}
              {importing
                ? 'Importing…'
                : reconciling
                  ? 'Reconciling…'
                  : syncing
                    ? 'Syncing…'
                    : 'Sync'}
              <ChevronDown size={13} className="opacity-60" />
            </button>
            {syncMenuOpen && (
              <div
                role="menu"
                className="absolute right-0 z-30 mt-1 w-72 rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
              >
                <button
                  role="menuitem"
                  onClick={() => {
                    setSyncMenuOpen(false);
                    runImport();
                  }}
                  className="w-full px-3 py-2 text-left hover:bg-gray-50"
                >
                  <span className="block text-sm text-gray-800">
                    Import from Shopify
                  </span>
                  <span className="block text-[11px] text-gray-500">
                    Pull new and updated open orders.
                  </span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setSyncMenuOpen(false);
                    runReconcile();
                  }}
                  className="w-full px-3 py-2 text-left hover:bg-gray-50"
                >
                  <span className="block text-sm text-gray-800">
                    Reconcile with Shopify
                  </span>
                  <span className="block text-[11px] text-gray-500">
                    Drop orders archived or cancelled in Shopify.
                  </span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setSyncMenuOpen(false);
                    runSyncStatuses();
                  }}
                  className="w-full px-3 py-2 text-left hover:bg-gray-50"
                >
                  <span className="block text-sm text-gray-800">
                    Refresh courier statuses
                  </span>
                  <span className="block text-[11px] text-gray-500">
                    Pull fresh delivery status for parcels in transit.
                  </span>
                </button>
                <div className="my-1 border-t border-gray-100" />
                <button
                  role="menuitem"
                  onClick={() => {
                    setSyncMenuOpen(false);
                    load();
                    loadCounts();
                  }}
                  className="w-full px-3 py-2 text-left hover:bg-gray-50"
                >
                  <span className="block text-sm text-gray-800">
                    Reload this board
                  </span>
                  <span className="block text-[11px] text-gray-500">
                    Re-read what is already stored — no external call.
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <PeriodSelect
        period={period}
        customFrom={customFrom}
        customTo={customTo}
        onChange={(n) => {
          setPage(1);
          setSelected(new Set());
          setPeriod(n.period);
          setCustomFrom(n.customFrom);
          setCustomTo(n.customTo);
          setActiveViewId(null);
        }}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <SavedViews
          current={viewState}
          activeId={activeViewId}
          onApply={applyView}
          onActiveChange={setActiveViewId}
        />
        <div className="flex items-center gap-2">
          <span className="hidden text-[11px] text-gray-400 sm:inline">
            <kbd className="rounded border border-gray-200 px-1">j</kbd>
            <kbd className="ml-0.5 rounded border border-gray-200 px-1">k</kbd> move ·{' '}
            <kbd className="rounded border border-gray-200 px-1">x</kbd> select ·{' '}
            <kbd className="rounded border border-gray-200 px-1">b</kbd> book ·{' '}
            <kbd className="rounded border border-gray-200 px-1">/</kbd> search
          </span>
          <button
            type="button"
            onClick={() => {
              const next = !dense;
              setDense(next);
              persist('orders.queue.dense', next);
            }}
            title={dense ? 'Comfortable rows' : 'Compact rows'}
            className="rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
          >
            {dense ? 'Comfortable' : 'Compact'}
          </button>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-2 shadow-sm">
          <div className="flex flex-wrap items-center gap-2 text-sm text-green-800">
            <span>
              {selected.size.toLocaleString()} order{selected.size === 1 ? '' : 's'} selected
              {selectionSummary && (
                <span className="ml-1 font-normal text-green-700">
                  · {selectionSummary}
                </span>
              )}
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
            <div className="relative" ref={rowViewMenuRef}>
              <button
                type="button"
                onClick={() => setRowViewMenuOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={rowViewMenuOpen}
                className="flex items-center gap-1 rounded-lg border border-green-300 bg-white px-2.5 py-1 text-xs font-medium text-green-800 hover:bg-green-50"
              >
                {rowView === 'selected' ? 'Showing selected' : 'Showing all'}
                <ChevronDown size={13} />
              </button>
              {rowViewMenuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-gray-200 bg-white py-1 text-sm shadow-lg"
                >
                  <button
                    role="menuitem"
                    onClick={() => {
                      setPage(1);
                      setRowView('selected');
                      setRowViewMenuOpen(false);
                    }}
                    className={cn(
                      'block w-full px-3 py-1.5 text-left text-xs hover:bg-gray-50',
                      rowView === 'selected' ? 'font-medium text-green-700' : 'text-gray-700',
                    )}
                  >
                    Show selected
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setPage(1);
                      setRowView('all');
                      setRowViewMenuOpen(false);
                    }}
                    className={cn(
                      'block w-full px-3 py-1.5 text-left text-xs hover:bg-gray-50',
                      rowView === 'all' ? 'font-medium text-green-700' : 'text-gray-700',
                    )}
                  >
                    Show all
                  </button>
                  <div className="my-1 border-t border-gray-100" />
                  <button
                    role="menuitem"
                    onClick={() => {
                      setSelected(new Set());
                      setRowViewMenuOpen(false);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50"
                  >
                    Unselect all
                  </button>
                </div>
              )}
            </div>

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
                <button
                  onClick={() => setConfirmBulkCancel('unbook')}
                  disabled={bulkCancelBusy}
                  className="flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                  title="Cancel the courier booking + unfulfill in Shopify. The order stays open and returns to To-book."
                >
                  <Ban size={14} />
                  Cancel booking {selected.size}
                </button>
                <button
                  onClick={() => setConfirmBulkCancel('cancel')}
                  disabled={bulkCancelBusy}
                  className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  title="Fully cancel the order in Shopify (cancel + archive) and CodesApp. Irreversible."
                >
                  <Trash2 size={14} />
                  Cancel order {selected.size}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Comma-separated bulk receive box (RTO views). */}
      {isReceivableView && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-200 bg-rose-50/50 px-4 py-2">
          <Link
            href="/orders/fulfillment/receive"
            className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
            title="Scan parcel AWB barcodes to mark them received (RTO)"
          >
            <ScanLine size={14} /> Scan returns
          </Link>
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
        <>
        {/* ── Phone: cards, not a sideways-scrolling 9-column table. The
            fulfillment role works from a packing bench, and this was the only
            role with no layout built for its device. One decision per card. ── */}
        <div className="space-y-2 md:hidden">
          {rows.map((r) => {
            const picked = selected.has(r.orderGid);
            const courier = rowCourier[r.orderGid] ?? r.suggestedCourier ?? null;
            const conf = CONF_BADGE[r.confirmationStatus];
            return (
              <div
                key={r.orderGid}
                className={cn(
                  'rounded-xl border bg-white p-3',
                  picked ? 'border-green-300 bg-green-50/60' : 'border-gray-200',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <label className="flex min-w-0 items-start gap-2">
                    <input
                      type="checkbox"
                      checked={picked}
                      onChange={() => toggleOne(r.orderGid)}
                      className="mt-0.5 shrink-0 cursor-pointer"
                    />
                    <span className="min-w-0">
                      <OrderNameButton
                        name={r.orderName}
                        gid={r.orderGid}
                        adminUrl={r.adminUrl}
                      />
                      <span className="mt-0.5 block truncate text-sm font-medium text-gray-800">
                        {r.customerName ?? '—'}
                      </span>
                      <span className="block truncate text-xs text-gray-500">
                        {[r.city, r.phone].filter(Boolean).join(' · ') || '—'}
                      </span>
                    </span>
                  </label>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {r.shipment ? (
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-[11px]',
                          STATUS_STYLES[r.shipment.status] ?? 'bg-blue-50 text-blue-700',
                        )}
                      >
                        {STATUS_LABELS[r.shipment.status] ?? r.shipment.status}
                      </span>
                    ) : conf ? (
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
                          conf.cls,
                        )}
                      >
                        {conf.label}
                      </span>
                    ) : null}
                    <WaitingCell
                      createdAt={r.createdAt}
                      live={
                        laneForStatus(status) === 'tobook' ||
                        laneForStatus(status) === 'attention'
                      }
                    />
                  </div>
                </div>

                <div className="mt-2 flex items-end justify-between gap-2 border-t border-gray-100 pt-2">
                  <span className="min-w-0 text-xs text-gray-500">
                    <span className="block truncate">{r.itemsSummary ?? '—'}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-semibold tabular-nums text-gray-900">
                      {qmoney(
                        (r.totalOutstanding ?? 0) > 0
                          ? r.totalOutstanding
                          : r.totalPrice,
                        r.currency,
                      )}
                    </span>
                    <span className="block text-[11px] text-gray-400">
                      {(r.totalOutstanding ?? 0) > 0 ? 'COD' : 'Prepaid'}
                    </span>
                  </span>
                </div>

                {bookable(r) && (
                  <button
                    onClick={() => book(r)}
                    disabled={bookingGid === r.orderGid}
                    className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    {bookingGid === r.orderGid ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : (
                      <Truck size={15} />
                    )}
                    Book{courier ? ` · ${COURIER_LABELS[courier]}` : ''}
                  </button>
                )}
                {!bookable(r) && r.shipment?.trackingNumber && (
                  <button
                    onClick={() => setTrackRow(r)}
                    className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    <ExternalLink size={14} /> Track {r.shipment.trackingNumber}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="hidden overflow-x-auto rounded-xl border border-gray-200 bg-white md:block">
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
                <th className="px-4 py-3 font-medium">Waiting</th>
                <th className="px-4 py-3 font-medium">Confirmation</th>
                <th className="px-4 py-3 font-medium">City</th>
                <th className="px-4 py-3 font-medium">Items</th>
                <th className="px-4 py-3 font-medium text-right">COD / Value</th>
                <th className="px-4 py-3 font-medium">Courier</th>
                <th className="px-4 py-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r, idx) => {
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
                    data-row-index={idx}
                    className={cn(
                      'hover:bg-gray-50',
                      dense && '[&>td]:py-1.5',
                      selected.has(r.orderGid) && 'bg-green-50/60',
                      cursor === idx &&
                        'bg-green-50 outline outline-2 -outline-offset-2 outline-green-500',
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
                      <OrderNameButton
                        name={r.orderName}
                        gid={r.orderGid}
                        adminUrl={r.adminUrl}
                      />
                      {r.createdAt && (
                        <div className="text-[11px] font-normal text-gray-400">
                          {fmtDate(r.createdAt)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      <CustomerPopover
                        name={r.customerName}
                        phone={r.phone}
                        email={r.email}
                        city={r.city}
                        address={r.address}
                        ordersCount={r.customerOrdersCount}
                      />
                      {r.phone && (
                        <span className="block text-xs text-gray-400">
                          {r.phone}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <WaitingCell
                        createdAt={r.createdAt}
                        live={
                          laneForStatus(status) === 'tobook' ||
                          laneForStatus(status) === 'attention'
                        }
                      />
                    </td>
                    <td className="px-4 py-3">
                      {CONF_BADGE[r.confirmationStatus] &&
                        (() => {
                          const hasActions =
                            r.confirmationStatus !== 'confirmed' &&
                            !r.archived &&
                            r.fulfillmentStatus === 'unfulfilled';
                          const open = confMenu?.gid === r.orderGid;
                          const btn =
                            'rounded-md px-3 py-1.5 text-left text-xs font-semibold text-white shadow-sm disabled:opacity-50';
                          return (
                            <div className="flex items-center gap-1">
                              <span
                                className={cn(
                                  'inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                                  CONF_BADGE[r.confirmationStatus]!.cls,
                                )}
                              >
                                {CONF_BADGE[r.confirmationStatus]!.label}
                              </span>
                              {hasActions && (
                                <button
                                  data-conf-menu
                                  onClick={(e) =>
                                    setConfMenu(
                                      open
                                        ? null
                                        : (() => {
                                            const rc =
                                              e.currentTarget.getBoundingClientRect();
                                            return {
                                              gid: r.orderGid,
                                              x: rc.left,
                                              y: rc.bottom + 4,
                                            };
                                          })(),
                                    )
                                  }
                                  title="Confirmation actions"
                                  className={cn(
                                    'rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600',
                                    open && 'bg-gray-100 text-gray-600',
                                  )}
                                >
                                  <ChevronDown
                                    size={13}
                                    className={cn(
                                      'transition-transform',
                                      open && 'rotate-180',
                                    )}
                                  />
                                </button>
                              )}
                              {hasActions && open && confMenu && (
                                <div
                                  data-conf-menu
                                  style={{ left: confMenu.x, top: confMenu.y }}
                                  className="fixed z-50 flex w-44 flex-col gap-1.5 rounded-lg border border-gray-200 bg-white p-2 shadow-xl"
                                >
                                  <button
                                    onClick={() => {
                                      setConfMenu(null);
                                      confirmOrder(r);
                                    }}
                                    disabled={confirmingGid === r.orderGid}
                                    className={cn(btn, 'bg-green-600 hover:bg-green-700')}
                                    title="Manually mark this order confirmed and apply the confirm tag in Shopify"
                                  >
                                    {confirmingGid === r.orderGid ? 'Marking…' : 'Mark confirmed'}
                                  </button>
                                  {r.confirmationStatus === 'undeliverable' ? (
                                    <button
                                      onClick={() => {
                                        setConfMenu(null);
                                        setAltPhoneRow(r);
                                      }}
                                      className={cn(btn, 'bg-sky-600 hover:bg-sky-700')}
                                      title="This number has no WhatsApp — send the confirmation to a different number"
                                    >
                                      Send to another number
                                    </button>
                                  ) : (
                                    <button
                                      onClick={() => {
                                        setConfMenu(null);
                                        resendConfirm(r);
                                      }}
                                      disabled={resendGid === r.orderGid}
                                      className={cn(btn, 'bg-sky-600 hover:bg-sky-700')}
                                      title="Resend the confirmation template to the customer"
                                    >
                                      {resendGid === r.orderGid ? 'Sending…' : 'Resend'}
                                    </button>
                                  )}
                                  {r.confirmationStatus !== 'no_response' && (
                                    <button
                                      onClick={() => {
                                        setConfMenu(null);
                                        noResponseOrder(r);
                                      }}
                                      disabled={noRespGid === r.orderGid}
                                      className={cn(btn, 'bg-orange-500 hover:bg-orange-600')}
                                      title="Called the customer, no answer — tag ❌ NO RESPONSE in Shopify + mark it here"
                                    >
                                      {noRespGid === r.orderGid ? 'Marking…' : 'No response'}
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })()}
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
                        // correcting it. Kept readable (not tiny/faint) since the
                        // agent reads it to confirm the delivery location.
                        <span className="mt-0.5 block max-w-[280px] whitespace-normal break-words text-xs leading-snug text-gray-600">
                          {r.address}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      <ItemsPopover
                        items={r.items}
                        count={itemCount}
                        fulfillmentStatus={r.fulfillmentStatus}
                        trailing={
                          !r.archived &&
                          r.fulfillmentStatus === 'unfulfilled' &&
                          !r.shipment ? (
                            <button
                              onClick={() => setEditItemsRow(r)}
                              title="Edit order items (updates Shopify)"
                              className="shrink-0 text-gray-300 hover:text-green-600"
                            >
                              <Package size={13} />
                            </button>
                          ) : undefined
                        }
                      />
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <span className="font-medium text-gray-800">
                        {qmoney(
                          isCod ? r.totalOutstanding : r.totalPrice,
                          r.currency,
                        )}
                      </span>
                      <span className="mt-0.5 flex justify-end">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium capitalize',
                            isCod
                              ? 'bg-amber-100 text-amber-700'
                              : notPaid
                              ? 'bg-gray-100 text-gray-600'
                              : 'bg-emerald-100 text-emerald-700',
                          )}
                        >
                          <span
                            className={cn(
                              'h-1.5 w-1.5 rounded-full',
                              isCod
                                ? 'bg-amber-500'
                                : notPaid
                                ? 'bg-gray-400'
                                : 'bg-emerald-500',
                            )}
                          />
                          {moneyLabel}
                        </span>
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
                                    () => revertAddressIssue(r.shipment!.id),
                                    'Cleared — pick a courier and Book',
                                  )
                                }
                                className="text-[11px] font-medium text-green-700 hover:underline disabled:opacity-50"
                                title="Clear the flag and return this order to To-book — then pick a courier and Book"
                              >
                                Resolve
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
        </>
      )}

      {rows.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-gray-600">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Rows per page</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPage(1);
                setPageSize(e.target.value === 'all' ? 'all' : Number(e.target.value));
              }}
              className="rounded-lg border border-gray-200 px-2 py-1 text-sm"
            >
              {[25, 50, 100, 200].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
              <option value="all">All</option>
            </select>
            <span className="text-xs text-gray-400">
              {pageSize === 'all'
                ? `${total.toLocaleString()} of ${total.toLocaleString()}`
                : `${(total === 0 ? 0 : (page - 1) * pageSize + 1).toLocaleString()}–${Math.min(page * pageSize, total).toLocaleString()} of ${total.toLocaleString()}`}
            </span>
          </div>
          {pageSize !== 'all' && (
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
          )}
        </div>
      )}

      {editRow && (
        <EditAddressModal
          orderGid={editRow.orderGid}
          orderName={editRow.orderName}
          initial={{
            name: editRow.customerName,
            phone: editRow.phone,
            address: editRow.address,
            city: editRow.city,
          }}
          onClose={() => setEditRow(null)}
          onSaved={async () => {
            const row = editRow; // capture before clearing state
            setEditRow(null);
            // Correcting the address of a flagged order CLEARS the flag and
            // returns it to To-book (pick courier + Book) — it never auto-books.
            // Best-effort; the reload reflects the final state either way.
            if (row?.shipment?.status === 'address_issue' && row.shipment.id) {
              await revertAddressIssue(row.shipment.id).catch(() => {});
            }
            // In-place refresh: keep scroll position + checkbox selection.
            load({ silent: true, keepSelection: true });
            onChanged?.();
          }}
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

      {altPhoneRow && (
        <SendToAnotherNumberModal
          order={altPhoneRow}
          onClose={() => setAltPhoneRow(null)}
          onSent={() => {
            setAltPhoneRow(null);
            // In-place refresh: the new send flips the badge off "No WhatsApp".
            load({ silent: true, keepSelection: true });
            onChanged?.();
          }}
          toast={toast}
        />
      )}

      {progress && progressOpen && (
        <BulkBookProgressModal
          gids={progress.gids}
          meta={progress.meta}
          onRetry={retryFailedBookings}
          // Closing MINIMIZES to the bar (keeps the batch alive) — it's only
          // fully cleared from the bar's dismiss, or when the bar auto-hides
          // after completion.
          onClose={() => {
            setProgressOpen(false);
            load({ silent: true, keepSelection: true });
          }}
        />
      )}

      {progress && !progressOpen && (
        <BookingProgressBar
          gids={progress.gids}
          meta={progress.meta}
          onOpen={() => setProgressOpen(true)}
          onDismiss={() => setProgress(null)}
          onDone={() => {
            load({ silent: true, keepSelection: true });
            onChanged?.();
          }}
        />
      )}

      <ConfirmDialog
        open={confirmBulkCancel !== null}
        danger={confirmBulkCancel === 'cancel'}
        busy={bulkCancelBusy}
        title={
          confirmBulkCancel === 'cancel'
            ? 'Cancel these orders?'
            : 'Cancel these bookings?'
        }
        message={
          confirmBulkCancel === 'cancel'
            ? `This will CANCEL and ARCHIVE ${selected.size} order${
                selected.size === 1 ? '' : 's'
              } in Shopify (and cancel any courier booking + archive on CodesApp). This is irreversible.`
            : `This will cancel the courier booking and unfulfill ${selected.size} order${
                selected.size === 1 ? '' : 's'
              } in Shopify, returning them to To-book. The orders stay open. Orders with no active booking are skipped.`
        }
        confirmLabel={confirmBulkCancel === 'cancel' ? 'Cancel orders' : 'Cancel bookings'}
        onConfirm={() => {
          if (confirmBulkCancel) startBulkCancel(confirmBulkCancel);
        }}
        onCancel={() => {
          if (!bulkCancelBusy) setConfirmBulkCancel(null);
        }}
      />

      {cancelBatch && (
        <BulkCancelProgressModal
          batchId={cancelBatch.batchId}
          mode={cancelBatch.mode}
          total={cancelBatch.total}
          onClose={() => {
            setCancelBatch(null);
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
        } to Address issue and asks the customer to confirm their address. Correct it (Edit) or Resolve to return it to To-book, then pick a courier and Book.`}
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

/**
 * "Send to another number" — for orders whose own number has no WhatsApp
 * ("No WhatsApp" badge). Sends the confirmation template to an agent-entered
 * number; the order's stored phone/address are left unchanged. A confirm/cancel
 * reply from the new number still tags the order (matched by message id).
 */
function SendToAnotherNumberModal({
  order,
  onClose,
  onSent,
  toast,
}: {
  order: QueueOrder;
  onClose: () => void;
  onSent: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

  const send = async () => {
    const p = phone.trim();
    if (p.replace(/\D/g, '').length < 7) {
      toast.error('Enter a valid phone number');
      return;
    }
    setBusy(true);
    try {
      await resendConfirmation(order.orderGid, p);
      toast.success('Confirmation sent to the new number');
      onSent();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to send confirmation');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Send confirmation — ${order.orderName ?? 'order'}`}
    >
      <div className="space-y-3">
        <p className="text-xs text-gray-500">
          The order&apos;s number{order.phone ? ` (${order.phone})` : ''} has no
          WhatsApp. Enter another number to send the confirmation there — the
          order&apos;s saved phone and address stay unchanged. If it&apos;s
          already confirmed over a call, use <b>Mark confirmed</b> instead.
        </p>
        <Field label="WhatsApp number">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+92…"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) send();
            }}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={send}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            Send confirmation
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
/**
 * Minimized bulk-book progress — a slim fixed bar shown after the full modal is
 * closed while booking is still running in the background. Polls booking-progress
 * itself, shows a live count + fill bar, reopens the modal on click, fires onDone
 * once when the batch finishes, and auto-hides shortly after a clean completion.
 */
function BookingProgressBar({
  gids,
  meta,
  onOpen,
  onDismiss,
  onDone,
}: {
  gids: string[];
  meta: Record<string, { orderName: string; courier?: CourierType }>;
  onOpen: () => void;
  onDismiss: () => void;
  onDone: () => void;
}) {
  const [rows, setRows] = useState<Record<string, BookingProgressRow>>({});
  const startedRef = useRef(Date.now());
  const doneFiredRef = useRef(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const CEILING_MS = 2_400_000; // 40-min hard stop, matches the modal's ceiling
    const poll = async () => {
      try {
        const res = await bookingProgress(gids);
        if (!alive) return;
        const map: Record<string, BookingProgressRow> = {};
        for (const r of res.rows) map[r.orderGid] = r;
        setRows(map);
        const pending = gids.some((g) => classifyProgress(map[g]) === 'pending');
        if (pending && Date.now() - startedRef.current < CEILING_MS) {
          timer = setTimeout(poll, 2500);
        } else if (!pending && !doneFiredRef.current) {
          doneFiredRef.current = true;
          onDone();
        }
      } catch {
        if (alive) timer = setTimeout(poll, 3500);
      }
    };
    poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gids]);

  const states = gids.map((g) => classifyProgress(rows[g]));
  const total = gids.length;
  const booked = states.filter((s) => s === 'booked').length;
  const failed = states.filter((s) => s === 'failed').length;
  const pending = states.filter((s) => s === 'pending').length;
  const done = pending === 0;
  const pct = total ? Math.round(((booked + failed) / total) * 100) : 0;

  // Auto-hide a few seconds after a clean finish; keep the bar if anything failed
  // so the user can open Details.
  useEffect(() => {
    if (!done || failed > 0) return;
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, failed]);

  return (
    <div className="fixed bottom-4 right-4 z-[70] w-72 rounded-xl border border-gray-200 bg-white shadow-lg">
      <button onClick={onOpen} className="block w-full px-3 pt-3 text-left">
        <div className="flex items-center justify-between text-xs font-medium text-gray-700">
          <span className="inline-flex items-center gap-1.5">
            {done ? (
              <CheckCircle2 size={14} className="text-green-600" />
            ) : (
              <Loader2 size={14} className="animate-spin text-gray-400" />
            )}
            {done ? 'Booking complete' : 'Booking parcels…'}
          </span>
          <span className="tabular-nums text-gray-500">
            {booked + failed}/{total}
          </span>
        </div>
      </button>
      <div className="px-3 pb-1 pt-2">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
          <div
            className={cn('h-full rounded-full transition-all', done ? 'bg-green-500' : 'bg-green-600')}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <div className="flex items-center justify-between px-3 pb-2 text-[11px] text-gray-500">
        <span>
          {booked} booked
          {failed ? ` · ${failed} failed` : ''}
          {pending ? ` · ${pending} left` : ''}
        </span>
        <span className="flex items-center gap-2">
          <button onClick={onOpen} className="font-medium text-blue-700 hover:underline">
            Details
          </button>
          <button
            onClick={onDismiss}
            title="Dismiss"
            className="text-gray-400 hover:text-gray-600"
          >
            <X size={13} />
          </button>
        </span>
      </div>
    </div>
  );
}

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

  // How long to keep polling before giving up. Each courier books 3 parcels at
  // once, each shard throttled ~6s apart, so a courier of N parcels drains in
  // ~(N/3) × 8s. Scale the ceiling to the biggest courier (8s per 3-parcel step
  // + a 90s buffer), floor 5 min, cap 40 min. Harmless if generous: the loop
  // stops the instant nothing is pending.
  const courierMax = (() => {
    const counts: Record<string, number> = {};
    for (const g of gids) {
      const c = meta[g]?.courier ?? '?';
      counts[c] = (counts[c] ?? 0) + 1;
    }
    return Math.max(1, ...Object.values(counts));
  })();
  const POLL_CEILING_MS = Math.min(
    2_400_000,
    Math.max(300_000, Math.ceil(courierMax / 3) * 8_000 + 90_000),
  );

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
        // Keep polling while anything is genuinely in a courier lane, up to the
        // batch-scaled ceiling (a big throttled batch can take 10-15+ min).
        if (pending && Date.now() - startedRef.current < POLL_CEILING_MS) {
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

  // Estimated time remaining. Each courier now books LANE_PARALLELISM(=3) parcels
  // at once (sharded serial lanes), each shard serial + throttled ~6s/order. So a
  // courier with N pending drains in ≈ (N / 3) × (6s throttle + per-request time),
  // and the batch finishes when its BIGGEST courier drains. We measure the real
  // per-order pace from progress so far ((elapsed × effectiveLanes) / resolved,
  // which already folds in throttle + request time); before there's data, fall
  // back to ~7s (6s throttle + ~1s request).
  const LANE_PARALLELISM = 3;
  const pendingByCourier: Record<string, number> = {};
  for (const v of view) {
    if (v.state === 'pending') {
      const c = v.courier ?? '?';
      pendingByCourier[c] = (pendingByCourier[c] ?? 0) + 1;
    }
  }
  const maxPendingCourier = Math.max(0, ...Object.values(pendingByCourier));
  const couriers = Math.max(1, new Set(view.map((v) => v.courier ?? '?')).size);
  const effectiveLanes = couriers * LANE_PARALLELISM;
  const resolved = booked + failed.length;
  const perOrderSec =
    resolved >= effectiveLanes && elapsed > 0
      ? (elapsed * effectiveLanes) / resolved
      : 7;
  const remainingSec = Math.min(
    2400,
    Math.ceil((maxPendingCourier / LANE_PARALLELISM) * perOrderSec),
  );
  const fmtClock = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

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
          <span
            className="ml-auto inline-flex items-center gap-1 font-mono tabular-nums text-gray-400"
            title={`Elapsed ${fmtClock(elapsed)}`}
          >
            <Clock size={13} />
            {done
              ? fmtClock(elapsed)
              : remainingSec > 0
                ? `~${fmtClock(remainingSec)} left`
                : 'finishing…'}
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

/** Live counters for a bulk-cancel batch. Polls bulk-cancel/progress ~1.5s
 *  until the batch reports finished, then lets the user close (which refreshes
 *  the board). Closing early is fine — the batch keeps running server-side. */
function BulkCancelProgressModal({
  batchId,
  mode,
  total,
  onClose,
}: {
  batchId: string;
  mode: BulkCancelMode;
  total: number;
  onClose: () => void;
}) {
  const [p, setP] = useState({
    processed: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    finished: false,
    errors: [] as string[],
  });

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const res = await bulkCancelProgress(batchId);
        if (!alive) return;
        setP({
          processed: res.processed,
          succeeded: res.succeeded,
          skipped: res.skipped,
          failed: res.failed,
          finished: res.finished,
          errors: res.errors ?? [],
        });
        if (!res.finished) timer = setTimeout(poll, 1500);
      } catch {
        if (alive) timer = setTimeout(poll, 2500);
      }
    };
    poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [batchId]);

  const title = mode === 'cancel' ? 'Cancelling orders' : 'Cancelling bookings';
  const pctDone = total ? Math.round((p.processed / total) * 100) : 0;

  return (
    <Modal open title={title} onClose={onClose}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="inline-flex items-center gap-1 text-green-700">
            <CheckCircle2 size={15} /> {p.succeeded} done
          </span>
          {mode === 'unbook' && p.skipped > 0 && (
            <span className="inline-flex items-center gap-1 text-gray-500">
              <Ban size={14} /> {p.skipped} skipped
            </span>
          )}
          {p.failed > 0 && (
            <span className="inline-flex items-center gap-1 text-red-600">
              <XCircle size={15} /> {p.failed} failed
            </span>
          )}
          <span className="ml-auto font-mono tabular-nums text-gray-400">
            {p.processed}/{total}
          </span>
        </div>

        <div className="h-2 overflow-hidden rounded-full bg-gray-100">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              mode === 'cancel' ? 'bg-red-500' : 'bg-amber-500',
            )}
            style={{ width: `${pctDone}%` }}
          />
        </div>

        {!p.finished && (
          <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-700">
            You can close this window and keep working — this runs in the
            background. The orders board updates on its own.
          </p>
        )}

        {p.errors.length > 0 && (
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-red-100 bg-red-50/40 p-2 text-xs text-red-700">
            {p.errors.map((e, i) => (
              <div key={i} className="break-words">
                {e}
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end">
          <button
            onClick={onClose}
            className={cn(
              'rounded-lg px-4 py-1.5 text-sm font-medium',
              p.finished
                ? 'bg-gray-800 text-white hover:bg-gray-900'
                : 'border border-gray-300 text-gray-700 hover:bg-gray-50',
            )}
          >
            {p.finished ? 'Done' : 'Close'}
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
  ['7 days', 7],
  ['30 days', 30],
  ['90 days', 90],
];

function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

// Colour a metric by how good it is. Higher-is-better for delivery; lower for
// returns/fails/lead time. Returns a { text, bar } class pair.
function perfTone(kind: 'delivery' | 'return' | 'fail' | 'speed', v: number | null) {
  if (v == null) return { text: 'text-gray-400', bar: 'bg-gray-300' };
  if (kind === 'delivery') {
    if (v >= 0.92) return { text: 'text-green-700', bar: 'bg-green-600' };
    if (v >= 0.85) return { text: 'text-amber-700', bar: 'bg-amber-500' };
    return { text: 'text-rose-700', bar: 'bg-rose-500' };
  }
  if (kind === 'return') {
    if (v <= 0.02) return { text: 'text-green-700', bar: 'bg-green-600' };
    if (v <= 0.05) return { text: 'text-amber-700', bar: 'bg-amber-500' };
    return { text: 'text-rose-700', bar: 'bg-rose-500' };
  }
  if (kind === 'fail') {
    if (v <= 0.05) return { text: 'text-green-700', bar: 'bg-green-600' };
    if (v <= 0.1) return { text: 'text-amber-700', bar: 'bg-amber-500' };
    return { text: 'text-rose-700', bar: 'bg-rose-500' };
  }
  // speed: days, lower better (v is days)
  if (v <= 4) return { text: 'text-sky-700', bar: 'bg-sky-500' };
  if (v <= 5.5) return { text: 'text-amber-700', bar: 'bg-amber-500' };
  return { text: 'text-rose-700', bar: 'bg-rose-500' };
}

/**
 * Routing opportunities: cities where the courier you use MOST has a materially
 * lower delivery rate than a better courier that also has enough volume there.
 * Computed entirely from the city breakdown the performance query already
 * returns — the whole point of measuring couriers is to route better, so this
 * turns the numbers into the specific swap to make.
 */
interface RoutingOpportunity {
  city: string;
  fromCourier: string;
  fromRate: number;
  fromVolume: number;
  toCourier: string;
  toRate: number;
  gap: number;
  avoidable: number; // rough parcels/window the gap costs
}

function findRoutingOpportunities(
  cities: CourierPerfCity[],
): RoutingOpportunity[] {
  const MIN_VOL = 15; // enough shipments for a rate to be trustworthy
  const MIN_GAP = 0.05; // at least 5 delivery points to be worth switching
  const ops: RoutingOpportunity[] = [];
  for (const city of cities) {
    const eligible = city.couriers.filter(
      (c) => c.deliveryRate != null && c.delivered + c.returned + c.failed >= MIN_VOL,
    );
    if (eligible.length < 2) continue;
    // The courier carrying the most volume here = the current de-facto default.
    const current = eligible.slice().sort((a, b) => b.total - a.total)[0];
    const best = eligible
      .slice()
      .sort((a, b) => (b.deliveryRate ?? 0) - (a.deliveryRate ?? 0))[0];
    if (best.courier === current.courier) continue;
    const gap = (best.deliveryRate ?? 0) - (current.deliveryRate ?? 0);
    if (gap < MIN_GAP) continue;
    ops.push({
      city: city.city,
      fromCourier: current.courier,
      fromRate: current.deliveryRate ?? 0,
      fromVolume: current.total,
      toCourier: best.courier,
      toRate: best.deliveryRate ?? 0,
      gap,
      avoidable: Math.round(current.total * gap),
    });
  }
  // Biggest avoidable loss first — that's where a routing change pays most.
  return ops.sort((a, b) => b.avoidable - a.avoidable).slice(0, 8);
}

function CourierPerformancePanel({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [data, setData] = useState<CourierPerformance | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  const [cityQuery, setCityQuery] = useState('');
  // Bumped by the Refresh button — re-runs the fetch even when the range is
  // unchanged (clicking the active range wouldn't otherwise refetch).
  const [reloadKey, setReloadKey] = useState(0);

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
  }, [days, reloadKey, toast]);

  // Rank couriers: delivery rate first, speed as the tie-break. This is the
  // order the scorecard shows, so "best overall" is unambiguous.
  const ranked = (data?.couriers ?? [])
    .slice()
    .sort((a, b) => {
      const dr = (b.deliveryRate ?? 0) - (a.deliveryRate ?? 0);
      if (Math.abs(dr) > 0.005) return dr;
      return (a.avgLeadDays ?? 99) - (b.avgLeadDays ?? 99);
    });

  // Best-in-class per metric (across couriers with data), for highlighting.
  const withData = ranked.filter((c) => c.deliveryRate != null);
  const bestDelivery = Math.max(...withData.map((c) => c.deliveryRate ?? 0), 0);
  const bestSpeed = Math.min(
    ...withData.filter((c) => c.avgLeadDays != null).map((c) => c.avgLeadDays as number),
    99,
  );
  const maxLead = Math.max(
    ...withData.filter((c) => c.avgLeadDays != null).map((c) => c.avgLeadDays as number),
    1,
  );

  const opportunities = findRoutingOpportunities(data?.cities ?? []);

  const q = cityQuery.trim().toLowerCase();
  const visibleCities = data
    ? q
      ? data.cities.filter((c) => c.city.toLowerCase().includes(q))
      : data.cities.slice(0, 60)
    : [];

  const failRate = (c: CourierPerfRow) =>
    c.total > 0 ? c.failed / (c.delivered + c.returned + c.failed || 1) : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-600">
          Delivery performance by courier — orders placed in the window, from
          courier tracking (covers every order).
        </p>
        <div className="flex items-center gap-2">
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
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : !data || withData.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
          No delivery data in this window yet. It builds up as couriers send
          tracking updates for your parcels.
        </div>
      ) : (
        <>
          {/* ── Ranked scorecard ─────────────────────────────────────── */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Courier scorecard — ranked by delivery rate
            </p>
            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
              {/* desktop header */}
              <div className="hidden grid-cols-[190px_1fr] border-b border-gray-100 bg-gray-50 text-[10.5px] font-semibold uppercase tracking-wide text-gray-500 sm:grid">
                <span className="px-4 py-2.5">Courier</span>
                <div className="grid grid-cols-4">
                  <span className="border-l border-gray-100 px-3 py-2.5">Delivery rate</span>
                  <span className="border-l border-gray-100 px-3 py-2.5">Speed</span>
                  <span className="border-l border-gray-100 px-3 py-2.5">Return rate</span>
                  <span className="border-l border-gray-100 px-3 py-2.5">Fail rate</span>
                </div>
              </div>
              {ranked.map((c, i) => {
                const isBestOverall = i === 0 && withData.length > 1;
                const fr = failRate(c);
                const dTone = perfTone('delivery', c.deliveryRate);
                const rTone = perfTone('return', c.returnRate);
                const fTone = perfTone('fail', fr);
                const sTone = perfTone('speed', c.avgLeadDays);
                const isFastest =
                  c.avgLeadDays != null && Math.abs(c.avgLeadDays - bestSpeed) < 0.05;
                const isBestDeliv =
                  c.deliveryRate != null && Math.abs(c.deliveryRate - bestDelivery) < 0.005;
                return (
                  <div
                    key={c.courier}
                    className="grid grid-cols-1 border-b border-gray-100 last:border-b-0 sm:grid-cols-[190px_1fr]"
                  >
                    <div className="flex items-center gap-2.5 border-b border-gray-100 px-4 py-3 sm:border-b-0 sm:border-r">
                      <span className="w-4 shrink-0 text-center font-bold text-gray-400">
                        {i + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-gray-800">
                          {c.courier}
                        </span>
                        <span className="block text-[11px] text-gray-400">
                          {c.total.toLocaleString()} orders
                        </span>
                      </span>
                      {isBestOverall && (
                        <span className="ml-auto rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-bold text-green-700">
                          Best overall
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4">
                      <ScoreCell
                        num={pct(c.deliveryRate)}
                        tone={dTone}
                        width={(c.deliveryRate ?? 0) * 100}
                        cap={`${c.delivered.toLocaleString()} delivered`}
                        best={isBestDeliv}
                      />
                      <ScoreCell
                        num={c.avgLeadDays == null ? '—' : `${c.avgLeadDays.toFixed(1)}d`}
                        tone={sTone}
                        width={c.avgLeadDays == null ? 0 : (1 - (c.avgLeadDays - 2) / (maxLead - 1)) * 100}
                        cap={isFastest ? 'fastest' : 'order → delivery'}
                        best={isFastest}
                      />
                      <ScoreCell
                        num={pct(c.returnRate)}
                        tone={rTone}
                        width={Math.min(100, (c.returnRate ?? 0) * 100 * 6)}
                        cap={`${c.returned.toLocaleString()} returned`}
                      />
                      <ScoreCell
                        num={pct(fr)}
                        tone={fTone}
                        width={Math.min(100, (fr ?? 0) * 100 * 4)}
                        cap={`${c.failed.toLocaleString()} failed`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-1.5 text-[11px] text-gray-400">
              Rates are over resolved parcels (delivered + returned + failed);
              in-progress parcels are excluded. Speed = average order-to-delivery.
            </p>
          </div>

          {/* ── Routing opportunities ────────────────────────────────── */}
          {opportunities.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Routing opportunities — where a better courier is available
              </p>
              <div className="space-y-2">
                {opportunities.map((o) => {
                  const hot = o.gap >= 0.08;
                  return (
                    <div
                      key={o.city}
                      className={cn(
                        'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-white px-4 py-3',
                        hot ? 'border-l-[3px] border-l-rose-500' : 'border-l-[3px] border-l-amber-500',
                      )}
                    >
                      <span className="min-w-[100px] font-semibold text-gray-900">
                        {o.city}
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="inline-flex items-center rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-semibold text-rose-700">
                          {o.fromCourier} {pct(o.fromRate)}
                        </span>
                        <span className="text-gray-400">→</span>
                        <span className="inline-flex items-center rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-semibold text-green-700">
                          {o.toCourier} {pct(o.toRate)}
                        </span>
                      </span>
                      <span className="flex-1" />
                      <span className="text-right text-xs text-gray-600">
                        <span className="text-sm font-bold text-rose-600">
                          ~{o.avoidable.toLocaleString()}
                        </span>{' '}
                        avoidable · {o.fromVolume.toLocaleString()} on {o.fromCourier}
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[11px] text-gray-400">
                The courier carrying the most volume in a city, where another
                courier with ≥15 parcels delivers at least 5 points better. Change
                the default in Settings → Courier · city mapping.
              </p>
            </div>
          )}

          {/* ── Best courier by city ─────────────────────────────────── */}
          {data.cities.length > 0 && (
            <div>
              <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Best courier by city
                </p>
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

              {/* Phone: city cards. */}
              <div className="space-y-2 sm:hidden">
                {visibleCities.length === 0 ? (
                  <p className="rounded-xl border border-gray-200 bg-white p-6 text-center text-xs text-gray-400">
                    No city matches &ldquo;{cityQuery.trim()}&rdquo; in this window.
                  </p>
                ) : (
                  visibleCities.map((city) => (
                    <div key={city.city} className="rounded-xl border border-gray-200 bg-white p-3">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-gray-800">{city.city}</span>
                        <span className="text-xs text-gray-400">
                          {city.total.toLocaleString()} shipments
                        </span>
                      </div>
                      <CityCourierChips city={city} />
                    </div>
                  ))
                )}
              </div>

              {/* Desktop: city table. */}
              <div className="hidden overflow-hidden rounded-xl border border-gray-200 bg-white sm:block">
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 text-left text-xs text-gray-500">
                      <tr>
                        <th className="px-4 py-2 font-medium">City</th>
                        <th className="px-4 py-2 text-right font-medium">Shipments</th>
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
                      {visibleCities.map((city) => (
                        <tr key={city.city} className="hover:bg-gray-50">
                          <td className="px-4 py-2 font-medium text-gray-800">
                            {city.city}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-gray-500">
                            {city.total.toLocaleString()}
                          </td>
                          <td className="px-4 py-2">
                            <CityCourierChips city={city} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              {!q && data.cities.length > 60 && (
                <p className="mt-1.5 text-[11px] text-gray-400">
                  Showing the 60 busiest cities. Search to find any other.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// One metric cell in the scorecard: number, a proportion bar, a caption.
function ScoreCell({
  num,
  tone,
  width,
  cap,
  best,
}: {
  num: string;
  tone: { text: string; bar: string };
  width: number;
  cap: string;
  best?: boolean;
}) {
  return (
    <div className="flex flex-col justify-center gap-1.5 border-l border-gray-100 px-3 py-3 first:border-l-0 sm:first:border-l">
      <span className="flex items-baseline gap-1.5">
        <span className={cn('text-base font-bold tabular-nums', tone.text)}>
          {num}
        </span>
        {best && (
          <span className="rounded bg-green-50 px-1 text-[9px] font-bold uppercase tracking-wide text-green-700">
            best
          </span>
        )}
      </span>
      <span className="h-1 overflow-hidden rounded-full bg-gray-100">
        <span
          className={cn('block h-full rounded-full', tone.bar)}
          style={{ width: `${Math.max(2, Math.min(100, width))}%` }}
        />
      </span>
      <span className="text-[10.5px] text-gray-400">{cap}</span>
    </div>
  );
}

// The per-courier delivery-rate chips for a city — best marked green, the
// highest-volume laggard marked rose when it's clearly beatable.
function CityCourierChips({ city }: { city: CourierPerfCity }) {
  const eligible = city.couriers.filter(
    (c) => c.deliveryRate != null && c.delivered + c.returned + c.failed >= 3,
  );
  const best = eligible.slice().sort((a, b) => (b.deliveryRate ?? 0) - (a.deliveryRate ?? 0))[0];
  const current = eligible.slice().sort((a, b) => b.total - a.total)[0];
  const worstIsCurrent =
    best && current && best.courier !== current.courier &&
    (best.deliveryRate ?? 0) - (current.deliveryRate ?? 0) >= 0.05;
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {city.couriers
        .slice()
        .sort((a, b) => b.total - a.total)
        .map((c) => {
          const isBest = best && c.courier === best.courier;
          const isLaggard = worstIsCurrent && current && c.courier === current.courier;
          return (
            <span
              key={c.courier}
              className={cn(
                'rounded-full px-2 py-0.5 text-xs',
                isBest
                  ? 'bg-green-100 font-medium text-green-800'
                  : isLaggard
                    ? 'bg-rose-50 text-rose-700'
                    : 'bg-gray-100 text-gray-600',
              )}
              title={`${c.delivered} delivered / ${c.returned} returned / ${c.failed} failed of ${c.total}`}
            >
              {c.courier} {pct(c.deliveryRate)}
            </span>
          );
        })}
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
  // PayFast gateway settlements: the upload/reconcile modal + past uploads.
  const [pfOpen, setPfOpen] = useState(false);
  const [pfViewId, setPfViewId] = useState<number | null>(null);
  const [pfList, setPfList] = useState<PayfastSettlement[]>([]);

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

  const loadPayfast = useCallback(async () => {
    try {
      setPfList(await listPayfastSettlements());
    } catch {
      setPfList([]); // non-owner/admin or nothing uploaded
    }
  }, []);

  const [pfPdfBusy, setPfPdfBusy] = useState<number | null>(null);
  const downloadPfPdf = async (id: number) => {
    setPfPdfBusy(id);
    try {
      const { url } = await payfastStatementPdf(id);
      window.open(url, '_blank', 'noreferrer');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not build the statement PDF');
    } finally {
      setPfPdfBusy(null);
    }
  };

  useEffect(() => {
    load();
    loadPayfast();
  }, [load, loadPayfast]);

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
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            {cardCount > 0 && (
              <button
                onClick={() => setOpen('card')}
                className="text-xs font-medium text-green-700 hover:underline"
              >
                Reconcile payments →
              </button>
            )}
            <button
              onClick={() => setPfOpen(true)}
              className="flex items-center gap-1 text-xs font-medium text-green-700 hover:underline"
            >
              <Upload size={12} /> Upload PayFast settlement
            </button>
          </div>
        </div>
      </div>

      {/* ── PayFast settlement history (upload lives on the Card payments card) ── */}
      {pfList.length > 0 && (
        <div className="space-y-2 border-t border-gray-100 pt-4">
          <p className="text-sm font-medium text-gray-700">PayFast settlements</p>
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-left text-gray-500">
                  <th className="px-3 py-1.5">Period</th>
                  <th className="px-2 py-1.5 text-right">Txns</th>
                  <th className="px-2 py-1.5 text-right">Received</th>
                  <th className="px-2 py-1.5">Status</th>
                  <th className="px-3 py-1.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pfList.map((s) => (
                  <tr key={s.id} className="border-b border-gray-50 last:border-0">
                    <td className="px-3 py-1.5 text-gray-700">
                      {s.periodStart ? fmtDate(s.periodStart) : '?'} → {s.periodEnd ? fmtDate(s.periodEnd) : '?'}
                    </td>
                    <td className="px-2 py-1.5 text-right text-gray-600">
                      {s.matchedTxns}/{s.totalTxns}
                    </td>
                    <td className="px-2 py-1.5 text-right font-medium text-gray-800">
                      {s.received == null ? '—' : `${s.currency ?? 'PKR'} ${Math.round(s.received).toLocaleString()}`}
                    </td>
                    <td className="px-2 py-1.5">
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide',
                          s.status === 'applied'
                            ? 'bg-green-100 text-green-700'
                            : s.status === 'applying'
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-gray-100 text-gray-600',
                        )}
                      >
                        {s.status}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <div className="flex items-center justify-end gap-3">
                        <button onClick={() => setPfViewId(s.id)} className="font-medium text-green-700 hover:underline">
                          View
                        </button>
                        <button
                          onClick={() => downloadPfPdf(s.id)}
                          disabled={pfPdfBusy === s.id}
                          className="inline-flex items-center gap-1 font-medium text-gray-600 hover:text-gray-900 disabled:opacity-50"
                        >
                          {pfPdfBusy === s.id ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Download size={12} />
                          )}
                          PDF
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {open && (
        <PrepaidDrilldownModal
          bucket={open}
          onClose={() => setOpen(null)}
          onReconciled={load}
          toast={toast}
        />
      )}
      {pfOpen && (
        <PayfastSettlementModal
          onClose={() => setPfOpen(false)}
          onApplied={() => {
            loadPayfast();
            load();
          }}
        />
      )}
      {pfViewId != null && (
        <PayfastStatementViewModal id={pfViewId} onClose={() => setPfViewId(null)} />
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
                      <OrderNameButton
                        name={r.orderName ?? (r.orderNumber ? `#${r.orderNumber}` : null)}
                        number={r.orderName ?? r.orderNumber ?? undefined}
                      />
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

/**
 * Statement history, grouped by courier.
 *
 * Was a flat table of every upload. The number that actually prompts action is
 * "what has accumulated with this courier since their last statement" — that is
 * what tells you to go ask for the next one — so each courier leads with its
 * outstanding receivable and its own statements sit under it.
 */
function StatementsPanel({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [invoices, setInvoices] = useState<CourierInvoice[]>([]);
  const [summary, setSummary] = useState<PendingPaymentsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewId, setViewId] = useState<number | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [inv, sum] = await Promise.all([
        listCourierInvoices().catch(() => [] as CourierInvoice[]),
        getCourierPendingPayments().catch(() => null),
      ]);
      setInvoices(inv);
      setSummary(sum);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load statements');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const cur = summary?.currency ?? null;

  // Group by the courier label the statement was filed under.
  const groups = COURIER_TYPES.map((c) => ({
    courier: c,
    rows: invoices.filter((iv) => iv.courierType === c),
    outstanding: summary?.couriers.find((x) => x.courier === c)?.receivable ?? 0,
  })).filter((g) => g.rows.length > 0 || g.outstanding > 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-400">
        <Loader2 className="animate-spin" size={22} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-600">
          Every settlement statement you have applied, per courier.
        </p>
        <button
          onClick={() => setUploadOpen(true)}
          className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
        >
          <Upload size={14} /> Upload statement
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
          No statements uploaded yet.
        </div>
      ) : (
        groups.map((g) => (
          <div
            key={g.courier}
            className="overflow-hidden rounded-xl border border-gray-200 bg-white"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 bg-gray-50 px-4 py-2.5">
              <span className="text-sm font-semibold text-gray-800">
                {COURIER_LABELS[g.courier]}
                <span className="ml-2 text-xs font-normal text-gray-500">
                  {g.rows.length} statement{g.rows.length === 1 ? '' : 's'}
                </span>
              </span>
              <span className="text-xs text-gray-600">
                Accumulated since the last one{' '}
                <span
                  className={cn(
                    'font-semibold tabular-nums',
                    g.outstanding > 0 ? 'text-green-700' : 'text-gray-400',
                  )}
                >
                  {qmoney(g.outstanding, cur)}
                </span>
              </span>
            </div>
            {g.rows.length === 0 ? (
              <p className="px-4 py-4 text-xs text-gray-500">
                Nothing uploaded for this courier yet — everything above is unreconciled.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="bg-white text-left text-xs text-gray-500">
                      <th className="px-4 py-2 font-medium">Uploaded</th>
                      <th className="px-4 py-2 font-medium">Invoice #</th>
                      <th className="px-4 py-2 font-medium">Parcels</th>
                      <th className="px-4 py-2 font-medium">Net payable</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium">Statement</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {g.rows.map((iv) => (
                      <tr key={iv.id} className="hover:bg-gray-50">
                        <td className="whitespace-nowrap px-4 py-2 text-gray-600">
                          {fmtDate(iv.createdAt)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-gray-600">
                          {iv.invoiceNumber ?? '—'}
                        </td>
                        <td className="px-4 py-2 text-gray-600">
                          {iv.paidRows}/{iv.totalRows} paid
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 font-medium tabular-nums text-green-700">
                          {qmoney(iv.netPayable ?? 0, iv.currency ?? cur)}
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={cn(
                              'rounded-full px-2 py-0.5 text-[11px] font-medium capitalize',
                              iv.status === 'applied'
                                ? 'bg-green-50 text-green-700'
                                : iv.status === 'failed'
                                  ? 'bg-red-50 text-red-700'
                                  : 'bg-amber-50 text-amber-700',
                            )}
                          >
                            {iv.status}
                          </span>
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-3">
                            <button
                              onClick={() => setViewId(iv.id)}
                              className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800"
                            >
                              <Eye size={13} /> View
                            </button>
                            {iv.pdfUrl ? (
                              <a
                                href={iv.pdfUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-xs font-medium text-green-700 hover:text-green-900"
                              >
                                <Download size={13} /> Download
                              </a>
                            ) : (
                              <span className="text-xs text-gray-400">—</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))
      )}

      {uploadOpen && (
        <CourierInvoiceModal
          onClose={() => {
            setUploadOpen(false);
            load();
          }}
          onApplied={load}
        />
      )}
      {viewId != null && (
        <CourierInvoiceViewModal id={viewId} onClose={() => setViewId(null)} />
      )}
    </div>
  );
}

/**
 * Standing COD shortfalls — parcels a courier's statement short-paid.
 *
 * Reconciling always computed these, but only showed the count once inside the
 * apply dialog, after which it was gone. Every figure here is read back from the
 * reconciled lines already stored on the applied statements, so this is a new
 * view over old data rather than new tracking.
 */
function ShortfallsPanel({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [data, setData] = useState<ShortfallsResult | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getCourierShortfalls());
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load shortfalls');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const cur = data?.currency ?? null;

  const exportCsv = () => {
    if (!data?.items.length) return;
    const head = 'Order,Tracking,Courier,Statement,Expected,Paid,Shortfall\n';
    const body = data.items
      .map((i) =>
        [
          i.orderName ?? '',
          i.trackingNumber ?? '',
          COURIER_LABELS[i.courier],
          i.invoiceNumber ?? '',
          i.expectedCod,
          i.paidCod,
          i.shortfall,
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(','),
      )
      .join('\n');
    const url = URL.createObjectURL(
      new Blob([head + body], { type: 'text/csv;charset=utf-8;' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `courier-shortfalls-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-400">
        <Loader2 className="animate-spin" size={22} />
      </div>
    );
  }

  if (!data || data.totals.count === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
        No shortfalls found. Every applied statement paid the full COD on every
        matched parcel.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-500">
            Short-paid by couriers
          </p>
          <p className="mt-0.5 text-3xl font-bold tabular-nums text-rose-600">
            {qmoney(data.totals.total, cur)}
          </p>
          <p className="text-xs text-gray-500">
            across {data.totals.count.toLocaleString()} parcel
            {data.totals.count === 1 ? '' : 's'} on applied statements
          </p>
        </div>
        <button
          onClick={exportCsv}
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
          title="Download the dispute list as CSV"
        >
          <Download size={14} /> Export dispute list
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {data.couriers.map((c) => (
          <div key={c.courier} className="rounded-xl border border-gray-200 bg-white p-3">
            <p className="text-sm font-semibold text-gray-800">
              {COURIER_LABELS[c.courier]}
            </p>
            <p className="mt-0.5 text-xl font-bold tabular-nums text-rose-600">
              {qmoney(c.total, cur)}
            </p>
            <p className="text-xs text-gray-500">
              {c.count.toLocaleString()} parcel{c.count === 1 ? '' : 's'}
            </p>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-3 font-medium">Order</th>
              <th className="px-4 py-3 font-medium">Courier</th>
              <th className="px-4 py-3 font-medium">Statement</th>
              <th className="px-4 py-3 text-right font-medium">Order says</th>
              <th className="px-4 py-3 text-right font-medium">Courier paid</th>
              <th className="px-4 py-3 text-right font-medium">Short by</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.items.map((i, n) => (
              <tr key={`${i.invoiceId}-${i.trackingNumber ?? n}`} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">
                  {i.orderName ?? '—'}
                  {i.trackingNumber && (
                    <span className="block font-mono text-[11px] font-normal text-gray-400">
                      {i.trackingNumber}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-600">
                  {COURIER_LABELS[i.courier]}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500">
                  {i.invoiceNumber ?? '—'}
                  {i.statementDate && (
                    <span className="block text-gray-400">
                      {fmtDate(i.statementDate)}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                  {qmoney(i.expectedCod, i.currency ?? cur)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                  {qmoney(i.paidCod, i.currency ?? cur)}
                </td>
                <td className="px-4 py-3 text-right font-semibold tabular-nums text-rose-600">
                  {qmoney(i.shortfall, i.currency ?? cur)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.truncated && (
        <p className="text-xs text-gray-400">
          Showing the 500 largest shortfalls. Export for the full list.
        </p>
      )}
    </div>
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
  // Courier settlement statements: the upload/reconcile modal + past uploads.
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [viewInvoiceId, setViewInvoiceId] = useState<number | null>(null);
  const [invoices, setInvoices] = useState<CourierInvoice[]>([]);

  const loadInvoices = useCallback(async () => {
    try {
      setInvoices(await listCourierInvoices());
    } catch {
      setInvoices([]); // non-owner/admin, or nothing uploaded yet
    }
  }, []);

  useEffect(() => {
    loadInvoices();
  }, [loadInvoices]);

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
          aging: { d0_15: 0, d16_30: 0, d31_60: 0, d60plus: 0 },
          oldestDays: null,
        },
        unstampedCount: 0,
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

  // Housekeeping: close off delivered parcels that owe nothing. Can only ever
  // touch zero-balance rows, so it never moves a real receivable.
  const stampZeroValue = async () => {
    setBusy(true);
    try {
      const r = await stampZeroValueDelivered();
      toast.success(
        `Stamped ${r.settled.toLocaleString()} settled parcel${r.settled === 1 ? '' : 's'}`,
      );
      loadSummary();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to stamp');
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

  // Only block on the FIRST load (no summary yet). A background refresh — e.g.
  // loadSummary() fired from the settlement modal's onApplied — must NOT unmount
  // this panel, or the open CourierInvoiceModal remounts and snaps back to its
  // upload step ("dialog jumps back") mid-apply.
  if (loading && !summary) {
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

  // ── The receivable ledger ────────────────────────────────────────────
  // Replaced four flat courier cards. The panel had no notion of age at all, so
  // a six-month-old debt and yesterday's read identically; aging is the primary
  // lens for any receivable, and it's what tells you which courier to call.
  const ag = summary?.totals.aging;
  const agingTotal = ag ? ag.d0_15 + ag.d16_30 + ag.d31_60 + ag.d60plus : 0;
  const AGE_BANDS: Array<{
    key: keyof ReceivableAging;
    label: string;
    bar: string;
    text: string;
  }> = [
    { key: 'd0_15', label: '0–15 days', bar: 'bg-teal-500', text: 'text-teal-700' },
    { key: 'd16_30', label: '16–30 days', bar: 'bg-amber-500', text: 'text-amber-700' },
    { key: 'd31_60', label: '31–60 days', bar: 'bg-orange-500', text: 'text-orange-700' },
    { key: 'd60plus', label: '60+ days', bar: 'bg-rose-500', text: 'text-rose-700' },
  ];
  const ageTone = (days: number | null) =>
    days == null
      ? 'text-gray-400'
      : days > 60
        ? 'text-rose-600 font-semibold'
        : days > 30
          ? 'text-orange-600'
          : days > 15
            ? 'text-amber-600'
            : 'text-gray-500';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-500">
            Owed to you by couriers
          </p>
          <p className="mt-0.5 text-3xl font-bold tabular-nums text-green-600">
            {qmoney(summary?.totals.receivable ?? 0, cur)}
          </p>
          <p className="text-xs text-gray-500">
            {(summary?.totals.receivableCount ?? 0).toLocaleString()} delivered
            parcels carrying COD
            {summary?.totals.oldestDays != null && (
              <>
                {' · oldest '}
                <span className={ageTone(summary.totals.oldestDays)}>
                  {summary.totals.oldestDays}d
                </span>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setInvoiceOpen(true)}
            className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
            title="Upload a courier's settlement statement to reconcile and settle COD"
          >
            <Upload size={14} /> Upload statement
          </button>
          <button
            onClick={loadSummary}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {/* Aging bar — where the money sits by age, at a glance. */}
      {ag && agingTotal > 0 && (
        <div>
          <div className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-gray-100">
            {AGE_BANDS.map((b) => {
              const v = ag[b.key];
              if (v <= 0) return null;
              return (
                <span
                  key={b.key}
                  className={b.bar}
                  style={{ width: `${(v / agingTotal) * 100}%` }}
                  title={`${b.label}: ${qmoney(v, cur)}`}
                />
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
            {AGE_BANDS.map((b) => (
              <span key={b.key} className="inline-flex items-center gap-1.5">
                <span className={cn('h-2 w-2 rounded-sm', b.bar)} />
                <span className="text-gray-600">{b.label}</span>
                <span className="tabular-nums text-gray-400">
                  {qmoney(ag[b.key], cur)}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {!summary || summary.couriers.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
          Nothing outstanding — every delivered parcel is settled.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3 font-medium">Courier</th>
                {AGE_BANDS.map((b) => (
                  <th key={b.key} className="px-3 py-3 text-right font-medium">
                    {b.label.replace(' days', 'd')}
                  </th>
                ))}
                <th className="px-4 py-3 text-right font-medium">Receivable</th>
                <th className="px-4 py-3 font-medium">Oldest</th>
                <th className="px-4 py-3 font-medium">With courier</th>
                <th className="px-4 py-3 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {summary.couriers
                .slice()
                .sort((a, b) => b.receivable - a.receivable)
                .map((c) => (
                  <tr key={c.courier} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-800">
                      {COURIER_LABELS[c.courier]}
                    </td>
                    {AGE_BANDS.map((b) => {
                      const v = c.aging?.[b.key] ?? 0;
                      return (
                        <td
                          key={b.key}
                          className={cn(
                            'px-3 py-3 text-right tabular-nums',
                            v > 0 ? b.text : 'text-gray-300',
                          )}
                        >
                          {v > 0 ? qmoney(v, c.currency ?? cur) : '—'}
                        </td>
                      );
                    })}
                    <td className="px-4 py-3 text-right font-semibold tabular-nums text-gray-900">
                      {qmoney(c.receivable, c.currency ?? cur)}
                      <span className="block text-[11px] font-normal text-gray-400">
                        {c.receivableCount.toLocaleString()} parcels
                      </span>
                    </td>
                    <td className={cn('px-4 py-3 tabular-nums', ageTone(c.oldestDays))}>
                      {c.oldestDays == null ? '—' : `${c.oldestDays}d`}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {c.inTransitCount.toLocaleString()} parcels
                      <span className="block text-gray-400">
                        {qmoney(c.inTransitExpected, c.currency ?? cur)} expected
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => setInvoiceOpen(true)}
                          className="rounded-lg bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700"
                          title="Upload this courier's statement and reconcile it"
                        >
                          Reconcile
                        </button>
                        <button
                          onClick={() => openCourier(c.courier)}
                          className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
                          title="Open the parcel list for this courier"
                        >
                          Parcels
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Housekeeping: delivered parcels that owe nothing are never stamped
          settled. They're already excluded from every figure above — this just
          closes them off so they stop accumulating. */}
      {(summary?.unstampedCount ?? 0) > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-600">
          <span>
            <span className="font-semibold tabular-nums text-gray-800">
              {(summary?.unstampedCount ?? 0).toLocaleString()}
            </span>{' '}
            delivered parcels owe nothing and have never been stamped settled.
            They don&apos;t affect the figures above.
          </span>
          <button
            onClick={stampZeroValue}
            disabled={busy}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {busy ? 'Stamping…' : 'Stamp all as settled'}
          </button>
        </div>
      )}

      {invoiceOpen && (
        <CourierInvoiceModal
          onClose={() => {
            setInvoiceOpen(false);
            loadInvoices();
          }}
          onApplied={() => {
            loadInvoices();
            loadSummary();
            if (courier) openCourier(courier);
          }}
        />
      )}

      {viewInvoiceId != null && (
        <CourierInvoiceViewModal id={viewInvoiceId} onClose={() => setViewInvoiceId(null)} />
      )}
    </div>
  );
}

