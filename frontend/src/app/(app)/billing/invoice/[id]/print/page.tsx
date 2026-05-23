'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Printer, ShieldCheck } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { cn, fmtDate, mediaUrl } from '@/lib/utils';
import type { Invoice, InvoiceStatus } from '@/lib/crm-types';

/**
 * A4-portrait, print-optimised invoice page. Opens in the same tab from
 * /billing — the user clicks "Print / Save as PDF" and the browser's
 * native print dialog produces a clean single-page PDF identical to what
 * they see on screen.
 *
 * Lives under (app)/ so the existing JWT + onboarding gates apply, but
 * the page uses `print:hidden` on the navbar wrapper via the `print:`
 * Tailwind variant inline so the actual sheet is just the invoice.
 *
 * For super-admins: visit via the existing "Impersonate owner" flow
 * (one click on the client profile) and then open the invoice from the
 * tenant's /billing page.
 */

interface InvoiceWithJoin extends Invoice {
  company?: {
    id: number;
    name: string;
    address: string | null;
    logo_url: string | null;
    timezone: string | null;
    activated_at: string | null;
    owner: { name: string; email: string } | null;
    plan: {
      plan_name: string;
      monthly_price: string | number;
      setup_fee: string | number;
    } | null;
  } | null;
}

function moneyUSD(v: string | number | null | undefined): string {
  const n = typeof v === 'string' ? Number(v) : (v ?? 0);
  if (!Number.isFinite(n)) return '$0.00';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function StatusBadge({ status }: { status: InvoiceStatus }) {
  const map = {
    paid: 'bg-emerald-50 text-emerald-700 border-emerald-300',
    pending: 'bg-amber-50 text-amber-800 border-amber-300',
    overdue: 'bg-red-50 text-red-700 border-red-300',
    cancelled: 'bg-slate-100 text-slate-600 border-slate-300',
  } as const;
  return (
    <span
      className={cn(
        'inline-block rounded-md px-3 py-1 text-xs font-semibold uppercase tracking-wider border',
        map[status],
      )}
    >
      {status}
    </span>
  );
}

export default function InvoicePrintPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = Number(params?.id);

  const [data, setData] = useState<InvoiceWithJoin | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    if (!Number.isFinite(id)) return;
    apiFetch<InvoiceWithJoin>(`/billing/invoices/${id}`)
      .then(setData)
      .catch((e) => {
        setError(
          e instanceof ApiError ? e.userMessage : 'Failed to load invoice',
        );
      })
      .finally(() => setLoading(false));
  }, [id]);

  const onPrint = useCallback(() => {
    if (typeof window !== 'undefined') window.print();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex justify-center pt-20">
        <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error || 'Invoice not found.'}
        </div>
        <button
          onClick={() => router.push('/billing')}
          className="mt-4 inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft size={14} /> Back to billing
        </button>
      </div>
    );
  }

  const c = data.company;
  const issued = fmtDate(data.created_at);
  const due = fmtDate(data.due_date);
  const paidOn = data.paid_at ? fmtDate(data.paid_at) : null;
  const amountUSD = moneyUSD(data.amount);

  // The cycle window for line-item presentation. We try the plan_snapshot
  // first (new invoices include cycle_start), fall back to the period or
  // the created_at month.
  const snapshot = data.plan_snapshot ?? {};
  const cycleStartIso =
    (snapshot as Record<string, string>).cycle_start ?? data.created_at;
  const cycleStart = new Date(cycleStartIso);
  const cycleEnd = new Date(cycleStart.getTime() + 30 * 86_400_000);

  const planName =
    (snapshot as Record<string, string>).plan_name ??
    c?.plan?.plan_name ??
    'Subscription';

  const lineDescription =
    data.description ??
    `${planName} plan — cycle starting ${fmtDate(cycleStart)}`;

  return (
    <>
      {/* Print-only CSS — collapses paddings so the sheet renders edge-to-edge,
          uses standard A4 portrait, and hides the on-screen action bar.
          Tailwind's `print:` variants handle most of this; we keep the
          @page rule here so it actually fires on the user's printer driver. */}
      <style jsx global>{`
        @page {
          size: A4 portrait;
          margin: 12mm 14mm;
        }
        /* Force browsers to PRINT backgrounds + gradients + colored fills
           instead of stripping them to save ink (default behaviour, which
           is why the saved PDF was coming out black-and-white). Has to be
           applied widely — the gradient header band, status pills, and
           card tints are all backgrounds. The webkit prefix covers
           Chrome/Edge/Safari; the unprefixed form covers Firefox + the
           PDF spec. */
        html,
        body,
        body *,
        .invoice-sheet,
        .invoice-sheet * {
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
          color-adjust: exact !important;
        }
        @media print {
          html,
          body {
            background: #fff !important;
          }
          .no-print {
            display: none !important;
          }
        }
      `}</style>

      <div className="min-h-screen bg-gray-100 print:bg-white">
        {/* Action bar — hidden in print */}
        <div className="no-print sticky top-0 z-10 bg-white border-b border-gray-200">
          <div className="max-w-[820px] mx-auto px-4 py-3 flex items-center gap-2">
            <button
              onClick={() => router.push('/billing')}
              className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
            >
              <ArrowLeft size={14} /> Back to billing
            </button>
            <span className="text-gray-300 mx-2">·</span>
            <span className="text-sm text-gray-500">
              Invoice {data.invoice_number ?? `#${data.id}`}
            </span>
            <button
              onClick={onPrint}
              className="ml-auto flex items-center gap-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-medium px-3 py-2 shadow-sm"
            >
              <Printer size={15} /> Print / Save as PDF
            </button>
          </div>
        </div>

        {/* The invoice sheet itself — sized to fit nicely on A4 */}
        <div className="max-w-[820px] mx-auto px-4 sm:px-6 py-6 sm:py-8 print:p-0">
          <div
            className="bg-white rounded-xl shadow-sm print:shadow-none print:rounded-none overflow-hidden border border-gray-100 print:border-0"
            style={{ minHeight: '1100px' }}
          >
            {/* Header band — gradient accent + branding */}
            <div className="bg-gradient-to-r from-emerald-600 to-green-600 text-white px-8 py-7 print:px-10 print:py-8">
              <div className="flex items-start justify-between gap-5">
                <div>
                  <div className="flex items-center gap-2 text-white/80 text-xs uppercase tracking-[0.2em] font-semibold">
                    <ShieldCheck size={14} /> Codentra · CodesApp
                  </div>
                  <h1 className="text-3xl sm:text-4xl font-bold mt-2">
                    INVOICE
                  </h1>
                  <p className="text-white/80 text-sm mt-1 font-mono">
                    {data.invoice_number ?? `#${data.id}`}
                  </p>
                </div>
                <div className="text-right">
                  <StatusBadge status={data.status} />
                  <div className="mt-3 text-white/90">
                    <div className="text-[10px] uppercase tracking-wider text-white/60">
                      Total
                    </div>
                    <div className="text-3xl font-bold tabular-nums">
                      {amountUSD}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* From / To band */}
            <div className="grid grid-cols-2 gap-8 px-8 py-6 print:px-10 print:py-7 border-b border-gray-100">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">
                  From
                </div>
                <div className="mt-1.5 text-sm">
                  <div className="font-semibold text-gray-900">
                    Codentra
                  </div>
                  <div className="text-gray-600">CodesApp Platform</div>
                  <div className="text-gray-500">apps.codentra.pk</div>
                  <div className="text-gray-500 mt-1">
                    admin@codentra.pk
                  </div>
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">
                  Bill to
                </div>
                <div className="mt-1.5 text-sm">
                  <div className="font-semibold text-gray-900 flex items-center gap-2">
                    {c?.logo_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={mediaUrl(c.logo_url) ?? c.logo_url}
                        alt=""
                        className="w-7 h-7 rounded object-cover border border-gray-200"
                      />
                    )}
                    {c?.name ?? `Company #${data.company_id}`}
                  </div>
                  {c?.owner && (
                    <div className="text-gray-600 mt-0.5">{c.owner.name}</div>
                  )}
                  {c?.owner?.email && (
                    <div className="text-gray-500">{c.owner.email}</div>
                  )}
                  {c?.address && (
                    <div className="text-gray-500 mt-1 whitespace-pre-line">
                      {c.address}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Key facts row */}
            <div className="grid grid-cols-3 gap-2 px-8 py-5 print:px-10 bg-gray-50/60 border-b border-gray-100">
              <Fact label="Issued" value={issued} />
              <Fact label="Due" value={due} />
              <Fact
                label={data.status === 'paid' ? 'Paid on' : 'Status'}
                value={paidOn ?? data.status.toUpperCase()}
              />
            </div>

            {/* Line items table */}
            <div className="px-8 py-6 print:px-10">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-gray-500 border-b-2 border-gray-200">
                    <th className="text-left py-2 font-semibold">
                      Description
                    </th>
                    <th className="text-left py-2 font-semibold">
                      Service period
                    </th>
                    <th className="text-right py-2 font-semibold">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-gray-100">
                    <td className="py-4 align-top">
                      <div className="font-medium text-gray-900 capitalize">
                        {planName} plan
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {lineDescription}
                      </div>
                    </td>
                    <td className="py-4 align-top text-gray-700 whitespace-nowrap">
                      {fmtDate(cycleStart)} → {fmtDate(cycleEnd)}
                    </td>
                    <td className="py-4 align-top text-right tabular-nums font-medium text-gray-900">
                      {amountUSD}
                    </td>
                  </tr>
                </tbody>
              </table>

              {/* Total */}
              <div className="flex justify-end mt-6">
                <div className="w-full sm:w-72">
                  <div className="flex justify-between text-sm text-gray-600 py-1.5">
                    <span>Subtotal</span>
                    <span className="tabular-nums">{amountUSD}</span>
                  </div>
                  <div className="flex justify-between text-sm text-gray-500 py-1.5 border-b border-gray-200">
                    <span>Tax</span>
                    <span className="tabular-nums">—</span>
                  </div>
                  <div className="flex justify-between text-base font-bold text-gray-900 py-3">
                    <span>Total due</span>
                    <span className="tabular-nums">{amountUSD}</span>
                  </div>
                  {data.status === 'paid' && paidOn && (
                    <div className="rounded-md bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs px-3 py-2 mt-2">
                      Paid in full on {paidOn}.
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Payment instructions footer */}
            <div className="px-8 py-6 print:px-10 bg-gray-50/60 border-t border-gray-100 mt-auto">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 text-xs">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-1">
                    Payment instructions
                  </div>
                  <p className="text-gray-600 leading-relaxed">
                    Settle this invoice by transferring{' '}
                    <strong>{amountUSD}</strong> by{' '}
                    <strong>{due}</strong>. Reach out to{' '}
                    <a
                      href="mailto:admin@codentra.pk"
                      className="text-emerald-700 underline"
                    >
                      admin@codentra.pk
                    </a>{' '}
                    for accepted payment channels (bank transfer, Wise,
                    Payoneer, JazzCash, EasyPaisa).
                  </p>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-1">
                    Reference
                  </div>
                  <p className="text-gray-600 leading-relaxed">
                    Please quote{' '}
                    <code className="bg-white border border-gray-200 rounded px-1.5 py-0.5 font-mono">
                      {data.invoice_number ?? `#${data.id}`}
                    </code>{' '}
                    when transferring so we can reconcile it to your
                    account automatically.
                  </p>
                </div>
              </div>
              <div className="mt-6 text-center text-[10px] text-gray-400 tracking-wide">
                Codentra · apps.codentra.pk · This is a computer-generated
                invoice and does not require a signature.
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Fact({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">
        {label}
      </div>
      <div className="text-sm font-semibold text-gray-900 mt-0.5">
        {value}
      </div>
    </div>
  );
}
