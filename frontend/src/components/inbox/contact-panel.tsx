'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  X,
  Package,
  Phone,
  Mail,
  Truck,
  ChevronRight,
  ShoppingCart,
  UserPlus,
  Ban,
  StickyNote,
  Bot,
  Megaphone,
  Plus,
  Copy,
  Check,
} from 'lucide-react';
import { fmtDate, cn } from '@/lib/utils';
import { apiFetch, ApiError } from '@/lib/api';
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
import type { ConversationNote } from '@/lib/inbox-types';
import type { TeamMember } from '@/lib/crm-types';
import { OrderNameButton } from '@/components/orders/order-detail-view';
import { markOrderNoResponse } from '@/lib/couriers';
import { useToast } from '@/components/toast';

// An order still awaiting the customer (live COD, unfulfilled, not yet
// confirmed / no-response) can be marked "no response" after a manual call.
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

/** Progress along the courier journey, 0–1, for the thin bar on an order card. */
function orderProgress(o: ContactOrder): number {
  if (o.cancelled) return 0;
  if (orderIsDelivered(o)) return 1;
  const s = (o.shipmentStatus || o.fulfillmentStatus || '').toLowerCase();
  if (/return|fail/.test(s)) return 1;
  if (/out for|attempt/.test(s)) return 0.75;
  if (/transit|pick/.test(s)) return 0.5;
  if (s) return 0.3; // booked / label made
  return 0.12; // placed only
}

/** Compact header chip: latest order + status, or "N orders". Opens the panel. */
export function ContactOrderChip({
  orders,
  onClick,
}: {
  orders: ContactOrders | null;
  onClick: () => void;
}) {
  if (!orders || orders.count === 0) return null;
  const latest = orders.orders[0];
  const label =
    orders.count > 1 ? `${orders.count} orders` : latest.orderName ?? '1 order';
  return (
    <button
      type="button"
      onClick={onClick}
      title="View this contact's orders"
      className={cn(
        'hidden sm:inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full shrink-0 hover:brightness-95',
        orderStatusTone(latest),
      )}
    >
      <Package size={12} />
      {label}
      {orders.count === 1 && (
        <span className="opacity-70">· {orderDisplayStatus(latest)}</span>
      )}
    </button>
  );
}

type OrderSegment = 'all' | 'active' | 'issues';

export interface ContactInfoPanelProps {
  conversationId: number;
  name: string | null;
  phone: string | null;
  email: string | null;
  orders: ContactOrders | null;
  loading: boolean;
  /** Contact tags (contact-scoped, e.g. "📢 From Ad", "VIP"). */
  tags: string[];
  /** Persist a new tag set (PATCH /contacts/:id). */
  onSetTags: (next: string[]) => Promise<void> | void;
  status: 'open' | 'resolved' | 'pending';
  blocked: boolean;
  assignedAgentName: string | null;
  /** First-touch attribution, if the chat came from a Meta ad/post. */
  referralSource: 'ad' | 'post' | null;
  /** For resolving note authors by user_id. */
  members: TeamMember[];
  // AI auto-pilot
  aiEnabled: boolean;
  autoReplyOn: boolean; // ai_autoreply === true (forced on this chat)
  autoReplyMuted: boolean; // ai_autoreply === false (muted)
  allChatsOn: boolean; // workspace answers every chat → per-chat toggle disabled
  onAiToggle: (mode: 'on' | 'off') => void;
  // Quick actions
  onCreateOrder?: () => void; // undefined → Shopify not configured / no permission
  onAssignToMe: () => void;
  onToggleBlock: () => void;
  onOpenNotes: () => void;
  onClose: () => void;
  /** Open the courier tracking timeline for a (trackable) order. */
  onTrack?: (o: ContactOrder) => void;
}

/** WhatsApp-style contact info panel — slides in on the right, shrinking the
 *  chat on desktop; full-screen overlay on mobile. A decision surface: identity,
 *  quick actions, customer intelligence, ownership, tags/context, then orders. */
