'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  PackageCheck,
  Pencil,
  Phone,
  RefreshCw,
  Send,
  Truck,
  Wallet,
  X,
} from 'lucide-react';
import { cn, fmtDateTime } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { useSip } from '@/context/sip-context';
import { Dropdown, type DropdownItem } from '@/components/ui/dropdown';
import { Skeleton } from '@/components/ui/skeleton';
import {
  assignOrder,
  getOrderDetail,
  getOrderDetailLive,
  listAssignableUsers,
  type AssignableUser,
  type OrderDetail,
  type OrderKey,
  type OrderLiveDetail,
} from '@/lib/orders';
import {
  markOrderConfirmed,
  markOrderNoResponse,
  manualFulfill,
  markOrderPaid,
  resendConfirmation,
  revertAddressIssue,
  sendShipperAdvice,
} from '@/lib/couriers';
import { logOrderContact } from '@/lib/agents-report';
import { StorePill } from '@/components/store-pill';
import { EditOrderModal } from './edit-order-modal';
import { DrawerChatPanel } from './drawer-chat-panel';
import { CopyButton, timeAgo } from './drawer/shared';
import { OrderProgress } from './drawer/progress';
import { NextStepCallout, courierName, deriveNextStep, type NextActionId } from './drawer/next-step';
import { CustomerCard } from './drawer/customer-card';
import { ItemsCard, type DrawerItem, type OrderMoney } from './drawer/items-card';
import {
  ShipperAdviceForm,
  ShippingCard,
  canTrackShipment,
  useTrackingScans,
} from './drawer/shipping-card';
import { TagsTeamCard } from './drawer/tags-team-card';
import { PaymentsTab, shortGateway } from './drawer/payments-tab';
import { ActivityTab, buildActivity } from './drawer/activity-tab';

/** True while the user is typing — drawer hotkeys must never fire then. */
function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
  );
}

const keyOf = (k: OrderKey) => (k.gid ? `g:${k.gid}` : `n:${k.number ?? ''}`);

