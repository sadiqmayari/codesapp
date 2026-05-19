'use client';

import { AlertTriangle, LogOut } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/utils';
import type { AccountStatus } from '@/lib/crm-types';

/**
 * Shown instead of the app shell when a company is suspended for an
 * overdue invoice. Payment is handled out-of-band (no payment gateway):
 * this is an informational dead-end with the outstanding balance so the
 * owner knows exactly what to settle to restore service.
 */
export function BillingBlocked({ status }: { status: AccountStatus }) {
  const total = status.unpaidInvoices.reduce(
    (s, i) => s + Number(i.amount ?? 0),
    0,
  );

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
              status.unpaidInvoices.map((inv) => (
                <div
                  key={inv.id}
                  className="px-4 py-3 flex items-center justify-between text-sm"
                >
                  <div>
                    <div className="font-medium text-gray-800">
                      {inv.invoice_number ?? `Invoice #${inv.id}`}
                    </div>
                    <div className="text-gray-500 text-xs">
                      {inv.description ?? '—'} · due {fmtDate(inv.due_date)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold text-gray-900">
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
              ))
            )}
          </div>

          <div className="mt-4 flex items-center justify-between">
            <span className="text-sm text-gray-600">Total due</span>
            <span className="text-lg font-bold text-gray-900">
              ${total.toFixed(2)}
            </span>
          </div>

          <p className="mt-5 text-sm text-gray-600">
            Already paid? It can take a short while to reflect. If you believe
            this is a mistake, contact CodesApp billing support.
          </p>

          <button
            onClick={() => {
              api.post('/auth/logout').finally(() => {
                window.location.assign('/login');
              });
            }}
            className="mt-5 inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
