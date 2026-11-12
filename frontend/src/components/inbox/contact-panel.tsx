'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Ban,
  Bot,
  Check,
  ChevronRight,
  Copy,
  FileText,
  Image as ImageIcon,
  Link2,
  Mail,
  MapPin,
  Megaphone,
  Package,
  Pencil,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Plus,
  RotateCcw,
  ShoppingCart,
  StickyNote,
  Trash2,
  Truck,
  UserCheck,
  X,
} from 'lucide-react';
import { fmtDate, fmtDateTime, cn, mediaUrl } from '@/lib/utils';
import { apiFetch, ApiError } from '@/lib/api';
import { avatarColor, initialsOf } from '@/lib/avatar';
import {
  type ContactOrder,
  type ContactOrders,
  isOrderTrackable,
  orderDisplayStatus,
  orderStatusTone,
  orderIsDelivered,
  orderIsActive,
  orderIsIssue,
  summarizeContactOrders,
  moneyCompact,
} from '@/lib/contact-orders';
import type { ConversationDetail, ConversationNote } from '@/lib/inbox-types';
import type { TeamMember } from '@/lib/crm-types';
import { OrderNameButton } from '@/components/orders/order-detail-view';
import { markOrderNoResponse } from '@/lib/couriers';
import { useToast } from '@/components/toast';
import { useSocket } from '@/context/socket-context';
import { ConfirmDialog } from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { LabelEditor } from '@/components/inbox/thread-header';

// ── helpers ─────────────────────────────────────────────────────────────────

function canMarkNoResponse(o: ContactOrder): boolean {
  return (
    !o.cancelled &&
    !o.archived &&
    !o.manualConfirmedAt &&
    (o.fulfillmentStatus ?? '').toLowerCase() === 'unfulfilled' &&
    (o.financialStatus ?? '').toLowerCase() !== 'paid'
  );
}

function money(amount: number | null, currency: string | null): string | null {
  if (amount == null) return null;
  return `${currency ? currency + ' ' : ''}${amount.toLocaleString()}`;
}

function orderProgress(o: ContactOrder): number {
  if (o.cancelled) return 0;
  if (orderIsDelivered(o)) return 1;
  const s = (o.shipmentStatus || o.fulfillmentStatus || '').toLowerCase();
  if (/return|fail/.test(s)) return 1;
  if (/out for|attempt/.test(s)) return 0.75;
  if (/transit|pick/.test(s)) return 0.5;
  if (s) return 0.3;
  return 0.12;
}

/** Compact header chip: latest order + status, or "N orders". */
export function ContactOrderChip({
  orders,
  onClick,
}: {
  orders: ContactOrders | null;
  onClick: () => void;
}) {
  if (!orders || orders.count === 0) return null;
  const latest = orders.orders[0];
  const total = orders.lifetime?.count ?? orders.count;
  const label = total > 1 ? `${total} orders` : latest.orderName ?? '1 order';
  return (
    <button
      type="button"
      onClick={onClick}
      title="View this contact's orders"
      className={cn(
        'hidden xl:inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full shrink-0 hover:brightness-95',
        orderStatusTone(latest),
      )}
    >
      <Package size={12} />
      {label}
      {total === 1 && <span className="opacity-70">· {orderDisplayStatus(latest)}</span>}
    </button>
  );
}

export type PanelTab = 'overview' | 'orders' | 'notes' | 'media';
export type AiMode = 'default' | 'on' | 'off';

export interface PanelCall {
  id: number;
  direction: 'inbound' | 'outbound';
  status: string;
  duration_sec: number | null;
  started_at: string | null;
  created_at: string;
}

export interface ContactInfoPanelProps {
  conversationId: number;
  convo: ConversationDetail | null;
  orders: ContactOrders | null;
  ordersLoading: boolean;
  ordersError: boolean;
  onRetryOrders: () => void;
  /** Re-fetch orders after a change made from the panel (e.g. No response). */
  onOrdersChanged: () => void;
  tab: PanelTab;
  onTabChange: (t: PanelTab) => void;
  tags: string[];
  onSetTags: (next: string[]) => Promise<void> | void;
  shopifyTags?: string[] | null;
  onSetShopifyTags?: (next: string[]) => Promise<void> | void;
  members: TeamMember[];
  meId: number | undefined;
  canManageAssign: boolean;
  onAssign: (userId: number | null) => void;
  aiEnabled: boolean;
  aiMode: AiMode;
  allChatsOn: boolean;
  onAiMode: (m: AiMode) => void;
  onCreateOrder?: () => void;
  /** In-app WhatsApp call (SIP); falls back to a tel: link when absent. */
  onCall?: () => void;
  onToggleBlock: () => void;
  onAddLabel: (l: string) => Promise<void> | void;
  onRemoveLabel: (l: string) => Promise<void> | void;
  onContactSaved: () => void;
  calls: PanelCall[];
  onClose: () => void;
  onTrack?: (o: ContactOrder) => void;
}

