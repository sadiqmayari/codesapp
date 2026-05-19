'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { cn, fmtDate } from '@/lib/utils';
import type { AdminInvoice, InvoiceStatus, Paged } from '@/lib/crm-types';

export const dynamic = 'force-dynamic';

const LIMIT = 20;

const FILTERS: Array<{ key: InvoiceStatus | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'paid', label: 'Paid' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'cancelled', label: 'Cancelled' },
];

function StatusPill({ status }: { status: InvoiceStatus }) {
  return (
    <span
      className={cn(
        'inline-block rounded-full px-2.5 py-0.5 text-xs font-medium capitalize',
        status === 'paid' && 'bg-green-900/50 text-green-300',
        status === 'pending' && 'bg-yellow-900/50 text-yellow-300',
        status === 'overdue' && 'bg-red-900/50 text-red-300',
        status === 'cancelled' && 'bg-gray-700 text-gray-300',
      )}
    >
      {status}
    </span>
  );
}

function money(v: string | number): string {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n.toFixed(2) : String(v);
}

export default function SuperAdminBillingPage() {
  const router = useRouter();
  const [rows, setRows] = useState<AdminInvoice[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<InvoiceStatus | 'all'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch<Paged<AdminInvoice>>(
        '/super-admin/invoices',
        { params: { page, limit: LIMIT }, noOnboardingRedirect: true },
      );
      setRows(res.items);
      setTotal(res.meta.total);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.replace('/super-admin/login');
        return;
      }
      setError(
        e instanceof ApiError ? e.userMessage : 'Failed to load invoices',
      );
    } finally {
      setLoading(false);
    }
  }, [page, router]);

  useEffect(() => {
    load();
  }, [load]);

  // Server gives no status filter — filter the current page client-side
  // (same approach as the clients page).
  const visible = useMemo(
    () => rows.filter((r) => filter === 'all' || r.status === filter),
    [rows, filter],
  );

  // Page-scoped paid total (the API has no aggregate endpoint).
  const paidOnPage = useMemo(
    () =>
      rows
        .filter((r) => r.status === 'paid')
        .reduce((s, r) => s + Number(r.amount || 0), 0),
    [rows],
  );

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <h2 className="text-xl font-bold mr-auto">Billing &amp; invoices</h2>
        <span className="text-sm text-gray-400">
          Paid on this page:{' '}
          <span className="text-green-400 font-semibold">
            ${paidOnPage.toFixed(2)}
          </span>
        </span>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              filter === f.key
                ? 'bg-green-600 text-white'
                : 'bg-gray-800 text-gray-300 hover:bg-gray-700',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-900/40 border border-red-800 px-4 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-gray-800">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-800 text-gray-400">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Invoice</th>
              <th className="text-left px-4 py-3 font-medium">Company</th>
              <th className="text-left px-4 py-3 font-medium">Period</th>
              <th className="text-right px-4 py-3 font-medium">Amount</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Due</th>
              <th className="text-left px-4 py-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-gray-500">
                  Loading…
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-gray-500">
                  No invoices match.
                </td>
              </tr>
            ) : (
              visible.map((inv) => (
                <tr key={inv.id} className="hover:bg-gray-800/50">
                  <td className="px-4 py-3 text-gray-300">
                    {inv.invoice_number ?? `#${inv.id}`}
                  </td>
                  <td className="px-4 py-3 font-medium text-white">
                    {inv.company?.company_name ?? `Company ${inv.company_id}`}
                  </td>
                  <td className="px-4 py-3 text-gray-400">
                    {inv.period ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-200">
                    ${money(inv.amount)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill status={inv.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-400">
                    {fmtDate(inv.due_date)}
                  </td>
                  <td className="px-4 py-3 text-gray-400">
                    {fmtDate(inv.created_at)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between mt-4 text-sm text-gray-400">
        <span>
          {total} total · page {page}/{totalPages}
        </span>
        <div className="flex gap-2">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="flex items-center gap-1 rounded-lg border border-gray-700 px-3 py-1.5 disabled:opacity-40 hover:bg-gray-800"
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="flex items-center gap-1 rounded-lg border border-gray-700 px-3 py-1.5 disabled:opacity-40 hover:bg-gray-800"
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <p className="mt-3 text-xs text-gray-600">
        View-only. Invoice generation and mark-paid run via the billing
        cron / tenant billing module — not exposed to super-admin here.
      </p>
    </div>
  );
}
