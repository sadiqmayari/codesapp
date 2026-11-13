'use client';

import { useCallback, useEffect, useState } from 'react';
import { LifeBuoy, RefreshCw, Clock, Tag, ChevronLeft, ChevronRight } from 'lucide-react';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import { useLatestRequest, useSearchBox, useUrlFilters } from '@/lib/use-list-query';
import { SearchInput } from '@/components/ui/search-input';
import { ActiveFilters, FilterSelect, StatusChips } from '@/components/ui/filter-bar';
import { NoResults } from '@/components/ui/empty-state';
import { TicketDetailModal } from '@/components/tickets/ticket-detail-modal';
import {
  listTickets,
  ticketStatusColor,
  ticketStatusLabel,
  ticketTypeLabel,
  codeLabel,
  RESOLUTION_CODES,
  TICKET_TYPES,
  TicketListItem,
} from '@/lib/tickets';
import { DataTable } from '@/components/ui/data-table';

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

const PAGE_SIZE = 50;

export default function TicketsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<TicketListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<number | null>(null);
  // Status / type / search / sort / page live in the URL (refresh + Back keep them).
  const { values: f, set, clearAll, ready } = useUrlFilters({
    status: '',
    type: '',
    q: '',
    sort: 'overdue',
    page: '1',
  });
  const [qInput, setQInput] = useSearchBox(f.q, ready, (q) => set({ q }));
  const run = useLatestRequest();
  const page = Math.max(1, Number(f.page) || 1);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Server-side: paginated, filtered, and sorted (overdue = oldest open first).
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await run((signal) =>
        listTickets(
          {
            status: f.status,
            type: f.type,
            search: f.q,
            sort: f.sort === 'recent' ? 'recent' : 'overdue',
            page,
            limit: PAGE_SIZE,
          },
          signal,
        ),
      );
      if (!data) return; // superseded by a newer request
      setRows(data.rows);
      setTotal(data.total);
      setLoading(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load tickets');
      setLoading(false);
    }
  }, [f.status, f.type, f.q, f.sort, page, run, toast]);

  useEffect(() => {
    if (ready) load();
  }, [load, ready]);

  // Deleted/closed tickets can leave us past the last page.
  useEffect(() => {
    if (!loading && page > pages) set({ page: String(pages) });
  }, [loading, page, pages, set]);

  const active = [
    f.q && { key: 'q', label: `“${f.q}”`, onRemove: () => set({ q: '' }) },
    f.type && { key: 'type', label: `Type: ${ticketTypeLabel(f.type)}`, onRemove: () => set({ type: '' }) },
    f.status && {
      key: 'status',
      label: `Status: ${STATUS_FILTERS.find((s) => s.value === f.status)?.label ?? f.status}`,
      onRemove: () => set({ status: '' }),
    },
  ].filter(Boolean) as { key: string; label: string; onRemove: () => void }[];
  const clearFilters = () => clearAll(['sort']);

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
                onClick={() => set({ sort: v })}
                aria-pressed={f.sort === v}
                className={cn(
                  'px-3 py-1.5',
                  f.sort === v ? 'bg-green-600 text-white' : 'text-gray-600 hover:bg-gray-50',
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

      <div className="flex flex-col gap-2 mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={qInput}
            onChange={setQInput}
            placeholder="Search ticket #, order, customer or phone"
            loading={loading && !!qInput}
            slashShortcut
            className="w-full sm:w-80"
          />
          <FilterSelect
            icon={Tag}
            label="Type"
            value={f.type}
            options={[
              { value: '', label: 'Any' },
              ...TICKET_TYPES.map((t) => ({ value: t, label: ticketTypeLabel(t) })),
            ]}
            onChange={(v) => set({ type: v })}
          />
        </div>
        <StatusChips
          options={STATUS_FILTERS}
          value={f.status}
          onChange={(v) => set({ status: v })}
        />
        <ActiveFilters filters={active} onClearAll={clearFilters} />
      </div>

      <DataTable<TicketListItem>
        rows={rows}
        loading={loading && rows.length === 0}
        rowKey={(t) => t.id}
        onRowClick={(t) => setOpenId(t.id)}
        emptyNode={
          active.length ? (
            <NoResults query={f.q} noun="tickets" onClear={clearFilters} compact />
          ) : undefined
        }
        empty={{
          icon: LifeBuoy,
          title: 'No tickets yet',
          description: 'Disputes raised by customers appear here.',
        }}
        columns={[
          {
            key: 'ticket',
            header: 'Ticket',
            render: (t) => (
              <span className="font-semibold text-gray-900">{t.ticket_number}</span>
            ),
            sortValue: (t) => t.ticket_number,
          },
          {
            key: 'customer',
            header: 'Customer',
            render: (t) => (
              <span className="text-gray-700">
                {t.contact?.name || t.contact?.phone || '—'}
              </span>
            ),
            sortValue: (t) => (t.contact?.name || t.contact?.phone || '').toLowerCase(),
          },
          {
            key: 'type',
            header: 'Type',
            render: (t) => <span className="text-gray-700">{ticketTypeLabel(t.type)}</span>,
            sortValue: (t) => ticketTypeLabel(t.type),
          },
          {
            key: 'status',
            header: 'Status',
            render: (t) => {
              const outcome = codeLabel(RESOLUTION_CODES, t.resolution_code ?? null);
              return (
                <>
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs font-semibold ${ticketStatusColor(
                      t.status,
                    )}`}
                  >
                    {ticketStatusLabel(t.status)}
                  </span>
                  {outcome && (
                    <span className="block mt-1 text-xs text-gray-400">{outcome}</span>
                  )}
                </>
              );
            },
            sortValue: (t) => ticketStatusLabel(t.status),
          },
          {
            key: 'order',
            header: 'Order',
            render: (t) => <span className="text-gray-600">{t.linked_order_name || '—'}</span>,
          },
          {
            key: 'assignee',
            header: 'Assignee',
            render: (t) => (
              <span className="text-gray-600">{t.assigned_user?.name || '—'}</span>
            ),
            sortValue: (t) => t.assigned_user?.name ?? null,
          },
          {
            key: 'age',
            header: 'Age',
            render: (t) => {
              const age = ticketAge(t);
              return (
                <span
                  className={cn(
                    'inline-flex items-center gap-1 text-xs font-semibold',
                    age.breach ? 'text-rose-600' : age.isOpen ? 'text-gray-600' : 'text-gray-400',
                  )}
                  title={age.isOpen ? 'Time open' : 'Time to close'}
                >
                  <Clock size={12} /> {age.label}
                </span>
              );
            },
            sortValue: (t) => ticketAge(t).mins,
          },
        ]}
      />

      {total > PAGE_SIZE && (
        <div className="mt-3 flex items-center justify-between text-sm text-gray-600">
          <span className="tabular-nums">
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => set({ page: String(page - 1) })}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 disabled:opacity-40"
              aria-label="Previous page"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="px-2 tabular-nums">
              {page} / {pages}
            </span>
            <button
              type="button"
              disabled={page >= pages}
              onClick={() => set({ page: String(page + 1) })}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 disabled:opacity-40"
              aria-label="Next page"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

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