// ── panel ───────────────────────────────────────────────────────────────────

/**
 * Inbox-v2 contact drawer. Summary before detail: identity → "Next step"
 * (latest order, what's owed, one-tap actions) → lifetime stats → tabs
 * Overview · Orders · Notes · Media. Desktop: a column that stays open across
 * chats. Mobile: a full-screen dialog (Esc / back button / ✕ close it).
 */
export function ContactInfoPanel(props: ContactInfoPanelProps) {
  const {
    conversationId,
    convo,
    orders,
    ordersLoading,
    ordersError,
    tab,
    onTabChange,
    onClose,
  } = props;
  const toast = useToast();
  const closeRef = useRef<HTMLButtonElement>(null);
  const summary = useMemo(() => summarizeContactOrders(orders), [orders]);

  const name = convo?.contact?.name || convo?.contact?.phone || 'Contact';
  const phone = convo?.contact?.phone ?? null;
  const blocked = convo?.contact?.status === 'blocked';
  const referral = convo?.referral?.source_type ?? null;
  const since = convo?.contact?.created_at ?? null;

  // Mobile dialog behaviour: Esc + the phone's Back button close the panel
  // (a history entry is pushed while it is open), body scroll is locked, and
  // focus lands on the close button.
  useEffect(() => {
    const mobile = window.matchMedia?.('(max-width: 767px)').matches;
    // Esc closes only the full-screen MOBILE sheet — on desktop the drawer is
    // a docked column and Esc belongs to the composer / search / menus.
    if (!mobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[aria-modal="true"]:not([data-contact-panel])')) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.history.pushState({ contactPanel: true }, '');
    const onPop = () => onClose();
    window.addEventListener('popstate', onPop);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onPop);
      document.body.style.overflow = prevOverflow;
      if (window.history.state?.contactPanel) window.history.back();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [copied, setCopied] = useState(false);
  const copyPhone = async () => {
    if (!phone) return;
    try {
      await navigator.clipboard.writeText(phone);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy');
    }
  };

  const notesCount = useNotesCount(conversationId);

  return (
    <aside
      data-contact-panel
      role="complementary"
      aria-label={`Contact details: ${name}`}
      className="fixed inset-0 z-50 flex h-full flex-col bg-surface md:static md:z-auto md:w-80 md:shrink-0 md:border-l md:border-line lg:w-[22rem]"
    >
      {/* Identity */}
      <div className="flex shrink-0 items-start gap-3 border-b border-line px-4 pb-3 pt-4">
        <span
          aria-hidden
          className={cn(
            'flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-lg font-bold text-white',
            avatarColor(name),
          )}
        >
          {initialsOf(name)}
        </span>
        <div className="min-w-0 flex-1">
          <EditableField
            value={convo?.contact?.name ?? ''}
            placeholder="Add a name"
            label="name"
            className="text-base font-semibold text-ink"
            onSave={async (v) => {
              if (!convo?.contact_id || !v.trim()) return;
              await apiFetch(`/contacts/${convo.contact_id}`, { method: 'PATCH', body: { name: v.trim() } });
              props.onContactSaved();
            }}
          />
          {phone && (
            <button
              type="button"
              onClick={copyPhone}
              className="mt-0.5 inline-flex items-center gap-1 text-sm tabular-nums text-muted hover:text-ink"
              aria-label="Copy phone number"
            >
              {phone}
              {copied ? <Check size={13} className="text-brand-600" /> : <Copy size={13} />}
            </button>
          )}
          <p className="mt-0.5 text-xs text-muted">
            {since ? `Customer since ${fmtDate(since)}` : 'Customer'}
            {convo?.via_number?.phone || convo?.via_number?.label
              ? ` · via ${convo.via_number.label || convo.via_number.phone}`
              : ''}
          </p>
          {(referral || blocked) && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {referral && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                  <Megaphone size={11} /> From {referral === 'ad' ? 'ad' : 'post'}
                  {convo?.referral?.headline ? `: ${convo.referral.headline.slice(0, 32)}` : ''}
                </span>
              )}
              {blocked && (
                <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700">Blocked</span>
              )}
            </div>
          )}
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close contact details"
          className="-mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Quick actions */}
        <div className="grid grid-cols-4 gap-1.5 px-4 pt-3">
          {phone && (
            <QuickAction
              icon={<Phone size={16} />}
              label="Call"
              onClick={props.onCall}
              href={props.onCall ? undefined : `tel:${phone}`}
            />
          )}
          {props.onCreateOrder && (
            <QuickAction icon={<ShoppingCart size={16} />} label="Order" onClick={props.onCreateOrder} />
          )}
          <QuickAction icon={<StickyNote size={16} />} label="Note" onClick={() => onTabChange('notes')} />
          <QuickAction
            icon={<Ban size={16} />}
            label={blocked ? 'Unblock' : 'Block'}
            onClick={props.onToggleBlock}
            danger={!blocked}
          />
        </div>

        <NextStep {...props} />

        {/* Lifetime stats */}
        <div className="grid grid-cols-4 gap-1.5 px-4 pt-3">
          {ordersLoading && !orders ? (
            [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-lg" />)
          ) : (
            <>
              <Stat label="Lifetime" value={summary ? moneyCompact(summary.ltv, summary.currency) : '—'} />
              <Stat label="Orders" value={summary ? String(summary.count) : '0'} />
              <Stat label="Avg order" value={summary && summary.aov ? moneyCompact(summary.aov, summary.currency) : '—'} />
              <Stat
                label="Delivered"
                value={summary?.deliveredRate != null ? `${summary.deliveredRate}%` : '—'}
                tone={
                  summary?.deliveredRate == null
                    ? undefined
                    : summary.deliveredRate >= 80
                      ? 'text-brand-700'
                      : summary.deliveredRate >= 50
                        ? 'text-amber-700'
                        : 'text-red-700'
                }
              />
            </>
          )}
        </div>

        {/* Tabs */}
        <div role="tablist" aria-label="Contact sections" className="sticky top-0 z-10 mt-3 flex gap-1 border-b border-line bg-surface px-3">
          {(
            [
              ['overview', 'Overview', null],
              ['orders', 'Orders', summary?.count ?? null],
              ['notes', 'Notes', notesCount],
              ['media', 'Media', null],
            ] as const
          ).map(([k, l, n]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => onTabChange(k)}
              className={cn(
                '-mb-px flex items-center gap-1 border-b-2 px-2 py-2 text-sm font-semibold',
                tab === k ? 'border-brand-600 text-ink' : 'border-transparent text-muted hover:text-ink',
              )}
            >
              {l}
              {n != null && n > 0 && (
                <span className="rounded-full bg-sunken px-1.5 text-xs tabular-nums text-muted">{n}</span>
              )}
            </button>
          ))}
        </div>

        <div className="px-4 py-3">
          {tab === 'overview' && <OverviewTab {...props} />}
          {tab === 'orders' && (
            <OrdersTab
              orders={orders}
              loading={ordersLoading}
              error={ordersError}
              onRetry={props.onRetryOrders}
              onChanged={props.onOrdersChanged}
              onTrack={props.onTrack}
            />
          )}
          {tab === 'notes' && <NotesTab conversationId={conversationId} members={props.members} meId={props.meId} canManage={props.canManageAssign} />}
          {tab === 'media' && <MediaTab conversationId={conversationId} />}
        </div>
      </div>
    </aside>
  );
}

