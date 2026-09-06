'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { LifeBuoy, RefreshCw, Clock } from 'lucide-react';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import { TicketDetailModal } from '@/components/tickets/ticket-detail-modal';
import {
  listTickets,
  ticketStatusColor,
  ticketStatusLabel,
  ticketTypeLabel,
  codeLabel,
  RESOLUTION_CODES,
  TicketListItem,
} from '@/lib/tickets';

const OPEN_STATUSES = ['open', 'in_progress', 'awaiting_customer'];

/** Compact "2d 4h" age of a ticket (open → now, or → closed). */
function ticketAge(t: TicketListItem) {
  const from = new Date(t.created_at).getTime();
  const isOpen = OPEN_STATUSES.includes(t.status);
  const to = isOpen ? Date.now() : new Date(t.closed_at ?? t.updated_at).getTime();
  const mins = Math.max(0, Math.round((to - from) / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  return {
    isOpen,
    mins,
    label: d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h` : `${mins}m`,
    breach: isOpen && mins >= 48 * 60,
  };
}

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'awaiting_customer', label: 'Awaiting customer' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'rejected', label: 'Rejected' },
];

export default function TicketsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<TicketListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [sort, setSort] = useState<'overdue' | 'recent'>('overdue');

  // Most-overdue: open tickets first, oldest open on top; then everyone else by
  // most-recently updated. "recent" = the server's updated-desc order.
  const sorted = useMemo(() => {
    if (sort === 'recent') return rows;
    return [...rows].sort((a, b) => {
      const ao = OPEN_STATUSES.includes(a.status) ? 1 : 0;
      const bo = OPEN_STATUSES.includes(b.status) ? 1 : 0;
      if (ao !== bo) return bo - ao; // open before closed
      if (ao === 1)
        return (
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        ); // oldest open first
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
  }, [rows, sort]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listTickets({ status: status || undefined });
      setRows(data);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load tickets');
    } finally {
      setLoading(false);
    }
  }, [status, toast]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          <LifeBuoy className="text-green-600" size={22} />
          <h1 className="text-xl font-semibold text-gray-900">Support tickets</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-lg border border-gray-200 overflow-hidden text-xs font-medium">
            {(
              [
                ['overdue', 'Most overdue'],
                ['recent', 'Recent'],
              ] as ['overdue' | 'recent', string][]
            ).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setSort(v)}
                className={cn(
                  'px-3 py-1.5',
                  sort === v ? 'bg-green-600 text-white' : 'text-gray-600 hover:bg-gray-50',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={load}
            className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900"
          >
            <RefreshCw size={15} /> Refresh
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setStatus(f.value)}
            className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
              status === f.value
                ? 'bg-green-600 text-white border-green-600'
                : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-10 text-center text-gray-400 text-sm">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-gray-400 text-sm">
            No tickets yet. Disputes raised by customers appear here.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-100">
                  <th className="px-4 py-3 font-medium">Ticket</th>
                  <th className="px-4 py-3 font-medium">Customer</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Order</th>
                  <th className="px-4 py-3 font-medium">Assignee</th>
                  <th className="px-4 py-3 font-medium">Age</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((t) => {
                  const age = ticketAge(t);
                  const outcome = codeLabel(RESOLUTION_CODES, t.resolution_code ?? null);
                  return (
                  <tr
                    key={t.id}
                    onClick={() => setOpenId(t.id)}
                    className="border-b border-gray-50 last:border-0 hover:bg-gray-50 cursor-pointer"
                  >
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {t.ticket_number}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {t.contact?.name || t.contact?.phone || '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {ticketTypeLabel(t.type)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${ticketStatusColor(
                          t.status,
                        )}`}
                      >
                        {ticketStatusLabel(t.status)}
                      </span>
                      {outcome && (
                        <span className="block mt-1 text-[11px] text-gray-400">
                          {outcome}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {t.linked_order_name || '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {t.assigned_user?.name || '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 text-xs font-medium',
                          age.breach
                            ? 'text-rose-600'
                            : age.isOpen
                              ? 'text-gray-600'
                              : 'text-gray-400',
                        )}
                        title={age.isOpen ? 'Time open' : 'Time to close'}
                      >
                        <Clock size={12} /> {age.label}
                      </span>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {openId != null && (
        <TicketDetailModal
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
