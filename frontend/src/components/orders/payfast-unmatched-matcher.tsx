'use client';

import { useState } from 'react';
import { Loader2, Link2 } from 'lucide-react';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { matchPayfastTxn } from '@/lib/payfast';

type Sample = { paymentId: string; issuer: string; amount: number };

/**
 * Renders each unmatched PayFast transaction with an inline "order #" input so an
 * agent can manually link it to its order (repoints the order's gateway ref at
 * the settled payment id + stamps it if already applied). Used in the upload
 * preview and the statement view. Calls `onChanged` after a successful match so
 * the parent re-fetches the settlement (the row then drops out).
 */
export function PayfastUnmatchedMatcher({
  settlementId,
  samples,
  money,
  onChanged,
}: {
  settlementId: number;
  samples: Sample[];
  money: (v: number | null | undefined) => string;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const match = async (paymentId: string) => {
    const orderNumber = (vals[paymentId] ?? '').trim();
    if (!orderNumber) {
      toast.error('Enter the order number to link this payment.');
      return;
    }
    setBusy(paymentId);
    try {
      const r = await matchPayfastTxn(settlementId, paymentId, orderNumber);
      toast.success(
        r.reconciled
          ? `Linked to ${r.orderName} and marked reconciled`
          : `Linked to ${r.orderName}`,
      );
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not link that order');
    } finally {
      setBusy(null);
    }
  };

  return (
    <ul className="mt-2 space-y-1.5">
      {samples.map((u) => (
        <li
          key={u.paymentId}
          className="flex flex-wrap items-center gap-2 rounded-md bg-white/60 px-2 py-1.5 text-amber-900"
        >
          <span className="min-w-0 flex-1 break-all text-[11px]">
            {u.paymentId} · {u.issuer} · {money(u.amount)}
          </span>
          <div className="flex items-center gap-1">
            <span className="text-gray-400">#</span>
            <input
              value={vals[u.paymentId] ?? ''}
              onChange={(e) => setVals((v) => ({ ...v, [u.paymentId]: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && match(u.paymentId)}
              placeholder="Order no."
              className="w-24 rounded border border-amber-300 bg-white px-2 py-1 text-xs text-gray-800 focus:border-amber-500 focus:outline-none"
            />
            <button
              onClick={() => match(u.paymentId)}
              disabled={busy === u.paymentId}
              className="inline-flex items-center gap-1 rounded-md bg-amber-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {busy === u.paymentId ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Link2 className="h-3 w-3" />
              )}
              Link
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