export function ContactInfoPanel(props: ContactInfoPanelProps) {
  const {
    conversationId,
    name,
    phone,
    email,
    orders,
    loading,
    tags,
    onSetTags,
    status,
    blocked,
    assignedAgentName,
    referralSource,
    members,
    aiEnabled,
    autoReplyOn,
    autoReplyMuted,
    allChatsOn,
    onAiToggle,
    onCreateOrder,
    onAssignToMe,
    onToggleBlock,
    onOpenNotes,
    onClose,
    onTrack,
  } = props;

  const summary = useMemo(() => summarizeContactOrders(orders), [orders]);
  const [seg, setSeg] = useState<OrderSegment>('all');
  const [copied, setCopied] = useState(false);

  const visibleOrders = useMemo(() => {
    const list = orders?.orders ?? [];
    if (seg === 'active') return list.filter((o) => orderIsActive(o) && !orderIsIssue(o));
    if (seg === 'issues') return list.filter(orderIsIssue);
    return list;
  }, [orders, seg]);

  const copyPhone = async () => {
    if (!phone) return;
    try {
      await navigator.clipboard.writeText(phone);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  const statusTone =
    status === 'open'
      ? 'bg-green-500'
      : status === 'pending'
        ? 'bg-amber-500'
        : 'bg-gray-300';

  // Quick actions, built dynamically (Order only when Shopify is configured).
  const actions: {
    key: string;
    icon: ReactNode;
    label: string;
    onClick?: () => void;
    href?: string;
    danger?: boolean;
  }[] = [];
  if (phone)
    actions.push({ key: 'call', icon: <Phone size={16} />, label: 'Call', href: `tel:${phone}` });
  if (onCreateOrder)
    actions.push({ key: 'order', icon: <ShoppingCart size={16} />, label: 'Order', onClick: onCreateOrder });
  actions.push({ key: 'assign', icon: <UserPlus size={16} />, label: 'Assign me', onClick: onAssignToMe });
  actions.push({
    key: 'block',
    icon: <Ban size={16} />,
    label: blocked ? 'Unblock' : 'Block',
    onClick: onToggleBlock,
    danger: !blocked,
  });

  return (
    <aside className="fixed inset-0 z-50 flex flex-col bg-white md:static md:z-auto md:w-80 md:shrink-0 md:border-l md:border-gray-200 h-full">
      {/* Identity */}
      <div className="flex items-center gap-3 px-4 py-4 border-b border-gray-100 shrink-0">
        <span className="relative w-12 h-12 rounded-full bg-gradient-to-br from-green-500 to-green-700 text-white flex items-center justify-center text-lg font-semibold shrink-0">
          {(name || phone || '?')[0]?.toUpperCase()}
          <span
            className={cn(
              'absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ring-2 ring-white',
              statusTone,
            )}
            title={status}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-gray-900 truncate">
            {name || phone || 'Contact'}
          </p>
          {phone && (
            <button
              type="button"
              onClick={copyPhone}
              className="group inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
              title="Copy number"
            >
              <span className="truncate">{phone}</span>
              {copied ? (
                <Check size={11} className="text-green-600" />
              ) : (
                <Copy size={11} className="opacity-0 group-hover:opacity-100" />
              )}
            </button>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 self-start"
          aria-label="Close contact details"
        >
          <X size={18} />
        </button>
      </div>

      {/* Quick actions */}
      <div
        className="grid gap-1.5 px-3 py-2.5 border-b border-gray-100 shrink-0"
        style={{ gridTemplateColumns: `repeat(${actions.length}, minmax(0, 1fr))` }}
      >
        {actions.map((a) => {
          const cls = cn(
            'flex flex-col items-center gap-1 py-2 rounded-lg text-[11px] font-medium border transition',
            a.danger
              ? 'text-rose-600 border-rose-100 bg-rose-50 hover:bg-rose-100'
              : 'text-green-800 border-gray-100 bg-gray-50 hover:bg-gray-100',
          );
          return a.href ? (
            <a key={a.key} href={a.href} className={cls}>
              {a.icon}
              {a.label}
            </a>
          ) : (
            <button key={a.key} type="button" onClick={a.onClick} className={cls}>
              {a.icon}
              {a.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Customer intelligence */}
        {summary && (
          <div className="grid grid-cols-3 divide-x divide-gray-100 border-b border-gray-100">
            <Stat label="Lifetime" value={moneyCompact(summary.ltv, summary.currency)} />
            <Stat label="Orders" value={String(summary.count)} />
            <Stat
              label="Delivered"
              value={summary.deliveredRate == null ? '—' : `${summary.deliveredRate}%`}
              tone={
                summary.deliveredRate == null
                  ? undefined
                  : summary.deliveredRate >= 70
                    ? 'good'
                    : summary.deliveredRate >= 40
                      ? 'warn'
                      : 'bad'
              }
            />
          </div>
        )}

        {/* Ownership + AI auto-pilot */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-gray-100">
          <span className="w-6 h-6 rounded-full bg-fuchsia-600 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
            {assignedAgentName
              ? assignedAgentName.slice(0, 2).toUpperCase()
              : '—'}
          </span>
          <div className="min-w-0 leading-tight">
            <p className="text-xs font-semibold text-gray-800 truncate">
              {assignedAgentName || 'Unassigned'}
            </p>
            <p className="text-[11px] text-gray-400">Assigned agent</p>
          </div>
          {aiEnabled && (
            <button
              type="button"
              onClick={() => !allChatsOn && onAiToggle(autoReplyOn ? 'off' : 'on')}
              disabled={allChatsOn}
              className={cn(
                'ml-auto inline-flex items-center gap-1.5 text-[11px] font-semibold',
                allChatsOn ? 'text-gray-400 cursor-default' : 'text-green-700',
              )}
              title={
                allChatsOn
                  ? 'Auto-pilot answers every chat (workspace setting)'
                  : autoReplyOn
                    ? 'Auto-pilot on for this chat — tap to mute'
                    : 'Turn AI auto-pilot on for this chat'
              }
            >
              <Bot size={13} />
              <span
                className={cn(
                  'relative w-8 h-[18px] rounded-full transition-colors',
                  allChatsOn || autoReplyOn ? 'bg-green-500' : 'bg-gray-300',
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 w-[14px] h-[14px] rounded-full bg-white transition-all',
                    allChatsOn || autoReplyOn ? 'right-0.5' : 'left-0.5',
                  )}
                />
              </span>
            </button>
          )}
        </div>

        {/* Contact rows */}
        {email && (
          <div className="px-4 py-3 border-b border-gray-100">
            <Row icon={<Mail size={13} />} text={email} />
          </div>
        )}

        {/* Tags & context */}
        <div className="px-4 py-3 border-b border-gray-100">
          <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
            Tags &amp; context
          </span>
          <TagEditor
            tags={tags}
            referralSource={referralSource}
            onSetTags={onSetTags}
          />
          <NotePreview
            conversationId={conversationId}
            members={members}
            onOpenNotes={onOpenNotes}
          />
        </div>

        {/* Orders */}
        <div className="px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
              Orders
            </span>
            {summary && (
              <span className="text-[11px] text-gray-400">
                {summary.count} · {money(summary.ltv, summary.currency)}
              </span>
            )}
          </div>

          {summary && summary.count > 1 && (
            <div className="flex gap-1 bg-gray-50 border border-gray-100 rounded-lg p-0.5 mb-2.5">
              {(
                [
                  ['all', `All ${summary.count}`],
                  ['active', `Active ${summary.activeCount}`],
                  ['issues', `Issues ${summary.issuesCount}`],
                ] as [OrderSegment, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSeg(key)}
                  className={cn(
                    'flex-1 text-[11px] font-medium py-1 rounded-md transition',
                    seg === key
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {loading ? (
            <div className="text-sm text-gray-400 py-6 text-center">Loading…</div>
          ) : !orders || orders.count === 0 ? (
            <div className="text-sm text-gray-400 py-6 text-center">
              No orders found for this contact.
            </div>
          ) : visibleOrders.length === 0 ? (
            <div className="text-sm text-gray-400 py-5 text-center">
              Nothing in this view.
            </div>
          ) : (
            <div className="space-y-2">
              {visibleOrders.map((o) => (
                <OrderCard key={o.orderGid} o={o} onTrack={onTrack} />
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'bad';
}) {
  return (
    <div className="px-2 py-3 text-center">
      <p
        className={cn(
          'text-base font-bold tracking-tight tabular-nums',
          tone === 'good' && 'text-green-600',
          tone === 'warn' && 'text-amber-600',
          tone === 'bad' && 'text-rose-600',
          !tone && 'text-gray-900',
        )}
      >
        {value}
      </p>
      <p className="text-[9.5px] font-semibold uppercase tracking-wide text-gray-400 mt-0.5">
        {label}
      </p>
    </div>
  );
}

function TagEditor({
  tags,
  referralSource,
  onSetTags,
}: {
  tags: string[];
  referralSource: 'ad' | 'post' | null;
  onSetTags: (next: string[]) => Promise<void> | void;
}) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (next: string[]) => {
    setBusy(true);
    try {
      await onSetTags(next);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to update tags');
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const t = value.trim();
    setValue('');
    setAdding(false);
    if (!t || tags.includes(t)) return;
    await save([...tags, t]);
  };

  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {referralSource && (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
          <Megaphone size={10} />
          {referralSource === 'ad' ? 'From Ad' : 'From Post'}
        </span>
      )}
      {tags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-600"
        >
          {t}
          <button
            type="button"
            disabled={busy}
            onClick={() => save(tags.filter((x) => x !== t))}
            className="text-gray-400 hover:text-rose-600 disabled:opacity-50"
            aria-label={`Remove ${t}`}
          >
            <X size={10} />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          autoFocus
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
            if (e.key === 'Escape') {
              setValue('');
              setAdding(false);
            }
          }}
          placeholder="tag…"
          className="text-[11px] px-2 py-0.5 rounded-full border border-green-300 outline-none w-20 focus:ring-1 focus:ring-green-400"
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-0.5 text-[11px] font-medium px-2 py-0.5 rounded-full border border-dashed border-gray-300 text-gray-400 hover:text-gray-600 hover:border-gray-400"
        >
          <Plus size={10} /> add
        </button>
      )}
    </div>
  );
}

function NotePreview({
  conversationId,
  members,
  onOpenNotes,
}: {
  conversationId: number;
  members: TeamMember[];
  onOpenNotes: () => void;
}) {
  const [latest, setLatest] = useState<ConversationNote | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch<ConversationNote[]>(`/inbox/conversations/${conversationId}/notes`)
      .then((n) => {
        if (!alive) return;
        const sorted = [...n].sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        );
        setLatest(sorted[0] ?? null);
      })
      .catch(() => {
        /* notes are best-effort in the panel */
      });
    return () => {
      alive = false;
    };
  }, [conversationId]);

  const author = latest
    ? members.find((m) => m.id === latest.user_id)?.name ?? null
    : null;

  return (
    <button
      type="button"
      onClick={onOpenNotes}
      className="mt-2.5 w-full text-left"
      title="Open internal notes"
    >
      {latest ? (
        <div className="relative rounded-lg bg-amber-50 border border-amber-100 pl-3 pr-2.5 py-2 hover:bg-amber-100/70 transition">
          <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded bg-amber-400" />
          <p className="text-xs text-gray-700 line-clamp-2">
            {author && <span className="font-semibold text-gray-800">{author}: </span>}
            {latest.body}
          </p>
          <p className="text-[10px] text-amber-700/80 mt-1">
            {fmtDate(latest.created_at)} · Internal note
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 text-[11px] text-gray-400 hover:text-gray-600">
          <StickyNote size={12} /> Add an internal note
        </div>
      )}
    </button>
  );
}

function Row({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-gray-700">
      <span className="text-gray-400 shrink-0">{icon}</span>
      <span className="truncate">{text}</span>
    </div>
  );
}

function OrderCard({
  o,
  onTrack,
}: {
  o: ContactOrder;
  onTrack?: (o: ContactOrder) => void;
}) {
  const toast = useToast();
  const total = money(o.total, o.currency);
  const cod =
    o.outstanding && o.outstanding > 0 ? money(o.outstanding, o.currency) : null;
  const trackable = !!onTrack && isOrderTrackable(o);
  // Local optimistic state so the badge/button flip instantly on click (the
  // authoritative value reloads next time the panel opens).
  const [noResp, setNoResp] = useState<boolean>(!!o.noResponseAt);
  const [busy, setBusy] = useState(false);
  const showNoRespBtn = !noResp && canMarkNoResponse(o);
  const progress = orderProgress(o);
  const progressTone = orderIsDelivered(o)
    ? 'bg-green-500'
    : orderIsIssue(o)
      ? 'bg-rose-500'
      : 'bg-blue-500';

  const markNoResp = async () => {
    setBusy(true);
    try {
      await markOrderNoResponse(o.orderGid);
      setNoResp(true);
      toast.success(`Marked ${o.orderName ?? 'order'} no response`);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to mark no response',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm truncate">
          <OrderNameButton name={o.orderName ?? 'Order'} gid={o.orderGid} />
        </span>
        <span
          className={cn(
            'text-[11px] px-2 py-0.5 rounded-full shrink-0',
            orderStatusTone(o),
          )}
        >
          {orderDisplayStatus(o)}
        </span>
      </div>
      {o.itemsSummary && (
        <p className="text-xs text-gray-500 mt-1 truncate">{o.itemsSummary}</p>
      )}
      {!o.cancelled && (
        <div className="mt-2 h-1 rounded-full bg-gray-100 overflow-hidden">
          <div
            className={cn('h-full rounded-full', progressTone)}
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      )}
      <div className="flex items-center justify-between mt-1.5 text-[11px] text-gray-400 gap-2">
        <span className="shrink-0">{o.createdAt ? fmtDate(o.createdAt) : ''}</span>
        {total && (
          <span className="text-gray-700 font-medium truncate text-right">
            {total}
            {cod && <span className="text-rose-600"> · COD {cod}</span>}
          </span>
        )}
      </div>
      {o.trackingNumber && (
        <div className="mt-1.5 flex items-center gap-1 text-[11px] text-gray-500">
          <Truck size={11} className="text-gray-400 shrink-0" />
          <span className="capitalize">{o.courierType ?? 'Courier'}</span>
          <span className="truncate">· {o.trackingNumber}</span>
        </div>
      )}
      {(noResp || showNoRespBtn) && (
        <div className="mt-2 flex items-center justify-between gap-2">
          {noResp ? (
            <span className="text-[10px] font-medium rounded-full bg-orange-50 text-orange-700 px-2 py-0.5">
              ❌ No response
            </span>
          ) : (
            <span />
          )}
          {showNoRespBtn && (
            <button
              type="button"
              onClick={markNoResp}
              disabled={busy}
              className="text-[11px] font-medium text-orange-700 hover:underline disabled:opacity-50"
              title="Called the customer, no answer — tag ❌ NO RESPONSE in Shopify + mark it here"
            >
              {busy ? 'Marking…' : 'No response'}
            </button>
          )}
        </div>
      )}
      {trackable && (
        <button
          type="button"
          onClick={() => onTrack!(o)}
          className="mt-2 flex w-full items-center justify-end gap-0.5 rounded text-[11px] font-medium text-green-700 transition hover:text-green-800"
        >
          View tracking <ChevronRight size={13} />
        </button>
      )}
    </div>
  );
}
