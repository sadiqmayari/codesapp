'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, Landmark, Loader2, CreditCard, Truck, Wallet } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { fmtDate } from '@/lib/utils';
import {
  getCourierPendingPayments,
  getPrepaidPayments,
  listCourierInvoices,
  courierInvoicePdf,
  COURIER_LABELS,
  type PendingPaymentsSummary,
  type PrepaidPaymentsSummary,
  type CourierInvoice,
} from '@/lib/couriers';
import {
  listPayfastSettlements,
  payfastStatementPdf,
  type PayfastSettlement,
} from '@/lib/payfast';
import { CourierInvoiceViewModal } from '@/components/orders/courier-invoice-view-modal';
import { PayfastStatementViewModal } from '@/components/orders/payfast-statement-view-modal';

/**
 * View-only finance dashboard for the `finance` role: courier COD receivable +
 * prepaid payout cards, plus the courier-invoice and PayFast-settlement statement
 * histories with view + download. No money actions (upload / apply / settle /
 * reconcile) — those stay with owner/admin.
 */
export default function FinancePage() {
  const toast = useToast();
  const [pending, setPending] = useState<PendingPaymentsSummary | null>(null);
  const [prepaid, setPrepaid] = useState<PrepaidPaymentsSummary | null>(null);
  const [invoices, setInvoices] = useState<CourierInvoice[]>([]);
  const [settlements, setSettlements] = useState<PayfastSettlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewInvoiceId, setViewInvoiceId] = useState<number | null>(null);
  const [viewSettlementId, setViewSettlementId] = useState<number | null>(null);
  const [pdfBusy, setPdfBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [pp, pr, inv, st] = await Promise.allSettled([
      getCourierPendingPayments(),
      getPrepaidPayments(),
      listCourierInvoices(),
      listPayfastSettlements(),
    ]);
    if (pp.status === 'fulfilled') setPending(pp.value);
    if (pr.status === 'fulfilled') setPrepaid(pr.value);
    if (inv.status === 'fulfilled') setInvoices(inv.value);
    if (st.status === 'fulfilled') setSettlements(st.value);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const money = (v: number | null | undefined, cur?: string | null) =>
    v == null ? '—' : `${cur ?? 'PKR'} ${Math.round(v).toLocaleString()}`;

  const downloadCourierPdf = async (id: number) => {
    setPdfBusy(`inv-${id}`);
    try {
      const { url } = await courierInvoicePdf(id);
      window.open(url, '_blank', 'noreferrer');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not build the PDF');
    } finally {
      setPdfBusy(null);
    }
  };
  const downloadPayfastPdf = async (id: number) => {
    setPdfBusy(`pf-${id}`);
    try {
      const { url } = await payfastStatementPdf(id);
      window.open(url, '_blank', 'noreferrer');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not build the PDF');
    } finally {
      setPdfBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center p-16">
        <Loader2 className="h-7 w-7 animate-spin text-green-500" />
      </div>
    );
  }

  const cur = pending?.currency ?? null;
  const bank = prepaid?.bankDeposit;
  const card = prepaid?.cardPayments;
  const bankTotal = (bank?.deliveredValue ?? 0) + (bank?.inTransitValue ?? 0);
  const cardTotal = (card?.deliveredValue ?? 0) + (card?.inTransitValue ?? 0);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Finance</h1>
        <p className="text-sm text-gray-500">Payments received and settlement statements (view only).</p>
      </div>

      {/* Top cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center gap-2 text-gray-500">
            <Wallet size={16} />
            <span className="text-xs uppercase tracking-wide">Courier COD receivable</span>
          </div>
          <p className="mt-1 text-3xl font-bold text-gray-900">{money(pending?.totals.receivable, cur)}</p>
          <p className="text-xs text-gray-400">
            {(pending?.totals.receivableCount ?? 0).toLocaleString()} delivered · not yet remitted
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center gap-2 text-gray-500">
            <Landmark size={16} />
            <span className="text-xs uppercase tracking-wide">Bank deposit (prepaid)</span>
          </div>
          <p className="mt-1 text-3xl font-bold text-gray-800">{money(bankTotal, bank?.currency)}</p>
          <p className="text-xs text-gray-400">already paid · informational</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center gap-2 text-gray-500">
            <CreditCard size={16} />
            <span className="text-xs uppercase tracking-wide">Card payments (gateway)</span>
          </div>
          <p className="mt-1 text-3xl font-bold text-green-600">{money(cardTotal, card?.currency)}</p>
          <p className="text-xs text-gray-400">awaiting / reconciled via settlements</p>
        </div>
      </div>

      {/* COD by courier */}
      {pending && pending.couriers.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="mb-3 flex items-center gap-2 text-sm font-medium text-gray-700">
            <Truck size={16} className="text-gray-400" /> Courier COD by courier
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-gray-500">
                  <th className="py-1.5 pr-2">Courier</th>
                  <th className="px-2 py-1.5 text-right">Receivable now</th>
                  <th className="px-2 py-1.5 text-right">Parcels</th>
                  <th className="px-2 py-1.5 text-right">In transit</th>
                </tr>
              </thead>
              <tbody>
                {pending.couriers.map((c) => (
                  <tr key={c.courier} className="border-b border-gray-50 last:border-0">
                    <td className="py-1.5 pr-2 font-medium text-gray-800">{COURIER_LABELS[c.courier]}</td>
                    <td className="px-2 py-1.5 text-right">{money(c.receivable, c.currency)}</td>
                    <td className="px-2 py-1.5 text-right text-gray-600">{c.receivableCount.toLocaleString()}</td>
                    <td className="px-2 py-1.5 text-right text-gray-500">{c.inTransitCount.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* PayFast settlements */}
      <StatementTable
        title="PayFast settlements"
        empty="No PayFast settlements yet."
        rows={settlements.map((s) => ({
          id: s.id,
          left: `${s.periodStart ? fmtDate(s.periodStart) : '?'} → ${s.periodEnd ? fmtDate(s.periodEnd) : '?'}`,
          mid: `${s.matchedTxns}/${s.totalTxns} txns`,
          amount: money(s.received, s.currency),
          status: s.status,
          onView: () => setViewSettlementId(s.id),
          onPdf: () => downloadPayfastPdf(s.id),
          pdfBusy: pdfBusy === `pf-${s.id}`,
        }))}
      />

      {/* Courier settlement invoices */}
      <StatementTable
        title="Courier settlement invoices"
        empty="No courier invoices yet."
        rows={invoices.map((i) => ({
          id: i.id,
          left: `${i.courierName} · ${i.invoiceNumber ?? '—'}`,
          mid: i.reportDate ? fmtDate(i.reportDate) : '',
          amount: money(i.netPayable, i.currency),
          status: i.status,
          onView: () => setViewInvoiceId(i.id),
          onPdf: () => downloadCourierPdf(i.id),
          pdfBusy: pdfBusy === `inv-${i.id}`,
        }))}
      />

      {viewInvoiceId != null && (
        <CourierInvoiceViewModal id={viewInvoiceId} onClose={() => setViewInvoiceId(null)} />
      )}
      {viewSettlementId != null && (
        <PayfastStatementViewModal id={viewSettlementId} onClose={() => setViewSettlementId(null)} />
      )}
    </div>
  );
}

function StatementTable({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: Array<{
    id: number;
    left: string;
    mid: string;
    amount: string;
    status: string;
    onView: () => void;
    onPdf: () => void;
    pdfBusy: boolean;
  }>;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="mb-3 text-sm font-medium text-gray-700">{title}</p>
      {rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-gray-400">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-gray-500">
                <th className="py-1.5 pr-2">Statement</th>
                <th className="px-2 py-1.5">Date</th>
                <th className="px-2 py-1.5 text-right">Net</th>
                <th className="px-2 py-1.5">Status</th>
                <th className="px-2 py-1.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-gray-50 last:border-0">
                  <td className="py-1.5 pr-2 font-medium text-gray-800">{r.left}</td>
                  <td className="px-2 py-1.5 text-gray-500">{r.mid}</td>
                  <td className="px-2 py-1.5 text-right font-medium text-gray-800">{r.amount}</td>
                  <td className="px-2 py-1.5">
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-600">
                      {r.status}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button onClick={r.onView} className="font-medium text-green-700 hover:underline">
                        View
                      </button>
                      <button
                        onClick={r.onPdf}
                        disabled={r.pdfBusy}
                        className="inline-flex items-center gap-1 font-medium text-gray-600 hover:text-gray-900 disabled:opacity-50"
                      >
                        {r.pdfBusy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                        PDF
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
