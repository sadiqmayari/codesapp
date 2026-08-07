'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { MessageSquare } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/toast';
import { useAuth } from '@/context/auth-context';
import { fmtDateTime } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import {
  addTicketNote,
  getTicket,
  ticketStatusColor,
  ticketStatusLabel,
  ticketTypeLabel,
  TICKET_STATUSES,
  TicketDetail,
  TicketStatus,
  updateTicket,
} from '@/lib/tickets';

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

  const load = useCallback(async () => {
    try {
      const t = await getTicket(id);
      setTicket(t);
      setResolution(t.resolution_note ?? '');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load ticket');
    }
  }, [id, toast]);

  useEffect(() => {
    load();
  }, [load]);

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
  );
}
