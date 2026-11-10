'use client';

/* Shared Courier-payments board — extracted from the Orders fulfillment page
   so BOTH the owner/admin Orders view and the finance role's /finance page
   render the identical board. A Next.js page.tsx may not carry extra named
   exports, which is why this lives in its own module. */

import { useCallback, useEffect, useRef, useState } from 'react';
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
} from 'lucide-react';
import Link from 'next/link';
import { EditItemsModal } from '@/components/orders/edit-items-modal';
import CreateOrderModal from '@/components/inbox/create-order-modal';
import OrderTrackingModal from '@/components/inbox/order-tracking-modal';
import type { ContactOrder } from '@/lib/contact-orders';
import { InvoiceImportPanel } from '@/components/orders/invoice-import-panel';
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
import { OrderNameButton } from '@/components/orders/order-detail-view';
import { ItemsPopover, CustomerPopover } from '@/components/orders/queue-popovers';
import { OrdersKpiStrip } from '@/components/orders/orders-kpi-strip';
import ScanToFind from '@/components/orders/scan-to-find';
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
import { periodRange, PeriodKey } from '@/lib/date-period';
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

// ── Local copies of three tiny page helpers the panels rely on (the
//    originals stay in the Orders page, which also uses them). ──
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

function qmoney(v: number | null, cur: string | null): string {
  if (v == null) return '—';
  return `${cur ? cur + ' ' : ''}${v.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}`;
}

function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

// ── Courier pending payments (COD receivable + reconciliation) ──

/**
 * The full Courier-payments board: COD receivable + Prepaid/gateway + statement
 * history + shortfalls + (optionally) invoice import, behind a sub-tab switcher.
 *
 * Shared by the Orders → Courier payments view (owner/admin) AND the finance
 * role's /finance page, so both surfaces behave identically. Owner/admin, and
 * the finance role, are the only roles that reach it (agents/fulfillment are
 * excluded upstream). Invoice-import is gated to its super-admin feature flag.
 */
export function CourierPaymentsBoard({
  toast,
}: {
  toast: ReturnType<typeof useToast>;
}) {
  const { user } = useAuth();
  const [payTab, setPayTab] = useState<
    'cod' | 'prepaid' | 'statements' | 'shortfalls' | 'invoice'
  >('cod');
  const canImport =
    ['owner', 'admin', 'finance'].includes(user?.role ?? '') &&
    !!user?.company?.invoiceImportEnabled;
  const PAY_TABS: Array<[typeof payTab, string]> = [
    ['cod', 'COD receivable'],
    ['prepaid', 'Prepaid & gateway'],
    ['statements', 'Statements'],
    ['shortfalls', 'Shortfalls'],
    ...(canImport
      ? ([['invoice', 'Invoice import']] as Array<[typeof payTab, string]>)
      : []),
  ];
  return (
    <div className="space-y-4">
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
      {payTab === 'invoice' && <InvoiceImportPanel />}
    </div>
  );
}

