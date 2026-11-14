'use client';
import { SkeletonRows } from '@/components/ui/skeleton';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  Loader2,
  RefreshCw,
  Truck,
  Copy,
  Store,
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
  Users,
  RotateCcw,
  Lock,
  ListChecks,
  ArrowDownUp,
  Rows3,
  Send,
  Phone,
  PhoneOff,
} from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { EditItemsModal } from '@/components/orders/edit-items-modal';
import CreateOrderModal from '@/components/inbox/create-order-modal';
import OrderTrackingModal from '@/components/inbox/order-tracking-modal';
import type { ContactOrder } from '@/lib/contact-orders';
import { InvoiceImportPanel } from '@/components/orders/invoice-import-panel';
import { CourierPaymentsBoard } from '@/components/orders/courier-payments-board';
import { ReplacementsBoard } from '@/components/couriers/replacements-board';
import { ImportLoadsheet } from '@/components/couriers/import-loadsheet';
import { CourierInvoiceModal } from '@/components/orders/courier-invoice-modal';
import { CourierInvoiceViewModal } from '@/components/orders/courier-invoice-view-modal';
import { PayfastSettlementModal } from '@/components/orders/payfast-settlement-modal';
import { PayfastStatementViewModal } from '@/components/orders/payfast-statement-view-modal';
import {
  listPayfastSettlements,
  payfastStatementPdf,
  deletePayfastSettlement,
  type PayfastSettlement,
} from '@/lib/payfast';
import { OrderNameButton, OrderDetailDrawer } from '@/components/orders/order-detail-view';
import { RowMenu, type RowMenuItem } from '@/components/orders/board/row-menu';
import { EmptyState, NoResults } from '@/components/ui/empty-state';
import { ItemsPopover, CustomerPopover } from '@/components/orders/queue-popovers';
import { OrdersKpiStrip } from '@/components/orders/orders-kpi-strip';
import ScanToFind from '@/components/orders/scan-to-find';
import { OrdersHeaderActions } from '@/components/orders/board/header-slot';
import {
  PipelineLanes,
  StatusChips,
  FilterChip,
  PeriodChip,
  ShortcutsHint,
} from '@/components/orders/board/toolbar';
import SavedViews from '@/components/orders/saved-views';
import { EditAddressModal } from '@/components/orders/edit-address-modal';
import { logOrderContact } from '@/lib/agents-report';
import { ApiError, apiFetch } from '@/lib/api';
import { StorePill } from '@/components/store-pill';
import { fmtDate, fmtDateTime, fmtTime, cn } from '@/lib/utils';
import { useToast } from '@/components/toast';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { AnimatedNumber } from '@/components/ui/animated-number';
import { Modal, ConfirmDialog } from '@/components/ui/modal';
import { PeriodSelect } from '@/components/orders/period-select';
import { periodRange, PeriodKey, PERIOD_OPTIONS } from '@/lib/date-period';
import {
  loadsheetStaging,
  listShipments,
  listLoadsheets,
  generateLoadsheet,
  revertAddressIssue,
  resolveAddressIssue,
  markShipmentReceived,
  sendShipperAdvice,
  bulkShipperAdvice,
  cancelBooking,
  generateLabels,
  downloadSlips,
  loadsheetPicklist,
  combinedPicklist,
  loadsheetFetchPdf,
  retryLoadsheet,
  deleteLoadsheet,
  loadsheetDispatchList,
  loadsheetSlips,
  rebuildManifest,
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
  setCourierInvoiceErpPosted,
  deleteCourierInvoice,
  createMonthlyRollup,
  type CourierInvoice,
  type BulkCancelMode,
  type BookingProgressRow,
  getCourierPerformance,
  getCourierPerformanceParcels,
  getCourierPendingPayments,
  stampZeroValueDelivered,
  getCourierShortfalls,
  resolveShortfall,
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
  type CourierShortfall,
  type ShortfallResolution,
  type QueueStatusFilter,
  type QueueSort,
  type LaneCounts,
  type CourierPerformance,
  type CourierPerfCity,
  type CourierPerfRow,
  type CourierPerfParcel,
  type CourierPerfBucket,
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
  const { user } = useAuth();
  // The view lives in the URL (?view=…) — the Orders header tabs (layout.tsx)
  // navigate between them, so Back and shared links keep the view.
  const searchParams = useSearchParams();
  const view = ((): 'queue' | 'dispatch' | 'replacements' | 'performance' | 'payments' => {
    const v = searchParams?.get('view');
    if (v === 'dispatch' || v === 'replacements' || v === 'performance') return v;
    // Courier payments is an owner/admin-only money view.
    if (v === 'payments' && (user?.role === 'owner' || user?.role === 'admin')) return v;
    return 'queue';
  })();
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
        <FulfillmentQueue toast={toast} onChanged={load} />
      </div>
    );
  }

  if (view === 'performance') {
    return (
      <div className="space-y-4">
        <CourierPerformancePanel toast={toast} />
      </div>
    );
  }

  if (view === 'replacements') {
    return (
      <div className="space-y-4">
        <ReplacementsBoard />
      </div>
    );
  }

  if (view === 'payments') {
    return (
      <div className="space-y-4">
        <CourierPaymentsBoard toast={toast} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
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
          <p className="text-sm font-semibold text-ink">Ready to manifest</p>
          <p className="text-xs text-muted">
            {(staging?.totals.total ?? 0).toLocaleString()} booked parcel
            {(staging?.totals.total ?? 0) === 1 ? '' : 's'} awaiting a loadsheet.
            Every other status lives on the{' '}
            <span className="font-medium">Orders</span> tab.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setBookOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-brand-600 text-white hover:bg-brand-700"
          >
            <Plus className="w-3.5 h-3.5" /> Book shipment
          </button>
          <button
            onClick={refreshDispatch}
            disabled={refreshingDispatch}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-line text-gray-600 hover:bg-sunken disabled:opacity-50"
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
                'relative overflow-hidden rounded-xl border bg-surface p-3',
                count > 0 ? 'border-line' : 'border-line opacity-60',
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
                    count > 0 ? 'text-amber-700' : 'text-muted',
                  )}
                >
                  {count}
                </p>
                <p className="mt-1 min-h-[16px] text-xs text-muted">
                  {count === 0
                    ? 'nothing waiting'
                    : stillBooking > 0
                      ? `${manifestable} ready · ${stillBooking} still booking`
                      : 'all have tracking'}
                </p>
                <p className="mt-1 min-h-[16px] text-xs font-medium">
                  {stale ? (
                    <span className="text-rose-600">
                      &#9888; oldest waiting {st!.oldestDays}d
                    </span>
                  ) : count === 1 ? (
                    <span className="text-muted">just 1 — wait to batch?</span>
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
                      ? 'cursor-default bg-sunken text-muted'
                      : count === 1
                        ? 'border border-green-600 text-green-700 hover:bg-green-50 disabled:opacity-60'
                        : 'bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-60',
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
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-gray-600 hover:bg-sunken"
        >
          <ChevronDown
            size={13}
            className={cn('opacity-60 transition-transform', pickOpen && 'rotate-180')}
          />
          {pickOpen ? 'Hide parcel list' : 'Pick individual parcels'}
          {(staging?.totals.total ?? 0) > 0 && (
            <span className="text-muted">
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
          className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-gray-700"
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
        <div className="rounded-xl border border-line bg-surface overflow-hidden">
          <SkeletonRows rows={6} />
        </div>
      ) : visible.length === 0 ? (
        <div className="bg-surface border border-line rounded-xl p-10 text-center">
          <Truck className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-muted">
            No shipments waiting for a loadsheet.
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-line rounded-xl overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
            <p className="text-xs text-muted">
              {labelSel.size > 0
                ? `${labelSel.size} selected${selCourier ? ` · ${COURIER_LABELS[selCourier]}` : ''}`
                : 'Select parcels to print shipping labels (one courier at a time).'}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => runSelectionLoadsheets(Array.from(labelSel))}
                disabled={loadsheetBusy || labelSel.size === 0}
                title="Generate a loadsheet per courier for the selected parcels (parallel)"
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs text-white hover:bg-brand-700 disabled:opacity-40"
              >
                {loadsheetBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileText className="h-3.5 w-3.5" />
                )}
                Generate loadsheets
              </button>
              {selMultiCourier && (
                <span className="text-xs text-amber-600">
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
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs text-white hover:bg-brand-700 disabled:opacity-40"
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
                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs text-gray-700 hover:bg-sunken disabled:opacity-40"
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
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-surface px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-40"
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
                    picked ? 'border-green-300 bg-green-50/60' : 'border-line',
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
                            'shrink-0 rounded-full px-2 py-0.5 text-xs',
                            STATUS_STYLES[s.status],
                          )}
                        >
                          {STATUS_LABELS[s.status]}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-sm font-medium text-ink">
                        {s.customer_name || '—'}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {[s.order_city || s.destination_city, s.phone]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </span>
                      <span className="mt-1.5 flex items-end justify-between gap-2 border-t border-line pt-1.5">
                        <span className="min-w-0 truncate text-xs text-muted">
                          {s.items_summary || '—'}
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block text-sm font-semibold tabular-nums text-ink">
                            {cod != null ? `${cur} ${Number(cod).toLocaleString()}` : '—'}
                          </span>
                          <span className="block font-mono text-xs text-muted">
                            {s.courier_tracking_number || COURIER_LABELS[s.courier_type]}
                          </span>
                        </span>
                      </span>
                      {s.address_issue_reason && (
                        <span className="mt-1 flex items-start gap-1 text-xs text-orange-600">
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
              <thead className="bg-sunken text-left text-xs uppercase tracking-wide text-muted">
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
              <tbody className="divide-y divide-line">
                {visible.map((s) => {
                  const cod =
                    s.total_outstanding != null && s.total_outstanding > 0
                      ? s.total_outstanding
                      : s.total_price ?? null;
                  const cur = s.currency || 'Rs';
                  return (
                    <tr key={s.id} className="hover:bg-sunken align-top">
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
                      <td className="px-4 py-3 font-medium text-ink whitespace-nowrap">
                        <OrderNameButton
                          name={s.shopify_order_name}
                          number={s.shopify_order_name}
                        />
                        <div className="text-xs font-normal text-muted">
                          {fmtDate(s.created_at)}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        <div>{s.customer_name || '—'}</div>
                        {s.phone && (
                          <div className="text-xs text-muted">{s.phone}</div>
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
                          <p className="text-xs text-orange-600 mt-1 flex items-start gap-1">
                            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                            {s.address_issue_reason}
                          </p>
                        )}
                        {s.booking_error && (
                          <p className="text-xs text-red-600 mt-1">{s.booking_error}</p>
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
            <span className="text-xs text-muted">Rows per page</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPage(1);
                setPageSize(Number(e.target.value));
              }}
              className="rounded-lg border border-line px-2 py-1 text-sm"
            >
              {[25, 50, 100, 200].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted">
              {(total === 0 ? 0 : (page - 1) * pageSize + 1).toLocaleString()}–
              {Math.min(page * pageSize, total).toLocaleString()} of{' '}
              {total.toLocaleString()}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(1)}
              disabled={page <= 1}
              className="rounded-lg border border-line px-2 py-1.5 text-xs disabled:opacity-40"
            >
              First
            </button>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-lg border border-line p-1.5 disabled:opacity-40"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="flex items-center gap-1">
              Page
              <select
                value={page}
                onChange={(e) => setPage(Number(e.target.value))}
                className="rounded-lg border border-line px-2 py-1 text-sm"
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
              className="rounded-lg border border-line p-1.5 disabled:opacity-40"
            >
              <ChevronRight size={16} />
            </button>
            <button
              onClick={() => setPage(lastPage)}
              disabled={page >= lastPage}
              className="rounded-lg border border-line px-2 py-1.5 text-xs disabled:opacity-40"
            >
              Last
            </button>
          </div>
        </div>
      )}
        </>
      )}

      {/* Recover a courier-generated loadsheet CodesApp doesn't have. */}
      <ImportLoadsheet onImported={() => setManifestsNonce((n) => n + 1)} />

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
          <label className="block text-xs text-muted mb-1">
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
          <label className="block text-xs text-muted mb-1">Courier</label>
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
          <p className="text-xs text-muted mt-1">
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
            className="px-4 py-2 text-sm rounded-lg bg-brand-600 text-white font-medium hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? 'Booking…' : 'Book shipment'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Phase B: the fulfilment queue (unfulfilled orders from the local mirror) ──

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

  // Keep polling while any batch is still generating OR waiting on its courier
  // PDF (two-phase Leopards/Trax) — both are self-terminating states.
  useEffect(() => {
    if (!batches?.some((b) => b.status === 'generating' || b.status === 'awaiting_pdf'))
      return;
    const id = setTimeout(() => load(), 4000);
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
    kind: 'labels' | 'picklist' | 'alist' | 'rebuild',
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

  // ONE combined pick sheet for every manifest generated on a given day.
  const combinedPick = async (g: { key: string; rows: LoadsheetBatch[] }) => {
    const d = new Date(g.rows[0].created_at);
    const from = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    const to = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
    setBusy(`day:${g.key}:picklist`);
    try {
      const res = await combinedPicklist(from.toISOString(), to.toISOString());
      openPdf(res.url, `picklist-all-${g.key.replace(/\s+/g, '-')}.pdf`);
      toast.success(`Combined pick list · ${res.totalUnits} units across ${res.parcels} parcels`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Download failed');
    } finally {
      setBusy(null);
    }
  };

  // A day-group header with its "Combined picklist" action (shared by the recent
  // and older lists).
  const DayHeader = ({ g }: { g: { key: string; label: string; rows: LoadsheetBatch[]; parcels: number } }) => (
    <div className="mb-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
      <span className="text-sm font-semibold text-ink">{g.label}</span>
      <span className="text-xs text-muted">
        {g.rows.length} manifest{g.rows.length === 1 ? '' : 's'} ·{' '}
        {g.parcels.toLocaleString()} parcels
      </span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => combinedPick(g)}
        disabled={busy === `day:${g.key}:picklist`}
        title="One pick sheet for every manifest of this day (all couriers)"
        className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-sunken disabled:opacity-50"
      >
        <ListChecks size={13} />
        {busy === `day:${g.key}:picklist` ? 'Building…' : 'Combined picklist'}
      </button>
    </div>
  );

  // Manually re-pull a created loadsheet's courier PDF (awaiting_pdf rows).
  const fetchPdf = async (id: number) => {
    setBusy(`${id}:fetchpdf`);
    try {
      await loadsheetFetchPdf(id);
      toast.success('Fetching the courier PDF — it will appear here shortly.');
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not fetch the PDF');
    } finally {
      setBusy(null);
    }
  };

  const all = batches ?? [];

  const statusPill = (b: LoadsheetBatch) => {
    const awaiting = b.status === 'awaiting_pdf';
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium capitalize',
          b.status === 'ready'
            ? 'bg-green-50 text-green-700'
            : b.status === 'failed'
              ? 'bg-red-50 text-red-700'
              : b.status === 'generating'
                ? 'bg-amber-50 text-amber-700'
                : 'bg-blue-50 text-blue-700',
        )}
        title={
          b.status === 'failed' && b.error
            ? b.error
            : awaiting
              ? `Loadsheet ${b.courier_loadsheet_id ? `#${b.courier_loadsheet_id} ` : ''}created — the courier is still preparing the PDF.`
              : undefined
        }
      >
        {(b.status === 'generating' || awaiting) && (
          <Loader2 className="h-3 w-3 animate-spin" />
        )}
        {awaiting ? 'PDF preparing' : b.status}
      </span>
    );
  };

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
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:border-line disabled:bg-gray-50 disabled:text-muted',
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
    mnp: '#BE123C',
    manual: '#475569',
  };

  const ManifestRow = ({ b }: { b: LoadsheetBatch }) => {
    const failed = b.status === 'failed';
    return (
      <div className="rounded-xl border border-line bg-surface px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="flex items-center gap-2.5">
            <span
              className="grid h-6 w-6 place-items-center rounded-md text-[10px] font-bold text-white"
              style={{ background: cmarkBg[b.courier_type] }}
            >
              {COURIER_LABELS[b.courier_type].slice(0, 2).toUpperCase()}
            </span>
            <span>
              <span className="block text-sm font-semibold text-ink">
                {COURIER_LABELS[b.courier_type]}
              </span>
              <span className="block text-xs text-muted">
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
                    const r = await retryLoadsheet(b.id);
                    toast.success(
                      r.mode === 'download'
                        ? 'Loadsheet already created — re-fetching its PDF.'
                        : `${COURIER_LABELS[b.courier_type]} loadsheet re-queued`,
                    );
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
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
              >
                {busy === `${b.id}:retry` ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                Retry
              </button>
              <button
                onClick={async () => {
                  setBusy(`${b.id}:delete`);
                  try {
                    await deleteLoadsheet(b.id);
                    toast.success('Failed loadsheet deleted');
                    load();
                  } catch (e) {
                    toast.error(e instanceof ApiError ? e.userMessage : 'Delete failed');
                  } finally {
                    setBusy(null);
                  }
                }}
                disabled={busy === `${b.id}:delete`}
                title="Remove this failed loadsheet from the list and the parcel totals"
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60"
              >
                {busy === `${b.id}:delete` ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}
                Delete
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {/* Loadsheet PDF — the courier's copy, reached on nearly every
                  manifest, so it's the one prominent action. While the courier
                  is still rendering a big PDF (awaiting_pdf, no url yet) this
                  becomes a "Fetch PDF" re-pull instead of a dead button. */}
              {b.status === 'awaiting_pdf' && !b.pdf_media_url
                ? actionBtn({
                    onClick: () => fetchPdf(b.id),
                    loading: busy === `${b.id}:fetchpdf`,
                    icon: <Download className="h-3 w-3" />,
                    label: 'Fetch PDF',
                    tone: 'blue',
                  })
                : actionBtn({
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
              {/* Rebuild the manifest from our own data (all pinned parcels) —
                  recovery when the courier returned an incomplete loadsheet PDF
                  (e.g. PostEx splits a >259-parcel request across sheets and
                  hands back only one). Only meaningful on a ready batch. */}
              {b.status === 'ready' &&
                actionBtn({
                  onClick: () =>
                    void run(
                      b.id,
                      'rebuild',
                      () => rebuildManifest(b.id),
                      `loadsheet-${b.courier_type}-${b.id}.pdf`,
                      'Manifest rebuilt from all parcels',
                    ).then(() => load()),
                  loading: busy === `${b.id}:rebuild`,
                  icon: <RefreshCw className="h-3 w-3" />,
                  label: 'Rebuild',
                  tone: 'blue',
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
        {/* A READY batch with a note = recovered: the courier created the sheet
            but never returned its PDF, so this is the CodesApp manifest. */}
        {b.status === 'ready' && b.error && (
          <p className="mt-2 flex items-start gap-1.5 text-[12px] text-amber-700">
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
          <p className="text-sm font-semibold text-ink">Manifests</p>
          <p className="text-xs text-muted">
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
            className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-gray-700"
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
            className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs text-gray-600 hover:bg-sunken"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
      </div>

      {batches === null ? (
        <div className="rounded-xl border border-line bg-surface overflow-hidden">
          <SkeletonRows rows={5} />
        </div>
      ) : all.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface p-10 text-center">
          <FileText className="mx-auto mb-2 h-8 w-8 text-gray-300" />
          <p className="text-sm text-muted">No manifests yet.</p>
          <p className="mt-1 text-xs text-muted">
            Manifest a courier from the staging lane above to generate one.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {recentGroups.map((g) => (
            <div key={g.key}>
              <DayHeader g={g} />
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
                  className="flex w-full items-center justify-between gap-3 rounded-xl border border-dashed border-gray-300 bg-sunken px-4 py-3 text-sm text-gray-600 hover:bg-gray-100"
                >
                  <span>
                    <b className="text-ink">{olderCount} earlier manifest{olderCount === 1 ? '' : 's'}</b>
                    {' · back to '}
                    {fmtDate(olderGroups[olderGroups.length - 1].rows[0].created_at)}
                  </span>
                  <span className="text-muted">Show all →</span>
                </button>
              ) : (
                <div className="space-y-5">
                  {olderGroups.map((g) => (
                    <div key={g.key}>
                      <DayHeader g={g} />
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

// Primary button on the dark floating bulk bar.
const BULK_PRIMARY =
  'inline-flex h-9 items-center gap-1.5 rounded-lg bg-green-500 px-3.5 text-[13px] font-bold text-slate-950 hover:bg-green-400 disabled:opacity-50';

// Split-pill tones for the Confirmation column (border + tint + text).
const CONF_TONE: Record<QueueOrder['confirmationStatus'], string> = {
  confirmed: 'border-green-200 bg-green-50 text-green-700',
  no_response: 'border-amber-200 bg-amber-50 text-amber-800',
  pending: 'border-sky-200 bg-sky-50 text-sky-700',
  undeliverable: 'border-rose-200 bg-rose-50 text-rose-700',
  cancelled: 'border-rose-200 bg-rose-50 text-rose-700',
  none: 'border-gray-200 bg-gray-50 text-gray-600',
};

/** True when a click landed on something that has its own behaviour, so the
 *  row's "open the order" click must not also fire. */
function isInteractiveTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (window.getSelection()?.toString()) return true; // selecting text
  return !!el.closest(
    'button, a, input, select, textarea, label, [role="menu"], [data-conf-menu], [data-no-row-open]',
  );
}

/** COD / Paid / Unpaid-state pill (a closed order at 0 outstanding isn't "Paid"). */
function PayPill({ row }: { row: QueueOrder }) {
  const isCod = (row.totalOutstanding ?? 0) > 0;
  const fin = (row.financialStatus ?? '').toLowerCase();
  const notPaid =
    fin === 'voided' ||
    fin === 'refunded' ||
    fin === 'partially_refunded' ||
    fin === 'pending' ||
    fin === 'authorized';
  const label = isCod ? 'COD' : notPaid ? fin.replace(/_/g, ' ') || 'Unpaid' : 'Paid';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold capitalize',
        isCod
          ? 'bg-amber-50 text-amber-800'
          : notPaid
            ? 'bg-gray-100 text-gray-600'
            : 'bg-green-50 text-green-700',
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          isCod ? 'bg-amber-500' : notPaid ? 'bg-gray-400' : 'bg-green-500',
        )}
      />
      {label}
    </span>
  );
}

/** How long the order has been waiting, as a compact severity chip. `live`
 *  colours it only where waiting is actionable (To book / Needs attention). */
function WaitChip({ createdAt, live }: { createdAt: string | null; live: boolean }) {
  if (!createdAt) return null;
  const ms = Date.now() - new Date(createdAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const hrs = ms / 3_600_000;
  const label =
    hrs < 1
      ? `${Math.max(1, Math.round(ms / 60_000))}m`
      : hrs < 24
        ? `${Math.floor(hrs)}h`
        : `${Math.floor(hrs / 24)}d`;
  const level = hrs >= 72 ? 'late' : hrs >= 24 ? 'due' : 'fresh';
  return (
    <span
      title={`Placed ${fmtDateTime(createdAt)}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums',
        !live
          ? 'bg-gray-100 text-gray-600'
          : level === 'late'
            ? 'bg-rose-50 text-rose-700'
            : level === 'due'
              ? 'bg-amber-50 text-amber-800'
              : 'bg-sky-50 text-sky-700',
      )}
    >
      <Clock size={10} />
      {label}
    </span>
  );
}

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
  /** Pipeline colour (dot, count, active underline). */
  color: string;
  /** Tailwind classes: accent text, tint background, active ring, rail. */
  tone: { text: string; bg: string; ring: string; rail: string };
}

const LANES: LaneDef[] = [
  {
    key: 'tobook',
    color: '#ea580c',
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
    color: '#0284c7',
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
    color: '#e11d48',
    label: 'Needs attention',
    status: 'needs_attention',
    members: ['needs_attention', 'address_issue', 'attempted', 'shipper_advice', 'failed', 'returned'],
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
    color: '#16a34a',
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
    ['shipper_advice', 'Shipper advice'],
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
            : 'text-muted',
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
  const { on, status: socketStatus } = useSocket();
  // The scrollable table viewport — bounded height + sticky header live here, and
  // changing page size resets it to the top (see the effects below).
  const tableScrollRef = useRef<HTMLDivElement>(null);
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
  // Multi-Store: filter the board to a single connected store (or 'all'). Only
  // shown when the tenant has >1 store.
  const [storeFilter, setStoreFilter] = useState<number | 'all'>('all');
  const [stores, setStores] = useState<{ id: number; label: string; isPrimary: boolean; tokenInvalid?: boolean }[]>([]);
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
  const loadSeqRef = useRef(0);
  const countsSeqRef = useRef(0);
  const [boardHydrated, setBoardHydrated] = useState(false);
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
  // Cross-screen booking lock: which orders another agent is currently booking.
  // Fed by the server's `order.locked`/`order.unlocked` socket events so a second
  // agent sees the Book button grey out the instant someone else starts. Keyed by
  // orderGid; `byUserId` lets us ignore our OWN lock (we show the spinner instead).
  const [lockedGids, setLockedGids] = useState<
    Record<string, { name: string; byUserId: number | null; at: number }>
  >({});
  const [confirmingGid, setConfirmingGid] = useState<string | null>(null);
  const [resendGid, setResendGid] = useState<string | null>(null);
  const [noRespGid, setNoRespGid] = useState<string | null>(null);
  const [logCallGid, setLogCallGid] = useState<string | null>(null);
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
  // "Create order" (blank, no chat) modal open?
  const [createOpen, setCreateOpen] = useState(false);
  // Shipment-status actions (moved here from the Shipments tab): a busy row +
  // the RTO "mark received" confirm target.
  const [actBusyGid, setActBusyGid] = useState<string | null>(null);
  const [receiveRow, setReceiveRow] = useState<QueueOrder | null>(null);
  const [receiving, setReceiving] = useState(false);
  // Shipper-advice modal target (an attempted parcel), or null.
  const [adviceRow, setAdviceRow] = useState<QueueOrder | null>(null);
  // Bulk shipper-advice modal (for the selected flagged parcels).
  const [bulkAdviceOpen, setBulkAdviceOpen] = useState(false);
  const [bulkAdviceBusy, setBulkAdviceBusy] = useState(false);
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
      // Stale-response guard: a slow earlier request (previous tab / filter /
      // search) must never overwrite newer rows.
      const my = ++loadSeqRef.current;
      const stale = () => my !== loadSeqRef.current;
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
          store: storeFilter === 'all' ? undefined : storeFilter,
          from: range.from,
          to: range.to,
        } as const;

        // "Show selected" restricts to exactly the selected gids — fetched via
        // the gid-scoped endpoint so it covers a selection spanning pages that
        // aren't currently loaded. Nothing selected → skip the request.
        const selectedGids = rowView === 'selected' ? Array.from(selectedRef.current) : null;
        if (selectedGids && selectedGids.length === 0) {
          if (stale()) return;
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
            if (stale()) return;
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
          if (stale()) return;
          setRows(res.rows);
          setTotal(res.total);
        }
        if (!keepSelection) setSelected(new Set()); // clear on reload/page change
      } catch (e) {
        if (stale()) return;
        toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load orders');
        if (!silent) setRows([]);
      } finally {
        // Only the LATEST request may end the spinner (silent or not).
        if (!stale()) setLoading(false);
        // Keep the lane tiles in step with the table: most in-app actions
        // (book / confirm / cancel / RTO / archive …) reload the rows but used
        // to leave the counts stale until a manual refresh. Counts are a single
        // cheap aggregate and ignore page/status, so refreshing on every load
        // is safe. Via a ref so it never widens load()'s dependency list.
        loadCountsRef.current?.();
      }
    },
    [search, page, pageSize, status, sort, confSub, courierFilter, storeFilter, period, customFrom, customTo, rowView, toast],
  );

  // Lane counts follow the board's own filters (search / courier / period) but
  // NOT the active lane — the whole point is seeing the other lanes' workload
  // without opening them. Best-effort: a counts failure must never blank the board.
  const loadCounts = useCallback(async () => {
    const my = ++countsSeqRef.current;
    try {
      const range = periodRange(period, { from: customFrom, to: customTo });
      const c = await fulfillmentLaneCounts({
        search,
        courier: courierFilter === 'all' ? undefined : courierFilter,
        store: storeFilter === 'all' ? undefined : storeFilter,
        from: range.from,
        to: range.to,
      });
      if (my === countsSeqRef.current) setCounts(c);
    } catch {
      if (my === countsSeqRef.current) setCounts(null);
    }
  }, [search, courierFilter, storeFilter, period, customFrom, customTo]);
  // No separate useEffect(loadCounts): every filter that changes the counts
  // also changes load(), whose finally refreshes them. The extra effect fetched
  // the counts twice per filter change.

  // Multi-Store: load the tenant's connected stores once for the board's store
  // filter + row pills. Best-effort; single-store tenants get an empty list and
  // never see the filter.
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ id: number; label: string; isPrimary: boolean; tokenInvalid?: boolean }[]>('/shopify/stores')
      .then((rows) => {
        if (!cancelled) setStores(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setStores([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live board: the server fires a coalesced `orders.changed` ping on any order
  // or shipment webhook (new order, cancel, fulfilled/shipped, courier delivery
  // status). Refresh the lane counts and the table in place — silent +
  // keepSelection so the operator's scroll position and selection survive and
  // the figures roll to their new value. Refs keep this subscription from
  // re-binding on every load/loadCounts identity change.
  const loadRef = useRef(load);
  const loadCountsRef = useRef(loadCounts);
  useEffect(() => {
    loadRef.current = load;
    loadCountsRef.current = loadCounts;
  }, [load, loadCounts]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = on('orders.changed', () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        loadCountsRef.current();
        loadRef.current({ silent: true, keepSelection: true });
      }, 500);
    });
    return () => {
      if (t) clearTimeout(t);
      off();
    };
    // socketStatus is a dep so the listener re-binds once the socket instance
    // actually exists (the provider's effect runs after ours on first mount).
  }, [on, socketStatus]);

  // Cross-screen booking lock: the server emits `order.locked` the instant an
  // agent starts booking an order and `order.unlocked` when they finish — so the
  // Book button greys out on every OTHER screen and no one double-books it.
  useEffect(() => {
    const offLock = on('order.locked', (p: unknown) => {
      const d = p as { orderGid?: string; byName?: string; byUserId?: number | null };
      if (!d?.orderGid) return;
      setLockedGids((prev) => ({
        ...prev,
        [d.orderGid as string]: {
          name: d.byName || '',
          byUserId: d.byUserId ?? null,
          at: Date.now(),
        },
      }));
    });
    const offUnlock = on('order.unlocked', (p: unknown) => {
      const d = p as { orderGid?: string };
      if (!d?.orderGid) return;
      setLockedGids((prev) => {
        if (!prev[d.orderGid as string]) return prev;
        const next = { ...prev };
        delete next[d.orderGid as string];
        return next;
      });
    });
    return () => {
      offLock();
      offUnlock();
    };
  }, [on, socketStatus]);

  // Safety sweep: if a booker's tab crashes/disconnects mid-book its
  // `order.unlocked` may never arrive — expire any lock older than 30s so an
  // order can never get stuck greyed-out.
  useEffect(() => {
    const t = setInterval(() => {
      setLockedGids((prev) => {
        const cutoff = Date.now() - 30_000;
        let changed = false;
        const next: typeof prev = {};
        for (const [gid, v] of Object.entries(prev)) {
          if (v.at < cutoff) changed = true;
          else next[gid] = v;
        }
        return changed ? next : prev;
      });
    }, 10_000);
    return () => clearInterval(t);
  }, []);

  // Reseed when the socket (re)connects — catches anything missed while offline.
  const prevSockRef = useRef(socketStatus);
  useEffect(() => {
    if (prevSockRef.current !== 'connected' && socketStatus === 'connected') {
      loadCountsRef.current();
      loadRef.current({ silent: true, keepSelection: true });
    }
    prevSockRef.current = socketStatus;
  }, [socketStatus]);

  // Rows-per-page changed → page is reset to 1, so put the operator back at the
  // first row instead of leaving them stranded at the bottom (where the selector
  // lives) after the list regrows. Resets the table's own scroll and lifts it
  // back into view.
  const prevPageSizeRef = useRef(pageSize);
  useEffect(() => {
    if (prevPageSizeRef.current !== pageSize) {
      prevPageSizeRef.current = pageSize;
      tableScrollRef.current?.scrollTo({ top: 0 });
      tableScrollRef.current?.scrollIntoView({ block: 'start' });
    }
  }, [pageSize]);

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
  const filterSignature = [status, sort, confSub, courierFilter, storeFilter, period, customFrom, customTo].join(' ');
  const prevFilterSigRef = useRef(filterSignature);
  useEffect(() => {
    if (!boardHydrated) return;
    const filtersChanged = prevFilterSigRef.current !== filterSignature;
    prevFilterSigRef.current = filterSignature;
    load({ keepSelection: !filtersChanged });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, boardHydrated]);

  // Search & filter conventions: the board's filters live in the URL (lane,
  // sub-tab, courier, store, period, search, sort, page) so refresh, Back and a
  // shared link restore the exact view. ?view= is owned by orders/layout and
  // preserved. Read once on mount; mirrored with replaceState (no history spam).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const lane = q.get('lane');
    if (lane && /^[a-z_]+$/.test(lane)) setStatus(lane as QueueStatusFilter);
    const conf = q.get('conf');
    if (conf === 'confirmed' || conf === 'unconfirmed') setConfSub(conf);
    const c = q.get('courier');
    if (c && c in COURIER_LABELS) setCourierFilter(c as CourierType);
    const st = Number(q.get('store'));
    if (st > 0) setStoreFilter(st);
    const per = q.get('period');
    if (per && PERIOD_OPTIONS.some((o) => o.key === per)) setPeriod(per as PeriodKey);
    if (q.get('from')) setCustomFrom(q.get('from') as string);
    if (q.get('to')) setCustomTo(q.get('to') as string);
    const so = q.get('sort');
    if (so === 'newest' || so === 'value' || so === 'oldest') setSort(so);
    const sq = q.get('q');
    if (sq) {
      setSearchInput(sq);
      setSearch(sq.trim());
    }
    const pg = Number(q.get('page'));
    if (pg > 1) setPage(pg);
    setBoardHydrated(true);
  }, []);
  useEffect(() => {
    if (!boardHydrated) return;
    const q = new URLSearchParams(window.location.search);
    const put = (k: string, v: string | null | undefined) => (v ? q.set(k, v) : q.delete(k));
    put('lane', status !== 'unfulfilled' ? status : null);
    put('conf', status === 'unfulfilled' && confSub !== 'all' ? confSub : null);
    put('courier', courierFilter !== 'all' ? courierFilter : null);
    put('store', storeFilter !== 'all' ? String(storeFilter) : null);
    put('period', period !== 'all' ? period : null);
    put('from', period === 'custom' ? customFrom : null);
    put('to', period === 'custom' ? customTo : null);
    put('sort', sort !== 'oldest' ? sort : null);
    put('q', search || null);
    put('page', page > 1 ? String(page) : null);
    const qs = q.toString();
    const url = window.location.pathname + (qs ? '?' + qs : '');
    if (url !== window.location.pathname + window.location.search) {
      window.history.replaceState(window.history.state, '', url);
    }
  }, [boardHydrated, status, confSub, courierFilter, storeFilter, period, customFrom, customTo, sort, search, page]);

  // Any narrowing filter beyond the lane itself (drives the filtered empty
  // state + its Clear filters action).
  const boardFiltered =
    courierFilter !== 'all' ||
    storeFilter !== 'all' ||
    period !== 'all' ||
    (status === 'unfulfilled' && confSub !== 'all');
  const clearBoardFilters = () => {
    setSearchInput('');
    setSearch('');
    setCourierFilter('all');
    setStoreFilter('all');
    setPeriod('all');
    setCustomFrom('');
    setCustomTo('');
    setConfSub('all');
    setPage(1);
  };

  // Multi-Store: the Sync actions honour the board's store filter — "All stores"
  // syncs every connected store, a selected store syncs just that one.
  const syncStoreId = storeFilter === 'all' ? undefined : storeFilter;
  const syncScopeLabel =
    syncStoreId == null
      ? stores.length > 1
        ? 'every connected store'
        : 'your store'
      : stores.find((s) => s.id === syncStoreId)?.label ?? 'this store';

  const runImport = async () => {
    setImporting(true);
    try {
      await importShopifyOrders(syncStoreId);
      toast.success(
        `Sync started for ${syncScopeLabel} — open orders refresh and archived ones drop off shortly.`,
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
      await reconcileShopifyOrders(syncStoreId);
      toast.success(
        `Reconcile started for ${syncScopeLabel} — orders archived/cancelled in Shopify will drop off shortly.`,
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

  // Log a call/contact for this order (counts in the Agent Performance report).
  const logCallOrder = async (r: QueueOrder) => {
    setLogCallGid(r.orderGid);
    try {
      await logOrderContact({ orderGid: r.orderGid, orderName: r.orderName ?? undefined });
      toast.success(`Call logged for ${r.orderName ?? 'order'}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to log call');
    } finally {
      setLogCallGid(null);
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

  // Shipper-advice tab → bulk "post shipper advice". Any selected row with a
  // shipment qualifies; the backend skips unsupported couriers (M&P/manual).
  const isShipperAdviceView = status === 'shipper_advice';
  const selectedAdviceIds = rows
    .filter((r) => selected.has(r.orderGid) && r.shipment)
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

  const runBulkShipperAdvice = async (
    action: 'reattempt' | 'return',
    remarks: string,
  ) => {
    if (!selectedAdviceIds.length) return;
    setBulkAdviceBusy(true);
    try {
      const res = await bulkShipperAdvice(selectedAdviceIds, action, remarks.trim());
      const bits = [
        `${res.sent} sent`,
        res.rejected ? `${res.rejected} rejected` : null,
        res.skipped ? `${res.skipped} skipped` : null,
        res.notFound ? `${res.notFound} not found` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      toast.success(`Shipper advice — ${bits}`);
      if (res.skippedCouriers.length) {
        toast.info(`Skipped (no shipper-advice API): ${res.skippedCouriers.join(', ')}`);
      }
      if (res.rejectedOrders.length) {
        toast.info(`Rejected: ${res.rejectedOrders.slice(0, 20).join(', ')}`);
      }
      setBulkAdviceOpen(false);
      setSelected(new Set());
      load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Bulk shipper advice failed');
    } finally {
      setBulkAdviceBusy(false);
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

  // Search-as-you-type: debounce the input so results filter ~300ms after
  // typing stops — no Enter needed. Pressing Enter (submitSearch) still applies
  // instantly. A new query resets to page 1. (setSearch with an unchanged value
  // is a no-op, so hitting Enter then the debounce firing won't double-load.)
  useEffect(() => {
    const t = setTimeout(() => {
      const next = searchInput.trim();
      // Only a real change resets the page (a trailing space used to).
      if (next === search) return;
      setPage(1);
      setSearch(next);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, search]);

  // Is this order currently being booked by SOMEONE ELSE? Returns the booker's
  // name (for the "Being booked by …" label) or null. Our own in-flight book is
  // ignored here — it already shows the local spinner via `bookingGid`.
  const lockedByOther = (gid: string): { name: string } | null => {
    const l = lockedGids[gid];
    if (!l) return null;
    if (l.byUserId != null && user?.id != null && l.byUserId === user.id) return null;
    return { name: l.name };
  };

  // Every displayed row is selectable now (so fulfilled orders can be archived
  // too). Booking still only applies to the bookable subset of the selection —
  // and never to an order another agent is already booking.
  // ── Row helpers (redesigned board) ──────────────────────────────────
  // Clicking a row (or Enter on the keyboard cursor) opens the order drawer.
  const [drawerGid, setDrawerGid] = useState<string | null>(null);
  const closeDrawer = useCallback(() => setDrawerGid(null), []);

  /** The one thing a person must know about this row, with its fix. Shown as a
   *  tinted strip under the row instead of badges piled into the action cell. */
  const rowException = (
    r: QueueOrder,
  ): { tone: 'amber' | 'rose'; text: string; action?: { label: string; run: () => void } } | null => {
    const sh = r.shipment;
    if (r.archived) return null;
    if (sh?.shipperAdviceRequiredAt) {
      return {
        tone: 'amber',
        text: `Courier is waiting for your advice${
          sh.shipperAdviceRequiredRaw ? ` — “${sh.shipperAdviceRequiredRaw}”` : ''
        }`,
        action: { label: 'Post advice', run: () => setAdviceRow(r) },
      };
    }
    if (sh?.status === 'address_issue') {
      return {
        tone: 'rose',
        text: 'Address flagged. Correct it, or pick a courier and book anyway.',
        action: { label: 'Fix address', run: () => setEditRow(r) },
      };
    }
    if (
      sh &&
      !['delivered', 'cancelled'].includes(sh.status) &&
      (sh.lastStatusReason ||
        (sh.shipperAdviceStatus && (sh.status === 'attempted' || sh.status === 'in_transit')))
    ) {
      const advice = sh.shipperAdviceStatus
        ? ` (advice sent: ${sh.shipperAdviceStatus === 'return' ? 'return' : 're-attempt'})`
        : '';
      return {
        tone: 'amber',
        text: `${sh.lastStatusReason ? `Courier: ${sh.lastStatusReason}` : 'Shipper advice posted'}${advice}`,
      };
    }
    if (!sh && r.fulfillmentStatus === 'unfulfilled' && r.confirmationStatus === 'undeliverable') {
      return {
        tone: 'rose',
        text: 'This number has no WhatsApp, so the confirmation never arrived.',
        action: { label: 'Send to another number', run: () => setAltPhoneRow(r) },
      };
    }
    return null;
  };

  /** Everything secondary for a row lives in its ⋯ menu. */
  const rowMenuItems = (r: QueueOrder): RowMenuItem[] => {
    const sh = r.shipment;
    const busy = actBusyGid === r.orderGid;
    const editable = !r.archived && r.fulfillmentStatus === 'unfulfilled' && !sh;
    const items: RowMenuItem[] = [
      { key: 'open', label: 'Open order', icon: Eye, onSelect: () => setDrawerGid(r.orderGid) },
    ];
    if (editable) {
      items.push(
        { key: 'addr', label: 'Edit address', icon: Pencil, onSelect: () => setEditRow(r), divider: true },
        { key: 'items', label: 'Edit items', icon: Package, onSelect: () => setEditItemsRow(r) },
        { key: 'flag', label: 'Flag wrong address', icon: MapPinOff, onSelect: () => setWrongAddrGid(r.orderGid) },
      );
    }
    if (sh && !r.archived) {
      let first = true;
      const grp = () => {
        const d = first;
        first = false;
        return d;
      };
      if (sh.status === 'address_issue') {
        items.push({ key: 'fix', label: 'Fix address', icon: Pencil, onSelect: () => setEditRow(r), divider: grp() });
      }
      if (sh.trackingNumber) {
        items.push({
          key: 'slip',
          label: slipBusy === sh.id ? 'Opening slip…' : 'Courier slip / label',
          icon: FileText,
          onSelect: () => openSlip(sh.id),
          disabled: slipBusy === sh.id,
          divider: grp(),
        });
      }
      if (sh.trackingNumber && sh.trackingUrl) {
        items.push({ key: 'track', label: 'Track parcel', icon: ExternalLink, onSelect: () => setTrackRow(r), divider: grp() });
      }
      if (sh.status === 'attempted' || sh.status === 'failed') {
        items.push({ key: 'advice', label: 'Shipper advice…', icon: RotateCcw, onSelect: () => setAdviceRow(r), disabled: busy, divider: grp() });
      }
      if (sh.status === 'failed') {
        items.push({ key: 'recv', label: 'Mark received (RTO)…', icon: ArchiveRestore, onSelect: () => setReceiveRow(r), disabled: busy });
      }
      if (['booked', 'in_transit', 'ready_for_pickup', 'picked_up'].includes(sh.status)) {
        items.push({ key: 'cancel', label: 'Cancel booking…', icon: Ban, onSelect: () => setCancelRow(r), disabled: busy, danger: true, divider: true });
      }
    }
    if (r.adminUrl) {
      const url = r.adminUrl;
      items.push({
        key: 'shopify',
        label: 'View in Shopify',
        icon: ExternalLink,
        onSelect: () => window.open(url, '_blank', 'noopener,noreferrer'),
        divider: true,
      });
    }
    return items;
  };

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.orderGid));
  const selectedBookableGids = rows
    .filter((r) => selected.has(r.orderGid) && bookable(r) && !lockedByOther(r.orderGid))
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
        // Select-all used to ignore the sub-tab and pick unconfirmed orders too.
        confirmation: status === 'unfulfilled' && confSub !== 'all' ? confSub : undefined,
        courier: courierFilter === 'all' ? undefined : courierFilter,
        store: storeFilter === 'all' ? undefined : storeFilter,
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
      // The order drawer owns J/K/Esc while it's open (it steps through these
      // same rows) — don't also move the board cursor behind it.
      if (document.querySelector('[data-order-drawer]')) return;

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
      } else if (e.key === 'Enter') {
        if (cur < 0 || cur > max) return;
        if (el && (el.tagName === 'BUTTON' || el.tagName === 'A')) return;
        e.preventDefault();
        setDrawerGid(rows[cur].orderGid);
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
    storeFilter,
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
    if (v.storeFilter === 'all' || typeof v.storeFilter === 'number') {
      setStoreFilter(v.storeFilter as number | 'all');
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
      {/* A store whose Shopify Admin API token was revoked (401) can't book —
          surface it loudly so the operator reconnects instead of hitting raw
          "booking failed" errors. */}
      {stores.some((s) => s.tokenInvalid) && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <span className="font-semibold">
              {stores.filter((s) => s.tokenInvalid).map((s) => s.label).join(', ')}
            </span>{' '}
            — Shopify token is invalid. Bookings for{' '}
            {stores.filter((s) => s.tokenInvalid).length > 1 ? 'these stores' : 'this store'} will
            fail until you reconnect it
            {user?.role === 'owner' || user?.role === 'admin' ? (
              <>
                {' '}in{' '}
                <Link href="/settings?tab=shopify" className="font-semibold underline">
                  Settings → Shopify
                </Link>
                .
              </>
            ) : (
              <> (ask an admin to update the Shopify Admin API token in Settings → Shopify).</>
            )}
          </div>
        </div>
      )}
      {/* Page actions live in the shared Orders header (layout.tsx slot). */}
      <OrdersHeaderActions>
        {user?.role !== 'fulfillment' && (
          <button
            type="button"
            onClick={() => {
              const next = !showMetrics;
              setShowMetrics(next);
              persist('orders.queue.metrics', next);
            }}
            aria-pressed={showMetrics}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-semibold',
              showMetrics
                ? 'border-brand-200 bg-brand-50 text-brand-700'
                : 'border-line bg-surface text-ink hover:bg-sunken',
            )}
          >
            <BarChart3 size={15} /> Metrics
          </button>
        )}
        <ScanToFind
          onScan={(code) => {
            setPage(1);
            setSearchInput(code);
            setSearch(code);
          }}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-semibold text-ink hover:bg-sunken"
        />
        <div className="relative" ref={syncMenuRef}>
          <button
            type="button"
            onClick={() => setSyncMenuOpen((o) => !o)}
            disabled={importing || reconciling || syncing}
            aria-haspopup="menu"
            aria-expanded={syncMenuOpen}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-semibold text-ink hover:bg-sunken disabled:opacity-50"
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
              className="absolute right-0 z-40 mt-1 w-72 rounded-xl border border-line bg-surface p-1 shadow-lg"
            >
              {stores.length > 1 && (
                <div className="border-b border-line px-3 py-1.5 text-xs text-muted">
                  Scope:{' '}
                  <span className="font-semibold text-gray-700">
                    {syncStoreId == null ? 'All stores' : syncScopeLabel}
                  </span>
                  {syncStoreId == null
                    ? ' — change the store filter to sync just one.'
                    : ' — filtered store only.'}
                </div>
              )}
              <button
                role="menuitem"
                onClick={() => {
                  setSyncMenuOpen(false);
                  runImport();
                }}
                className="w-full rounded-lg px-3 py-2 text-left hover:bg-sunken"
              >
                <span className="block text-sm text-ink">
                  Import from Shopify
                </span>
                <span className="block text-xs text-muted">
                  Pull new and updated open orders from {syncStoreId == null && stores.length > 1 ? 'every store' : 'the store'}.
                </span>
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setSyncMenuOpen(false);
                  runReconcile();
                }}
                className="w-full rounded-lg px-3 py-2 text-left hover:bg-sunken"
              >
                <span className="block text-sm text-ink">
                  Reconcile with Shopify
                </span>
                <span className="block text-xs text-muted">
                  Drop orders archived or cancelled in Shopify.
                </span>
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setSyncMenuOpen(false);
                  runSyncStatuses();
                }}
                className="w-full rounded-lg px-3 py-2 text-left hover:bg-sunken"
              >
                <span className="block text-sm text-ink">
                  Refresh courier statuses
                </span>
                <span className="block text-xs text-muted">
                  Pull fresh delivery status for parcels in transit.
                </span>
              </button>
              <div className="my-1 border-t border-line" />
              <button
                role="menuitem"
                onClick={() => {
                  setSyncMenuOpen(false);
                  load();
                  loadCounts();
                }}
                className="w-full rounded-lg px-3 py-2 text-left hover:bg-sunken"
              >
                <span className="block text-sm text-ink">
                  Reload this board
                </span>
                <span className="block text-xs text-muted">
                  Re-read what is already stored — no external call.
                </span>
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          title="Create a new Shopify order (no chat needed)"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 text-[13px] font-semibold text-white hover:bg-brand-700"
        >
          <Plus size={15} /> Create order
        </button>
      </OrdersHeaderActions>

      {showMetrics && user?.role !== 'fulfillment' && <OrdersKpiStrip />}

      {/* ── The order lifecycle as one pipeline — the board's primary nav. ── */}
      <PipelineLanes
        activeKey={laneForStatus(status)}
        onSelect={(k) => {
          const lane = LANES.find((l) => l.key === k);
          if (!lane) return;
          setPage(1);
          setSelected(new Set());
          setConfSub('all');
          setStatus(lane.status);
        }}
        lanes={LANES.map((lane) => {
          const c = counts;
          return {
            key: lane.key,
            label: lane.label,
            color: lane.color,
            value:
              lane.key === 'tobook'
                ? c?.toBook.total
                : lane.key === 'inflight'
                  ? c?.inFlight.total
                  : lane.key === 'attention'
                    ? c?.needsAttention.total
                    : c?.delivered.total,
            sub:
              lane.key === 'tobook'
                ? c && `${c.toBook.confirmed.toLocaleString()} confirmed · ${c.toBook.awaiting.toLocaleString()} awaiting`
                : lane.key === 'inflight'
                  ? c && `${c.inFlight.outForDelivery.toLocaleString()} out for delivery`
                  : lane.key === 'attention'
                    ? c &&
                      `${c.needsAttention.addressIssue.toLocaleString()} address · ${c.needsAttention.failed.toLocaleString()} failed · ${c.needsAttention.returned.toLocaleString()} RTO`
                    : lane.hint,
            alert:
              lane.key === 'attention' && c && c.needsAttention.shipperAdvice > 0
                ? `${c.needsAttention.shipperAdvice} need advice`
                : null,
          };
        })}
      />

      {/* Every status inside the active lane, visible with its count (the old
          refine <select> hid them). To-book's chips are the confirmation split. */}
      <StatusChips<string>
        value={status === 'unfulfilled' ? `conf:${confSub}` : status}
        onChange={(k) => {
          setPage(1);
          setSelected(new Set());
          if (k.startsWith('conf:')) {
            setStatus('unfulfilled');
            setConfSub(k.slice(5) as 'all' | 'confirmed' | 'unconfirmed');
          } else {
            setConfSub('all');
            setStatus(k as QueueStatusFilter);
          }
        }}
        chips={(() => {
          const lk = laneForStatus(status);
          const c = counts;
          if (lk === 'tobook') {
            return [
              { key: 'conf:all', label: 'All waiting', count: c?.toBook.total },
              { key: 'conf:confirmed', label: 'Confirmed', count: c?.toBook.confirmed },
              { key: 'conf:unconfirmed', label: 'Awaiting confirmation', count: c?.toBook.awaiting, warn: true },
            ];
          }
          if (!lk) return [];
          const known: Partial<Record<QueueStatusFilter, number | undefined>> = {
            in_flight: c?.inFlight.total,
            out_for_delivery: c?.inFlight.outForDelivery,
            needs_attention: c?.needsAttention.total,
            address_issue: c?.needsAttention.addressIssue,
            shipper_advice: c?.needsAttention.shipperAdvice,
            failed: c?.needsAttention.failed,
            returned: c?.needsAttention.returned,
            delivered: c?.delivered.total,
          };
          return REFINE_OPTIONS[lk].map(([k, label]) => ({
            key: k as string,
            label,
            count: known[k],
            warn: k === 'shipper_advice' || k === 'address_issue',
          }));
        })()}
        records={OTHER_VIEWS.map(([k, label]) => ({ key: k as string, label }))}
      />

      {/* ── One filter bar: search + filter chips + views. ── */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2">
        <form onSubmit={submitSearch} className="relative min-w-0 flex-[1_1_260px]">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            id="queue-search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search order #, name, phone, city or tracking"
            className="h-9 w-full rounded-lg border border-transparent bg-sunken pl-9 pr-10 text-sm text-ink placeholder:text-muted focus:border-brand-500 focus:bg-surface focus:outline-none"
          />
          <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-line bg-surface px-1.5 font-mono text-xs text-muted sm:block">
            /
          </kbd>
        </form>
        <div className="flex max-w-full items-center gap-2 overflow-x-auto sm:overflow-visible">
          <FilterChip
            icon={Truck}
            label="Courier"
            value={courierFilter}
            defaultValue="all"
            title="Filter orders by courier"
            options={[
              { value: 'all', label: 'All' },
              ...COURIER_TYPES.map((c) => ({ value: c, label: COURIER_LABELS[c] })),
            ]}
            onChange={(v) => {
              setPage(1);
              setSelected(new Set());
              setCourierFilter(v as CourierType | 'all');
            }}
          />
          {stores.length > 1 && (
            <FilterChip
              icon={Store}
              label="Store"
              value={String(storeFilter)}
              defaultValue="all"
              title="Filter orders by store"
              options={[
                { value: 'all', label: 'All' },
                ...stores.map((st) => ({
                  value: String(st.id),
                  label: `${st.label}${st.isPrimary ? ' (default)' : ''}`,
                })),
              ]}
              onChange={(v) => {
                setPage(1);
                setSelected(new Set());
                setStoreFilter(v === 'all' ? 'all' : Number(v));
              }}
            />
          )}
          <PeriodChip
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
          <FilterChip
            icon={ArrowDownUp}
            label="Sort"
            value={sort}
            defaultValue="oldest"
            title="Sort the queue"
            options={SORT_OPTIONS.map(([k, label]) => ({ value: k, label }))}
            onChange={(v) => {
              setPage(1);
              setSort(v as QueueSort);
            }}
          />
        </div>
        <span aria-hidden className="hidden h-6 w-px bg-line md:block" />
        <SavedViews
          current={viewState}
          activeId={activeViewId}
          onApply={applyView}
          onActiveChange={setActiveViewId}
        />
        <ShortcutsHint />
      </div>

      <div className="flex items-center justify-between gap-2 px-1">
        <p className="text-[13px] text-muted">
          <span className="font-bold text-ink">{total.toLocaleString()}</span>{' '}
          {status === 'unfulfilled' ? 'to book' : 'orders'}
          {laneForStatus(status) &&
            ` · ${LANES.find((l) => l.key === laneForStatus(status))!.hint}`}
        </p>
        <button
          type="button"
          onClick={() => {
            const next = !dense;
            setDense(next);
            persist('orders.queue.dense', next);
          }}
          title={dense ? 'Switch to comfortable rows' : 'Switch to compact rows'}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-muted hover:bg-sunken hover:text-ink"
        >
          <Rows3 size={14} /> {dense ? 'Compact' : 'Comfortable'}
        </button>
      </div>

      {/* ── Floating bulk bar: the selection's facts + the lane's main action.
          Risky actions (archive / cancel booking / cancel order) sit under More,
          each behind its existing confirmation. Lifted above the mobile tab bar. ── */}
      {selected.size > 0 && (
        <div
          role="region"
          aria-label="Bulk actions"
          className="fixed bottom-20 left-1/2 z-[55] flex w-[min(1040px,calc(100vw-1.5rem))] -translate-x-1/2 flex-wrap items-center gap-2 rounded-2xl bg-slate-900 px-3 py-2 text-white shadow-2xl ring-1 ring-white/10 md:bottom-5 md:pl-4"
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-sm font-extrabold">
              {selected.size.toLocaleString()} selected
            </span>
            {selectionSummary && (
              <span className="min-w-0 truncate text-[13px] text-slate-400">· {selectionSummary}</span>
            )}
            {allSelected && selected.size < total && (
              <button
                onClick={selectAllMatching}
                disabled={selectingAll}
                className="text-[13px] font-semibold text-green-300 underline-offset-2 hover:underline disabled:opacity-50"
              >
                {selectingAll ? 'Selecting…' : `Select all ${total.toLocaleString()} matching`}
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {status === 'archived' ? (
              <button
                onClick={() => bulkArchive(false)}
                disabled={bulkBusy}
                className={BULK_PRIMARY}
              >
                {bulkBusy ? <Loader2 size={14} className="animate-spin" /> : <ArchiveRestore size={14} />}
                Unarchive {selected.size}
              </button>
            ) : (
              <>
                {selectedBookableGids.length > 0 && (
                  <>
                    <select
                      value={bulkCourier}
                      onChange={(e) => setBulkCourier(e.target.value as CourierType | '')}
                      className="h-9 rounded-lg border border-white/15 bg-slate-800 px-2 text-[13px] font-semibold text-white"
                      title="Courier to book with"
                      aria-label="Courier to book with"
                    >
                      <option value="">Suggested per city</option>
                      {COURIER_TYPES.map((c) => (
                        <option key={c} value={c}>
                          {COURIER_LABELS[c]}
                        </option>
                      ))}
                    </select>
                    <button onClick={bulkBook} disabled={bulkBusy} className={BULK_PRIMARY}>
                      {bulkBusy ? <Loader2 size={14} className="animate-spin" /> : <Truck size={14} />}
                      Book {selectedBookableGids.length}
                    </button>
                  </>
                )}
                {isShipperAdviceView && selectedAdviceIds.length > 0 && (
                  <button
                    onClick={() => setBulkAdviceOpen(true)}
                    disabled={bulkAdviceBusy}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-amber-500 px-3 text-[13px] font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
                    title="Post one shipper-advice decision (re-attempt / return) to all selected parcels"
                  >
                    {bulkAdviceBusy ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                    Post advice {selectedAdviceIds.length}
                  </button>
                )}
                {isReceivableView && selectedReceivableIds.length > 0 && (
                  <button
                    onClick={() => setConfirmBulkReceive({ kind: 'selected', ids: selectedReceivableIds })}
                    disabled={bulkReceiveBusy}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-rose-500 px-3 text-[13px] font-semibold text-white hover:bg-rose-400 disabled:opacity-50"
                    title="Mark selected parcels received (RTO) — blacklist, cancel & archive"
                  >
                    {bulkReceiveBusy ? <Loader2 size={14} className="animate-spin" /> : <ArchiveRestore size={14} />}
                    Mark received {selectedReceivableIds.length}
                  </button>
                )}
              </>
            )}
            <RowMenu
              label="More bulk actions"
              trigger={
                <>
                  More <ChevronDown size={14} className="opacity-70" />
                </>
              }
              className="h-9 border-white/15 bg-white/5 px-3 text-[13px] font-semibold text-white hover:border-white/25 hover:bg-white/10 hover:text-white"
              items={[
                {
                  key: 'view',
                  label: rowView === 'selected' ? 'Show all rows' : 'Show only selected',
                  icon: ListChecks,
                  onSelect: () => {
                    setPage(1);
                    setRowView(rowView === 'selected' ? 'all' : 'selected');
                  },
                },
                ...(status !== 'archived'
                  ? [
                      {
                        key: 'archive',
                        label: `Archive ${selected.size}`,
                        icon: Archive,
                        onSelect: () => bulkArchive(true),
                        disabled: bulkBusy,
                        divider: true,
                      },
                      {
                        key: 'unbook',
                        label: `Cancel booking ${selected.size}…`,
                        icon: Ban,
                        onSelect: () => setConfirmBulkCancel('unbook'),
                        disabled: bulkCancelBusy,
                      },
                      {
                        key: 'cancel',
                        label: `Cancel order ${selected.size}…`,
                        icon: Trash2,
                        onSelect: () => setConfirmBulkCancel('cancel'),
                        disabled: bulkCancelBusy,
                        danger: true,
                      },
                    ]
                  : []),
              ]}
            />
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              aria-label="Clear selection"
              title="Clear selection"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Comma-separated bulk receive box (RTO views). */}
      {isReceivableView && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-rose-200 bg-rose-50/60 px-3 py-2">
          <Link
            href="/orders/fulfillment/receive"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white hover:bg-brand-700"
            title="Scan parcel AWB barcodes to mark them received (RTO)"
          >
            <ScanLine size={14} /> Scan returns
          </Link>
          <span className="text-xs font-semibold text-rose-800">Receive by order #</span>
          <input
            value={receiveInput}
            onChange={(e) => setReceiveInput(e.target.value)}
            placeholder="e.g. 30994, #30871, 30765"
            className="h-8 min-w-[220px] flex-1 rounded-lg border border-rose-200 bg-surface px-3 text-xs text-ink"
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
            className="rounded-lg border border-rose-300 bg-surface px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-40"
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
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <SkeletonRows rows={8} />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface">
          {search || boardFiltered ? (
            <NoResults
              query={search}
              noun="orders"
              hint={
                boardFiltered
                  ? 'Courier, store, period or sub-tab filters are on. Order #, phone (any format) and tracking are all searched.'
                  : 'Order #, phone (any format), tracking and customer name are all searched.'
              }
              onClear={clearBoardFilters}
            />
          ) : status === 'unfulfilled' ? (
            <EmptyState
              icon={CheckCircle2}
              title="Nothing waiting to be booked"
              description="New Shopify orders land here automatically. Use Sync → Import from Shopify to pull older open orders."
            />
          ) : (
            <EmptyState
              icon={Package}
              title="No orders here"
              description="Try another status above, or widen the date range."
            />
          )}
        </div>
      ) : (
        <>
        {/* ── Phone: one card per order, one big action. ── */}
        <div className="space-y-2 md:hidden">
          {rows.map((r) => {
            const picked = selected.has(r.orderGid);
            const courier = rowCourier[r.orderGid] ?? r.suggestedCourier ?? null;
            const conf = CONF_BADGE[r.confirmationStatus];
            const sh = r.shipment;
            const isCod = (r.totalOutstanding ?? 0) > 0;
            const exc = rowException(r);
            return (
              <div
                key={r.orderGid}
                onClick={(e) => {
                  if (isInteractiveTarget(e.target)) return;
                  setDrawerGid(r.orderGid);
                }}
                className={cn(
                  'rounded-2xl border bg-surface p-3 shadow-sm',
                  picked ? 'border-brand-300 bg-brand-50/60' : 'border-line',
                )}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={picked}
                    onChange={() => toggleOne(r.orderGid)}
                    aria-label={`Select ${r.orderName ?? 'order'}`}
                    className="h-4 w-4 shrink-0 cursor-pointer accent-brand-600"
                  />
                  <OrderNameButton
                    name={r.orderName}
                    gid={r.orderGid}
                    adminUrl={r.adminUrl}
                    className="text-[15px] font-extrabold text-ink"
                  />
                  <WaitChip
                    createdAt={r.createdAt}
                    live={laneForStatus(status) === 'tobook' || laneForStatus(status) === 'attention'}
                  />
                  <span className="flex-1" />
                  <span className="text-[15px] font-extrabold tabular-nums text-ink">
                    {qmoney(isCod ? r.totalOutstanding : r.totalPrice, r.currency)}
                  </span>
                </div>

                <div className="mt-1.5 pl-6">
                  <p className="truncate text-sm font-bold text-ink">{r.customerName ?? '—'}</p>
                  <p className="truncate text-xs text-muted">
                    {[r.city, r.phone].filter(Boolean).join(' · ') || '—'}
                    {r.itemsSummary ? ` · ${r.itemsSummary}` : ''}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <PayPill row={r} />
                    {sh ? (
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
                          STATUS_STYLES[sh.status] ?? 'bg-blue-50 text-blue-700',
                        )}
                      >
                        {STATUS_LABELS[sh.status] ?? sh.status}
                      </span>
                    ) : conf ? (
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold',
                          CONF_TONE[r.confirmationStatus],
                        )}
                      >
                        {conf.label}
                      </span>
                    ) : null}
                    {r.storeLabel && (
                      <StorePill storeId={r.storeId} label={r.storeLabel} size="xs" />
                    )}
                  </div>
                  {exc && (
                    <p
                      className={cn(
                        'mt-1.5 rounded-lg px-2 py-1 text-xs font-medium',
                        exc.tone === 'amber' ? 'bg-amber-50 text-amber-800' : 'bg-rose-50 text-rose-700',
                      )}
                    >
                      {exc.text}
                    </p>
                  )}
                </div>

                <div className="mt-2.5 flex items-center gap-2">
                  {bookable(r) ? (
                    <button
                      onClick={() => book(r)}
                      disabled={bookingGid === r.orderGid || !!lockedByOther(r.orderGid)}
                      title={
                        lockedByOther(r.orderGid)
                          ? `Being booked by ${lockedByOther(r.orderGid)!.name || 'another agent'}`
                          : undefined
                      }
                      className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-brand-600 px-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                    >
                      {bookingGid === r.orderGid ? (
                        <Loader2 size={15} className="animate-spin" />
                      ) : lockedByOther(r.orderGid) ? (
                        <Lock size={15} />
                      ) : (
                        <Truck size={15} />
                      )}
                      {lockedByOther(r.orderGid)
                        ? `Being booked${lockedByOther(r.orderGid)!.name ? ` by ${lockedByOther(r.orderGid)!.name}` : '…'}`
                        : `Book${courier ? ` · ${COURIER_LABELS[courier]}` : ''}`}
                    </button>
                  ) : sh?.status === 'attempted' ? (
                    <button
                      onClick={() => setAdviceRow(r)}
                      disabled={actBusyGid === r.orderGid}
                      className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-amber-300 bg-amber-50 px-3 text-sm font-semibold text-amber-800 disabled:opacity-50"
                    >
                      <RotateCcw size={15} /> Post shipper advice
                    </button>
                  ) : sh?.status === 'failed' ? (
                    <button
                      onClick={() => setReceiveRow(r)}
                      disabled={actBusyGid === r.orderGid}
                      className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-rose-300 bg-rose-50 px-3 text-sm font-semibold text-rose-700 disabled:opacity-50"
                    >
                      <ArchiveRestore size={15} /> Mark received
                    </button>
                  ) : sh?.trackingNumber ? (
                    <button
                      onClick={() => setTrackRow(r)}
                      className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-line px-3 text-sm font-semibold text-ink hover:bg-sunken"
                    >
                      <ExternalLink size={14} /> Track {sh.trackingNumber}
                    </button>
                  ) : (
                    <span className="flex-1" />
                  )}
                  <RowMenu
                    items={rowMenuItems(r)}
                    label={`More actions for ${r.orderName ?? 'order'}`}
                    className="h-10 w-10 border-line"
                  />
                </div>
              </div>
            );
          })}
        </div>

        <div
          ref={tableScrollRef}
          className="hidden max-h-[calc(100dvh-16rem)] overflow-auto rounded-xl border border-line bg-surface shadow-sm md:block"
        >
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 z-[5] bg-sunken text-left text-xs font-bold uppercase tracking-wide text-muted shadow-[0_1px_0_rgb(var(--line))]">
              <tr>
                <th className="w-10 py-2.5 pl-4 pr-1">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    disabled={rows.length === 0}
                    title="Select all orders on this page"
                    aria-label="Select all orders on this page"
                    className="h-4 w-4 cursor-pointer accent-brand-600"
                  />
                </th>
                <th className="px-3 py-2.5">Order</th>
                <th className="px-3 py-2.5">Customer</th>
                <th className="px-3 py-2.5">Destination</th>
                <th className="hidden px-3 py-2.5 xl:table-cell">Items</th>
                <th className="px-3 py-2.5 text-right">Amount</th>
                <th className="px-3 py-2.5">Confirmation</th>
                <th className="px-3 py-2.5">Courier</th>
                <th className="sticky right-0 bg-sunken px-3 py-2.5 pr-4 text-right shadow-[-1px_0_0_rgb(var(--line))]">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const itemCount = r.items.reduce(
                  (n, it) => n + (it.quantity || 0),
                  0,
                );
                const sh = r.shipment;
                const picked = selected.has(r.orderGid);
                const exc = rowException(r);
                const cell = cn('px-3 align-top', dense ? 'py-1.5' : 'py-3');
                const rowBg = cn(
                  picked ? 'bg-brand-50/60' : 'group-hover:bg-sunken',
                  cursor === idx && 'bg-brand-50',
                );
                const lockedBy = lockedByOther(r.orderGid);
                return (
                  <Fragment key={r.orderGid}>
                  <tr
                    data-row-index={idx}
                    onClick={(e) => {
                      if (isInteractiveTarget(e.target)) return;
                      setCursor(idx);
                      setDrawerGid(r.orderGid);
                    }}
                    className={cn(
                      'group cursor-pointer [&>td]:transition-colors',
                      !exc && 'border-b border-line/70',
                    )}
                  >
                    <td
                      className={cn(
                        'w-10 pl-4 pr-1 align-top',
                        dense ? 'py-1.5' : 'py-3',
                        rowBg,
                        cursor === idx && 'shadow-[inset_3px_0_0_rgb(var(--brand-600))]',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={picked}
                        onChange={() => toggleOne(r.orderGid)}
                        aria-label={`Select ${r.orderName ?? 'order'}`}
                        className="mt-0.5 h-4 w-4 cursor-pointer accent-brand-600"
                      />
                    </td>
                    <td className={cn(cell, rowBg, 'whitespace-nowrap')}>
                      <OrderNameButton
                        name={r.orderName}
                        gid={r.orderGid}
                        adminUrl={r.adminUrl}
                        className="text-[14px] font-extrabold text-ink"
                      />
                      <div className="mt-1 flex items-center gap-1.5">
                        {r.storeLabel && (
                          <StorePill storeId={r.storeId} label={r.storeLabel} size="xs" />
                        )}
                        <WaitChip
                          createdAt={r.createdAt}
                          live={laneForStatus(status) === 'tobook' || laneForStatus(status) === 'attention'}
                        />
                      </div>
                      {r.courierInvoiceNumber && (
                        <div className="mt-0.5 text-xs text-muted">Inv #{r.courierInvoiceNumber}</div>
                      )}
                    </td>
                    <td className={cn(cell, rowBg)}>
                      <div className="font-bold text-ink">
                        <CustomerPopover
                          name={r.customerName}
                          phone={r.phone}
                          email={r.email}
                          city={r.city}
                          address={r.address}
                          ordersCount={r.customerOrdersCount}
                        />
                      </div>
                      {r.phone && (
                        <span className="mt-0.5 block font-mono text-xs text-muted">{r.phone}</span>
                      )}
                    </td>
                    <td className={cn(cell, rowBg)}>
                      <span className="font-semibold text-ink">{r.city || '—'}</span>
                      {r.address && (
                        // Two lines is enough to verify the delivery location at a
                        // glance; the full address is in the tooltip and the drawer.
                        <span
                          title={r.address}
                          className="mt-0.5 line-clamp-2 max-w-[220px] whitespace-normal break-words text-xs leading-snug text-muted"
                        >
                          {r.address}
                        </span>
                      )}
                    </td>
                    <td className={cn(cell, rowBg, 'hidden text-muted xl:table-cell')}>
                      <ItemsPopover
                        items={r.items}
                        count={itemCount}
                        fulfillmentStatus={r.fulfillmentStatus}
                      />
                    </td>
                    <td className={cn(cell, rowBg, 'whitespace-nowrap text-right')}>
                      <span className="font-extrabold tabular-nums text-ink">
                        {qmoney(
                          (r.totalOutstanding ?? 0) > 0 ? r.totalOutstanding : r.totalPrice,
                          r.currency,
                        )}
                      </span>
                      <span className="mt-1 flex justify-end">
                        <PayPill row={r} />
                      </span>
                      <span className="mt-0.5 block text-xs text-muted xl:hidden">
                        {itemCount} item{itemCount === 1 ? '' : 's'}
                      </span>
                    </td>
                    <td className={cn(cell, rowBg)}>
                      {CONF_BADGE[r.confirmationStatus] &&
                        (() => {
                          // Address-issue parcels always get the confirmation
                          // actions (even once confirmed): an agent calling the
                          // customer to fix the address who gets no answer needs
                          // "No response" here without opening the order.
                          const hasActions =
                            !r.archived &&
                            r.fulfillmentStatus === 'unfulfilled' &&
                            (r.confirmationStatus !== 'confirmed' ||
                              r.shipment?.status === 'address_issue');
                          const open = confMenu?.gid === r.orderGid;
                          const item =
                            'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-semibold hover:bg-sunken disabled:opacity-50';
                          return (
                            <div
                              className={cn(
                                'inline-flex items-stretch overflow-hidden rounded-lg border text-xs font-bold',
                                CONF_TONE[r.confirmationStatus],
                              )}
                            >
                              <span className="inline-flex items-center gap-1 whitespace-nowrap px-2 py-1">
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
                                              x: Math.min(rc.left - 80, window.innerWidth - 232),
                                              y: rc.bottom + 4,
                                            };
                                          })(),
                                    )
                                  }
                                  title="Confirmation actions"
                                  aria-label="Confirmation actions"
                                  aria-expanded={open}
                                  className="border-l border-black/10 px-1 hover:bg-black/5"
                                >
                                  <ChevronDown
                                    size={13}
                                    className={cn('transition-transform', open && 'rotate-180')}
                                  />
                                </button>
                              )}
                              {hasActions && open && confMenu && (
                                <div
                                  data-conf-menu
                                  role="menu"
                                  style={{ left: Math.max(8, confMenu.x), top: confMenu.y }}
                                  className="fixed z-50 w-56 rounded-xl border border-line bg-surface p-1.5 text-ink shadow-lg"
                                >
                                  <button
                                    role="menuitem"
                                    onClick={() => {
                                      setConfMenu(null);
                                      confirmOrder(r);
                                    }}
                                    disabled={confirmingGid === r.orderGid}
                                    className={cn(item, 'text-brand-700')}
                                    title="Manually mark this order confirmed and apply the confirm tag in Shopify"
                                  >
                                    <Check size={15} />
                                    {confirmingGid === r.orderGid ? 'Marking…' : 'Mark confirmed'}
                                  </button>
                                  {r.confirmationStatus === 'undeliverable' ? (
                                    <button
                                      role="menuitem"
                                      onClick={() => {
                                        setConfMenu(null);
                                        setAltPhoneRow(r);
                                      }}
                                      className={item}
                                      title="This number has no WhatsApp — send the confirmation to a different number"
                                    >
                                      <Send size={15} /> Send to another number
                                    </button>
                                  ) : (
                                    <button
                                      role="menuitem"
                                      onClick={() => {
                                        setConfMenu(null);
                                        resendConfirm(r);
                                      }}
                                      disabled={resendGid === r.orderGid}
                                      className={item}
                                      title="Resend the confirmation template to the customer"
                                    >
                                      <Send size={15} />
                                      {resendGid === r.orderGid ? 'Sending…' : 'Resend confirmation'}
                                    </button>
                                  )}
                                  <button
                                    role="menuitem"
                                    onClick={() => {
                                      setConfMenu(null);
                                      logCallOrder(r);
                                    }}
                                    disabled={logCallGid === r.orderGid}
                                    className={item}
                                    title="Log that you called/contacted this customer — counts in the Agent Performance report"
                                  >
                                    <Phone size={15} />
                                    {logCallGid === r.orderGid ? 'Logging…' : 'Log call'}
                                  </button>
                                  {r.confirmationStatus !== 'no_response' && (
                                    <button
                                      role="menuitem"
                                      onClick={() => {
                                        setConfMenu(null);
                                        noResponseOrder(r);
                                      }}
                                      disabled={noRespGid === r.orderGid}
                                      className={cn(item, 'text-amber-700')}
                                      title="Called the customer, no answer — tag ❌ NO RESPONSE in Shopify + mark it here"
                                    >
                                      <PhoneOff size={15} />
                                      {noRespGid === r.orderGid ? 'Marking…' : 'No response'}
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })()}
                    </td>
                    <td className={cn(cell, rowBg)}>
                      {sh && sh.status !== 'address_issue' ? (
                        // Booked → the ACTUAL courier + its tracking number (an
                        // address-issue parcel isn't booked yet — it falls
                        // through to the courier select, like an unbooked row).
                        <div className="flex flex-col gap-0.5">
                          <span className="inline-flex w-fit items-center gap-1 text-[13px] font-semibold text-ink">
                            <Truck size={13} className="text-muted" />
                            {COURIER_LABELS[sh.courierType]}
                          </span>
                          {sh.trackingNumber &&
                            (sh.trackingUrl ? (
                              <button
                                onClick={() => setTrackRow(r)}
                                className="inline-flex w-fit items-center gap-1 font-mono text-xs text-sky-700 hover:underline"
                                title="View this parcel on the courier's portal"
                              >
                                {sh.trackingNumber}
                                <ExternalLink size={10} />
                              </button>
                            ) : (
                              <span className="font-mono text-xs text-muted">{sh.trackingNumber}</span>
                            ))}
                        </div>
                      ) : r.archived || r.fulfillmentStatus !== 'unfulfilled' ? (
                        !r.archived && r.suggestedCourier ? (
                          <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-ink">
                            <Truck size={13} className="text-muted" />
                            {COURIER_LABELS[r.suggestedCourier]}
                          </span>
                        ) : (
                          <span className="text-xs text-muted">—</span>
                        )
                      ) : r.availableCouriers.length > 0 ? (
                        <select
                          value={
                            rowCourier[r.orderGid] ??
                            r.shipment?.courierType ??
                            r.suggestedCourier ??
                            ''
                          }
                          onChange={(e) =>
                            setRowCourier((prev) => ({
                              ...prev,
                              [r.orderGid]: e.target.value as CourierType,
                            }))
                          }
                          className="h-8 rounded-lg border border-line bg-surface px-2 text-[13px] font-semibold text-ink hover:bg-sunken"
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
                          className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800"
                          title="No courier serves this city yet — add a city mapping in Settings → Courier"
                        >
                          <MapPin size={12} /> No courier for city
                        </span>
                      )}
                    </td>
                    <td className={cn(cell, 'sticky right-0 bg-surface shadow-[-1px_0_0_rgb(var(--line))]', rowBg, 'whitespace-nowrap pr-4 text-right')}>
                      <div className="flex items-center justify-end gap-1.5">
                        {r.archived ? (
                          <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-600">
                            Archived
                          </span>
                        ) : sh ? (
                          <>
                            <span
                              className={cn(
                                'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold',
                                STATUS_STYLES[sh.status] ?? 'bg-blue-50 text-blue-700',
                              )}
                            >
                              {STATUS_LABELS[sh.status] ?? sh.status}
                            </span>
                            {sh.status === 'address_issue' && (
                              <button
                                disabled={
                                  actBusyGid === r.orderGid ||
                                  !(rowCourier[r.orderGid] ?? sh.courierType ?? r.suggestedCourier)
                                }
                                onClick={() =>
                                  shipmentAct(
                                    r,
                                    () =>
                                      resolveAddressIssue(
                                        sh.id,
                                        rowCourier[r.orderGid] ??
                                          sh.courierType ??
                                          r.suggestedCourier ??
                                          undefined,
                                      ),
                                    'Booking…',
                                  )
                                }
                                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                                title="Book this order with the selected courier"
                              >
                                {actBusyGid === r.orderGid ? (
                                  <Loader2 size={14} className="animate-spin" />
                                ) : (
                                  <Truck size={14} />
                                )}
                                Book
                              </button>
                            )}
                            {sh.status === 'attempted' && (
                              <button
                                disabled={actBusyGid === r.orderGid}
                                onClick={() => setAdviceRow(r)}
                                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                                title="Tell the courier to re-attempt or return this parcel"
                              >
                                Advice
                              </button>
                            )}
                            {sh.status === 'failed' && (
                              <button
                                disabled={actBusyGid === r.orderGid}
                                onClick={() => setReceiveRow(r)}
                                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-rose-300 bg-rose-50 px-3 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                                title="Parcel returned & received back — blacklist customer, cancel & archive"
                              >
                                Mark received
                              </button>
                            )}
                          </>
                        ) : r.fulfillmentStatus !== 'unfulfilled' ? (
                          <span className="inline-flex items-center rounded-full bg-green-50 px-2.5 py-1 text-xs font-semibold capitalize text-green-700">
                            {r.fulfillmentStatus ?? 'fulfilled'}
                          </span>
                        ) : (
                          <button
                            onClick={() => book(r)}
                            disabled={bookingGid === r.orderGid || !r.suggestedCourier || !!lockedBy}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                            title={
                              lockedBy
                                ? `Being booked by ${lockedBy.name || 'another agent'}`
                                : (rowCourier[r.orderGid] ?? r.suggestedCourier)
                                  ? `Book with ${COURIER_LABELS[rowCourier[r.orderGid] ?? r.suggestedCourier!]}`
                                  : 'No courier configured for this city'
                            }
                          >
                            {bookingGid === r.orderGid ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : lockedBy ? (
                              <Lock size={14} />
                            ) : (
                              <Truck size={14} />
                            )}
                            {lockedBy
                              ? lockedBy.name
                                ? `Booking (${lockedBy.name})`
                                : 'Booking…'
                              : 'Book'}
                          </button>
                        )}
                        <RowMenu
                          items={rowMenuItems(r)}
                          label={`More actions for ${r.orderName ?? 'order'}`}
                        />
                      </div>
                    </td>
                  </tr>
                  {exc && (
                    <tr className="border-b border-line/70">
                      <td colSpan={9} className={cn('pb-3 pl-14 pr-4 pt-0', picked && 'bg-brand-50/60')}>
                        <div
                          className={cn(
                            'flex flex-wrap items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px]',
                            exc.tone === 'amber'
                              ? 'border-amber-200 bg-amber-50 text-amber-800'
                              : 'border-rose-200 bg-rose-50 text-rose-700',
                          )}
                        >
                          <AlertTriangle size={14} className="shrink-0" />
                          <span className="min-w-0 flex-1">{exc.text}</span>
                          {exc.action && (
                            <button
                              onClick={exc.action.run}
                              disabled={actBusyGid === r.orderGid}
                              className="inline-flex h-7 items-center rounded-md border border-black/10 bg-surface px-2.5 text-xs font-bold hover:bg-white/70 disabled:opacity-50"
                            >
                              {exc.action.label}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}

      {rows.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-sm text-muted">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">Rows per page</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPage(1);
                setPageSize(e.target.value === 'all' ? 'all' : Number(e.target.value));
              }}
              className="rounded-lg border border-line px-2 py-1 text-sm"
            >
              {[25, 50, 100, 200].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
              <option value="all">All</option>
            </select>
            <span className="text-xs text-muted">
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
                className="rounded-lg border border-line px-2 py-1.5 text-xs disabled:opacity-40"
              >
                First
              </button>
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded-lg border border-line p-1.5 disabled:opacity-40"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="flex items-center gap-1">
                Page
                <select
                  value={page}
                  onChange={(e) => setPage(Number(e.target.value))}
                  className="rounded-lg border border-line px-2 py-1 text-sm"
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
                className="rounded-lg border border-line p-1.5 disabled:opacity-40"
              >
                <ChevronRight size={16} />
              </button>
              <button
                onClick={() => setPage(lastPage)}
                disabled={page >= lastPage}
                className="rounded-lg border border-line px-2 py-1.5 text-xs disabled:opacity-40"
              >
                Last
              </button>
            </div>
          )}
        </div>
      )}

      {selected.size > 0 && <div aria-hidden className="h-16" />}

      {drawerGid && (() => {
        const drawerRow = rows.find((r) => r.orderGid === drawerGid);
        return (
          <OrderDetailDrawer
            orderKey={{ gid: drawerGid }}
            onClose={closeDrawer}
            siblings={rows.map((r) => ({ gid: r.orderGid }))}
            onNavigate={(k) => k.gid && setDrawerGid(k.gid)}
            contextLabel={`Orders · ${status.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())}`}
            onBook={drawerRow && bookable(drawerRow) ? () => book(drawerRow) : undefined}
          />
        );
      })()}

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

      {createOpen && (
        <CreateOrderModal
          assignedAgentName={user?.name ?? null}
          onCreated={() => {
            // Pull the freshly-created order onto the board (also arrives via the
            // orders webhook shortly after).
            load({ silent: true, keepSelection: true });
            loadCounts();
            onChanged?.();
          }}
          onClose={() => setCreateOpen(false)}
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

      {bulkAdviceOpen && (
        <BulkShipperAdviceModal
          count={selectedAdviceIds.length}
          busy={bulkAdviceBusy}
          onClose={() => {
            if (!bulkAdviceBusy) setBulkAdviceOpen(false);
          }}
          onSubmit={runBulkShipperAdvice}
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
          <span className="font-mono text-xs text-muted">{ship.trackingNumber}</span>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-surface px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-sunken"
          >
            <ExternalLink size={12} /> Open on courier portal
          </a>
        </div>

        {loading ? (
          <div className="flex h-40 items-center justify-center text-muted">
            <Loader2 size={22} className="animate-spin" />
          </div>
        ) : checkpoints && checkpoints.length ? (
          // Courier APIs return oldest → newest; show newest first.
          <ol className="relative ml-1 space-y-4 border-l border-line pl-5">
            {[...checkpoints].reverse().map((c, i) => (
              <li key={i} className="relative">
                <span
                  className={cn(
                    'absolute -left-[23px] top-1 h-2.5 w-2.5 rounded-full',
                    i === 0 ? 'bg-brand-600 ring-2 ring-green-100' : 'bg-gray-300',
                  )}
                />
                <div className="text-sm font-medium text-ink">{c.status}</div>
                {c.detail && <div className="text-xs text-muted">{c.detail}</div>}
                {c.at && <div className="text-xs text-muted">{fmtDateTime(c.at)}</div>}
              </li>
            ))}
          </ol>
        ) : (
          <div className="rounded-lg border border-line bg-sunken p-4 text-sm text-gray-600">
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
      const res = await sendShipperAdvice(row.shipment.id, action, remarks.trim());
      const base =
        action === 'reattempt'
          ? 'Re-attempt requested with the courier'
          : 'Return requested with the courier';
      // Rocket files this as a complaint and returns a Complaint Id — surface it
      // so the operator can find the request in the courier portal (it won't
      // show on the shipment itself).
      toast.success(res.reference ? `${base} (Complaint #${res.reference})` : base);
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
        <p className="text-xs text-muted">
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
                  : 'border-line text-gray-600 hover:bg-sunken',
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
            className="w-full rounded-lg border border-line px-3 py-2 text-sm"
          />
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-gray-600 hover:bg-sunken"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50',
              action === 'return' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-brand-600 hover:bg-brand-700',
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
 * Bulk shipper advice — one decision (re-attempt / return) + shared remarks
 * posted to every selected flagged parcel. Unsupported couriers (M&P/manual)
 * are skipped server-side and reported back in the toast summary.
 */
function BulkShipperAdviceModal({
  count,
  busy,
  onClose,
  onSubmit,
}: {
  count: number;
  busy: boolean;
  onClose: () => void;
  onSubmit: (action: 'reattempt' | 'return', remarks: string) => void;
}) {
  const [action, setAction] = useState<'reattempt' | 'return'>('reattempt');
  const [remarks, setRemarks] = useState('');
  return (
    <Modal open onClose={onClose} title={`Shipper advice — ${count} parcel${count === 1 ? '' : 's'}`}>
      <div className="space-y-4">
        <p className="text-xs text-muted">
          Posts the same decision to all {count} selected parcel{count === 1 ? '' : 's'}. Parcels on
          couriers without a shipper-advice API (M&amp;P / manual) are skipped and reported.
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
                  : 'border-line text-gray-600 hover:bg-sunken',
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
                ? 'e.g. Customers confirmed address, please redeliver.'
                : 'e.g. Customers not responding, return the parcels.'
            }
            className="w-full rounded-lg border border-line px-3 py-2 text-sm"
          />
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-gray-600 hover:bg-sunken disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit(action, remarks)}
            disabled={busy}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50',
              action === 'return' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-brand-600 hover:bg-brand-700',
            )}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            Post to {count}
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
        <p className="text-xs text-muted">
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
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-sunken"
          >
            Cancel
          </button>
          <button
            onClick={send}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
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
    <div className="fixed bottom-20 md:bottom-4 right-4 z-[70] w-72 rounded-xl border border-line bg-surface shadow-lg">
      <button onClick={onOpen} className="block w-full px-3 pt-3 text-left">
        <div className="flex items-center justify-between text-xs font-medium text-gray-700">
          <span className="inline-flex items-center gap-1.5">
            {done ? (
              <CheckCircle2 size={14} className="text-green-600" />
            ) : (
              <Loader2 size={14} className="animate-spin text-muted" />
            )}
            {done ? 'Booking complete' : 'Booking parcels…'}
          </span>
          <span className="tabular-nums text-muted">
            {booked + failed}/{total}
          </span>
        </div>
      </button>
      <div className="px-3 pb-1 pt-2">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
          <div
            className={cn('h-full rounded-full transition-all', done ? 'bg-green-500' : 'bg-brand-600')}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <div className="flex items-center justify-between px-3 pb-2 text-xs text-muted">
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
            className="text-muted hover:text-gray-600"
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
            <span className="inline-flex items-center gap-1 text-muted">
              <Loader2 size={14} className="animate-spin" /> {pending} in progress
            </span>
          )}
          <span
            className="ml-auto inline-flex items-center gap-1 font-mono tabular-nums text-muted"
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
        <div className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {view.map((v) => (
            <div key={v.gid} className="flex items-start gap-2 px-3 py-2 text-sm">
              <span className="mt-0.5 shrink-0">
                {v.state === 'booked' ? (
                  <CheckCircle2 size={16} className="text-green-600" />
                ) : v.state === 'failed' ? (
                  <XCircle size={16} className="text-red-500" />
                ) : (
                  <Loader2 size={15} className="animate-spin text-muted" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-ink">
                    {v.name}
                  </span>
                  {v.courier && (
                    <span className="shrink-0 text-xs text-muted">
                      {COURIER_LABELS[v.courier]}
                    </span>
                  )}
                </div>
                {v.state === 'failed' && v.error && (
                  <p className="mt-0.5 text-xs text-red-500">{v.error}</p>
                )}
                {v.state === 'booked' && v.tracking && (
                  <p className="mt-0.5 text-xs text-muted">
                    Tracking {v.tracking}
                  </p>
                )}
                {v.state === 'pending' && (
                  <p className="mt-0.5 text-xs text-muted">
                    {v.hasRow ? 'Booking…' : 'Queued…'}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-xs text-muted">
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
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-sunken disabled:opacity-50"
              >
                {retrying ? 'Retrying…' : `Retry ${failed.length} failed`}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
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
            <span className="inline-flex items-center gap-1 text-muted">
              <Ban size={14} /> {p.skipped} skipped
            </span>
          )}
          {p.failed > 0 && (
            <span className="inline-flex items-center gap-1 text-red-600">
              <XCircle size={15} /> {p.failed} failed
            </span>
          )}
          <span className="ml-auto font-mono tabular-nums text-muted">
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
                : 'border border-gray-300 text-gray-700 hover:bg-sunken',
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
      <label className="mb-1 block text-xs text-muted">{label}</label>
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
    // Physically-returned rate (received back ÷ total handed over) — a subset of
    // all failures, so it runs lower than the fail rate.
    if (v <= 0.05) return { text: 'text-green-700', bar: 'bg-green-600' };
    if (v <= 0.12) return { text: 'text-amber-700', bar: 'bg-amber-500' };
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
  // Scorecard cell drill-down (received / in-return / delivered parcels).
  const [drill, setDrill] = useState<{
    courierType: string;
    courierName: string;
    bucket: CourierPerfBucket;
  } | null>(null);
  const fromIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

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

  const failRate = (c: CourierPerfRow) => c.failRate;

  return (
    <div className="space-y-5">
      {drill && (
        <CourierParcelsModal
          courierType={drill.courierType}
          courierName={drill.courierName}
          bucket={drill.bucket}
          from={fromIso}
          onClose={() => setDrill(null)}
          toast={toast}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-600">
          Delivery performance by courier — orders placed in the window, from
          courier tracking (covers every order).
        </p>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-line bg-surface">
            {PERF_RANGES.map(([label, d]) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={cn(
                  'px-3 py-1 text-xs',
                  days === d ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-sunken',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-gray-600 hover:bg-sunken disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : !data || withData.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface p-10 text-center text-sm text-muted">
          No delivery data in this window yet. It builds up as couriers send
          tracking updates for your parcels.
        </div>
      ) : (
        <>
          {/* ── Ranked scorecard ─────────────────────────────────────── */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Courier scorecard — ranked by delivery rate
            </p>
            <div className="overflow-hidden rounded-xl border border-line bg-surface">
              {/* desktop header */}
              <div className="hidden grid-cols-[190px_1fr] border-b border-line bg-sunken text-[10.5px] font-semibold uppercase tracking-wide text-muted sm:grid">
                <span className="px-4 py-2.5">Courier</span>
                <div className="grid grid-cols-3">
                  <span className="border-l border-line px-3 py-2.5">Delivery rate</span>
                  <span className="border-l border-line px-3 py-2.5">Speed</span>
                  <span className="border-l border-line px-3 py-2.5">Fail / RTO rate</span>
                </div>
              </div>
              {ranked.map((c, i) => {
                const isBestOverall = i === 0 && withData.length > 1;
                const fr = failRate(c);
                const dTone = perfTone('delivery', c.deliveryRate);
                const fTone = perfTone('fail', fr);
                const sTone = perfTone('speed', c.avgLeadDays);
                const isFastest =
                  c.avgLeadDays != null && Math.abs(c.avgLeadDays - bestSpeed) < 0.05;
                const isBestDeliv =
                  c.deliveryRate != null && Math.abs(c.deliveryRate - bestDelivery) < 0.005;
                return (
                  <div
                    key={c.courier}
                    className="grid grid-cols-1 border-b border-line last:border-b-0 sm:grid-cols-[190px_1fr]"
                  >
                    <div className="flex items-center gap-2.5 border-b border-line px-4 py-3 sm:border-b-0 sm:border-r">
                      <span className="w-4 shrink-0 text-center font-bold text-muted">
                        {i + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-ink">
                          {c.courier}
                        </span>
                        <span className="block text-xs text-muted">
                          {c.total.toLocaleString()} orders
                        </span>
                      </span>
                      {isBestOverall && (
                        <span className="ml-auto rounded-full bg-green-50 px-2 py-0.5 text-xs font-bold text-green-700">
                          Best overall
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-3">
                      <ScoreCell
                        num={pct(c.deliveryRate)}
                        tone={dTone}
                        width={(c.deliveryRate ?? 0) * 100}
                        cap={`${c.delivered.toLocaleString()} delivered`}
                        best={isBestDeliv}
                        onCap={
                          c.delivered > 0
                            ? () =>
                                setDrill({
                                  courierType: c.courierType,
                                  courierName: c.courier,
                                  bucket: 'delivered',
                                })
                            : undefined
                        }
                      />
                      <ScoreCell
                        num={c.avgLeadDays == null ? '—' : `${c.avgLeadDays.toFixed(1)}d`}
                        tone={sTone}
                        width={c.avgLeadDays == null ? 0 : (1 - (c.avgLeadDays - 2) / (maxLead - 1)) * 100}
                        cap={isFastest ? 'fastest' : 'order → delivery'}
                        best={isFastest}
                      />
                      <FailCell
                        rate={fr}
                        tone={fTone}
                        failed={c.failed}
                        received={c.returnedReceived}
                        onDrill={(bucket) =>
                          setDrill({
                            courierType: c.courierType,
                            courierName: c.courier,
                            bucket,
                          })
                        }
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-1.5 text-xs text-muted">
              Rates are over resolved parcels (delivered + failed); in-progress
              excluded. Fail / RTO = every parcel that didn&rsquo;t deliver; its
              bar is split into the portion physically received back (solid —
              counted even once cancelled &amp; archived) and the portion still
              in return (faded). Speed = average order-to-delivery.
            </p>
          </div>

          {/* ── Routing opportunities ────────────────────────────────── */}
          {opportunities.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                Routing opportunities — where a better courier is available
              </p>
              <div className="space-y-2">
                {opportunities.map((o) => {
                  const hot = o.gap >= 0.08;
                  return (
                    <div
                      key={o.city}
                      className={cn(
                        'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-surface px-4 py-3',
                        hot ? 'border-l-[3px] border-l-rose-500' : 'border-l-[3px] border-l-amber-500',
                      )}
                    >
                      <span className="min-w-[100px] font-semibold text-ink">
                        {o.city}
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="inline-flex items-center rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-semibold text-rose-700">
                          {o.fromCourier} {pct(o.fromRate)}
                        </span>
                        <span className="text-muted">→</span>
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
              <p className="mt-1.5 text-xs text-muted">
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
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Best courier by city
                </p>
                <div className="relative w-full sm:w-64">
                  <Search
                    size={14}
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
                  />
                  <input
                    value={cityQuery}
                    onChange={(e) => setCityQuery(e.target.value)}
                    placeholder="Search any city…"
                    className="w-full rounded-lg border border-line py-1.5 pl-8 pr-3 text-xs focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
                  />
                </div>
              </div>

              {/* Phone: city cards. */}
              <div className="space-y-2 sm:hidden">
                {visibleCities.length === 0 ? (
                  <p className="rounded-xl border border-line bg-surface p-6 text-center text-xs text-muted">
                    No city matches &ldquo;{cityQuery.trim()}&rdquo; in this window.
                  </p>
                ) : (
                  visibleCities.map((city) => (
                    <div key={city.city} className="rounded-xl border border-line bg-surface p-3">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-ink">{city.city}</span>
                        <span className="text-xs text-muted">
                          {city.total.toLocaleString()} shipments
                        </span>
                      </div>
                      <CityCourierChips city={city} />
                    </div>
                  ))
                )}
              </div>

              {/* Desktop: city table. */}
              <div className="hidden overflow-hidden rounded-xl border border-line bg-surface sm:block">
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-sunken text-left text-xs text-muted">
                      <tr>
                        <th className="px-4 py-2 font-medium">City</th>
                        <th className="px-4 py-2 text-right font-medium">Shipments</th>
                        <th className="px-4 py-2 font-medium">By courier (delivery rate)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {visibleCities.length === 0 && (
                        <tr>
                          <td colSpan={3} className="px-4 py-8 text-center text-xs text-muted">
                            No city matches &ldquo;{cityQuery.trim()}&rdquo; in this window.
                          </td>
                        </tr>
                      )}
                      {visibleCities.map((city) => (
                        <tr key={city.city} className="hover:bg-sunken">
                          <td className="px-4 py-2 font-medium text-ink">
                            {city.city}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-muted">
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
                <p className="mt-1.5 text-xs text-muted">
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
const PERF_BUCKET_LABEL: Record<CourierPerfBucket, string> = {
  received: 'Received back',
  in_return: 'In return',
  delivered: 'Delivered',
};

// Drill-down list behind a courier scorecard cell: the actual parcels in the
// clicked bucket (received / in-return / delivered) for one courier.
function CourierParcelsModal({
  courierType,
  courierName,
  bucket,
  from,
  onClose,
  toast,
}: {
  courierType: string;
  courierName: string;
  bucket: CourierPerfBucket;
  from: string;
  onClose: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [rows, setRows] = useState<CourierPerfParcel[] | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number | 'all'>(50);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setPage(1);
    getCourierPerformanceParcels({ courier: courierType, bucket, from })
      .then((r) => !cancelled && setRows(r))
      .catch((e) => {
        if (!cancelled) {
          toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load parcels');
          setRows([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [courierType, bucket, from, toast]);

  const fmtAmt = (p: CourierPerfParcel) =>
    p.amount == null ? '—' : `${p.currency || 'PKR'} ${Math.round(p.amount).toLocaleString()}`;

  const total = rows?.length ?? 0;
  const lastPage = pageSize === 'all' ? 1 : Math.max(1, Math.ceil(total / pageSize));
  // All parcels are already loaded (the backend returns the full bucket in one
  // call, capped at 1000), so paging/export are pure client-side slicing.
  const pageRows =
    rows == null
      ? []
      : pageSize === 'all'
        ? rows
        : rows.slice((page - 1) * pageSize, page * pageSize);

  // Export EVERY loaded parcel (not just the visible page) to CSV.
  const exportRows = () => {
    if (!rows || !rows.length) return;
    const head =
      'Order,Tracking,Status,Customer,City,ReceivedAt,DeliveredAt,Amount,Currency\n';
    const body = rows
      .map((p) =>
        [
          p.orderName ?? '',
          p.tracking ?? '',
          p.status ?? '',
          p.customerName ?? '',
          p.city ?? '',
          p.receivedAt ? fmtDate(p.receivedAt) : '',
          p.deliveredAt ? fmtDate(p.deliveredAt) : '',
          p.amount ?? '',
          p.currency ?? '',
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
    a.download = `${courierType}-${bucket}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`${courierName} · ${PERF_BUCKET_LABEL[bucket]}`}
    >
      <div className="overflow-auto">
        {rows == null ? (
          <div className="flex items-center justify-center py-12 text-muted">
            <Loader2 className="animate-spin" size={20} />
          </div>
        ) : rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted">No parcels in this bucket.</p>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted">{total.toLocaleString()} parcels</p>
              <button
                onClick={exportRows}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-300 bg-surface px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-sunken"
              >
                <Download size={14} /> Export CSV
              </button>
            </div>
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-surface text-[10.5px] uppercase tracking-wide text-muted">
                <tr className="border-b border-line">
                  <th className="py-2 pr-3 font-semibold">Order</th>
                  <th className="py-2 pr-3 font-semibold">Tracking</th>
                  <th className="py-2 pr-3 font-semibold">Customer</th>
                  <th className="py-2 pr-3 font-semibold">City</th>
                  <th className="py-2 pr-0 text-right font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((p, idx) => (
                  <tr key={`${p.orderName}-${idx}`} className="border-b border-gray-50 align-top">
                    <td className="py-2 pr-3">
                      <Link
                        href={`/orders/${encodeURIComponent(p.orderName.replace(/^#/, ''))}`}
                        className="font-medium text-blue-600 hover:underline"
                      >
                        {p.orderName || '—'}
                      </Link>
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-gray-600">{p.tracking || '—'}</td>
                    <td className="py-2 pr-3 text-gray-700">{p.customerName || '—'}</td>
                    <td className="py-2 pr-3 text-gray-600">{p.city || '—'}</td>
                    <td className="py-2 pr-0 text-right tabular-nums text-gray-700">{fmtAmt(p)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-gray-600">
              <div className="flex items-center gap-2">
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPage(1);
                    setPageSize(e.target.value === 'all' ? 'all' : Number(e.target.value));
                  }}
                  className="rounded-lg border border-line px-2 py-1 text-sm"
                >
                  {[25, 50, 100, 200].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                  <option value="all">All</option>
                </select>
                <span className="text-xs text-muted">
                  {pageSize === 'all'
                    ? `${total.toLocaleString()} of ${total.toLocaleString()}`
                    : `${(total === 0 ? 0 : (page - 1) * pageSize + 1).toLocaleString()}–${Math.min(
                        page * pageSize,
                        total,
                      ).toLocaleString()} of ${total.toLocaleString()}`}
                </span>
              </div>
              {pageSize !== 'all' && total > pageSize && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="rounded-lg border border-line p-1.5 disabled:opacity-40"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <span className="text-xs">
                    Page {page} of {lastPage}
                  </span>
                  <button
                    onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
                    disabled={page >= lastPage}
                    className="rounded-lg border border-line p-1.5 disabled:opacity-40"
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function ScoreCell({
  num,
  tone,
  width,
  cap,
  best,
  onCap,
}: {
  num: string;
  tone: { text: string; bar: string };
  width: number;
  cap: string;
  best?: boolean;
  /** When set, the caption becomes a button that opens the parcel drill-down. */
  onCap?: () => void;
}) {
  return (
    <div className="flex flex-col justify-center gap-1.5 border-l border-line px-3 py-3 first:border-l-0 sm:first:border-l">
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
      {onCap ? (
        <button
          type="button"
          onClick={onCap}
          className="self-start text-[10.5px] text-blue-600 underline decoration-dotted underline-offset-2 hover:text-blue-700"
        >
          {cap}
        </button>
      ) : (
        <span className="text-[10.5px] text-muted">{cap}</span>
      )}
    </div>
  );
}

// The Fail / RTO cell: a single failure rate whose bar is split into the
// physically-RETURNED slice (solid) and the still-out slice (faded), so
// "received back" reads as a part of failures rather than a rival metric.
function FailCell({
  rate,
  tone,
  failed,
  received,
  onDrill,
}: {
  rate: number | null;
  tone: { text: string; bar: string };
  failed: number;
  received: number;
  /** Opens the parcel drill-down for the clicked bucket. */
  onDrill?: (bucket: CourierPerfBucket) => void;
}) {
  const stillOut = Math.max(0, failed - received);
  // Total filled width represents the fail rate (same *4 visual scaling as
  // before); split proportionally between received and still-out.
  const filled = Math.min(100, (rate ?? 0) * 100 * 4);
  const recvW = failed > 0 ? filled * (received / failed) : 0;
  const outW = failed > 0 ? filled * (stillOut / failed) : 0;
  return (
    <div className="flex flex-col justify-center gap-1.5 border-l border-line px-3 py-3 first:border-l-0 sm:first:border-l">
      <span className={cn('text-base font-bold tabular-nums', tone.text)}>
        {pct(rate)}
      </span>
      <span className="flex h-1 overflow-hidden rounded-full bg-gray-100">
        {received > 0 && (
          <span
            className={cn('block h-full', tone.bar)}
            style={{ width: `${Math.max(2, recvW)}%` }}
            title={`${received} received back`}
          />
        )}
        {stillOut > 0 && (
          <span
            className={cn('block h-full opacity-40', tone.bar)}
            style={{ width: `${Math.max(2, outW)}%` }}
            title={`${stillOut} still in return`}
          />
        )}
      </span>
      <span className="text-[10.5px] text-muted">
        {failed.toLocaleString()} failed
        {failed > 0 && (
          <>
            {' — '}
            {received > 0 && onDrill ? (
              <button
                type="button"
                onClick={() => onDrill('received')}
                className="text-blue-600 underline decoration-dotted underline-offset-2 hover:text-blue-700"
              >
                {received.toLocaleString()} received
              </button>
            ) : (
              <span className="text-muted">{received.toLocaleString()} received</span>
            )}
            {', '}
            {stillOut > 0 && onDrill ? (
              <button
                type="button"
                onClick={() => onDrill('in_return')}
                className="text-blue-600 underline decoration-dotted underline-offset-2 hover:text-blue-700"
              >
                {stillOut.toLocaleString()} in return
              </button>
            ) : (
              `${stillOut.toLocaleString()} in return`
            )}
          </>
        )}
      </span>
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
