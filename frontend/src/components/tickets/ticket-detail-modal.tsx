'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { MessageSquare, Truck, Package, Printer, Clock, Plus } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/toast';
import { useAuth } from '@/context/auth-context';
import { fmtDateTime } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import { generateLabels } from '@/lib/couriers';
import { ReplacementShipmentModal } from '@/components/tickets/replacement-shipment-modal';
import {
  addTicketNote,
  getTicket,
  getReplacementContext,
  ticketStatusColor,
  ticketStatusLabel,
  ticketTypeLabel,
  TICKET_STATUSES,
  TicketDetail,
  TicketStatus,
  type ReplacementContext,
  updateTicket,
} from '@/lib/tickets';

/** "aged 2d 4h" from open→now (or →closed). Flags long-open tickets in red. */
function ageParts(fromIso: string, toIso?: string | null) {
  const from = new Date(fromIso).getTime();
  const to = toIso ? new Date(toIso).getTime() : Date.now();
  const mins = Math.max(0, Math.round((to - from) / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const label = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
  return { mins, label };
}

/**
 * Shared ticket detail popup — used by the Tickets page AND the inbox thread's
 * ticket chip (so clicking a ticket opens it in place, never navigates away).
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

  const load = useCallback(async () => {
    try {
      const t = await getTicket(id);
      setTicket(t);
      setResolution(t.resolution_note ?? '');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load ticket');
    }
  }, [id, toast]);

  // Replacement pre-fill + already-booked parcels. Best-effort — a courier
  // config problem must not break the ticket view.
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
        <div className="grid md:grid-cols-2 gap-5 p-5">
          {/* Left: details + actions */}
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`px-2 py-0.5 rounded-full text-xs font-medium ${ticketStatusColor(
                  ticket.status,
                )}`}
              >
                {ticketStatusLabel(ticket.status)}
              </span>
              {(() => {
                const open = ['open', 'in_progress', 'awaiting_customer'].includes(
                  ticket.status,
                );
                const a = ageParts(ticket.created_at, ticket.closed_at);
                const breach = open && a.mins >= 48 * 60;
                return (
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                      breach
                        ? 'bg-rose-100 text-rose-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}
                    title={open ? 'Time open' : 'Time to close'}
                  >
                    <Clock size={11} /> {open ? 'aged' : 'closed in'} {a.label}
                  </span>
                );
              })()}
              <span className="text-xs text-gray-500">
                {ticketTypeLabel(ticket.type)} · opened by {ticket.created_by}
              </span>
            </div>

            <div className="text-sm text-gray-700">
              <div className="text-gray-500">Customer</div>
              <div className="font-medium">
                {ticket.contact?.name || ticket.contact?.phone || '—'}
              </div>
            </div>

            {ticket.description && (
              <div className="text-sm text-gray-700">
                <div className="text-gray-500">Issue</div>
                <div>{ticket.description}</div>
              </div>
            )}

            {ticket.linked_order_name && (
              <div className="text-sm text-gray-700">
                <div className="text-gray-500">Order</div>
                <div>{ticket.linked_order_name}</div>
              </div>
            )}

            <div>
              <label className="text-xs text-gray-500">Status</label>
              <select
                value={ticket.status}
                disabled={saving}
                onChange={(e) => patch({ status: e.target.value as TicketStatus })}
                className="mt-1 block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
              >
                {TICKET_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {ticketStatusLabel(s)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs text-gray-500">Assignee</label>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-sm text-gray-700">
                  {ticket.assigned_user?.name || 'Unassigned'}
                </span>
                <div className="ml-auto flex gap-2">
                  {user && ticket.assigned_user_id !== user.id && (
                    <button
                      disabled={saving}
                      onClick={() => patch({ assignedUserId: user.id })}
                      className="text-xs text-green-700 hover:underline"
                    >
                      Assign to me
                    </button>
                  )}
                  {ticket.assigned_user_id != null && (
                    <button
                      disabled={saving}
                      onClick={() => patch({ assignedUserId: null })}
                      className="text-xs text-gray-500 hover:underline"
                    >
                      Unassign
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div>
              <label className="text-xs text-gray-500">Resolution note</label>
              <textarea
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                rows={3}
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

            {/* Replacement shipments (PostEx/Trax etc.) */}
            <div className="rounded-lg border border-gray-200 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <Truck size={13} /> Replacement shipments
                </div>
                {ctx && ctx.couriers.length > 0 && (
                  <button
                    onClick={() => setRsOpen(true)}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-green-700 hover:underline"
                  >
                    <Plus size={13} /> New
                  </button>
                )}
              </div>

              {!ctx || ctx.replacements.length === 0 ? (
                <p className="text-xs text-gray-400">
                  {ctx && ctx.couriers.length === 0
                    ? 'No courier configured — add one in Settings → Courier.'
                    : 'No replacement parcel booked yet.'}
                </p>
              ) : (
                <div className="space-y-2">
                  {ctx.replacements.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center gap-2 text-sm rounded-md bg-gray-50 border border-gray-100 px-2.5 py-2"
                    >
                      <Package size={14} className="text-gray-400 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-gray-800 capitalize">
                          {r.courierLabel}
                          <span className="ml-1 text-xs font-normal text-gray-500">
                            · {r.status}
                          </span>
                        </div>
                        {r.trackingNumber && (
                          <div className="text-xs text-gray-500 truncate">
                            {r.trackingUrl ? (
                              <a
                                href={r.trackingUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-green-700 hover:underline"
                              >
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

            <Link
              href={`/inbox/${ticket.conversation_id}`}
              className="inline-flex items-center gap-1.5 text-sm text-green-700 hover:underline"
            >
              <MessageSquare size={15} /> Open conversation
            </Link>
          </div>

          {/* Right: timeline */}
          <div className="space-y-3">
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Timeline
            </div>
            <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
              {ticket.events.map((ev) => (
                <div key={ev.id} className="text-sm">
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <span className="font-medium text-gray-700">{ev.actor}</span>
                    <span>· {ev.kind.replace(/_/g, ' ')}</span>
                    <span className="ml-auto">{fmtDateTime(ev.created_at)}</span>
                  </div>
                  {ev.body && (
                    <div className="text-gray-700 mt-0.5">{ev.body}</div>
                  )}
                </div>
              ))}
            </div>

            <div className="pt-2 border-t border-gray-100">
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