// Bank Deposit + Card Payments — prepaid (non-COD) orders. Bank Deposit is
// informational (money already in the bank); Card Payments needs the gateway
// payout reconciled. Both show a delivered vs with-courier split + totals.
function PrepaidPaymentsPanel({ toast }: { toast: ReturnType<typeof useToast> }) {
  const { user } = useAuth();
  // Deleting a settlement is owner/admin only on the backend — hide it from the
  // finance role (which otherwise has the full board) to avoid a dead 403 click.
  const canDelete = user?.role === 'owner' || user?.role === 'admin';
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

  const [pfDelTarget, setPfDelTarget] = useState<PayfastSettlement | null>(null);
  const [pfDelBusy, setPfDelBusy] = useState(false);
  const runPfDelete = async () => {
    if (!pfDelTarget) return;
    setPfDelBusy(true);
    try {
      const r = await deletePayfastSettlement(pfDelTarget.id);
      toast.success(
        r.unsettled > 0
          ? `Settlement deleted — ${r.unsettled} order${r.unsettled === 1 ? '' : 's'} un-reconciled`
          : 'Settlement deleted',
      );
      setPfDelTarget(null);
      loadPayfast();
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not delete the settlement');
    } finally {
      setPfDelBusy(false);
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
                        {canDelete && s.status !== 'applying' && (
                          <button
                            onClick={() => setPfDelTarget(s)}
                            title="Delete settlement"
                            className="inline-flex items-center font-medium text-gray-400 hover:text-rose-600"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!pfDelTarget}
        title="Delete this settlement?"
        message={
          pfDelTarget
            ? `The PayFast settlement for ${
                pfDelTarget.periodStart ? fmtDate(pfDelTarget.periodStart) : '?'
              } → ${
                pfDelTarget.periodEnd ? fmtDate(pfDelTarget.periodEnd) : '?'
              } and its reconciliation will be removed.${
                pfDelTarget.status === 'applied'
                  ? ' It was applied, so its orders are un-reconciled (their gateway payout goes back to unreconciled). Shopify paid-status is unchanged.'
                  : ''
              } This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        danger
        busy={pfDelBusy}
        onConfirm={runPfDelete}
        onCancel={() => setPfDelTarget(null)}
      />

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
        <PayfastStatementViewModal
          id={pfViewId}
          onClose={() => setPfViewId(null)}
          onApplied={() => {
            loadPayfast();
            load();
          }}
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
const STMT_ICON_BTN =
  'flex h-7 w-7 items-center justify-center rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50';
// Subtle per-courier badge tint for the statement cards.
const COURIER_ACCENT: Record<string, string> = {
  trax: 'bg-rose-50 text-rose-600',
  leopards: 'bg-cyan-50 text-cyan-700',
  postex: 'bg-violet-50 text-violet-700',
  rocket: 'bg-amber-50 text-amber-700',
  mnp: 'bg-slate-100 text-slate-600',
};
const monthLabel = (p?: string | null): string => {
  const m = /^(\d{4})-(\d{2})$/.exec(p ?? '');
  if (!m) return '';
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
};
const stmtRange = (rows: CourierInvoice[]): string => {
  const ds = rows
    .map((r) => new Date(r.reportDate || r.createdAt))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  if (!ds.length) return '';
  const mo = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' });
  const a = ds[0];
  const b = ds[ds.length - 1];
  return a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()
    ? `${mo(a)} ${b.getFullYear()}`
    : `${mo(a)} – ${mo(b)} ${b.getFullYear()}`;
};

function StatementsPanel({ toast }: { toast: ReturnType<typeof useToast> }) {
  const { user } = useAuth();
  // Deleting an applied statement is owner/admin only on the backend — hide the
  // button from finance (full board otherwise) so it's never a dead 403 click.
  const canDelete = user?.role === 'owner' || user?.role === 'admin';
  const [invoices, setInvoices] = useState<CourierInvoice[]>([]);
  const [summary, setSummary] = useState<PendingPaymentsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewId, setViewId] = useState<number | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [rollupCourier, setRollupCourier] = useState<CourierType | null>(null);
  const [rollupMonth, setRollupMonth] = useState('');
  const [rollupBusy, setRollupBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<CourierInvoice | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [erpBusy, setErpBusy] = useState<number | null>(null);
  const toggleErpPosted = async (iv: CourierInvoice, posted: boolean) => {
    setErpBusy(iv.id);
    try {
      await setCourierInvoiceErpPosted(iv.id, posted);
      setInvoices((prev) =>
        prev.map((x) =>
          x.id === iv.id ? { ...x, erpPostedAt: posted ? new Date().toISOString() : null } : x,
        ),
      );
      toast.success(posted ? 'Marked posted' : 'Posted mark removed');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not update');
    } finally {
      setErpBusy(null);
    }
  };
  const toggleExpand = (c: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });

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

  const runRollup = async () => {
    if (!rollupCourier || !rollupMonth) return;
    setRollupBusy(true);
    try {
      const r = await createMonthlyRollup(rollupCourier, rollupMonth);
      toast.success(
        `${COURIER_LABELS[rollupCourier]} ${rollupMonth} rolled up — net ${qmoney(
          r.netPayable ?? 0,
          r.currency ?? cur,
        )}`,
      );
      setRollupCourier(null);
      setRollupMonth('');
      load();
      setViewId(r.id);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not build the monthly statement');
    } finally {
      setRollupBusy(false);
    }
  };

  const runDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      const r = await deleteCourierInvoice(deleteTarget.id);
      toast.success(
        r.unsettled > 0
          ? `Statement deleted — ${r.unsettled} parcel${r.unsettled === 1 ? '' : 's'} back in Receivable`
          : 'Statement deleted',
      );
      setDeleteTarget(null);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not delete the statement');
    } finally {
      setDeleteBusy(false);
    }
  };

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
        groups.map((g) => {
          const rollups = g.rows.filter((r) => r.isRollup);
          const stmts = g.rows.filter((r) => !r.isRollup);
          const netPeriod = stmts.reduce((s, iv) => s + (iv.netPayable ?? 0), 0);
          const isOpen = expanded.has(g.courier);
          const shown = isOpen ? stmts : stmts.slice(0, 6);
          return (
            <div
              key={g.courier}
              className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm"
            >
              {/* Courier header */}
              <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-3.5">
                <span
                  className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold',
                    COURIER_ACCENT[g.courier] ?? 'bg-gray-100 text-gray-600',
                  )}
                >
                  {COURIER_LABELS[g.courier].slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <div className="text-base font-bold tracking-tight text-gray-900">
                    {COURIER_LABELS[g.courier]}
                  </div>
                  <div className="text-xs text-gray-400">
                    {stmts.length} statement{stmts.length === 1 ? '' : 's'}
                    {stmtRange(stmts) ? ` · ${stmtRange(stmts)}` : ''}
                    {g.outstanding > 0 && (
                      <>
                        {' · unreconciled '}
                        <span className="font-semibold tabular-nums text-green-700">
                          {qmoney(g.outstanding, cur)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div className="ml-auto flex items-center gap-3">
                  {stmts.length > 0 && (
                    <div className="text-right">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                        Net this period
                      </div>
                      <div className="font-mono text-lg font-extrabold tabular-nums text-green-700">
                        {qmoney(netPeriod, cur)}
                      </div>
                    </div>
                  )}
                  {stmts.length > 0 && (
                    <button
                      onClick={() => {
                        setRollupCourier(g.courier);
                        setRollupMonth('');
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                    >
                      <FileText size={14} className="text-violet-600" /> Monthly statement
                    </button>
                  )}
                </div>
              </div>

              {/* Rollups — elevated on top */}
              {rollups.map((iv) => (
                <div
                  key={iv.id}
                  className="flex items-center gap-3 border-b border-gray-100 bg-gradient-to-r from-violet-50 to-transparent px-4 py-3"
                >
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-violet-300 bg-white px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700">
                    ◆ Rollup
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-bold text-gray-900">
                      {monthLabel(iv.period) || iv.invoiceNumber}
                    </div>
                    <div className="text-xs text-gray-500">
                      {iv.sourceInvoiceIds?.length ?? 0} statements merged · {iv.totalRows} parcels
                    </div>
                  </div>
                  <div className="ml-auto shrink-0 font-mono text-base font-extrabold tabular-nums text-gray-900">
                    {qmoney(iv.netPayable ?? 0, iv.currency ?? cur)}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button onClick={() => setViewId(iv.id)} title="View" className={STMT_ICON_BTN}>
                      <Eye size={14} />
                    </button>
                    {iv.pdfUrl && (
                      <a
                        href={iv.pdfUrl}
                        target="_blank"
                        rel="noreferrer"
                        title="Download"
                        className={cn(STMT_ICON_BTN, 'border-transparent bg-gray-50 text-green-700')}
                      >
                        <Download size={14} />
                      </a>
                    )}
                    {canDelete && (
                      <button
                        onClick={() => setDeleteTarget(iv)}
                        title="Delete"
                        className={cn(STMT_ICON_BTN, 'text-gray-400 hover:bg-rose-50 hover:text-rose-600')}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))}

              {/* Statement rows */}
              {stmts.length === 0 && rollups.length === 0 ? (
                <p className="px-4 py-4 text-xs text-gray-500">
                  Nothing uploaded for this courier yet — everything above is unreconciled.
                </p>
              ) : (
                <div>
                  {shown.map((iv) => {
                    const pct = iv.totalRows ? Math.round((iv.paidRows / iv.totalRows) * 100) : 0;
                    const applied = iv.status === 'applied';
                    return (
                      <div
                        key={iv.id}
                        className="relative flex items-center gap-3 border-t border-gray-50 px-4 py-2.5 first:border-t-0 hover:bg-gray-50/60"
                      >
                        <span
                          className={cn(
                            'absolute left-1.5 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full',
                            applied
                              ? 'bg-green-500/50'
                              : iv.status === 'failed'
                                ? 'bg-rose-500'
                                : 'bg-amber-500',
                          )}
                        />
                        <div className="w-28 shrink-0 pl-2 sm:w-32">
                          <div className="text-[13px] font-semibold text-gray-800">
                            {fmtDate(iv.reportDate || iv.createdAt)}
                          </div>
                          <div className="truncate font-mono text-[11px] text-gray-400">
                            {iv.invoiceNumber ?? '—'}
                          </div>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="mb-1 text-xs text-gray-500">
                            <b className="text-gray-800">{iv.paidRows}</b>/{iv.totalRows} paid
                            {!applied && (
                              <span className="ml-1.5 capitalize text-amber-600">· {iv.status}</span>
                            )}
                          </div>
                          <div className="h-1.5 max-w-[180px] overflow-hidden rounded-full bg-gray-100">
                            <div className="h-full rounded-full bg-green-500" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                        <div className="w-28 shrink-0 text-right font-mono text-[13px] font-bold tabular-nums text-gray-900 sm:w-32">
                          {qmoney(iv.netPayable ?? 0, iv.currency ?? cur)}
                        </div>
                        <div className="flex w-[92px] shrink-0 items-center justify-end gap-1">
                          {iv.erpPostedAt ? (
                            <>
                              <span
                                title={`Posted to ERP${iv.erpPostedBy ? ` by ${iv.erpPostedBy}` : ''} · ${fmtDate(iv.erpPostedAt)}`}
                                className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-700"
                              >
                                Posted
                              </span>
                              <button
                                onClick={() => toggleErpPosted(iv, false)}
                                disabled={erpBusy === iv.id}
                                title="Undo — not posted"
                                className="text-gray-300 hover:text-rose-600 disabled:opacity-50"
                              >
                                <X size={13} />
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => toggleErpPosted(iv, true)}
                              disabled={erpBusy === iv.id}
                              title="Mark this statement posted in your ERP"
                              className="rounded-lg border border-gray-200 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                            >
                              Mark posted
                            </button>
                          )}
                        </div>
                        <div className="flex shrink-0 gap-1">
                          <button onClick={() => setViewId(iv.id)} title="View" className={STMT_ICON_BTN}>
                            <Eye size={14} />
                          </button>
                          {iv.pdfUrl ? (
                            <a
                              href={iv.pdfUrl}
                              target="_blank"
                              rel="noreferrer"
                              title="Download"
                              className={cn(STMT_ICON_BTN, 'border-transparent bg-gray-50 text-green-700')}
                            >
                              <Download size={14} />
                            </a>
                          ) : (
                            <span className="w-7" />
                          )}
                          {canDelete && (
                            <button
                              onClick={() => setDeleteTarget(iv)}
                              title="Delete"
                              className={cn(STMT_ICON_BTN, 'text-gray-400 hover:bg-rose-50 hover:text-rose-600')}
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {stmts.length > 6 && (
                    <button
                      onClick={() => toggleExpand(g.courier)}
                      className="w-full border-t border-gray-50 py-2 text-center text-xs font-medium text-gray-500 hover:bg-gray-50"
                    >
                      {isOpen ? 'Show less' : `+ ${stmts.length - 6} more statements`}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })
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
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete this statement?"
        message={
          deleteTarget
            ? `${COURIER_LABELS[deleteTarget.courierType]} ${
                deleteTarget.invoiceNumber ?? `#${deleteTarget.id}`
              } and its reconciliation will be removed.${
                deleteTarget.status === 'applied' && !deleteTarget.isRollup
                  ? ' It was applied, so its parcels are un-settled and their COD goes back to Receivable — deliveries stay as they are.'
                  : ''
              } This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        danger
        busy={deleteBusy}
        onConfirm={runDelete}
        onCancel={() => setDeleteTarget(null)}
      />
      {rollupCourier && (
        <Modal open onClose={() => setRollupCourier(null)} title="Monthly statement" size="md">
          <div className="space-y-4 p-5">
            <p className="text-sm text-gray-600">
              Combine all <b>{COURIER_LABELS[rollupCourier]}</b> statements from one
              month into a single consolidated statement (totals, every parcel, and
              one PDF). Your uploaded statements aren&apos;t changed.
            </p>
            <div>
              <label className="text-xs font-semibold text-gray-500">Month</label>
              <input
                type="month"
                value={rollupMonth}
                onChange={(e) => setRollupMonth(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRollupCourier(null)}
                className="px-3 py-2 text-sm text-gray-600 hover:text-gray-900"
              >
                Cancel
              </button>
              <button
                onClick={runRollup}
                disabled={!rollupMonth || rollupBusy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
              >
                {rollupBusy && <Loader2 size={15} className="animate-spin" />}
                {rollupBusy ? 'Building…' : 'Create rollup'}
              </button>
            </div>
          </div>
        </Modal>
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
const SHORTFALL_RES_LABEL: Record<ShortfallResolution, string> = {
  disputed: 'Disputed',
  recovered: 'Recovered',
  written_off: 'Written off',
};

function ShortfallsPanel({ toast }: { toast: ReturnType<typeof useToast> }) {
  const { user } = useAuth();
  const canManageShortfalls = ['owner', 'admin', 'finance'].includes(user?.role ?? '');
  const [data, setData] = useState<ShortfallsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const [resolveFor, setResolveFor] = useState<CourierShortfall | null>(null);
  const [resolveBusy, setResolveBusy] = useState(false);

  const load = useCallback(
    async (includeResolved = false) => {
      setLoading(true);
      try {
        setData(await getCourierShortfalls(includeResolved));
      } catch (e) {
        toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load shortfalls');
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  const toggleResolved = async () => {
    const next = !showResolved;
    setShowResolved(next);
    await load(next);
  };

  const submitResolve = async (resolution: ShortfallResolution, note: string) => {
    if (!resolveFor) return;
    setResolveBusy(true);
    try {
      await resolveShortfall({
        invoiceId: resolveFor.invoiceId,
        trackingNumber: resolveFor.trackingNumber,
        orderName: resolveFor.orderName,
        resolution,
        note: note.trim() || null,
      });
      toast.success('Shortfall cleared');
      setResolveFor(null);
      await load(showResolved);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to clear shortfall');
    } finally {
      setResolveBusy(false);
    }
  };

  const reopenShortfall = async (i: CourierShortfall) => {
    try {
      await resolveShortfall({
        invoiceId: i.invoiceId,
        trackingNumber: i.trackingNumber,
        orderName: i.orderName,
        resolution: null,
      });
      toast.success('Shortfall reopened');
      await load(showResolved);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to reopen');
    }
  };

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

  if (!data || (data.totals.count === 0 && data.items.length === 0)) {
    return (
      <div className="space-y-3">
        {canManageShortfalls && (
          <div className="flex justify-end">
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={showResolved}
                onChange={toggleResolved}
                className="h-3.5 w-3.5 rounded border-gray-300"
              />
              Show cleared
            </label>
          </div>
        )}
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
          No shortfalls found. Every applied statement paid the full COD on every
          matched parcel.
        </div>
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
        <div className="flex items-center gap-2">
          {canManageShortfalls && (
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={showResolved}
                onChange={toggleResolved}
                className="h-3.5 w-3.5 rounded border-gray-300"
              />
              Show cleared
            </label>
          )}
          <button
            onClick={exportCsv}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            title="Download the dispute list as CSV"
          >
            <Download size={14} /> Export dispute list
          </button>
        </div>
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
              {canManageShortfalls && <th className="px-4 py-3 text-right font-medium">Action</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.items.map((i, n) => (
              <tr key={`${i.invoiceId}-${i.trackingNumber ?? n}`} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">
                  {i.orderName ?? '—'}
                  {i.resolution && (
                    <span className="ml-1.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                      {SHORTFALL_RES_LABEL[i.resolution]}
                    </span>
                  )}
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
                <td
                  className={`px-4 py-3 text-right font-semibold tabular-nums ${
                    i.resolution ? 'text-gray-400 line-through' : 'text-rose-600'
                  }`}
                >
                  {qmoney(i.shortfall, i.currency ?? cur)}
                </td>
                {canManageShortfalls && (
                  <td className="px-4 py-3 text-right">
                    {i.resolution ? (
                      <button
                        onClick={() => reopenShortfall(i)}
                        className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                      >
                        Reopen
                      </button>
                    ) : (
                      <button
                        onClick={() => setResolveFor(i)}
                        className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                      >
                        Clear
                      </button>
                    )}
                  </td>
                )}
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
      {resolveFor && (
        <ShortfallResolveModal
          item={resolveFor}
          busy={resolveBusy}
          onCancel={() => setResolveFor(null)}
          onSubmit={submitResolve}
        />
      )}
    </div>
  );
}

/** Clear a short-paid line — disputed / recovered / written off (+ optional note). */
function ShortfallResolveModal({
  item,
  busy,
  onCancel,
  onSubmit,
}: {
  item: CourierShortfall;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (resolution: ShortfallResolution, note: string) => void;
}) {
  const [resolution, setResolution] = useState<ShortfallResolution>('disputed');
  const [note, setNote] = useState('');
  const OPTIONS: Array<{ key: ShortfallResolution; label: string; hint: string }> = [
    { key: 'disputed', label: 'Disputed', hint: 'Raised with the courier, chasing the balance' },
    { key: 'recovered', label: 'Recovered', hint: 'Courier paid the balance separately' },
    { key: 'written_off', label: 'Written off', hint: 'Accepted as a loss' },
  ];
  return (
    <Modal open onClose={onCancel} title="Clear shortfall">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          {item.orderName ?? item.trackingNumber ?? 'Parcel'} — short by{' '}
          <span className="font-semibold text-rose-600">
            {qmoney(item.shortfall, item.currency)}
          </span>
          . Clearing removes it from the standing list.
        </p>
        <div className="space-y-2">
          {OPTIONS.map((o) => (
            <label
              key={o.key}
              className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 ${
                resolution === o.key ? 'border-green-500 bg-green-50/40' : 'border-gray-200'
              }`}
            >
              <input
                type="radio"
                name="shortfall-res"
                checked={resolution === o.key}
                onChange={() => setResolution(o.key)}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-medium text-gray-800">{o.label}</span>
                <span className="block text-xs text-gray-500">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          rows={2}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit(resolution, note)}
            disabled={busy}
            className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {busy ? 'Clearing…' : 'Clear shortfall'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Hard safety cap on a full "All"/export pull so a huge courier can't hang the
// browser — mirrors the Orders table's ALL_ROWS_CAP. The backend caps a single
// page at 200, so we loop 200-row pages until we have everything (or hit CAP).
const PENDING_ALL_CAP = 20000;
async function fetchAllPendingPayments(
  courierType: CourierType,
  bucket: 'receivable' | 'transit',
  sort: 'oldest' | 'value',
): Promise<{ rows: PendingPaymentRow[]; total: number }> {
  const CHUNK = 200;
  const all: PendingPaymentRow[] = [];
  let page = 1;
  let total = 0;
  for (;;) {
    const res = await listPendingPayments({ courierType, bucket, page, pageSize: CHUNK, sort });
    total = res.total;
    all.push(...res.rows);
    if (all.length >= total || res.rows.length < CHUNK || all.length >= PENDING_ALL_CAP) break;
    page += 1;
  }
  return { rows: all, total };
}

function PendingPaymentsPanel({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [summary, setSummary] = useState<PendingPaymentsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [courier, setCourier] = useState<CourierType | null>(null);
  const [bucket, setBucket] = useState<'receivable' | 'transit'>('receivable');
  const [sort, setSort] = useState<'oldest' | 'value'>('oldest');
  const [rows, setRows] = useState<PendingPaymentRow[]>([]);
  // COD row whose courier tracking timeline is open (reuses the inbox modal).
  const [trackRow, setTrackRow] = useState<PendingPaymentRow | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number | 'all'>(50);
  const [listLoading, setListLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
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
      if (pageSize === 'all') {
        const res = await fetchAllPendingPayments(courier, bucket, sort);
        setRows(res.rows);
        setTotal(res.total);
      } else {
        const res = await listPendingPayments({
          courierType: courier,
          bucket,
          page,
          pageSize,
          sort,
        });
        setRows(res.rows);
        setTotal(res.total);
      }
      setSelected(new Set());
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load list');
    } finally {
      setListLoading(false);
    }
  }, [courier, bucket, page, pageSize, sort, toast]);

  useEffect(() => {
    if (courier) loadList();
  }, [courier, bucket, page, pageSize, sort, loadList]);

  const cur = summary?.currency ?? null;
  const lastPage = pageSize === 'all' ? 1 : Math.max(1, Math.ceil(total / pageSize));

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

  // Age chip: days since the anchor date (delivered = days owed; booked = days in
  // transit). Grey < 15d, amber 15–29d, red ≥ 30d so stale money/parcels stand out.
  const ageChip = (iso: string | null) => {
    if (!iso) return <span className="text-xs text-gray-400">—</span>;
    const days = Math.max(
      0,
      Math.floor((Date.now() - new Date(iso).getTime()) / 86400000),
    );
    const cls =
      days >= 30
        ? 'bg-red-100 text-red-700 font-medium'
        : days >= 15
          ? 'bg-amber-100 text-amber-700 font-medium'
          : 'bg-gray-100 text-gray-500';
    const label = days === 0 ? 'Today' : `${days} day${days === 1 ? '' : 's'}`;
    return (
      <span className={cn('inline-block rounded-full px-2 py-0.5 text-xs', cls)}>
        {label}
      </span>
    );
  };

  // Export the FULL list (every page, not just the loaded one) to CSV — hand to
  // the courier for reconciliation. Pulls all rows across pages up to the cap.
  const exportRows = async () => {
    if (!courier || total === 0 || exporting) return;
    setExporting(true);
    let allRows: PendingPaymentRow[];
    try {
      allRows =
        pageSize === 'all'
          ? rows
          : (await fetchAllPendingPayments(courier, bucket, sort)).rows;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to export');
      setExporting(false);
      return;
    }
    if (allRows.length >= PENDING_ALL_CAP && allRows.length < total) {
      toast.info(
        `Exporting the first ${PENDING_ALL_CAP.toLocaleString()} of ${total.toLocaleString()} rows — narrow the filters to export the rest.`,
      );
    }
    const ageOf = (iso: string | null) =>
      iso
        ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000))
        : '';
    const head = 'Order,Phone,Tracking,City,Delivered,Booked,AgeDays,Receivable\n';
    const body = allRows
      .map((r) =>
        [
          r.orderName ?? '',
          r.phone ?? '',
          r.tracking ?? '',
          r.city ?? '',
          r.deliveredAt ? fmtDate(r.deliveredAt) : '',
          r.bookedAt ? fmtDate(r.bookedAt) : '',
          ageOf(bucket === 'receivable' ? (r.deliveredAt ?? r.bookedAt) : r.bookedAt),
          r.receivable,
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
    a.download = `${courier}-${bucket}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setExporting(false);
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
    const cs = summary?.couriers.find((c) => c.courier === courier) ?? null;
    const footTotal =
      bucket === 'receivable' ? (cs?.receivable ?? 0) : (cs?.inTransitExpected ?? 0);
    const footCount =
      bucket === 'receivable' ? (cs?.receivableCount ?? total) : (cs?.inTransitCount ?? total);
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

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="max-w-md text-xs text-gray-500">
            {bucket === 'receivable'
              ? "Delivered parcels the courier owes you. Tick the ones they've remitted, or settle the whole courier at once."
              : 'Parcels still with the courier — expected COD once delivered. Nothing to reconcile yet.'}
          </p>
          <div className="flex items-center gap-2">
            {/* Sort: chase the longest-owed money, or the biggest tickets. */}
            <div className="flex overflow-hidden rounded-lg border border-gray-300 bg-white text-xs">
              {([
                ['oldest', 'Oldest first'],
                ['value', 'Highest value'],
              ] as Array<['oldest' | 'value', string]>).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => {
                    setPage(1);
                    setSort(k);
                  }}
                  className={cn(
                    'px-2.5 py-1.5',
                    sort === k
                      ? 'bg-gray-800 text-white'
                      : 'text-gray-600 hover:bg-gray-50',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              onClick={exportRows}
              disabled={total === 0 || exporting}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {exporting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Download size={14} />
              )}
              {exporting ? 'Exporting…' : 'Export CSV'}
            </button>
            {bucket === 'receivable' && (
              <button
                onClick={settleAll}
                disabled={busy}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                <Check size={14} /> Mark ALL paid
              </button>
            )}
          </div>
        </div>
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
                  <th className="px-4 py-3 font-medium">Tracking</th>
                  <th className="px-4 py-3 font-medium">City</th>
                  {bucket === 'receivable' ? (
                    <th className="px-4 py-3 font-medium">Delivered</th>
                  ) : (
                    <th className="px-4 py-3 font-medium">Status</th>
                  )}
                  <th className="px-4 py-3 font-medium">
                    {bucket === 'receivable' ? 'Owed' : 'In transit'}
                  </th>
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
                    <td className="px-4 py-2.5">
                      {r.tracking ? (
                        <span className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setTrackRow(r)}
                            title="Track this shipment"
                            className="inline-flex items-center gap-1 font-mono text-xs text-blue-700 hover:underline"
                          >
                            <Truck size={12} className="text-gray-400" />
                            {r.tracking}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard
                                ?.writeText(r.tracking as string)
                                .then(() => toast.success('Tracking copied'))
                                .catch(() => {});
                            }}
                            title="Copy tracking number"
                            className="text-gray-300 hover:text-gray-600"
                          >
                            <Copy size={12} />
                          </button>
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
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
                    <td className="px-4 py-2.5">
                      {ageChip(
                        bucket === 'receivable'
                          ? (r.deliveredAt ?? r.bookedAt)
                          : r.bookedAt,
                      )}
                    </td>
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
              <tfoot className="border-t border-gray-200 bg-gray-50">
                <tr>
                  <td
                    className="px-4 py-3 text-xs font-medium text-gray-600"
                    colSpan={bucket === 'receivable' ? 5 : 4}
                  >
                    {footCount.toLocaleString()}{' '}
                    {bucket === 'receivable' ? 'parcels outstanding' : 'parcels in transit'}
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-gray-400">Total</td>
                  <td className="px-4 py-3 text-right text-sm font-semibold text-gray-900">
                    {qmoney(footTotal, cur)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-gray-600">
          <div className="flex items-center gap-2">
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

        {/* Courier tracking timeline — reuses the inbox OrderTrackingModal. No
            onSend (no chat here), so it's a read-only tracking lookup. */}
        {trackRow && (
          <OrderTrackingModal
            order={
              {
                orderGid: '',
                orderName: trackRow.orderName,
                financialStatus: null,
                fulfillmentStatus: null,
                shipmentId: trackRow.shipmentId,
                shipmentStatus: trackRow.status,
                courierType: trackRow.courier,
                trackingNumber: trackRow.tracking,
                trackingUrl: null,
                total: null,
                outstanding: trackRow.receivable,
                currency: trackRow.currency,
                createdAt: null,
                itemsSummary: null,
                cancelled: false,
                archived: false,
              } satisfies ContactOrder
            }
            onClose={() => setTrackRow(null)}
          />
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

