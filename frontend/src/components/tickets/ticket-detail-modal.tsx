'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  MessageSquare,
  Truck,
  Package,
  Printer,
  Clock,
  Plus,
  Bot,
  ExternalLink,
  PackageCheck,
} from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/toast';
import { useAuth } from '@/context/auth-context';
import { fmtDate, fmtDateTime, cn } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import { generateLabels } from '@/lib/couriers';
import {
  getContactOrders,
  orderDisplayStatus,
  orderStatusTone,
  orderIsDelivered,
  orderIsFailed,
  type ContactOrder,
} from '@/lib/contact-orders';
import { ReplacementShipmentModal } from '@/components/tickets/replacement-shipment-modal';
import {
  addTicketNote,
  getTicket,
  getReplacementContext,
  ticketStatusColor,
  ticketStatusLabel,
  ticketTypeLabel,
  TICKET_STATUSES,
  RESOLUTION_CODES,
  REASON_CODES,
  TicketDetail,
  TicketStatus,
  type ReplacementContext,
  updateTicket,
} from '@/lib/tickets';

/** "2d 4h" from open→now (or →closed). */
function ageParts(fromIso: string, toIso?: string | null) {
  const from = new Date(fromIso).getTime();
  const to = toIso ? new Date(toIso).getTime() : Date.now();
  const mins = Math.max(0, Math.round((to - from) / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const label = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
  return { mins, label };
}

/** Courier journey as four steps, with the current one and any failure marked. */
function parcelSteps(o: ContactOrder): { label: string; state: 'done' | 'cur' | 'todo' | 'bad' }[] {
  const base = ['Booked', 'In transit', 'Out for delivery', 'Delivered'];
  if (o.cancelled) return base.map((label) => ({ label, state: 'todo' as const }));
  if (orderIsDelivered(o)) return base.map((label) => ({ label, state: 'done' as const }));
  const s = (o.shipmentStatus || o.fulfillmentStatus || '').toLowerCase();
  if (orderIsFailed(o)) {
    // Returned / failed — show the journey up to the break, last step red.
    return [
      { label: 'Booked', state: 'done' },
      { label: 'In transit', state: 'done' },
      { label: 'Attempted', state: 'done' },
      { label: /return/.test(s) ? 'Returned' : 'Failed', state: 'bad' },
    ];
  }
  let idx = 0; // placed/booked
  if (/out for|attempt/.test(s)) idx = 2;
  else if (/transit|pick|dispatch/.test(s)) idx = 1;
  else if (s) idx = 1;
  return base.map((label, i) => ({
    label,
    state: i < idx ? 'done' : i === idx ? 'cur' : 'todo',
  }));
}

const money = (a: number | null, c: string | null) =>
  a == null ? null : `${c ? c + ' ' : ''}${a.toLocaleString()}`;

/**
 * Ticket resolution cockpit — used by the Tickets page AND the inbox thread's
 * ticket chip. Left: the order & parcel the ticket is about, the resolve action
 * rail (incl. replacement shipments), structured outcome, status/assignee.
 * Right: an actor-colored activity timeline + notes.
 */
export function TicketDetailModal({
  id,
  onClose,
  onChanged,
}: {
  id: number;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const toast = useToast();
  const { user } = useAuth();
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [note, setNote] = useState('');
  const [resolution, setResolution] = useState('');
  const [saving, setSaving] = useState(false);
  const [ctx, setCtx] = useState<ReplacementContext | null>(null);
  const [rsOpen, setRsOpen] = useState(false);
  const [labelBusy, setLabelBusy] = useState<number | null>(null);
  const [order, setOrder] = useState<ContactOrder | null>(null);

  const load = useCallback(async () => {
    try {
      const t = await getTicket(id);
      setTicket(t);
      setResolution(t.resolution_note ?? '');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load ticket');
    }
  }, [id, toast]);

  const loadCtx = useCallback(async () => {
    try {
      setCtx(await getReplacementContext(id));
    } catch {
      setCtx(null);
    }
  }, [id]);

  useEffect(() => {
    load();
    loadCtx();
  }, [load, loadCtx]);

  // Pull the linked order's live parcel status from the contact's orders (same
  // source the inbox uses) so the cockpit shows the parcel without a new API.
  useEffect(() => {
    const phone = ticket?.contact?.phone;
    const name = ticket?.linked_order_name;
    if (!phone || !name) {
      setOrder(null);
      return;
    }
    let alive = true;
    getContactOrders(phone)
      .then((r) => {
        if (!alive) return;
        const want = name.replace(/^#/, '');
        setOrder(
          r.orders.find((o) => (o.orderName ?? '').replace(/^#/, '') === want) ??
            null,
        );
      })
      .catch(() => alive && setOrder(null));
    return () => {
      alive = false;
    };
  }, [ticket?.contact?.phone, ticket?.linked_order_name]);

  const patch = async (body: Parameters<typeof updateTicket>[1]) => {
    setSaving(true);
    try {
      const t = await updateTicket(id, body);
      setTicket(t);
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Update failed');
    } finally {
      setSaving(false);
    }
  };

  const submitNote = async () => {
    if (!note.trim()) return;
    setSaving(true);
    try {
      const t = await addTicketNote(id, note.trim());
      setTicket(t);
      setNote('');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to add note');
    } finally {
      setSaving(false);
    }
  };

  const downloadLabel = async (shipmentId: number) => {
    setLabelBusy(shipmentId);
    try {
      const res = await generateLabels([shipmentId]);
      const url = res.labels[0]?.url;
      if (url) window.open(url, '_blank');
      else toast.error('Label not ready yet — try again in a moment.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not fetch label');
    } finally {
      setLabelBusy(null);
    }
  };

  const open = ticket
    ? ['open', 'in_progress', 'awaiting_customer'].includes(ticket.status)
    : false;
  const age = ticket ? ageParts(ticket.created_at, ticket.closed_at) : null;
  const breach = open && !!age && age.mins >= 48 * 60;
  const total = order ? money(order.total, order.currency) : null;
  const cod = order && order.outstanding && order.outstanding > 0 ? money(order.outstanding, order.currency) : null;

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size="xl"
        title={ticket ? `Ticket ${ticket.ticket_number}` : 'Ticket'}
      >
        {!ticket ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading…</div>
        ) : (
          <div className="grid md:grid-cols-[1.35fr_1fr] gap-0 md:divide-x divide-gray-100">
            {/* ───────── Left: the case + actions ───────── */}
            <div className="p-5 space-y-4">
              {/* Header */}
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-bold text-gray-900 -mb-0.5">
                    {ticketTypeLabel(ticket.type)}
                  </h3>
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs font-medium ${ticketStatusColor(
                      ticket.status,
                    )}`}
                  >
                    {ticketStatusLabel(ticket.status)}
                  </span>
                  {age && (
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
                        breach ? 'bg-rose-100 text-rose-700' : 'bg-gray-100 text-gray-600',
                      )}
                    >
                      <Clock size={11} /> {open ? 'aged' : 'closed in'} {age.label}
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-1.5 flex items-center gap-1 flex-wrap">
                  {ticket.created_by === 'ai' ? (
                    <span className="inline-flex items-center gap-1 text-violet-600 font-medium">
                      <Bot size={12} /> AI-opened
                    </span>
                  ) : (
                    <span className="font-medium">Agent-opened</span>
                  )}
                  <span>·</span>
                  <span>{ticket.contact?.name || ticket.contact?.phone || '—'}</span>
                  <span>·</span>
                  <span>{ticket.assigned_user?.name ? `assigned to ${ticket.assigned_user.name}` : 'unassigned'}</span>
                </p>
              </div>

              {/* Linked order + parcel */}
              {ticket.linked_order_name && (
                <div className="rounded-xl border border-gray-200 p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-xs font-bold text-gray-500 uppercase tracking-wide">
                      <Package size={13} /> Linked order
                    </div>
                    {order && (
                      <span className={cn('text-[11px] px-2 py-0.5 rounded-full', orderStatusTone(order))}>
                        {orderDisplayStatus(order)}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 text-sm">
                    <span className="font-semibold text-gray-900">{ticket.linked_order_name}</span>
                    <span className="text-gray-600">
                      {order?.createdAt ? fmtDate(order.createdAt) : ''}
                    </span>
                  </div>
                  {order?.itemsSummary && (
                    <p className="text-xs text-gray-500 mt-1 truncate">{order.itemsSummary}</p>
                  )}
                  {total && (
                    <div className="mt-1 text-sm font-medium text-gray-800">
                      {total}
                      {cod && <span className="text-rose-600"> · COD {cod}</span>}
                    </div>
                  )}
                  {/* Step tracker */}
                  {order && (
                    <div className="mt-3 flex">
                      {parcelSteps(order).map((s, i) => (
                        <div key={i} className="flex-1 relative text-center">
                          <div
                            className={cn(
                              'h-1 rounded-full',
                              s.state === 'done' && 'bg-green-500',
                              s.state === 'cur' && 'bg-blue-500',
                              s.state === 'bad' && 'bg-rose-500',
                              s.state === 'todo' && 'bg-gray-200',
                            )}
                          />
                          <span
                            className={cn(
                              'block mt-1 text-[9px] font-semibold uppercase tracking-wide',
                              s.state === 'done' && 'text-green-600',
                              s.state === 'cur' && 'text-blue-600',
                              s.state === 'bad' && 'text-rose-600',
                              s.state === 'todo' && 'text-gray-400',
                            )}
                          >
                            {s.label}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {order?.trackingNumber && (
                    <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-gray-500">
                      <Truck size={12} className="text-gray-400" />
                      <span className="capitalize">{order.courierType ?? 'Courier'}</span>
                      {order.trackingUrl ? (
                        <a href={order.trackingUrl} target="_blank" rel="noopener noreferrer" className="text-green-700 hover:underline truncate">
                          {order.trackingNumber}
                        </a>
                      ) : (
                        <span className="truncate">· {order.trackingNumber}</span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Issue */}
              {ticket.description && (
                <div>
                  <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Issue</div>
                  <p className="text-sm text-gray-700">{ticket.description}</p>
                </div>
              )}

              {/* Resolve action rail */}
              <div>
                <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Resolve</div>
                <div className="flex flex-wrap gap-2">
                  {ctx && ctx.couriers.length > 0 && (
                    <button
                      onClick={() => setRsOpen(true)}
                      className="inline-flex items-center gap-1.5 text-sm font-semibold rounded-lg px-3 py-2 text-white bg-gradient-to-r from-violet-600 to-rose-500 hover:brightness-105"
                    >
                      <Truck size={15} /> Create replacement shipment
                    </button>
                  )}
                  <Link
                    href={`/inbox/${ticket.conversation_id}`}
                    className="inline-flex items-center gap-1.5 text-sm font-semibold rounded-lg px-3 py-2 border border-gray-200 text-gray-700 hover:bg-gray-50"
                  >
                    <MessageSquare size={15} /> Message customer
                  </Link>
                  {order?.trackingUrl && (
                    <a
                      href={order.trackingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-sm font-semibold rounded-lg px-3 py-2 border border-gray-200 text-gray-700 hover:bg-gray-50"
                    >
                      <ExternalLink size={15} /> Track parcel
                    </a>
                  )}
                </div>
              </div>

              {/* Replacement shipments */}
              {ctx && (ctx.replacements.length > 0 || ctx.couriers.length > 0) && (
                <div className="rounded-xl border border-gray-200 p-3.5">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                      <PackageCheck size={13} /> Replacement shipments
                    </div>
                    {ctx.couriers.length > 0 && (
                      <button onClick={() => setRsOpen(true)} className="inline-flex items-center gap-1 text-xs font-semibold text-green-700 hover:underline">
                        <Plus size={13} /> New
                      </button>
                    )}
                  </div>
                  {ctx.replacements.length === 0 ? (
                    <p className="text-xs text-gray-400">No replacement parcel booked yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {ctx.replacements.map((r) => (
                        <div key={r.id} className="flex items-center gap-2 text-sm rounded-md bg-gray-50 border border-gray-100 px-2.5 py-2">
                          <Package size={14} className="text-gray-400 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-gray-800 capitalize">
                              {r.courierLabel}
                              <span className="ml-1 text-xs font-normal text-gray-500">· {r.status}</span>
                            </div>
                            {r.trackingNumber && (
                              <div className="text-xs text-gray-500 truncate">
                                {r.trackingUrl ? (
                                  <a href={r.trackingUrl} target="_blank" rel="noopener noreferrer" className="text-green-700 hover:underline">
                                    {r.trackingNumber}
                                  </a>
                                ) : (
                                  r.trackingNumber
                                )}
                              </div>
                            )}
                          </div>
                          <button
                            onClick={() => downloadLabel(r.id)}
                            disabled={labelBusy === r.id}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-gray-600 hover:text-gray-900 disabled:opacity-50 shrink-0"
                            title="Download shipping label"
                          >
                            <Printer size={13} />
                            {labelBusy === r.id ? '…' : 'Label'}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Structured outcome */}
              <div>
                <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Outcome</div>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={ticket.resolution_code ?? ''}
                    disabled={saving}
                    onChange={(e) => patch({ resolutionCode: e.target.value })}
                    className="rounded-lg border border-gray-200 px-2.5 py-2 text-sm"
                  >
                    <option value="">Resolution…</option>
                    {RESOLUTION_CODES.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                  <select
                    value={ticket.reason_code ?? ''}
                    disabled={saving}
                    onChange={(e) => patch({ reasonCode: e.target.value })}
                    className="rounded-lg border border-gray-200 px-2.5 py-2 text-sm"
                  >
                    <option value="">Reason…</option>
                    {REASON_CODES.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Status + assignee */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Status</label>
                  <select
                    value={ticket.status}
                    disabled={saving}
                    onChange={(e) => patch({ status: e.target.value as TicketStatus })}
                    className="mt-1 block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                  >
                    {TICKET_STATUSES.map((s) => (
                      <option key={s} value={s}>{ticketStatusLabel(s)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Assignee</label>
                  <div className="mt-1 flex items-center gap-2 h-[38px]">
                    <span className="text-sm text-gray-700 truncate">
                      {ticket.assigned_user?.name || 'Unassigned'}
                    </span>
                    <div className="ml-auto flex gap-2 shrink-0">
                      {user && ticket.assigned_user_id !== user.id && (
                        <button disabled={saving} onClick={() => patch({ assignedUserId: user.id })} className="text-xs text-green-700 hover:underline">
                          To me
                        </button>
                      )}
                      {ticket.assigned_user_id != null && (
                        <button disabled={saving} onClick={() => patch({ assignedUserId: null })} className="text-xs text-gray-500 hover:underline">
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Resolution note */}
              <div>
                <label className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Resolution note</label>
                <textarea
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  rows={2}
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                  placeholder="What was decided / done…"
                />
                <button
                  disabled={saving}
                  onClick={() => patch({ resolutionNote: resolution })}
                  className="mt-2 text-sm bg-gray-900 text-white rounded-lg px-3 py-1.5 disabled:opacity-50"
                >
                  Save note
                </button>
              </div>
            </div>

            {/* ───────── Right: activity ───────── */}
            <div className="p-5 bg-gray-50/50 md:rounded-r-2xl">
              <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-3">Activity</div>
              <div className="relative max-h-[26rem] overflow-y-auto pr-1">
                <div className="absolute left-[5px] top-1 bottom-1 w-px bg-gray-200" />
                <div className="space-y-3.5">
                  {ticket.events.map((ev) => {
                    const isShip = ev.kind === 'replacement_booked';
                    const dot =
                      isShip ? 'bg-rose-500'
                        : ev.actor === 'ai' ? 'bg-violet-500'
                        : ev.actor === 'customer' ? 'bg-blue-500'
                        : ev.actor === 'agent' ? 'bg-green-600'
                        : 'bg-gray-400';
                    return (
                      <div key={ev.id} className="relative pl-5">
                        <span className={cn('absolute left-0 top-1 w-[11px] h-[11px] rounded-full ring-2 ring-white', dot)} />
                        <div className="flex items-center gap-2 text-[11px] text-gray-500">
                          <span className="font-bold text-gray-700 capitalize">{ev.actor}</span>
                          <span>· {ev.kind.replace(/_/g, ' ')}</span>
                          <span className="ml-auto">{fmtDateTime(ev.created_at)}</span>
                        </div>
                        {ev.body && <div className="text-sm text-gray-700 mt-0.5">{ev.body}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="pt-3 mt-3 border-t border-gray-200">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  className="block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                  placeholder="Add an internal note…"
                />
                <button
                  disabled={saving || !note.trim()}
                  onClick={submitNote}
                  className="mt-2 text-sm bg-green-600 text-white rounded-lg px-3 py-1.5 disabled:opacity-50"
                >
                  Add note
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {rsOpen && ctx && (
        <ReplacementShipmentModal
          ticketId={id}
          context={ctx}
          onClose={() => setRsOpen(false)}
          onBooked={() => {
            load();
            loadCtx();
          }}
        />
      )}
    </>
  );
}