/* ── Slide-over drawer ──────────────────────────────────────────────────── */
export function OrderDetailDrawer({
  orderKey,
  onClose,
  readOnly = false,
  siblings,
  onNavigate,
  contextLabel,
  onBook,
}: {
  orderKey: OrderKey;
  onClose: () => void;
  /** View-only mode (finance): hides every mutating control and the chat path. */
  readOnly?: boolean;
  /** Orders in the list the drawer was opened from — enables ↑/↓ and J/K. */
  siblings?: OrderKey[];
  onNavigate?: (key: OrderKey) => void;
  /** Breadcrumb for the list ("To confirm"), shown with the position. */
  contextLabel?: string;
  /** Books this order with the board's suggested courier (board only; omit
   *  when the order isn't bookable). The drawer reloads once it settles. */
  onBook?: (key: OrderKey) => unknown;
}) {
  // When set, the drawer shows the conversation IN PLACE (no navigation away
  // from the orders board). Back returns to the order details.
  const [chat, setChat] = useState<{ id: number; title: string | null } | null>(null);

  const idx = useMemo(() => {
    if (!siblings?.length) return -1;
    const k = keyOf(orderKey);
    return siblings.findIndex((s) => keyOf(s) === k);
  }, [siblings, orderKey]);
  const canNav = !!onNavigate && idx >= 0 && !!siblings;
  const go = useCallback(
    (dir: 1 | -1) => {
      if (!canNav || !siblings) return;
      const next = siblings[idx + dir];
      if (next) {
        setChat(null);
        onNavigate!(next);
      }
    },
    [canNav, siblings, idx, onNavigate],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (chat) setChat(null);
        else onClose();
        return;
      }
      if (chat || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        if (!canNav) return;
        e.preventDefault();
        go(1);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        if (!canNav) return;
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose, chat, canNav, go]);

  // Portal to <body>: the drawer is often opened from inside a `truncate` /
  // nowrap chip or row, and CSS inheritance (white-space, text-align, case…)
  // would otherwise leak in and stop long text from wrapping.
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex justify-end whitespace-normal text-left font-normal normal-case tracking-normal"
      data-order-drawer
    >
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-xl flex-col bg-sunken shadow-2xl">
        {chat ? (
          <DrawerChatPanel conversationId={chat.id} title={chat.title} onBack={() => setChat(null)} />
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-4 py-2 text-xs text-muted">
              <span className="truncate">
                {contextLabel ?? 'Order'}
                {canNav && siblings ? (
                  <span className="tabular-nums"> · {idx + 1} of {siblings.length}</span>
                ) : null}
              </span>
              <div className="ml-auto flex items-center gap-1">
                {canNav && (
                  <>
                    <NavBtn label="Previous order (K)" disabled={idx <= 0} onClick={() => go(-1)}>
                      <ChevronUp size={16} />
                    </NavBtn>
                    <NavBtn
                      label="Next order (J)"
                      disabled={!siblings || idx >= siblings.length - 1}
                      onClick={() => go(1)}
                    >
                      <ChevronDown size={16} />
                    </NavBtn>
                  </>
                )}
                <NavBtn label="Close (Esc)" onClick={onClose}>
                  <X size={16} />
                </NavBtn>
              </div>
            </div>
            <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
              <OrderDetailContent
                key={keyOf(orderKey)}
                orderKey={orderKey}
                readOnly={readOnly}
                hotkeys
                onOpenChat={readOnly ? undefined : (id, title) => setChat({ id, title })}
                onBook={readOnly || !onBook ? undefined : () => onBook(orderKey)}
              />
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function NavBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid h-7 w-7 place-items-center rounded-lg border border-line bg-surface text-muted hover:bg-sunken hover:text-ink disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/* ── Drop-in clickable order number (self-contained drawer) ─────────────── */
/** Renders an order number that opens the CodesApp detail drawer, plus an
 *  optional secondary Shopify link. Manages its own open state, so it can be
 *  dropped into ANY order table with no parent wiring. */
export function OrderNameButton({
  name,
  gid,
  number,
  adminUrl,
  className,
}: {
  name: string | null;
  gid?: string | null;
  number?: string | null;
  adminUrl?: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const key: OrderKey | null = gid ? { gid } : number ? { number } : null;
  return (
    <span className="inline-flex items-center gap-1">
      {key ? (
        <button
          type="button"
          onClick={(e) => {
            // May be nested inside a clickable row/card (e.g. the chat's trackable
            // order card) — don't also trigger the parent's handler.
            e.stopPropagation();
            setOpen(true);
          }}
          className={cn('font-semibold text-indigo-600 hover:underline', className)}
          title="Open order in CodesApp"
        >
          {name || '—'}
        </button>
      ) : (
        <span className={className}>{name || '—'}</span>
      )}
      {adminUrl && (
        <a
          href={adminUrl}
          target="_blank"
          rel="noreferrer"
          className="text-gray-300 hover:text-green-600"
          title="View in Shopify"
        >
          <ExternalLink size={13} />
        </a>
      )}
      {open && key && <OrderDetailDrawer orderKey={key} onClose={() => setOpen(false)} />}
    </span>
  );
}

type Tab = 'overview' | 'payments' | 'activity';

/* ── Reusable content (drawer + /orders/[no] page) ──────────────────────── */
export function OrderDetailContent({
  orderKey,
  onOpenChat,
  readOnly = false,
  hotkeys = false,
  onBook,
}: {
  orderKey: OrderKey;
  /** When provided (drawer), "Open chat" opens the conversation in place via
   *  this callback instead of navigating to /inbox (full-page view omits it). */
  onOpenChat?: (conversationId: number, title: string | null) => void;
  /** View-only mode (the finance role): every mutating control is hidden —
   *  Open chat, Edit order, Confirmation actions, Log call, Assign, tags/note
   *  editing — leaving the read-only data plus Refresh / Tracking / Shopify. */
  readOnly?: boolean;
  /** Enable the drawer hotkey R (refresh). Off on the full page. */
  hotkeys?: boolean;
  /** Board-only: book this order with the suggested courier. */
  onBook?: () => unknown;
}) {
  const toast = useToast();
  const router = useRouter();
  const sip = useSip();
  const [d, setD] = useState<OrderDetail | null>(null);
  const [live, setLive] = useState<OrderLiveDetail | null>(null);
  const [liveAt, setLiveAt] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [team, setTeam] = useState<AssignableUser[]>([]);
  const [assigning, setAssigning] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState<NextActionId | 'logcontact' | null>(null);
  const [advice, setAdvice] = useState<'reattempt' | 'return' | null>(null);
  const [trackOpen, setTrackOpen] = useState(false);
  // Manual fulfilment (no courier) — opened from the ⋯ menu / callout.
  const [manualOpen, setManualOpen] = useState(false);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualTracking, setManualTracking] = useState('');
  const [manualNotify, setManualNotify] = useState(false);
  const [manualMarkPaid, setManualMarkPaid] = useState(false);
  // Standalone "Mark as paid" (COD collected / manual settlement).
  const [payBusy, setPayBusy] = useState(false);

  const loadMirror = useCallback(async () => {
    try {
      setD(await getOrderDetail(orderKey));
    } catch (e) {
      setErr(e instanceof ApiError ? e.userMessage : 'Could not load this order');
    }
  }, [orderKey]);

  const loadLive = useCallback(async () => {
    setRefreshing(true);
    try {
      setLive(await getOrderDetailLive(orderKey));
    } catch {
      setLive({ ok: false, reason: 'error' });
    } finally {
      setLiveAt(Date.now());
      setRefreshing(false);
    }
  }, [orderKey]);

  useEffect(() => {
    loadMirror();
    loadLive();
    if (readOnly) return; // view-only: no assign dropdown, so skip the team fetch
    listAssignableUsers()
      .then(setTeam)
      .catch(() => setTeam([]));
  }, [orderKey, loadMirror, loadLive, readOnly]);

  // Keep "Synced Xm ago" honest without re-fetching.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!hotkeys) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'r' && !refreshing) {
        e.preventDefault();
        loadLive();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkeys, loadLive, refreshing]);

  const { scans, loading: scansLoading } = useTrackingScans(d);
  const activityCount = useMemo(() => (d ? buildActivity(d, live, scans).length : 0), [d, live, scans]);

  const doAssign = async (userId: number | null) => {
    if (!d) return;
    setAssigning(true);
    try {
      await assignOrder(d.order.orderGid, userId);
      await loadMirror();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not assign');
    } finally {
      setAssigning(false);
    }
  };

  // Shared runner for one-shot actions (confirm / resend / no response / log
  // call / shipper advice): spinner on that action, toast, then reload.
  const run = async (
    kind: NextActionId | 'logcontact',
    fn: () => Promise<unknown>,
    okMsg: string,
    reloadLive = false,
  ) => {
    if (!d) return;
    setBusy(kind);
    try {
      await fn();
      toast.success(okMsg);
      await loadMirror();
      if (reloadLive) await loadLive();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not complete that');
    } finally {
      setBusy(null);
    }
  };

  const afterEdit = async (opts?: { addressChanged?: boolean }) => {
    // Correcting the address of an `address_issue` order also clears the flag
    // (returns it to To book) — same as the order-table pencil. Best-effort.
    if (opts?.addressChanged && d?.shipment?.status === 'address_issue' && d.shipment.id) {
      await revertAddressIssue(d.shipment.id).catch(() => {});
    }
    loadMirror();
    loadLive();
  };

  if (err) return <div className="p-10 text-center text-sm text-muted">{err}</div>;
  if (!d) return <DetailSkeleton />;

  const o = d.order;
  const sh = d.shipment && d.shipment.status !== 'cancelled' ? d.shipment : null;
  const cur = o.currency ?? live?.currency ?? 'PKR';
  const money = (v: number | null | undefined) =>
    v == null ? '—' : `${cur} ${Math.round(v).toLocaleString()}`;
  // Money still to collect is the reliable COD signal — the gateway string is
  // unreliable (a COD order can be "manual"/null, not literally "cod").
  const outstanding = o.totalOutstanding ?? 0;
  const paid = outstanding <= 0 && (o.financialStatus ?? '').toUpperCase() === 'PAID';
  const hasCOD = outstanding > 0 || /cod|cash on delivery/i.test(o.paymentGateway ?? '');
  const unfulfilled = !['fulfilled', 'partially_fulfilled'].includes(
    (o.fulfillmentStatus ?? '').toLowerCase(),
  );
  const active = !o.cancelledAt && !o.archivedAt;
  // Items + address edits on ANY unfulfilled, active order (incl. prepaid —
  // the editor warns about the balance/refund a re-price creates).
  const canEditItems = unfulfilled && active;
  const canEditAddress = unfulfilled && active;
  const editable = canEditItems || canEditAddress;
  const canConfirmActions = !readOnly && active && unfulfilled;
  const canManualFulfil = !readOnly && active && unfulfilled && !d.shipment;
  const canMarkPaid = !readOnly && active && outstanding > 0;
  const adviceCourier = sh && !['mnp', 'manual'].includes(sh.courierType);

  const items: DrawerItem[] =
    live?.ok && live.lineItems?.length
      ? live.lineItems
      : d.lineItems.map((l) => ({
          title: l.title ?? '',
          quantity: l.quantity ?? 0,
          variantTitle: l.variantTitle ?? null,
          unitPrice: l.price ? Number(l.price) : null,
          originalUnitPrice: null,
          lineDiscount: null,
          lineTotal: l.price && l.quantity ? Number(l.price) * l.quantity : null,
          image: null,
        }));
  // Money lines (reconcile exactly). Shopify's subtotal is AFTER discounts and
  // before shipping/tax; live values win, the mirror is the fallback.
  const liveD = live?.ok ? live : null;
  const itemsSubtotal = items.reduce(
    (s, it) => s + (it.originalUnitPrice ?? it.unitPrice ?? 0) * (it.quantity ?? 0),
    0,
  );
  const itemsAfter = liveD?.subtotalPrice ?? o.subtotalPrice ?? null;
  const discountTotal = liveD?.totalDiscounts ?? o.totalDiscounts ?? 0;
  const tax = liveD?.totalTax ?? o.totalTax ?? null;
  const shipping =
    liveD?.totalShipping ??
    o.totalShipping ??
    (itemsAfter != null && o.totalPrice != null
      ? Math.max(0, Math.round((o.totalPrice - itemsAfter - (tax ?? 0)) * 100) / 100)
      : null);
  const apps = (liveD?.discountApplications ?? []).filter((da) => da.label);
  const orderMoney: OrderMoney = {
    itemsGross: itemsAfter != null ? itemsAfter + discountTotal : itemsSubtotal > 0 ? itemsSubtotal : null,
    discountTotal,
    discounts: apps.map((da) => ({
      label: da.label as string,
      detail: da.percentage != null ? `${da.percentage}%` : null,
      amount: apps.length === 1 ? discountTotal : da.amount,
    })),
    itemsAfter,
    shipping,
    tax,
    received: Math.max(0, (o.totalPrice ?? 0) - outstanding - (liveD?.totalRefunded ?? 0)),
    refunded: liveD?.totalRefunded ?? 0,
    state:
      d.shipment && (d.shipment.receivedAt || /^(returned|failed)$/.test(d.shipment.status ?? ''))
        ? 'returned'
        : o.cancelledAt
          ? 'cancelled'
          : 'kept',
  };

  /* ── actions ── */
  const openChat =
    !readOnly && d.conversationId
      ? () =>
          onOpenChat
            ? onOpenChat(d.conversationId!, o.customerName)
            : router.push(`/inbox/${d.conversationId}`)
      : undefined;
  const call =
    !readOnly && o.phone
      ? () => {
          if (sip?.available && sip.ready) sip.placeCall(o.phone!);
          else window.location.href = `tel:${o.phone}`;
        }
      : undefined;
  const logCall = () =>
    run(
      'logcontact',
      () => logOrderContact({ orderGid: o.orderGid, orderName: o.orderName ?? undefined }),
      'Call logged',
    );
  const doMarkPaid = async () => {
    if (!o.orderName) return;
    setPayBusy(true);
    try {
      await markOrderPaid(o.orderName);
      toast.success(`${o.orderName} marked paid`);
      await loadMirror();
      await loadLive();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not mark as paid');
    } finally {
      setPayBusy(false);
    }
  };
  const doManualFulfill = async () => {
    if (!o.orderName) return;
    setManualBusy(true);
    try {
      await manualFulfill({
        shopifyOrderName: o.orderName,
        trackingNumber: manualTracking.trim() || undefined,
        notifyCustomer: manualNotify,
        markPaid: manualMarkPaid,
      });
      toast.success(
        manualMarkPaid
          ? `${o.orderName} fulfilled manually & marked paid`
          : `${o.orderName} fulfilled manually`,
      );
      setManualOpen(false);
      setManualTracking('');
      setManualNotify(false);
      setManualMarkPaid(false);
      await loadMirror();
      await loadLive();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not fulfil manually');
    } finally {
      setManualBusy(false);
    }
  };
  const doBook = onBook
    ? async () => {
        setBusy('book');
        try {
          await onBook();
        } finally {
          setBusy(null);
        }
        await loadMirror();
      }
    : undefined;
  const openManual = () => {
    setTab('overview');
    setManualOpen(true);
  };
  const postAdvice = async (remarks: string) => {
    if (!sh || !advice) return;
    const action = advice;
    setBusy(action);
    try {
      const r = await sendShipperAdvice(sh.id, action, remarks);
      toast.success(
        `${action === 'reattempt' ? 'Re-attempt' : 'Return'} advice sent to ${courierName(sh.courierType)}${r.reference ? ` (Complaint #${r.reference})` : ''}`,
      );
      setAdvice(null);
      await loadMirror();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not send shipper advice');
    } finally {
      setBusy(null);
    }
  };

  const next = deriveNextStep(d, money);
  const handlers: Partial<Record<NextActionId, () => void>> = readOnly
    ? canTrackShipment(d)
      ? { track: () => setTrackOpen(true) }
      : {}
    : {
        ...(canConfirmActions && {
          confirm: () => run('confirm', () => markOrderConfirmed(o.orderGid), 'Order marked confirmed'),
          resend: () => run('resend', () => resendConfirmation(o.orderGid), 'Confirmation resent on WhatsApp'),
          noresp: () => run('noresp', () => markOrderNoResponse(o.orderGid), 'Marked “No response”'),
        }),
        ...(canEditAddress && { fix_address: () => setEditOpen(true) }),
        ...(adviceCourier && {
          reattempt: () => setAdvice('reattempt'),
          return: () => setAdvice('return'),
        }),
        ...(openChat && { open_chat: openChat }),
        ...(call && { call }),
        ...(doBook && canManualFulfil && { book: doBook }),
        ...(canManualFulfil && { fulfil_manual: openManual }),
        ...(canTrackShipment(d) && { track: () => setTrackOpen(true) }),
      };

  const menu: DropdownItem[] = [
    ...(!readOnly && doBook && canManualFulfil
      ? [{ key: 'book', label: 'Book courier', icon: Truck, onSelect: doBook, disabled: busy === 'book' }]
      : []),
    ...(canManualFulfil
      ? [{ key: 'manual', label: 'Fulfil manually (no courier)', icon: PackageCheck, onSelect: openManual }]
      : []),
    ...(canMarkPaid
      ? [{ key: 'paid', label: 'Mark as paid', icon: Wallet, onSelect: doMarkPaid, disabled: payBusy }]
      : []),
    ...(canConfirmActions
      ? [
          {
            key: 'confirm',
            label: 'Mark confirmed',
            icon: Check,
            onSelect: () => run('confirm', () => markOrderConfirmed(o.orderGid), 'Order marked confirmed'),
          },
          {
            key: 'resend',
            label: 'Resend confirmation',
            icon: Send,
            onSelect: () => run('resend', () => resendConfirmation(o.orderGid), 'Confirmation resent on WhatsApp'),
          },
          {
            key: 'noresp',
            label: 'Mark “No response”',
            icon: X,
            onSelect: () => run('noresp', () => markOrderNoResponse(o.orderGid), 'Marked “No response”'),
          },
        ]
      : []),
    ...(!readOnly
      ? [{ key: 'log', label: 'Log a call', icon: Phone, onSelect: logCall, disabled: busy === 'logcontact' }]
      : []),
    ...(o.publicTrackingUrl
      ? [
          {
            key: 'trackpage',
            label: 'Open tracking page ↗',
            icon: MapPin,
            onSelect: () => window.open(o.publicTrackingUrl!, '_blank', 'noopener'),
          },
        ]
      : []),
    ...(o.adminUrl
      ? [
          {
            key: 'shopify',
            label: 'View in Shopify ↗',
            icon: ExternalLink,
            onSelect: () => window.open(o.adminUrl!, '_blank', 'noopener'),
          },
        ]
      : []),
    { key: 'refresh', label: 'Refresh from Shopify', icon: RefreshCw, onSelect: loadLive, disabled: refreshing },
  ];

  const manualPanel = manualOpen ? (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Marks this order fulfilled in Shopify with <b className="text-ink">no courier booking</b> (self or hand
        delivery).
      </p>
      <div>
        <label htmlFor="manual-tracking" className="mb-1 block text-xs text-muted">
          Tracking number (optional)
        </label>
        <input
          id="manual-tracking"
          value={manualTracking}
          onChange={(e) => setManualTracking(e.target.value)}
          placeholder="Leave blank for none"
          className="h-9 w-full rounded-lg border border-line bg-surface px-3 text-[13px] text-ink"
        />
      </div>
      <label className="flex items-center gap-2 text-[13px] text-ink">
        <input
          type="checkbox"
          checked={manualNotify}
          onChange={(e) => setManualNotify(e.target.checked)}
          className="h-4 w-4 rounded border-line"
        />
        Email the customer Shopify&apos;s shipment confirmation
      </label>
      {hasCOD && (
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={manualMarkPaid}
            onChange={(e) => setManualMarkPaid(e.target.checked)}
            className="h-4 w-4 rounded border-line"
          />
          Also mark as paid now (cash collected)
        </label>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setManualOpen(false)}
          disabled={manualBusy}
          className="h-8 rounded-lg border border-line px-3 text-xs font-bold text-ink hover:bg-sunken disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={doManualFulfill}
          disabled={manualBusy}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-bold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {manualBusy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          Fulfil manually
        </button>
      </div>
    </div>
  ) : undefined;

  const onNoteSaved = (note: string) =>
    setD((prev) => (prev ? { ...prev, order: { ...prev.order, internalNote: note || null } } : prev));

  const returned =
    !!o.cancelledAt && /return|fail|attempt/.test((o.deliveryStatus ?? sh?.status ?? '').toLowerCase());

  return (
    <div>
      {/* Header */}
      <div className="border-b border-line bg-surface px-5 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <h1 className="text-2xl font-extrabold tracking-tight text-ink">
                {o.orderName ?? `#${o.orderNumber ?? ''}`}
              </h1>
              <CopyButton value={o.orderName ?? o.orderNumber} label="order number" size={15} />
              {d.multiStore && o.storeLabel && <StorePill storeId={o.storeId} label={o.storeLabel} />}
            </div>
            <p className="mt-0.5 text-xs text-muted">
              Placed {fmtDateTime(o.createdAt)}
              {o.createdAt ? ` · ${timeAgo(o.createdAt)}` : ''}
              {o.source ? ` · ${sourceLabel(o.source)}` : ''}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-xl font-extrabold tabular-nums text-ink">{money(o.totalPrice)}</div>
            <div
              className={cn(
                'text-xs font-bold',
                outstanding > 0 ? 'text-amber-700' : paid ? 'text-brand-700' : 'text-muted',
              )}
            >
              {outstanding > 0
                ? `${money(outstanding)} COD to collect`
                : paid
                  ? 'Paid'
                  : (o.financialStatus ?? '—').replace(/_/g, ' ')}
            </div>
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <StatusPill value={o.financialStatus} />
          <StatusPill value={o.fulfillmentStatus} />
          {o.deliveryStatus && <StatusPill value={o.deliveryStatus} />}
          {o.cancelledAt &&
            (returned ? (
              <Pill tone="bad">Returned</Pill>
            ) : (
              <Pill tone="bad">Cancelled</Pill>
            ))}
          {o.archivedAt && <Pill>Archived</Pill>}
          {o.paymentGateway && <Pill>{shortGateway(o.paymentGateway)}</Pill>}
          {o.city && <Pill>{o.city}</Pill>}
        </div>

        <OrderProgress d={d} />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {openChat &&
            (onOpenChat ? (
              <HeaderBtn primary onClick={openChat} icon={<MessageCircle size={15} />}>
                Open chat
              </HeaderBtn>
            ) : (
              <Link
                href={`/inbox/${d.conversationId}`}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-bold text-white hover:bg-brand-700"
              >
                <MessageCircle size={15} /> Open chat
              </Link>
            ))}
          {call && (
            <HeaderBtn onClick={call} icon={<Phone size={15} />}>
              Call
            </HeaderBtn>
          )}
          {!readOnly && editable && (
            <HeaderBtn onClick={() => setEditOpen(true)} icon={<Pencil size={15} />}>
              Edit order
            </HeaderBtn>
          )}
          <Dropdown
            label="More actions"
            className="ml-auto"
            items={menu}
            trigger={
              <span className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-sunken hover:text-ink">
                {busy === 'logcontact' || busy === 'confirm' || busy === 'resend' || busy === 'noresp' ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <MoreHorizontal size={18} />
                )}
              </span>
            }
          />
        </div>
      </div>

      {/* Tabs (sticky while scrolling the drawer) */}
      <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-line bg-surface px-3">
        {(
          [
            ['overview', 'Overview', null],
            ['payments', 'Payments', null],
            ['activity', 'Activity', activityCount || null],
          ] as Array<[Tab, string, number | null]>
        ).map(([k, label, n]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cn(
              'border-b-2 px-3 py-2.5 text-[13px] font-bold',
              tab === k ? 'border-brand-600 text-ink' : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {label}
            {n != null && (
              <span className="ml-1.5 rounded-full bg-sunken px-1.5 text-[11px] tabular-nums">{n}</span>
            )}
          </button>
        ))}
        <button
          type="button"
          onClick={loadLive}
          disabled={refreshing}
          title="Refresh from Shopify (R)"
          className="ml-auto inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted hover:bg-sunken hover:text-ink"
        >
          {refreshing ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                live?.ok ? 'bg-brand-500' : live ? 'bg-amber-500' : 'bg-line',
              )}
            />
          )}
          <span className="hidden sm:inline">
            {refreshing
              ? 'Syncing…'
              : live?.ok
                ? `Synced ${timeAgo(liveAt)}`
                : live
                  ? 'Shopify unavailable'
                  : 'Syncing…'}
          </span>
        </button>
      </div>

      <div className="space-y-3 p-3.5 sm:p-4">
        {tab === 'overview' && (
          <>
            <NextStepCallout step={next} handlers={handlers} busy={busy as NextActionId | null} />
            {advice && sh && (
              <ShipperAdviceForm
                key={advice}
                action={advice}
                courier={courierName(sh.courierType)}
                busy={busy === advice}
                onCancel={() => setAdvice(null)}
                onSubmit={postAdvice}
              />
            )}
            <CustomerCard d={d} onOpenChat={openChat} onCall={call} />
            <ItemsCard
              items={items}
              money={money}
              m={orderMoney}
              total={o.totalPrice}
              outstanding={outstanding}
              paid={paid}
            />
            <ShippingCard
              d={d}
              scans={scans}
              scansLoading={scansLoading}
              manualPanel={manualPanel}
              trackOpen={trackOpen}
              onTrackOpen={setTrackOpen}
            />
            <TagsTeamCard
              d={d}
              liveTags={live ? (live.ok ? live.tags ?? [] : []) : undefined}
              team={team}
              assigning={assigning}
              onAssign={doAssign}
              readOnly={readOnly}
              onNoteSaved={onNoteSaved}
            />
          </>
        )}
        {tab === 'payments' && (
          <PaymentsTab
            d={d}
            live={live}
            money={money}
            outstanding={outstanding}
            hasCOD={hasCOD}
            canMarkPaid={canMarkPaid}
            payBusy={payBusy}
            onMarkPaid={doMarkPaid}
          />
        )}
        {tab === 'activity' && (
          <ActivityTab d={d} live={live} scans={scans} readOnly={readOnly} onNoteSaved={onNoteSaved} />
        )}
        {!readOnly && tab === 'overview' && (
          <p className="px-1 text-center text-xs text-muted">
            Called the customer? Use <b className="font-semibold">⋯ → Log a call</b> so it counts in the agent report.
          </p>
        )}
      </div>

      {editOpen && (
        <EditOrderModal
          orderGid={o.orderGid}
          orderName={o.orderName}
          currency={cur}
          canEditItems={canEditItems}
          canEditAddress={canEditAddress}
          prepaid={canEditItems && outstanding <= 0}
          initial={{
            name: o.customerName,
            phone: o.phone,
            email: o.email,
            address1: o.address1,
            address2: o.address2,
            city: o.city,
            countryCode: o.countryCode,
            note: o.internalNote,
          }}
          tags={live?.ok ? live.tags ?? [] : undefined}
          onClose={() => setEditOpen(false)}
          onSaved={afterEdit}
        />
      )}
    </div>
  );
}

