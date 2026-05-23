'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
  Receipt,
  Play,
} from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { ConfirmDialog } from '@/components/ui/modal';
import { useToast } from '@/components/toast';
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
        'inline-block rounded-full px-2.5 py-0.5 text-xs font-medium capitalize border',
        status === 'paid' && 'bg-green-50 text-green-700 border-green-200',
        status === 'pending' && 'bg-amber-50 text-amber-700 border-amber-200',
        status === 'overdue' && 'bg-red-50 text-red-700 border-red-200',
        status === 'cancelled' && 'bg-gray-100 text-gray-600 border-gray-200',
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
  const toast = useToast();
  const [rows, setRows] = useState<AdminInvoice[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<InvoiceStatus | 'all'>('all');
  const [markBusyId, setMarkBusyId] = useState<number | null>(null);
  const [genConfirm, setGenConfirm] = useState(false);
  const [genBusy, setGenBusy] = useState(false);

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

  const markPaid = async (id: number) => {
    setMarkBusyId(id);
    try {
      await apiFetch(`/super-admin/billing/invoices/${id}/mark-paid`, {
        method: 'POST',
        noOnboardingRedirect: true,
      });
      toast.success('Invoice marked paid');
      load();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Mark-paid failed',
      );
    } finally {
      setMarkBusyId(null);
    }
  };

  const runGenerate = async () => {
    setGenBusy(true);
    try {
      const res = await apiFetch<{ created: number; skipped: number }>(
        '/super-admin/billing/invoices/generate',
        { method: 'POST', noOnboardingRedirect: true },
      );
      toast.success(
        `Generated ${res.created} · skipped ${res.skipped} (idempotent)`,
      );
      setGenConfirm(false);
      load();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Generation failed',
      );
    } finally {
      setGenBusy(false);
    }
  };

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
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <span className="w-9 h-9 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center">
              <Receipt size={18} />
            </span>
            Billing &amp; invoices
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Billing is <strong>activation-anchored, 30-day cycles</strong> —
            an invoice is raised on each client&apos;s activation anniversary
            (first one on activation itself, then every 30 days). A cron
            <em> checks daily</em> whether a new cycle is due and raises only
            the missing invoice. Use the button for off-cycle runs. Mark
            paid auto-reactivates a cron-suspended company once nothing is
            unpaid.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500 bg-white border border-gray-200 rounded-lg px-3 py-1.5 shadow-sm">
            Paid on this page:{' '}
            <span className="text-green-700 font-semibold">
              ${paidOnPage.toFixed(2)}
            </span>
          </span>
          <button
            onClick={() => setGenConfirm(true)}
            disabled={genBusy}
            className="flex items-center gap-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm px-3 py-2 shadow-sm disabled:opacity-50"
            title="Run generateDueInvoices() now (same as the daily cron)"
          >
            <Play size={14} /> Run invoice generation
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              filter === f.key
                ? 'bg-green-600 text-white shadow-sm'
                : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Invoice</th>
                <th className="text-left px-4 py-3 font-medium">Company</th>
                <th className="text-left px-4 py-3 font-medium">Period</th>
                <th className="text-right px-4 py-3 font-medium">Amount</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-left px-4 py-3 font-medium">Due</th>
                <th className="text-left px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-gray-400">
                    Loading…
                  </td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-gray-400">
                    No invoices match.
                  </td>
                </tr>
              ) : (
                visible.map((inv) => (
                  <tr key={inv.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-gray-600">
                      {inv.invoice_number ?? `#${inv.id}`}
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {inv.company?.company_name ?? `Company ${inv.company_id}`}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {inv.period ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-800 tabular-nums font-medium">
                      ${money(inv.amount)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill status={inv.status} />
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {fmtDate(inv.due_date)}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {fmtDate(inv.created_at)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {(inv.status === 'pending' ||
                        inv.status === 'overdue') && (
                        <button
                          onClick={() => markPaid(inv.id)}
                          disabled={markBusyId === inv.id}
                          className="rounded-lg bg-green-600 hover:bg-green-700 text-white text-xs font-medium px-2.5 py-1 disabled:opacity-50"
                        >
                          {markBusyId === inv.id ? '…' : 'Mark paid'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between text-sm text-gray-500">
        <span>
          {total} total · page {page}/{totalPages}
        </span>
        <div className="flex gap-2">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 disabled:opacity-40 hover:bg-gray-50"
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 disabled:opacity-40 hover:bg-gray-50"
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={genConfirm}
        title="Run invoice generation now?"
        message="This runs generateDueInvoices() against every active client — the same routine the daily cron uses. It's idempotent (existing cycle invoices are skipped), so running it off-cycle is safe."
        confirmLabel="Run now"
        busy={genBusy}
        onConfirm={runGenerate}
        onCancel={() => !genBusy && setGenConfirm(false)}
      />
    </div>
  );
}
