'use client';

import { AlertTriangle, LogOut, Mail } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/context/auth-context';
import { fmtDate } from '@/lib/utils';
import type { AccountStatus } from '@/lib/crm-types';

const BILLING_EMAIL = 'admin@codentra.pk';

function daysOverdue(due: string): number {
  const diff = Date.now() - new Date(due).getTime();
  return diff <= 0 ? 0 : Math.floor(diff / 86_400_000);
}

/**
 * Shown instead of the app shell when a company is suspended for an
 * overdue invoice. Payment is handled out-of-band (no payment gateway):
 * this is an informational dead-end with the outstanding balance + a
 * pre-filled mailto so the owner can settle the balance through support.
 * Phase 5 (Suspended-workflow polish): adds per-invoice days-overdue,
 * a total outstanding row, and the support-email CTA.
 */
export function BillingBlocked({ status }: { status: AccountStatus }) {
  const { user } = useAuth();
  const companyName = user?.company?.name ?? 'Account';

  const total = status.unpaidInvoices.reduce(
    (s, i) => s + Number(i.amount ?? 0),
    0,
  );

  const subject = `[Suspension] ${companyName} — settle outstanding $${total.toFixed(2)}`;
  const lines = status.unpaidInvoices
    .map(
      (i) =>
        `• ${i.invoice_number ?? `#${i.id}`} — $${Number(i.amount ?? 0).toFixed(2)} (due ${fmtDate(i.due_date)})`,
    )
    .join('\n');
  const body =
    `Hi CodesApp team,\n\n` +
    `Our account "${companyName}" has been suspended for the following overdue invoice(s):\n\n` +
    `${lines || '(no invoices on file)'}\n\n` +
    `Total outstanding: $${total.toFixed(2)}\n\n` +
    `Please advise on settlement so service can be restored.\n\nThanks.`;
  const mailto = `mailto:${BILLING_EMAIL}?subject=${encodeURIComponent(
    subject,
  )}&body=${encodeURIComponent(body)}`;

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-2xl border border-red-200 bg-white shadow-sm overflow-hidden">
        <div className="bg-red-50 border-b border-red-200 px-6 py-5 flex items-start gap-3">
          <AlertTriangle className="text-red-500 shrink-0 mt-0.5" size={22} />
          <div>
            <h1 className="text-lg font-bold text-red-800">
              Service suspended — payment overdue
            </h1>
            <p className="text-sm text-red-700 mt-1">
              Access has been paused because your account has an overdue
              invoice. Settle the balance below to restore service.
            </p>
          </div>
        </div>

        <div className="px-6 py-5">
          <h2 className="text-xs font-semibold uppercase text-gray-500 mb-2">
            Outstanding invoices
          </h2>
          <div className="rounded-lg border border-gray-200 divide-y divide-gray-100">
            {status.unpaidInvoices.length === 0 ? (
              <p className="px-4 py-3 text-sm text-gray-500">
                No invoice on file — contact support.
              </p>
            ) : (
              status.unpaidInvoices.map((inv) => {
                const od = daysOverdue(inv.due_date);
                return (
                  <div
                    key={inv.id}
                    className="px-4 py-3 flex items-center justify-between text-sm"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-gray-800 truncate">
                        {inv.invoice_number ?? `Invoice #${inv.id}`}
                      </div>
                      <div className="text-gray-500 text-xs">
                        {inv.description ?? '—'} · due {fmtDate(inv.due_date)}
                        {od > 0 && (
                          <span className="ml-1 text-red-600 font-medium">
                            · {od}d overdue
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right pl-3 shrink-0">
                      <div className="font-semibold text-gray-900 tabular-nums">
                        ${Number(inv.amount ?? 0).toFixed(2)}
                      </div>
                      <div
                        className={
                          inv.status === 'overdue'
                            ? 'text-xs text-red-600 capitalize'
                            : 'text-xs text-gray-500 capitalize'
                        }
                      >
                        {inv.status}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="mt-4 flex items-center justify-between border-t border-gray-100 pt-3">
            <span className="text-sm text-gray-600">Total due</span>
            <span className="text-lg font-bold text-gray-900 tabular-nums">
              ${total.toFixed(2)}
            </span>
          </div>

          <p className="mt-5 text-sm text-gray-600">
            Already paid? It can take a short while to reflect. If you believe
            this is a mistake, contact CodesApp billing support.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <a
              href={mailto}
              className="inline-flex items-center gap-2 rounded-lg bg-green-600 hover:bg-green-700 text-white px-4 py-2 text-sm font-medium"
            >
              <Mail size={15} /> Email billing support
            </a>
            <button
              onClick={() => {
                api.post('/auth/logout').finally(() => {
                  window.location.assign('/login');
                });
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <LogOut size={15} /> Sign out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
