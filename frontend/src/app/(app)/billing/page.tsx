'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Download } from 'lucide-react';
import { apiFetch, apiFetchEnvelope, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { Modal } from '@/components/ui/modal';
import { cn, fmtDateTime } from '@/lib/utils';
import type {
  Invoice,
  InvoiceStatus,
  BillingSubscription,
} from '@/lib/crm-types';

const STATUSES: Array<'all' | InvoiceStatus> = [
  'all',
  'pending',
  'paid',
  'overdue',
  'cancelled',
];

const STATUS_STYLE: Record<InvoiceStatus, string> = {
  paid: 'bg-green-100 text-green-700',
  pending: 'bg-yellow-100 text-yellow-700',
  overdue: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-100 text-gray-500',
};

const LIMIT = 20;

function money(v: string | number) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

export default function BillingPage() {
  const toast = useToast();
  const [sub, setSub] = useState<BillingSubscription | null>(null);
  const [rows, setRows] = useState<Invoice[]>([]);
  const [status, setStatus] = useState<'all' | InvoiceStatus>('all');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Invoice | null>(null);

  const loadSub = useCallback(async () => {
    try {
      setSub(await apiFetch<BillingSubscription>('/billing/subscription'));
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load subscription',
      );
    }
  }, [toast]);

  const loadInvoices = useCallback(async () => {
    setLoading(true);
    try {
      const env = await apiFetchEnvelope<Invoice[]>('/billing/invoices', {
        params: {
          status: status === 'all' ? undefined : status,
          page,
          limit: LIMIT,
        },
      });
      setRows(env.data);
      setTotal((env.meta?.total as number) ?? env.data.length);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load invoices',
      );
    } finally {
      setLoading(false);
    }
  }, [status, page, toast]);

  useEffect(() => {
    loadSub();
  }, [loadSub]);
  useEffect(() => {
    loadInvoices();
  }, [loadInvoices]);

  const pages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Billing</h1>

      {/* Plan + usage */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
        {sub ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <p className="text-sm text-gray-500">Current plan</p>
              <p className="text-2xl font-bold text-gray-900 capitalize mt-1">
                {sub.plan}
              </p>
              <p className="text-sm text-gray-500 mt-1">
                {money(sub.monthlyPrice)} / month · {sub.period}
              </p>
            </div>
            <div className="md:col-span-2 grid grid-cols-2 gap-4">
              <Stat
                label="Contacts"
                value={sub.usage.contactsStored}
                limit={sub.limits.contactLimit}
              />
              <Stat
                label="Templates"
                value={sub.usage.templatesUsed}
                limit={sub.limits.templateLimit}
              />
              <Stat
                label="Messages sent"
                value={sub.usage.messagesSent}
                limit={null}
              />
              <Stat
                label="Webhook calls"
                value={sub.usage.webhookCalls}
                limit={null}
              />
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-400">Loading subscription…</p>
        )}
      </div>

      {/* AI usage accruing this cycle (post-paid → next invoice) */}
      {sub?.aiUsage && (
        <div className="bg-violet-50 border border-violet-200 rounded-xl p-5 mb-6 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-violet-900">
              AI usage this billing cycle
            </p>
            <p className="text-xs text-violet-700 mt-0.5">
              Added to your next invoice
              {sub.aiUsage.nextInvoiceDate
                ? ` (≈ ${new Date(
                    sub.aiUsage.nextInvoiceDate,
                  ).toLocaleDateString()})`
                : ''}
              .
            </p>
          </div>
          <p className="text-2xl font-bold text-violet-700 shrink-0">
            {money(sub.aiUsage.billedCents / 100)}
          </p>
        </div>
      )}

      {/* Invoices */}
      <div className="flex gap-1 flex-wrap mb-3">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => {
              setStatus(s);
              setPage(1);
            }}
            className={cn(
              'px-3 py-1 text-xs rounded-full capitalize',
              status === s
                ? 'bg-green-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200',
            )}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-500">
              <tr>
                <th className="px-4 py-3">Invoice #</th>
                <th className="px-4 py-3">Period</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Due</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center">
                    <div className="inline-block w-6 h-6 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-10 text-center text-gray-400"
                  >
                    No invoices.
                  </td>
                </tr>
              ) : (
                rows.map((inv) => (
                  <tr
                    key={inv.id}
                    className="border-t border-gray-100 hover:bg-gray-50"
                  >
                    <td className="px-4 py-3 font-medium text-gray-800">
                      {inv.invoice_number || `#${inv.id}`}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {inv.period || '—'}
                    </td>
                    <td className="px-4 py-3">{money(inv.amount)}</td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'text-xs px-2 py-0.5 rounded-full capitalize',
                          STATUS_STYLE[inv.status],
                        )}
                      >
                        {inv.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {inv.due_date ? fmtDateTime(inv.due_date) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right space-x-3">
                      <button
                        onClick={() => setDetail(inv)}
                        className="text-green-600 hover:underline text-xs"
                      >
                        View
                      </button>
                      <Link
                        href={`/billing/invoice/${inv.id}/print`}
                        className="text-gray-500 hover:text-gray-800 text-xs inline-flex items-center gap-1"
                        title="Open the invoice page and download as PDF"
                      >
                        <Download size={12} /> PDF
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 text-sm">
            <span className="text-gray-500">
              Page {page} of {pages} · {total} total
            </span>
            <div className="flex gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="px-3 py-1 rounded border border-gray-300 disabled:opacity-40"
              >
                Prev
              </button>
              <button
                disabled={page >= pages}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1 rounded border border-gray-300 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={`Invoice ${detail?.invoice_number || `#${detail?.id ?? ''}`}`}
      >
        {detail && (
          <div className="space-y-3 text-sm">
            <Row k="Amount" v={money(detail.amount)} />
            {(() => {
              const ai = detail.plan_snapshot?.ai_usage as
                | { billed_cents?: number }
                | null
                | undefined;
              if (!ai?.billed_cents) return null;
              return (
                <Row
                  k="— incl. AI usage"
                  v={money(ai.billed_cents / 100)}
                />
              );
            })()}
            <Row k="Status" v={detail.status} />
            <Row k="Period" v={detail.period || '—'} />
            <Row
              k="Due date"
              v={detail.due_date ? fmtDateTime(detail.due_date) : '—'}
            />
            <Row
              k="Paid at"
              v={detail.paid_at ? fmtDateTime(detail.paid_at) : 'Unpaid'}
            />
            <Row
              k="Created"
              v={detail.created_at ? fmtDateTime(detail.created_at) : '—'}
            />
            {detail.description && (
              <div>
                <p className="text-gray-500 mb-1">Description</p>
                <p className="text-gray-800 whitespace-pre-wrap">
                  {detail.description}
                </p>
              </div>
            )}
            <div className="pt-3 border-t border-gray-100 flex justify-end">
              <Link
                href={`/billing/invoice/${detail.id}/print`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-medium px-3 py-2"
              >
                <Download size={14} /> Download PDF
              </Link>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Stat({
  label,
  value,
  limit,
}: {
  label: string;
  value: number;
  limit: number | null;
}) {
  const pct =
    limit == null || limit <= 0
      ? null
      : Math.min(100, Math.round((value / limit) * 100));
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-gray-600">{label}</span>
        <span className="text-gray-500">
          {value.toLocaleString()}
          {limit != null ? ` / ${limit.toLocaleString()}` : ''}
        </span>
      </div>
      {pct != null && (
        <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
          <div
            className={cn(
              'h-full',
              pct > 80
                ? 'bg-red-500'
                : pct >= 60
                  ? 'bg-yellow-500'
                  : 'bg-green-500',
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between border-b border-gray-100 pb-2">
      <span className="text-gray-500">{k}</span>
      <span className="text-gray-800 capitalize">{v}</span>
    </div>
  );
}
