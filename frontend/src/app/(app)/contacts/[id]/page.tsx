'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  ChevronDown,
  Copy,
  LifeBuoy,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  Send,
  ShoppingBag,
  StickyNote,
  UserX,
} from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { useSip } from '@/context/sip-context';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/modal';
import { Dropdown, DropdownItem } from '@/components/ui/dropdown';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton, SkeletonRows } from '@/components/ui/skeleton';
import { ContactFormModal } from '@/components/contacts/contact-form-modal';
import { TagEditor } from '@/components/contacts/tag-editor';
import {
  CustomFieldsEditor,
  FieldRow,
  fieldsFromRows,
  rowsFromFields,
} from '@/components/contacts/custom-fields-editor';
import { OrderNameButton } from '@/components/orders/order-detail-view';
import { cn, fmtDate, fmtDateTime, fmtListTime } from '@/lib/utils';
import type { Contact } from '@/lib/crm-types';
import {
  ContactOverview,
  deleteContact,
  ensureConversation,
  formatPhone,
  getContactOverview,
  initials,
  isManagerRole,
  listContactTags,
  updateContact,
} from '@/lib/contacts';
import {
  ContactOrders,
  getContactOrders,
  moneyCompact,
  orderDisplayStatus,
  orderStatusTone,
  summarizeContactOrders,
} from '@/lib/contact-orders';

type Tab = 'timeline' | 'conversations' | 'orders' | 'tickets' | 'calls' | 'notes';

type TimelineItem = {
  key: string;
  at: string;
  icon: React.ElementType;
  tone: string;
  title: React.ReactNode;
  detail?: React.ReactNode;
  href?: string;
};

const fmtDur = (s: number | null) =>
  s == null ? '' : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;