// ── pieces ──────────────────────────────────────────────────────────────────

function QuickAction({
  icon,
  label,
  onClick,
  href,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  href?: string;
  danger?: boolean;
}) {
  const cls = cn(
    'flex flex-col items-center gap-1 rounded-xl border border-line py-2 text-xs font-semibold hover:bg-sunken',
    danger ? 'text-red-700' : 'text-ink',
  );
  if (href) {
    return (
      <a href={href} className={cls}>
        {icon}
        {label}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {icon}
      {label}
    </button>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg bg-sunken px-2 py-1.5">
      <p className={cn('truncate text-sm font-bold tabular-nums', tone ?? 'text-ink')}>{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wide text-muted">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Inline-editable text (click the pencil → input; Enter saves, Esc cancels). */
function EditableField({
  value,
  placeholder,
  label,
  className,
  type = 'text',
  onSave,
}: {
  value: string;
  placeholder: string;
  label: string;
  className?: string;
  type?: 'text' | 'email';
  onSave: (v: string) => Promise<void>;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  const [busy, setBusy] = useState(false);
  useEffect(() => setV(value), [value]);
  const save = async () => {
    if (v.trim() === value.trim()) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onSave(v);
      setEditing(false);
      toast.success(`Saved ${label}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : `Couldn’t save ${label}`);
    } finally {
      setBusy(false);
    }
  };
  if (editing) {
    return (
      <input
        autoFocus
        type={type}
        value={v}
        disabled={busy}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') {
            e.stopPropagation();
            setV(value);
            setEditing(false);
          }
        }}
        aria-label={`Edit ${label}`}
        className="w-full rounded-md border border-brand-500 bg-surface px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
    );
  }
  return (
    <span className="group/edit flex min-w-0 items-center gap-1">
      <span className={cn('truncate', className, !value && 'italic text-muted')}>{value || placeholder}</span>
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`Edit ${label}`}
        className="shrink-0 rounded p-0.5 text-muted opacity-60 hover:text-ink group-hover/edit:opacity-100"
      >
        <Pencil size={13} />
      </button>
    </span>
  );
}

/** "What does this customer need now": the latest live order, front and centre. */
function NextStep(p: ContactInfoPanelProps) {
  const list = p.orders?.orders ?? [];
  const o = list.find((x) => !x.cancelled && orderIsActive(x)) ?? list.find((x) => !x.cancelled) ?? null;
  if (p.ordersLoading && !p.orders) {
    return <Skeleton className="mx-4 mt-3 h-24 rounded-xl" />;
  }
  if (p.ordersError) {
    return (
      <div className="mx-4 mt-3 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
        <AlertCircle size={14} /> Couldn’t load orders.
        <button onClick={p.onRetryOrders} className="ml-auto font-semibold underline">
          Retry
        </button>
      </div>
    );
  }
  if (!o) {
    return p.onCreateOrder ? (
      <button
        type="button"
        onClick={p.onCreateOrder}
        className="mx-4 mt-3 flex w-[calc(100%-2rem)] items-center gap-2 rounded-xl border border-dashed border-line px-3 py-3 text-left text-sm text-muted hover:border-brand-500 hover:text-brand-700"
      >
        <Plus size={16} /> No orders yet — create one from this chat
      </button>
    ) : null;
  }
  const cod = o.outstanding && o.outstanding > 0 ? money(o.outstanding, o.currency) : null;
  const progress = orderProgress(o);
  return (
    <div className="mx-4 mt-3 rounded-xl border border-line p-3">
      <p className="text-xs font-bold uppercase tracking-wide text-brand-700">Latest order</p>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-semibold">
          <OrderNameButton name={o.orderName ?? 'Order'} gid={o.orderGid} />
        </span>
        <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold', orderStatusTone(o))}>
          {orderDisplayStatus(o)}
        </span>
      </div>
      {o.itemsSummary && <p className="mt-0.5 truncate text-xs text-muted">{o.itemsSummary}</p>}
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sunken" aria-hidden>
        <div
          className={cn('h-full rounded-full', orderIsDelivered(o) ? 'bg-brand-600' : orderIsIssue(o) ? 'bg-red-500' : 'bg-sky-500')}
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
      <p className="mt-1.5 text-xs text-muted">
        {cod ? (
          <>
            COD <strong className="text-ink">{cod}</strong> to collect
          </>
        ) : (
          money(o.total, o.currency) ?? ''
        )}
        {o.createdAt ? ` · ${fmtDate(o.createdAt)}` : ''}
        {o.trackingNumber ? ` · ${o.courierType ?? 'Courier'}` : ''}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {p.onTrack && isOrderTrackable(o) && (
          <button
            type="button"
            onClick={() => p.onTrack!(o)}
            className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-xs font-semibold hover:bg-sunken"
          >
            <Truck size={13} /> Track &amp; send
          </button>
        )}
        <NoResponseButton o={o} onDone={p.onOrdersChanged} />
        {list.length > 1 && (
          <button
            type="button"
            onClick={() => p.onTabChange('orders')}
            className="ml-auto inline-flex items-center text-xs font-semibold text-brand-700 hover:underline"
          >
            All orders <ChevronRight size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

function NoResponseButton({ o, onDone }: { o: ContactOrder; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (o.noResponseAt) {
    return (
      <span className="inline-flex items-center rounded-full bg-orange-50 px-2 py-1 text-xs font-semibold text-orange-800">
        No response
      </span>
    );
  }
  if (!canMarkNoResponse(o)) return null;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await markOrderNoResponse(o.orderGid);
          toast.success(`Marked ${o.orderName ?? 'order'} no response`);
          // Re-fetch so the flag persists (it used to revert on reopen).
          onDone();
        } catch (e) {
          toast.error(e instanceof ApiError ? e.userMessage : 'Failed to mark no response');
        } finally {
          setBusy(false);
        }
      }}
      title="Called the customer, no answer — tags ❌ NO RESPONSE in Shopify"
      className="inline-flex items-center gap-1 rounded-lg border border-orange-200 px-2.5 py-1 text-xs font-semibold text-orange-800 hover:bg-orange-50 disabled:opacity-50"
    >
      {busy ? 'Marking…' : 'No response'}
    </button>
  );
}

function OverviewTab(p: ContactInfoPanelProps) {
  const c = p.convo;
  const assigned = c?.assigned_user ?? null;
  const labels = (c?.labels ?? []).map((l) => l.label);
  const custom = c?.contact?.custom_fields && typeof c.contact.custom_fields === 'object'
    ? Object.entries(c.contact.custom_fields).filter(([, v]) => v != null && v !== '')
    : [];
  return (
    <div className="space-y-5">
      <Section title="Assigned to">
        {p.canManageAssign ? (
          <select
            value={assigned?.id ?? ''}
            onChange={(e) => p.onAssign(e.target.value ? Number(e.target.value) : null)}
            aria-label="Assigned teammate"
            className="w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-sm"
          >
            <option value="">Unassigned</option>
            {p.members
              .filter((m) => m.status === 'active' || m.id === assigned?.id)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.id === p.meId ? ' (me)' : ''}
                </option>
              ))}
          </select>
        ) : (
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className={cn(!assigned && 'text-muted')}>{assigned?.name ?? 'Unassigned'}</span>
            {assigned?.id !== p.meId && p.meId && (
              <button
                type="button"
                onClick={() => p.onAssign(p.meId!)}
                className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs font-semibold hover:bg-sunken"
              >
                <UserCheck size={13} /> Assign to me
              </button>
            )}
          </div>
        )}
      </Section>

      {p.aiEnabled && (
        <Section title="AI auto-reply for this chat">
          <div className="grid grid-cols-3 rounded-lg bg-sunken p-1" role="group" aria-label="AI auto-reply">
            {(
              [
                ['default', p.allChatsOn ? 'Workspace (on)' : 'Workspace (off)'],
                ['on', 'On'],
                ['off', 'Mute'],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                type="button"
                aria-pressed={p.aiMode === k}
                onClick={() => p.onAiMode(k)}
                className={cn(
                  'rounded-md px-1 py-1.5 text-xs font-semibold',
                  p.aiMode === k ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink',
                )}
              >
                {k === 'on' && <Bot size={12} className="mr-0.5 inline" aria-hidden />}
                {l}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted">
            {p.aiMode === 'default'
              ? `Follows the workspace setting — the AI ${p.allChatsOn ? 'replies' : 'does not reply'} here.`
              : p.aiMode === 'on'
                ? 'The AI replies in this chat even when someone is assigned.'
                : 'The AI never replies in this chat.'}
          </p>
        </Section>
      )}

      <Section title="Contact">
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center gap-2">
            <Mail size={14} className="shrink-0 text-muted" aria-hidden />
            <EditableField
              value={c?.contact?.email ?? ''}
              placeholder="Add email"
              label="email"
              type="email"
              onSave={async (v) => {
                if (!c?.contact_id || !v.trim()) return;
                await apiFetch(`/contacts/${c.contact_id}`, { method: 'PATCH', body: { email: v.trim() } });
                p.onContactSaved();
              }}
            />
          </div>
          {(c?.contact?.address || c?.contact?.city) && (
            <div className="flex items-start gap-2">
              <MapPin size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 break-words text-ink [word-break:break-word]">
                {[c?.contact?.address, c?.contact?.city].filter(Boolean).join(', ')}
              </span>
            </div>
          )}
          {custom.map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-muted">{k.replace(/_/g, ' ')}</span>
              <span className="truncate text-right">{String(v)}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Contact tags">
        <TagList tags={p.tags} onChange={p.onSetTags} />
      </Section>

      {p.shopifyTags != null && p.onSetShopifyTags && (
        <Section title="Shopify customer tags">
          <TagList tags={p.shopifyTags} onChange={p.onSetShopifyTags} tone="shopify" />
        </Section>
      )}

      <Section title="Conversation labels">
        <LabelEditorInline labels={labels} onAdd={p.onAddLabel} onRemove={p.onRemoveLabel} />
      </Section>

      {p.calls.length > 0 && (
        <Section title="Recent calls">
          <ul className="space-y-1.5">
            {p.calls.slice(-4).reverse().map((call) => {
              const missed = call.status === 'missed' || call.status === 'failed';
              const Icon = missed ? PhoneMissed : call.direction === 'inbound' ? PhoneIncoming : PhoneOutgoing;
              return (
                <li key={call.id} className="flex items-center gap-2 text-xs">
                  <Icon size={14} className={missed ? 'text-red-600' : 'text-brand-600'} aria-hidden />
                  <span className={missed ? 'text-red-700' : 'text-ink'}>
                    {missed ? 'Missed' : call.direction === 'inbound' ? 'Incoming' : 'Outgoing'}
                    {call.duration_sec ? ` · ${Math.floor(call.duration_sec / 60)}:${String(call.duration_sec % 60).padStart(2, '0')}` : ''}
                  </span>
                  <span className="ml-auto text-muted">{fmtDateTime(call.started_at || call.created_at)}</span>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
    </div>
  );
}

/** Small wrapper so the label editor doesn't steal focus on mount. */
function LabelEditorInline(p: { labels: string[]; onAdd: (l: string) => Promise<void> | void; onRemove: (l: string) => Promise<void> | void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {p.labels.map((l) => (
          <span key={l} className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-800">
            {l}
          </span>
        ))}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-line px-2 py-0.5 text-xs text-muted hover:text-ink"
        >
          <Plus size={11} /> {p.labels.length ? 'Edit' : 'Add label'}
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <LabelEditor labels={p.labels} onAdd={p.onAdd} onRemove={p.onRemove} />
      <button type="button" onClick={() => setOpen(false)} className="text-xs font-semibold text-brand-700 hover:underline">
        Done
      </button>
    </div>
  );
}

/** Tag chips with an add box: case-insensitive de-dupe, input kept on failure. */
function TagList({
  tags,
  onChange,
  tone,
}: {
  tags: string[];
  onChange: (next: string[]) => Promise<void> | void;
  tone?: 'shopify';
}) {
  const toast = useToast();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (next: string[], onOk?: () => void) => {
    setBusy(true);
    try {
      await onChange(next);
      onOk?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to update tags');
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    const t = value.trim();
    if (!t) return;
    if (tags.some((x) => x.toLowerCase() === t.toLowerCase())) {
      setValue('');
      return;
    }
    void save([...tags, t], () => setValue(''));
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((t) => (
        <span
          key={t}
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
            tone === 'shopify' ? 'bg-lime-50 text-lime-900' : 'bg-sunken text-ink',
          )}
        >
          {t}
          <button
            type="button"
            disabled={busy}
            onClick={() => void save(tags.filter((x) => x !== t))}
            aria-label={`Remove tag ${t}`}
            className="rounded-full p-0.5 text-muted hover:text-red-600 disabled:opacity-50"
          >
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        placeholder="+ add tag"
        aria-label={tone === 'shopify' ? 'Add Shopify tag' : 'Add contact tag'}
        className="min-w-[6rem] flex-1 rounded-full border border-dashed border-line bg-transparent px-2.5 py-0.5 text-xs focus:border-brand-500 focus:outline-none"
      />
    </div>
  );
}

function OrdersTab({
  orders,
  loading,
  error,
  onRetry,
  onChanged,
  onTrack,
}: {
  orders: ContactOrders | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onChanged: () => void;
  onTrack?: (o: ContactOrder) => void;
}) {
  const [seg, setSeg] = useState<'all' | 'active' | 'issues'>('all');
  const [limit, setLimit] = useState(5);
  const list = useMemo(() => {
    const all = orders?.orders ?? [];
    if (seg === 'active') return all.filter((o) => orderIsActive(o) && !orderIsIssue(o));
    if (seg === 'issues') return all.filter(orderIsIssue);
    return all;
  }, [orders, seg]);
  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted">
        <AlertCircle size={20} className="text-red-600" />
        Couldn’t load this contact’s orders.
        <button onClick={onRetry} className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink">
          <RotateCcw size={13} /> Retry
        </button>
      </div>
    );
  }
  if (loading && !orders) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 rounded-lg" />
        ))}
      </div>
    );
  }
  if (!orders || orders.orders.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">No orders found for this contact.</p>;
  }
  const lifetime = orders.lifetime?.count ?? orders.count;
  return (
    <div className="space-y-2">
      <div className="flex gap-1" role="group" aria-label="Filter orders">
        {(['all', 'active', 'issues'] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={seg === k}
            onClick={() => setSeg(k)}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-semibold capitalize',
              seg === k ? 'bg-brand-600 text-white' : 'bg-sunken text-muted hover:text-ink',
            )}
          >
            {k}
          </button>
        ))}
      </div>
      {list.slice(0, limit).map((o) => (
        <OrderCard key={o.orderGid} o={o} onTrack={onTrack} onChanged={onChanged} />
      ))}
      {list.length === 0 && <p className="py-4 text-center text-xs text-muted">Nothing here.</p>}
      {list.length > limit && (
        <button
          type="button"
          onClick={() => setLimit((l) => l + 10)}
          className="w-full rounded-lg border border-line py-1.5 text-xs font-semibold text-muted hover:text-ink"
        >
          Show more ({list.length - limit})
        </button>
      )}
      {lifetime > orders.orders.length && (
        <p className="text-center text-xs text-muted">
          Showing the latest {orders.orders.length} of {lifetime} orders.
        </p>
      )}
    </div>
  );
}

function OrderCard({
  o,
  onTrack,
  onChanged,
}: {
  o: ContactOrder;
  onTrack?: (o: ContactOrder) => void;
  onChanged: () => void;
}) {
  const total = money(o.total, o.currency);
  const cod = o.outstanding && o.outstanding > 0 ? money(o.outstanding, o.currency) : null;
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm">
          <OrderNameButton name={o.orderName ?? 'Order'} gid={o.orderGid} />
        </span>
        <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs', orderStatusTone(o))}>
          {orderDisplayStatus(o)}
        </span>
      </div>
      {o.itemsSummary && <p className="mt-1 truncate text-xs text-muted">{o.itemsSummary}</p>}
      <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted">
        <span>{o.createdAt ? fmtDate(o.createdAt) : ''}</span>
        {total && (
          <span className="truncate font-medium text-ink">
            {total}
            {cod && <span className="text-red-700"> · COD {cod}</span>}
          </span>
        )}
      </div>
      {o.trackingNumber && (
        <p className="mt-1 flex items-center gap-1 text-xs text-muted">
          <Truck size={12} aria-hidden /> <span className="capitalize">{o.courierType ?? 'Courier'}</span> · {o.trackingNumber}
        </p>
      )}
      {!!o.callCount && (
        <p className="mt-0.5 text-xs text-muted">
          {o.callCount} call{o.callCount > 1 ? 's' : ''}
          {o.lastCall?.agent ? ` · last by ${o.lastCall.agent}` : ''}
        </p>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <NoResponseButton o={o} onDone={onChanged} />
        {onTrack && isOrderTrackable(o) && (
          <button
            type="button"
            onClick={() => onTrack(o)}
            className="ml-auto inline-flex items-center gap-0.5 text-xs font-semibold text-brand-700 hover:underline"
          >
            View tracking <ChevronRight size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Notes ───────────────────────────────────────────────────────────────────

const notesCache = new Map<number, ConversationNote[]>();
const notesListeners = new Set<() => void>();

function useNotes(conversationId: number) {
  const { on } = useSocket();
  const [notes, setNotes] = useState<ConversationNote[] | null>(notesCache.get(conversationId) ?? null);
  const [error, setError] = useState(false);
  const load = useCallback(async () => {
    try {
      const n = await apiFetch<ConversationNote[]>(`/inbox/conversations/${conversationId}/notes`);
      notesCache.set(conversationId, n);
      setNotes(n);
      setError(false);
      notesListeners.forEach((l) => l());
    } catch {
      setError(true);
    }
  }, [conversationId]);
  useEffect(() => {
    void load();
  }, [load]);
  // Live: notes added/edited/deleted by teammates.
  useEffect(
    () =>
      on<{ conversationId: number }>('note.changed', (p) => {
        if (p.conversationId === conversationId) void load();
      }),
    [on, conversationId, load],
  );
  useEffect(() => {
    const l = () => setNotes(notesCache.get(conversationId) ?? null);
    notesListeners.add(l);
    return () => {
      notesListeners.delete(l);
    };
  }, [conversationId]);
  return { notes, error, load };
}

function useNotesCount(conversationId: number): number | null {
  const { notes } = useNotes(conversationId);
  return notes ? notes.length : null;
}

function NotesTab({
  conversationId,
  members,
  meId,
  canManage,
}: {
  conversationId: number;
  members: TeamMember[];
  meId: number | undefined;
  canManage: boolean;
}) {
  const toast = useToast();
  const { notes, error, load } = useNotes(conversationId);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [editBody, setEditBody] = useState('');
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const author = (uid: number) =>
    uid === meId ? 'You' : members.find((m) => m.id === uid)?.name ?? 'Teammate';

  const add = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await apiFetch(`/inbox/conversations/${conversationId}/notes`, {
        method: 'POST',
        body: { body: body.trim() },
      });
      setBody('');
      void load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Couldn’t add the note');
    } finally {
      setBusy(false);
    }
  };
  const saveEdit = async () => {
    if (editId == null || !editBody.trim()) return;
    setBusy(true);
    try {
      await apiFetch(`/inbox/notes/${editId}`, { method: 'PATCH', body: { body: editBody.trim() } });
      setEditId(null);
      void load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Couldn’t save the note');
    } finally {
      setBusy(false);
    }
  };
  const doDelete = async () => {
    if (deleteId == null) return;
    setBusy(true);
    try {
      await apiFetch(`/inbox/notes/${deleteId}`, { method: 'DELETE' });
      setDeleteId(null);
      void load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Couldn’t delete the note');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="note-body" className="sr-only">
          New internal note
        </label>
        <textarea
          id="note-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void add();
          }}
          rows={3}
          placeholder="Write an internal note — only your team sees it"
          className="w-full rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-xs text-muted">Ctrl+Enter to save</span>
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy || !body.trim()}
            className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
          >
            Add note
          </button>
        </div>
      </div>
      {error && (
        <p className="text-xs text-red-700">
          Couldn’t load notes.{' '}
          <button onClick={() => void load()} className="font-semibold underline">
            Retry
          </button>
        </p>
      )}
      {notes == null && !error && <Skeleton className="h-16 rounded-lg" />}
      {notes?.length === 0 && <p className="py-2 text-center text-xs text-muted">No notes yet.</p>}
      <ul className="space-y-2">
        {notes?.map((n) => {
          const mine = n.user_id === meId || canManage;
          return (
            <li key={n.id} className="group/note rounded-lg border border-amber-100 bg-amber-50 px-3 py-2">
              {editId === n.id ? (
                <>
                  <textarea
                    autoFocus
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    rows={3}
                    aria-label="Edit note"
                    className="w-full rounded-md border border-amber-300 bg-surface px-2 py-1 text-sm"
                  />
                  <div className="mt-1 flex justify-end gap-2">
                    <button onClick={() => setEditId(null)} className="text-xs text-muted">
                      Cancel
                    </button>
                    <button onClick={() => void saveEdit()} disabled={busy} className="text-xs font-semibold text-amber-800">
                      Save
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="whitespace-pre-wrap text-sm text-ink">{n.body}</p>
                  <div className="mt-1 flex items-center gap-2 text-xs text-amber-800/80">
                    <span>
                      {author(n.user_id)} · {fmtDateTime(n.created_at)}
                    </span>
                    {mine && (
                      <span className="ml-auto flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/note:opacity-100">
                        <button
                          onClick={() => {
                            setEditId(n.id);
                            setEditBody(n.body);
                          }}
                          aria-label="Edit note"
                          className="rounded p-1 hover:bg-amber-100"
                        >
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => setDeleteId(n.id)} aria-label="Delete note" className="rounded p-1 hover:bg-amber-100">
                          <Trash2 size={13} />
                        </button>
                      </span>
                    )}
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={deleteId != null}
        title="Delete note"
        message="Delete this internal note? This can't be undone."
        confirmLabel="Delete"
        danger
        busy={busy}
        onConfirm={() => void doDelete()}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}

// ── Media ───────────────────────────────────────────────────────────────────

interface MediaRow {
  id: number;
  message_type: string;
  media_url: string | null;
  content: string | null;
  direction: string;
  timestamp: string;
}

function MediaTab({ conversationId }: { conversationId: number }) {
  const [data, setData] = useState<{ media: MediaRow[]; links: { messageId: number; url: string; timestamp: string }[] } | null>(null);
  const [error, setError] = useState(false);
  const [kind, setKind] = useState<'media' | 'docs' | 'links'>('media');
  const load = useCallback(() => {
    setError(false);
    apiFetch<typeof data>(`/inbox/conversations/${conversationId}/media`)
      .then(setData)
      .catch(() => setError(true));
  }, [conversationId]);
  useEffect(() => {
    load();
  }, [load]);
  if (error) {
    return (
      <p className="py-6 text-center text-sm text-muted">
        Couldn’t load shared media.{' '}
        <button onClick={load} className="font-semibold text-brand-700 underline">
          Retry
        </button>
      </p>
    );
  }
  if (!data) return <Skeleton className="h-32 rounded-lg" />;
  const visual = data.media.filter((m) => m.message_type === 'image' || m.message_type === 'video');
  const docs = data.media.filter((m) => m.message_type === 'document' || m.message_type === 'audio');
  return (
    <div className="space-y-3">
      <div className="flex gap-1" role="group" aria-label="Media type">
        {(
          [
            ['media', `Photos (${visual.length})`],
            ['docs', `Files (${docs.length})`],
            ['links', `Links (${data.links.length})`],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-semibold',
              kind === k ? 'bg-brand-600 text-white' : 'bg-sunken text-muted hover:text-ink',
            )}
          >
            {l}
          </button>
        ))}
      </div>
      {kind === 'media' &&
        (visual.length ? (
          <div className="grid grid-cols-3 gap-1">
            {visual.map((m) => (
              <a
                key={m.id}
                href={mediaUrl(m.media_url) ?? '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="relative block aspect-square overflow-hidden rounded-md bg-sunken"
                title={fmtDateTime(m.timestamp)}
              >
                {m.message_type === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={mediaUrl(m.media_url?.replace(/\.[^./]+$/, '.thumb.jpg') ?? null) ?? undefined}
                    onError={(e) => {
                      const full = mediaUrl(m.media_url);
                      if (full && e.currentTarget.src !== full) e.currentTarget.src = full;
                    }}
                    alt={m.content?.slice(0, 80) || `Photo from ${fmtDate(m.timestamp)}`}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-xs font-semibold text-muted">
                    <ImageIcon size={18} aria-hidden /> Video
                  </span>
                )}
              </a>
            ))}
          </div>
        ) : (
          <p className="py-4 text-center text-xs text-muted">No photos or videos yet.</p>
        ))}
      {kind === 'docs' &&
        (docs.length ? (
          <ul className="space-y-1.5">
            {docs.map((m) => (
              <li key={m.id}>
                <a
                  href={mediaUrl(m.media_url) ?? '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-2 text-sm hover:bg-sunken"
                >
                  <FileText size={16} className="shrink-0 text-brand-700" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    {m.content?.trim() || (m.media_url ?? '').split('/').pop() || 'File'}
                  </span>
                  <span className="shrink-0 text-xs text-muted">{fmtDate(m.timestamp)}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-4 text-center text-xs text-muted">No files yet.</p>
        ))}
      {kind === 'links' &&
        (data.links.length ? (
          <ul className="space-y-1.5">
            {data.links.map((l, i) => (
              <li key={`${l.messageId}-${i}`}>
                <a
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-2 text-sm hover:bg-sunken"
                >
                  <Link2 size={15} className="shrink-0 text-sky-700" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sky-800">{l.url.replace(/^https?:\/\//, '')}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-4 text-center text-xs text-muted">No links yet.</p>
        ))}
    </div>
  );
}