/* ── small presentational helpers ───────────────────────────────────────── */
function HeaderBtn({
  onClick,
  icon,
  children,
  primary,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-bold',
        primary
          ? 'bg-brand-600 text-white hover:bg-brand-700'
          : 'border border-line bg-surface text-ink hover:bg-sunken',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function Pill({ children, tone }: { children: React.ReactNode; tone?: 'good' | 'warn' | 'bad' | 'info' }) {
  return (
    <span
      className={cn(
        'rounded-full px-2.5 py-0.5 text-xs font-bold capitalize',
        tone === 'good' && 'bg-brand-50 text-brand-700',
        tone === 'warn' && 'bg-amber-50 text-amber-700',
        tone === 'bad' && 'bg-rose-50 text-rose-700',
        tone === 'info' && 'bg-sky-50 text-sky-700',
        !tone && 'border border-line bg-sunken text-muted',
      )}
    >
      {children}
    </span>
  );
}

function StatusPill({ value }: { value: string | null }) {
  if (!value) return null;
  const v = value.toLowerCase();
  const tone =
    v === 'paid' || v === 'delivered' || v === 'fulfilled'
      ? 'good'
      : v === 'pending' || v === 'unfulfilled' || v === 'partially_paid'
        ? 'warn'
        : v === 'in_transit' || v === 'out_for_delivery'
          ? 'info'
          : /fail|return|refund|void/.test(v)
            ? 'bad'
            : undefined;
  return <Pill tone={tone}>{value.replace(/_/g, ' ')}</Pill>;
}

function sourceLabel(s: string): string {
  const v = s.toLowerCase();
  if (v === 'web') return 'Online store';
  if (v === 'codesapp') return 'Created in CodesApp';
  if (v === 'pos') return 'Point of sale';
  if (v.includes('draft')) return 'Draft order';
  return `via ${s.replace(/_/g, ' ')}`;
}

function DetailSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading order">
      <div className="space-y-3 border-b border-line bg-surface px-5 py-5">
        <div className="flex justify-between">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-7 w-24" />
        </div>
        <Skeleton className="h-4 w-56" />
        <div className="flex gap-1.5">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-5 w-14 rounded-full" />
        </div>
        <Skeleton className="h-8 w-full" />
        <div className="flex gap-2">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-20" />
        </div>
      </div>
      <div className="space-y-3 p-4">
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-48 w-full rounded-2xl" />
      </div>
    </div>
  );
}

