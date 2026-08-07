'use client';

import { useCallback, useEffect, useState } from 'react';
import { LifeBuoy, RefreshCw } from 'lucide-react';
import { useToast } from '@/components/toast';
import { fmtDateTime } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import { TicketDetailModal } from '@/components/tickets/ticket-detail-modal';
import {
  listTickets,
  ticketStatusColor,
  ticketStatusLabel,
  ticketTypeLabel,
  TicketListItem,
} from '@/lib/tickets';

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
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900"
        >
          <RefreshCw size={15} /> Refresh
        </button>
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
                  <th className="px-4 py-3 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
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
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {t.linked_order_name || '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {t.assigned_user?.name || '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {fmtDateTime(t.updated_at)}
                    </td>
                  </tr>
                ))}
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
