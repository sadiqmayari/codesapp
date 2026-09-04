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
  getCourierShortfalls,
  COURIER_LABELS,
  type PendingPaymentsSummary,
  type PrepaidPaymentsSummary,
  type CourierInvoice,
  type ShortfallsResult,
  type ReceivableAging,
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
  const [shortfalls, setShortfalls] = useState<ShortfallsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewInvoiceId, setViewInvoiceId] = useState<number | null>(null);
  const [viewSettlementId, setViewSettlementId] = useState<number | null>(null);
  const [pdfBusy, setPdfBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [pp, pr, inv, st, sf] = await Promise.allSettled([
      getCourierPendingPayments(),
      getPrepaidPayments(),
      listCourierInvoices(),
      listPayfastSettlements(),
      getCourierShortfalls(),
    ]);
    if (pp.status === 'fulfilled') setPending(pp.value);
    if (pr.status === 'fulfilled') setPrepaid(pr.value);
    if (inv.status === 'fulfilled') setInvoices(inv.value);
    if (st.status === 'fulfilled') setSettlements(st.value);
    if (sf.status === 'fulfilled') setShortfalls(sf.value);
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

      {/* Courier COD receivable — aged. Mirrors the Courier-payments ledger
          (view-only here): the same money, split by how long it has been owed,
          with the oldest unpaid parcel per courier so a stale debt surfaces. */}
      {pending && pending.couriers.length > 0 && (() => {
        const ag = pending.totals.aging;
        const agTotal = ag ? ag.d0_15 + ag.d16_30 + ag.d31_60 + ag.d60plus : 0;
        const BANDS: Array<{ key: keyof ReceivableAging; label: string; bar: string; text: string }> = [
          { key: 'd0_15', label: '0–15d', bar: 'bg-teal-500', text: 'text-teal-700' },
          { key: 'd16_30', label: '16–30d', bar: 'bg-amber-500', text: 'text-amber-700' },
          { key: 'd31_60', label: '31–60d', bar: 'bg-orange-500', text: 'text-orange-700' },
          { key: 'd60plus', label: '60d+', bar: 'bg-rose-500', text: 'text-rose-700' },
        ];
        const ageTone = (d: number | null) =>
          d == null ? 'text-gray-400'
            : d > 60 ? 'text-rose-600 font-semibold'
            : d > 30 ? 'text-orange-600'
            : d > 15 ? 'text-amber-600'
            : 'text-gray-500';
        return (
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="mb-3 flex items-center gap-2 text-sm font-medium text-gray-700">
              <Truck size={16} className="text-gray-400" /> Courier COD by courier — aged
            </p>

            {ag && agTotal > 0 && (
              <div className="mb-3">
                <div className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-gray-100">
                  {BANDS.map((b) =>
                    ag[b.key] > 0 ? (
                      <span
                        key={b.key}
                        className={b.bar}
                        style={{ width: `${(ag[b.key] / agTotal) * 100}%` }}
                        title={`${b.label}: ${money(ag[b.key], cur)}`}
                      />
                    ) : null,
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                  {BANDS.map((b) => (
                    <span key={b.key} className="inline-flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-sm ${b.bar}`} />
                      <span className="text-gray-600">{b.label}</span>
                      <span className="tabular-nums text-gray-400">{money(ag[b.key], cur)}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-gray-500">
                    <th className="py-1.5 pr-2">Courier</th>
                    {BANDS.map((b) => (
                      <th key={b.key} className="px-2 py-1.5 text-right">{b.label}</th>
                    ))}
                    <th className="px-2 py-1.5 text-right">Receivable</th>
                    <th className="px-2 py-1.5">Oldest</th>
                    <th className="px-2 py-1.5 text-right">In transit</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.couriers
                    .slice()
                    .sort((a, b) => b.receivable - a.receivable)
                    .map((c) => (
                      <tr key={c.courier} className="border-b border-gray-50 last:border-0">
                        <td className="py-1.5 pr-2 font-medium text-gray-800">
                          {COURIER_LABELS[c.courier]}
                        </td>
                        {BANDS.map((b) => {
                          const v = c.aging?.[b.key] ?? 0;
                          return (
                            <td
                              key={b.key}
                              className={`px-2 py-1.5 text-right tabular-nums ${v > 0 ? b.text : 'text-gray-300'}`}
                            >
                              {v > 0 ? money(v, c.currency) : '—'}
                            </td>
                          );
                        })}
                        <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-gray-900">
                          {money(c.receivable, c.currency)}
                          <span className="block text-[11px] font-normal text-gray-400">
                            {c.receivableCount.toLocaleString()} parcels
                          </span>
                        </td>
                        <td className={`px-2 py-1.5 tabular-nums ${ageTone(c.oldestDays)}`}>
                          {c.oldestDays == null ? '—' : `${c.oldestDays}d`}
                        </td>
                        <td className="px-2 py-1.5 text-right text-gray-500">
                          {c.inTransitCount.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* Shortfalls — parcels a courier's statement short-paid. View + export,
          the same standing list the Courier-payments tab shows, so finance can
          chase recoverable losses. */}
      {shortfalls && shortfalls.totals.count > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-gray-700">Courier shortfalls</p>
              <p className="text-xs text-gray-400">
                <span className="font-semibold text-rose-600">
                  {money(shortfalls.totals.total, shortfalls.currency)}
                </span>{' '}
                short-paid across {shortfalls.totals.count.toLocaleString()} parcel
                {shortfalls.totals.count === 1 ? '' : 's'} on applied statements
              </p>
            </div>
            <button
              onClick={() => {
                const head = 'Order,Tracking,Courier,Statement,Expected,Paid,Shortfall\n';
                const body = shortfalls.items
                  .map((i) =>
                    [i.orderName ?? '', i.trackingNumber ?? '', COURIER_LABELS[i.courier], i.invoiceNumber ?? '', i.expectedCod, i.paidCod, i.shortfall]
                      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
                      .join(','),
                  )
                  .join('\n');
                const url = URL.createObjectURL(new Blob([head + body], { type: 'text/csv;charset=utf-8;' }));
                const a = document.createElement('a');
                a.href = url;
                a.download = `courier-shortfalls-${new Date().toISOString().slice(0, 10)}.csv`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            >
              <Download size={13} /> Export
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-gray-500">
                  <th className="py-1.5 pr-2">Order</th>
                  <th className="px-2 py-1.5">Courier</th>
                  <th className="px-2 py-1.5">Statement</th>
                  <th className="px-2 py-1.5 text-right">Order says</th>
                  <th className="px-2 py-1.5 text-right">Paid</th>
                  <th className="px-2 py-1.5 text-right">Short by</th>
                </tr>
              </thead>
              <tbody>
                {shortfalls.items.slice(0, 100).map((i, n) => (
                  <tr key={`${i.invoiceId}-${i.trackingNumber ?? n}`} className="border-b border-gray-50 last:border-0">
                    <td className="py-1.5 pr-2 font-medium text-gray-800">
                      {i.orderName ?? '—'}
                    </td>
                    <td className="px-2 py-1.5 text-gray-600">{COURIER_LABELS[i.courier]}</td>
                    <td className="px-2 py-1.5 text-gray-500">{i.invoiceNumber ?? '—'}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-gray-700">{money(i.expectedCod, i.currency)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-gray-700">{money(i.paidCod, i.currency)}</td>
                    <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-rose-600">{money(i.shortfall, i.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shortfalls.items.length > 100 && (
            <p className="mt-2 text-[11px] text-gray-400">
              Showing the 100 largest. Export for the full list.
            </p>
          )}
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
