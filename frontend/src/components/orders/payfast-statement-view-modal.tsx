'use client';

import { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/utils';
import {
  getPayfastSettlement,
  payfastStatementPdf,
  type PayfastPreview,
} from '@/lib/payfast';

/**
 * The on-screen consolidated PayFast statement: grand totals, then each payout
 * settlement as its own section (its orders + subtotal). Drills grand → settlement
 * → order, all tying back to what PayFast deposited.
 */
export function PayfastStatementViewModal({
  id,
  onClose,
}: {
  id: number;
  onClose: () => void;
}) {
  const toast = useToast();
  const [data, setData] = useState<PayfastPreview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPayfastSettlement(id)
      .then(setData)
      .catch((e) => toast.error(e instanceof ApiError ? e.userMessage : 'Could not load the statement'));
  }, [id, toast]);

  const cur = data?.currency ?? 'PKR';
  const money = (v: number | null | undefined) =>
    v == null ? '—' : `${cur} ${Math.round(v).toLocaleString()}`;

  const download = async () => {
    setBusy(true);
    try {
      const { url } = await payfastStatementPdf(id);
      window.open(url, '_blank', 'noreferrer');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not build the PDF');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title="PayFast settlement statement" onClose={onClose}>
      {!data ? (
        <div className="flex items-center justify-center py-16 text-gray-400">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-semibold text-gray-800">Merchant {data.merchantId ?? '—'}</p>
            <p className="text-xs text-gray-500">
              {data.periodStart ? fmtDate(data.periodStart) : '?'} → {data.periodEnd ? fmtDate(data.periodEnd) : '?'}
            </p>
          </div>

          {/* Grand totals */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ['Gross collected', money(data.gross), 'text-gray-800'],
              ['PayFast fees', `- ${money(data.fees)}`, 'text-red-700'],
              ['Received (payout)', money(data.received), 'text-green-700'],
              ['WHT + ST withheld', money(data.whtSt), 'text-gray-500'],
            ].map(([label, val, col]) => (
              <div key={label} className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                <p className="text-[11px] text-gray-500">{label}</p>
                <p className={`text-sm font-semibold ${col}`}>{val}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-500">
            {data.matchedTxns.toLocaleString()} of {data.totalTxns.toLocaleString()} transactions
            matched · {data.batches.length} settlements
          </p>

          {/* Per-settlement sections */}
          <div className="max-h-[52vh] space-y-3 overflow-y-auto pr-1">
            {data.batches.map((b, i) => (
              <details key={i} className="rounded-lg border border-gray-200" open={data.batches.length <= 3}>
                <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 bg-gray-50 px-3 py-2 text-xs">
                  <span className="font-semibold text-gray-800">
                    {b.settlementDate ?? '—'} · {b.bank} · {b.count} orders
                  </span>
                  <span className="font-semibold text-green-700">
                    {money(b.gross)} → {money(b.received)}
                  </span>
                </summary>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-100 text-left text-gray-500">
                        <th className="px-3 py-1.5">Order</th>
                        <th className="px-2 py-1.5">Method</th>
                        <th className="px-2 py-1.5 text-right">Amount</th>
                        <th className="px-2 py-1.5 text-right">Fee</th>
                        <th className="px-3 py-1.5 text-right">Received</th>
                      </tr>
                    </thead>
                    <tbody>
                      {b.txns.map((t, j) => (
                        <tr key={j} className="border-b border-gray-50 last:border-0">
                          <td className="px-3 py-1.5 font-medium text-gray-800">
                            {t.orderName ?? <span className="text-red-600">unmatched</span>}
                          </td>
                          <td className="px-2 py-1.5 text-gray-500">{t.issuer}</td>
                          <td className="px-2 py-1.5 text-right">{money(t.amount)}</td>
                          <td className="px-2 py-1.5 text-right text-gray-500">{money(t.fee)}</td>
                          <td className="px-3 py-1.5 text-right text-gray-700">{money(t.merchantAmount)}</td>
                        </tr>
                      ))}
                      <tr className="bg-gray-50 font-semibold">
                        <td className="px-3 py-1.5 text-gray-800">Subtotal</td>
                        <td className="px-2 py-1.5 text-gray-500">{b.count}</td>
                        <td className="px-2 py-1.5 text-right">{money(b.gross)}</td>
                        <td className="px-2 py-1.5 text-right text-red-700">{money(b.fees)}</td>
                        <td className="px-3 py-1.5 text-right text-green-700">{money(b.received)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </details>
            ))}
          </div>

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
              Close
            </button>
            <button
              onClick={download}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-white hover:bg-gray-900 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Download PDF
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