export default function ContactDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const validId = Number.isInteger(id) && id > 0;
  const router = useRouter();
  const toast = useToast();
  const { user } = useAuth();
  const { on } = useSocket();
  const sip = useSip();
  const canManage = isManagerRole(user?.role);

  const [ov, setOv] = useState<ContactOverview | null>(null);
  const [loading, setLoading] = useState(validId);
  const [notFound, setNotFound] = useState(!validId);
  const [orders, setOrders] = useState<ContactOrders | null>(null);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [tagOptions, setTagOptions] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>('timeline');
  const [editOpen, setEditOpen] = useState(false);
  const [fieldsEditing, setFieldsEditing] = useState(false);
  const [fieldRows, setFieldRows] = useState<FieldRow[]>([]);
  const [savingFields, setSavingFields] = useState(false);
  const [patching, setPatching] = useState(false);
  const [confirm, setConfirm] = useState<null | 'block' | 'archive' | 'delete' | 'optout'>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [opening, setOpening] = useState(false);

  const contact = ov?.contact ?? null;

  const load = useCallback(
    async (silent = false) => {
      if (!validId) return;
      if (!silent) setLoading(true);
      try {
        const data = await getContactOverview(id);
        setOv(data);
        setNotFound(false);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else if (!silent) toast.error(e instanceof ApiError ? e.userMessage : 'Could not load the contact');
      } finally {
        setLoading(false);
      }
    },
    [id, validId, toast],
  );

  useEffect(() => {
    void load();
    listContactTags().then(setTagOptions).catch(() => undefined);
  }, [load]);

  // Orders by phone (Shopify mirror) — loaded once the phone is known.
  const phone = contact?.phone;
  useEffect(() => {
    if (!phone) return;
    setOrdersLoading(true);
    getContactOrders(phone)
      .then(setOrders)
      .catch(() => setOrders(null))
      .finally(() => setOrdersLoading(false));
  }, [phone]);

  // Live updates from other agents / the inbox.
  useEffect(() => {
    const offContact = on<{ contactId?: number; bulk?: boolean }>('contact.updated', (p) => {
      if (p?.bulk || p?.contactId === id) void load(true);
    });
    const offNote = on<{ conversationId?: number }>('note.changed', (p) => {
      if (ov?.conversations.some((c) => c.id === p?.conversationId)) void load(true);
    });
    return () => {
      offContact();
      offNote();
    };
  }, [on, id, load, ov?.conversations]);

  const summary = useMemo(() => summarizeContactOrders(orders), [orders]);

  const patch = async (body: Record<string, unknown>, ok: string) => {
    if (!contact) return;
    setPatching(true);
    try {
      const updated = await updateContact(contact.id, body);
      setOv((cur) => (cur ? { ...cur, contact: updated } : cur));
      toast.success(ok);
      setConfirm(null);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Update failed');
      throw e;
    } finally {
      setPatching(false);
    }
  };

  const openChat = async () => {
    if (!contact) return;
    setOpening(true);
    try {
      const { conversationId } = await ensureConversation(contact.id);
      router.push(`/inbox/${conversationId}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not open the chat');
      setOpening(false);
    }
  };

  const doDelete = async () => {
    if (!contact) return;
    setPatching(true);
    try {
      await deleteContact(contact.id);
      toast.success('Contact deleted');
      router.push('/contacts');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not delete');
      setPatching(false);
    }
  };

  const saveFields = async () => {
    const r = fieldsFromRows(fieldRows);
    if ('error' in r) {
      toast.error(r.error);
      return;
    }
    setSavingFields(true);
    try {
      await patch({ customFields: r.fields }, 'Fields saved');
      setFieldsEditing(false); // only closes after a successful save
    } catch {
      /* toast already shown; keep the editor open */
    } finally {
      setSavingFields(false);
    }
  };

  const addNote = async () => {
    const body = noteDraft.trim();
    if (!body || !contact) return;
    setSavingNote(true);
    try {
      const convId = ov?.conversations[0]?.id ?? (await ensureConversation(contact.id)).conversationId;
      await apiFetch(`/inbox/conversations/${convId}/notes`, { method: 'POST', body: { body } });
      setNoteDraft('');
      void load(true);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save the note');
    } finally {
      setSavingNote(false);
    }
  };

  const copyPhone = async () => {
    if (!contact) return;
    try {
      await navigator.clipboard.writeText(formatPhone(contact.phone).replace(/\s/g, ''));
      toast.success('Number copied');
    } catch {
      /* ignore */
    }
  };

  const timeline = useMemo<TimelineItem[]>(() => {
    if (!ov) return [];
    const items: TimelineItem[] = [];
    for (const c of ov.conversations) {
      if (c.last_message_at)
        items.push({
          key: `cm${c.id}`,
          at: c.last_message_at,
          icon: MessageCircle,
          tone: 'bg-brand-50 text-brand-700',
          title: 'Last message',
          detail: c.last_message ? `“${c.last_message.slice(0, 140)}”` : undefined,
          href: `/inbox/${c.id}`,
        });
      items.push({
        key: `cs${c.id}`,
        at: c.created_at,
        icon: MessageCircle,
        tone: 'bg-sunken text-muted',
        title: 'Conversation started',
        detail: c.assigned_user ? `Assigned to ${c.assigned_user.name}` : undefined,
        href: `/inbox/${c.id}`,
      });
    }
    for (const t of ov.tickets)
      items.push({
        key: `t${t.id}`,
        at: t.created_at,
        icon: LifeBuoy,
        tone: 'bg-amber-50 text-amber-700',
        title: `Ticket ${t.ticket_number} · ${t.type}`,
        detail: `${t.status}${t.linked_order_name ? ` · order ${t.linked_order_name}` : ''}`,
      });
    for (const c of ov.calls)
      items.push({
        key: `c${c.id}`,
        at: c.started_at ?? c.created_at,
        icon: c.direction === 'inbound' ? PhoneIncoming : PhoneOutgoing,
        tone: c.status === 'completed' || c.status === 'answered' ? 'bg-sky-50 text-sky-700' : 'bg-red-50 text-red-700',
        title: `${c.direction === 'inbound' ? 'Incoming' : 'Outgoing'} call · ${c.status}`,
        detail: [fmtDur(c.duration_sec), c.user?.name].filter(Boolean).join(' · ') || undefined,
      });
    for (const n of ov.notes)
      items.push({
        key: `n${n.id}`,
        at: n.created_at,
        icon: StickyNote,
        tone: 'bg-violet-50 text-violet-700',
        title: `Note${n.user_name ? ` by ${n.user_name}` : ''}`,
        detail: n.body,
      });
    for (const o of orders?.orders ?? [])
      if (o.createdAt)
        items.push({
          key: `o${o.orderGid}`,
          at: o.createdAt,
          icon: ShoppingBag,
          tone: 'bg-emerald-50 text-emerald-700',
          title: `Order ${o.orderName ?? ''} · ${orderDisplayStatus(o)}`,
          detail: [o.total != null ? moneyCompact(o.total, o.currency) : null, o.itemsSummary].filter(Boolean).join(' · '),
        });
    return items.sort((a, b) => +new Date(b.at) - +new Date(a.at)).slice(0, 80);
  }, [ov, orders]);

  // ---------------------------------------------------------------- states

  if (notFound) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <EmptyState
          icon={UserX}
          title="Contact not found"
          description="It may have been deleted or merged into another contact."
          action={
            <Link href="/contacts" className="text-sm font-semibold text-brand-700 hover:underline">
              Back to contacts
            </Link>
          }
        />
      </div>
    );
  }

  if (loading || !contact || !ov) {
    return (
      <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-4" aria-busy>
        <Skeleton className="h-8 w-56" />
        <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <Skeleton className="h-96" />
          <div className="space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-20" />
              ))}
            </div>
            <SkeletonRows rows={6} />
          </div>
        </div>
      </div>
    );
  }

  const tags = Array.isArray(contact.tags) ? contact.tags : [];
  const fields = Object.entries(contact.custom_fields ?? {});
  const latestConv = ov.conversations[0];
  const windowOpen = !!latestConv?.window_expires_at && new Date(latestConv.window_expires_at) > new Date();

  const menu: DropdownItem[] = [
    contact.status === 'blocked'
      ? { key: 'unblock', label: 'Unblock', icon: CheckCircle2, onSelect: () => void patch({ status: 'active' }, 'Contact unblocked') }
      : { key: 'block', label: 'Block', icon: Ban, onSelect: () => setConfirm('block') },
    contact.status === 'archived'
      ? { key: 'unarchive', label: 'Move back to active', onSelect: () => void patch({ status: 'active' }, 'Contact restored') }
      : { key: 'archive', label: 'Archive', onSelect: () => setConfirm('archive') },
    contact.opted_out_at
      ? { key: 'optin', label: 'Re-subscribe to broadcasts', onSelect: () => void patch({ optedOut: false }, 'Subscribed to broadcasts') }
      : { key: 'optout', label: 'Opt out of broadcasts', onSelect: () => setConfirm('optout') },
    ...(canManage
      ? [{ key: 'delete', label: 'Delete contact', danger: true, onSelect: () => setConfirm('delete') } as DropdownItem]
      : []),
  ];

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'timeline', label: 'Timeline' },
    { key: 'conversations', label: 'Chats', count: ov.conversations.length },
    { key: 'orders', label: 'Orders', count: orders?.lifetime?.count ?? orders?.count },
    { key: 'tickets', label: 'Tickets', count: ov.tickets.length },
    { key: 'calls', label: 'Calls', count: ov.calls.length },
    { key: 'notes', label: 'Notes', count: ov.notes.length },
  ];

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div className="mr-auto min-w-0">
          <button
            type="button"
            onClick={() => (window.history.length > 1 ? router.back() : router.push('/contacts'))}
            className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink"
          >
            <ArrowLeft size={14} /> Contacts
          </button>
          <h1 className="text-2xl font-bold text-ink truncate">{contact.name}</h1>
        </div>
        <Button onClick={openChat} loading={opening}>
          <MessageCircle size={15} /> Open chat
        </Button>
        <Button variant="secondary" onClick={openChat} disabled={opening} title="Opens the chat — outside 24 hours only templates can be sent">
          <Send size={15} /> Send template
        </Button>
        {sip?.available && (
          <Button variant="secondary" onClick={() => sip.placeCall(contact.phone)} disabled={!sip.ready}>
            <Phone size={15} /> Call
          </Button>
        )}
        <Button variant="secondary" onClick={() => setEditOpen(true)}>
          <Pencil size={15} /> Edit
        </Button>
        <Dropdown
          label="More actions"
          items={menu}
          trigger={
            <span className="inline-flex h-10 items-center gap-1 rounded-lg border border-line bg-surface px-3 text-sm font-semibold text-ink hover:bg-sunken">
              <MoreHorizontal size={16} /> <ChevronDown size={13} />
            </span>
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)] items-start">
        {/* Profile */}
        <Card className="p-5 space-y-5">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="h-14 w-14 shrink-0 rounded-full bg-sky-50 text-sky-700 text-lg font-bold inline-flex items-center justify-center"
            >
              {initials(contact.name)}
            </span>
            <div className="min-w-0">
              <p className="font-semibold text-ink truncate">{contact.name}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {contact.status === 'active' && <Badge tone="success">Active</Badge>}
                {contact.status === 'blocked' && <Badge tone="danger">Blocked</Badge>}
                {contact.status === 'archived' && <Badge tone="neutral">Archived</Badge>}
                {contact.opted_out_at ? (
                  <Badge tone="warn" title={`Since ${fmtDate(contact.opted_out_at)}`}>
                    {contact.opt_out_source === 'whatsapp_stop' ? 'Replied STOP' : 'Opted out'}
                  </Badge>
                ) : (
                  <Badge tone="brand">Subscribed</Badge>
                )}
              </div>
            </div>
          </div>

          <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted">Phone</dt>
            <dd className="flex items-center gap-1 tabular-nums text-ink">
              {formatPhone(contact.phone)}
              <button type="button" onClick={copyPhone} aria-label="Copy number" className="p-1 rounded text-muted hover:text-ink hover:bg-sunken">
                <Copy size={12} />
              </button>
            </dd>
            <dt className="text-muted">Email</dt>
            <dd className="text-ink break-all">{contact.email || <span className="text-muted">—</span>}</dd>
            <dt className="text-muted">City</dt>
            <dd className="text-ink">{contact.city || <span className="text-muted">—</span>}</dd>
            <dt className="text-muted">Address</dt>
            <dd className="text-ink">{contact.address || <span className="text-muted">—</span>}</dd>
            <dt className="text-muted">Added</dt>
            <dd className="text-ink">{fmtDate(contact.created_at)}</dd>
            <dt className="text-muted">Last msg</dt>
            <dd className="text-ink">{contact.last_message_at ? fmtDateTime(contact.last_message_at) : <span className="text-muted">Never</span>}</dd>
          </dl>

          <div>
            <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-1.5">Tags</p>
            <TagEditor
              tags={tags}
              suggestions={tagOptions}
              disabled={patching}
              onChange={(next) => patch({ tags: next }, 'Tags updated')}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-xs font-semibold text-muted uppercase tracking-wide">Custom fields</p>
              {!fieldsEditing && (
                <button
                  type="button"
                  onClick={() => {
                    setFieldRows(rowsFromFields(contact.custom_fields));
                    setFieldsEditing(true);
                  }}
                  className="text-xs font-semibold text-brand-700 hover:underline"
                >
                  Edit
                </button>
              )}
            </div>
            {fieldsEditing ? (
              <div className="space-y-2">
                <CustomFieldsEditor rows={fieldRows} onChange={setFieldRows} disabled={savingFields} />
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setFieldsEditing(false)} disabled={savingFields}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={saveFields} loading={savingFields}>
                    Save
                  </Button>
                </div>
              </div>
            ) : fields.length ? (
              <dl className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1.5 text-sm">
                {fields.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted truncate">{k}</dt>
                    <dd className="text-ink break-words">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted">None yet.</p>
            )}
          </div>
        </Card>

        <div className="min-w-0 space-y-4">
          {/* Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Lifetime value" value={ordersLoading ? null : summary ? moneyCompact(summary.ltv, summary.currency) : '—'} />
            <Stat label="Orders" value={ordersLoading ? null : String(summary?.count ?? 0)} sub={summary?.aov ? `AOV ${moneyCompact(summary.aov, summary.currency)}` : undefined} />
            <Stat
              label="Delivered"
              value={ordersLoading ? null : summary?.deliveredRate != null ? `${summary.deliveredRate}%` : '—'}
              sub={summary?.issuesCount ? `${summary.issuesCount} with issues` : undefined}
              tone={summary?.deliveredRate != null && summary.deliveredRate < 60 ? 'bad' : undefined}
            />
            <Stat label="Last message" value={contact.last_message_at ? fmtListTime(contact.last_message_at) : 'Never'} sub={windowOpen ? 'Chat window open' : undefined} />
          </div>

          {/* Tabs */}
          <Card>
            <div role="tablist" aria-label="Contact activity" className="flex gap-1 overflow-x-auto border-b border-line px-3">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  role="tab"
                  type="button"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                  className={cn(
                    'whitespace-nowrap border-b-2 px-3 py-3 text-sm font-semibold',
                    tab === t.key ? 'border-brand-600 text-brand-700' : 'border-transparent text-muted hover:text-ink',
                  )}
                >
                  {t.label}
                  {t.count ? <span className="ml-1.5 text-xs text-muted tabular-nums">{t.count}</span> : null}
                </button>
              ))}
            </div>

            <div role="tabpanel" className="p-4">
              {tab === 'timeline' &&
                (timeline.length ? (
                  <ol className="space-y-4">
                    {timeline.map((it) => {
                      const Icon = it.icon;
                      const body = (
                        <>
                          <span className={cn('mt-0.5 h-7 w-7 shrink-0 rounded-full inline-flex items-center justify-center', it.tone)}>
                            <Icon size={14} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold text-ink">{it.title}</span>
                            {it.detail && <span className="block text-sm text-muted break-words line-clamp-3">{it.detail}</span>}
                          </span>
                          <span className="shrink-0 text-xs text-muted tabular-nums">{fmtListTime(it.at)}</span>
                        </>
                      );
                      return (
                        <li key={it.key}>
                          {it.href ? (
                            <Link href={it.href} className="flex gap-3 rounded-lg -mx-2 px-2 py-1 hover:bg-sunken">
                              {body}
                            </Link>
                          ) : (
                            <div className="flex gap-3 px-0 py-1">{body}</div>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <EmptyState compact title="Nothing yet" description="Chats, orders, calls, tickets and notes will show here." />
                ))}

              {tab === 'conversations' &&
                (ov.conversations.length ? (
                  <ul className="divide-y divide-line">
                    {ov.conversations.map((c) => (
                      <li key={c.id}>
                        <Link href={`/inbox/${c.id}`} className="flex items-center gap-3 py-3 hover:bg-sunken -mx-2 px-2 rounded-lg">
                          <MessageCircle size={16} className="text-brand-600 shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm text-ink truncate">{c.last_message || 'No messages yet'}</span>
                            <span className="block text-xs text-muted">
                              {c.assigned_user ? `Assigned to ${c.assigned_user.name}` : 'Unassigned'} · started {fmtDate(c.created_at)}
                            </span>
                          </span>
                          {c.unread_count > 0 && <Badge tone="brand">{c.unread_count} unread</Badge>}
                          <Badge tone={c.status === 'open' ? 'info' : 'neutral'}>{c.status}</Badge>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState
                    compact
                    icon={MessageCircle}
                    title="No chats yet"
                    action={
                      <Button size="sm" onClick={openChat} loading={opening}>
                        Start a chat
                      </Button>
                    }
                  />
                ))}

              {tab === 'orders' &&
                (ordersLoading ? (
                  <SkeletonRows rows={3} />
                ) : orders?.orders.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-xs text-muted">
                        <tr className="border-b border-line">
                          <th className="py-2 text-left font-semibold">Order</th>
                          <th className="py-2 text-left font-semibold">Date</th>
                          <th className="py-2 text-left font-semibold">Items</th>
                          <th className="py-2 text-right font-semibold">Total</th>
                          <th className="py-2 text-right font-semibold">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {orders.orders.map((o) => (
                          <tr key={o.orderGid} className="border-b border-line last:border-0">
                            <td className="py-2">
                              <OrderNameButton name={o.orderName} gid={o.orderGid} />
                            </td>
                            <td className="py-2 text-muted whitespace-nowrap">{o.createdAt ? fmtDate(o.createdAt) : '—'}</td>
                            <td className="py-2 text-muted max-w-[16rem] truncate">{o.itemsSummary ?? ''}</td>
                            <td className="py-2 text-right tabular-nums text-ink">{moneyCompact(o.total, o.currency)}</td>
                            <td className="py-2 text-right">
                              <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-semibold', orderStatusTone(o))}>
                                {orderDisplayStatus(o)}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {(orders.lifetime?.count ?? 0) > orders.orders.length && (
                      <p className="mt-2 text-xs text-muted">
                        Showing the latest {orders.orders.length} of {orders.lifetime!.count} orders.
                      </p>
                    )}
                  </div>
                ) : (
                  <EmptyState compact icon={ShoppingBag} title="No orders for this number" />
                ))}

              {tab === 'tickets' &&
                (ov.tickets.length ? (
                  <ul className="divide-y divide-line">
                    {ov.tickets.map((t) => (
                      <li key={t.id} className="flex flex-wrap items-center gap-3 py-3">
                        <LifeBuoy size={16} className="text-amber-600 shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-ink">
                            {t.ticket_number} · {t.type}
                          </span>
                          <span className="block text-xs text-muted">
                            Opened {fmtDate(t.created_at)}
                            {t.linked_order_name ? ` · order ${t.linked_order_name}` : ''}
                            {t.closed_at ? ` · closed ${fmtDate(t.closed_at)}` : ''}
                          </span>
                        </span>
                        {t.priority && <Badge tone={t.priority === 'high' ? 'danger' : 'neutral'}>{t.priority}</Badge>}
                        <Badge tone={t.closed_at ? 'neutral' : 'warn'}>{t.status}</Badge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState compact icon={LifeBuoy} title="No tickets" />
                ))}

              {tab === 'calls' &&
                (ov.calls.length ? (
                  <ul className="divide-y divide-line">
                    {ov.calls.map((c) => {
                      const Icon = c.direction === 'inbound' ? PhoneIncoming : PhoneOutgoing;
                      return (
                        <li key={c.id} className="flex items-center gap-3 py-3 text-sm">
                          <Icon size={16} className="text-sky-600 shrink-0" />
                          <span className="flex-1 text-ink">
                            {c.direction === 'inbound' ? 'Incoming' : 'Outgoing'} · {c.status}
                            {c.duration_sec ? ` · ${fmtDur(c.duration_sec)}` : ''}
                            {c.user ? <span className="text-muted"> · {c.user.name}</span> : null}
                          </span>
                          <span className="text-xs text-muted">{fmtDateTime(c.started_at ?? c.created_at)}</span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <EmptyState compact icon={Phone} title="No calls" />
                ))}

              {tab === 'notes' && (
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <label htmlFor="note-new" className="sr-only">
                      New note
                    </label>
                    <textarea
                      id="note-new"
                      value={noteDraft}
                      onChange={(e) => setNoteDraft(e.target.value)}
                      rows={2}
                      maxLength={5000}
                      placeholder="Add a note for the team…"
                      className="flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-brand-500 focus:outline-none"
                    />
                    <Button onClick={addNote} loading={savingNote} disabled={!noteDraft.trim()} className="self-end">
                      Save
                    </Button>
                  </div>
                  {ov.notes.length ? (
                    <ul className="space-y-2">
                      {ov.notes.map((n) => (
                        <li key={n.id} className="rounded-lg border border-line bg-sunken px-3 py-2">
                          <p className="text-sm text-ink whitespace-pre-wrap break-words">{n.body}</p>
                          <p className="mt-1 text-xs text-muted">
                            {n.user_name ?? 'Team member'} · {fmtDateTime(n.created_at)} ·{' '}
                            <Link href={`/inbox/${n.conversation_id}`} className="hover:underline">
                              in chat
                            </Link>
                          </p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted">No notes yet. Notes are shared with the team and also show in the inbox.</p>
                  )}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      <ContactFormModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        contact={contact as Contact}
        canEditPhone={canManage}
        tagSuggestions={tagOptions}
        onSaved={(saved) => {
          setEditOpen(false);
          if (saved) setOv((cur) => (cur ? { ...cur, contact: saved } : cur));
          else void load(true);
        }}
      />

      <ConfirmDialog
        open={confirm === 'block'}
        title="Block this contact?"
        message="Their messages are still saved but won’t raise alerts, run bots or AI, and you won’t be able to message them."
        confirmLabel="Block"
        danger
        busy={patching}
        onConfirm={() => void patch({ status: 'blocked' }, 'Contact blocked').catch(() => undefined)}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'archive'}
        title="Archive this contact?"
        message="Archived contacts are hidden from the Active list. You can move them back any time."
        confirmLabel="Archive"
        busy={patching}
        onConfirm={() => void patch({ status: 'archived' }, 'Contact archived').catch(() => undefined)}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'optout'}
        title="Opt out of broadcasts?"
        message="They won’t receive broadcasts. One-to-one chat is not affected."
        confirmLabel="Opt out"
        busy={patching}
        onConfirm={() => void patch({ optedOut: true }, 'Opted out of broadcasts').catch(() => undefined)}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title="Delete this contact?"
        message="They’ll be removed from the list. Chat history is kept, and an owner or admin can restore them."
        confirmLabel="Delete"
        danger
        busy={patching}
        onConfirm={doDelete}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string | null;
  sub?: string;
  tone?: 'bad';
}) {
  return (
    <Card className="px-4 py-3">
      <p className="text-xs font-semibold text-muted">{label}</p>
      {value === null ? (
        <Skeleton className="mt-1.5 h-6 w-20" />
      ) : (
        <p className={cn('mt-0.5 text-xl font-bold tabular-nums', tone === 'bad' ? 'text-red-600' : 'text-ink')}>{value}</p>
      )}
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </Card>
  );
}
