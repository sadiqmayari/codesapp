'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, X, Loader2, Package } from 'lucide-react';
import { humanizeStatus } from '@/lib/contact-orders';
import { lookupOrder, type OrderShare } from '@/lib/team-chat';

/**
 * Share a CodesApp order into a team chat. Type an order number → resolves the
 * order via the universal mirror lookup (`/shopify/orders/detail?number=`) →
 * preview card → Share. Debounced; never throws (lookup returns null on miss).
 */
export default function OrderPicker({
  onPick,
  onClose,
}: {
  onPick: (order: OrderShare) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [found, setFound] = useState<OrderShare | null>(null);
  const [missed, setMissed] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const n = q.replace(/[^0-9]/g, '');
    if (!n) {
      setFound(null);
      setMissed(false);
      setLoading(false);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    setMissed(false);
    const t = window.setTimeout(async () => {
      const order = await lookupOrder(n);
      if (mine !== seq.current) return; // a newer query superseded this one
      setLoading(false);
      setFound(order);
      setMissed(!order);
    }, 400);
    return () => window.clearTimeout(t);
  }, [q]);

  const money = (o: OrderShare) =>
    o.total == null
      ? null
      : `${o.currency ? o.currency + ' ' : ''}${Number(o.total).toLocaleString()}`;

  return (
    <div className="fixed inset-0 z-50 flex items-stretch sm:items-center sm:justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div className="relative flex max-h-full w-full flex-col bg-white shadow-xl sm:max-h-[80vh] sm:max-w-sm sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h2 className="font-semibold text-gray-900">Share an order</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div className="border-b border-gray-100 p-3">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              inputMode="numeric"
              placeholder="Order number, e.g. 34919"
              className="w-full rounded-lg border border-gray-300 py-2 pl-8 pr-3 text-sm"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-gray-300">
              <Loader2 className="animate-spin" size={22} />
            </div>
          ) : found ? (
            <button
              onClick={() => onPick(found)}
              className="flex w-full items-center gap-3 rounded-xl border border-gray-200 p-3 text-left hover:border-green-400 hover:bg-green-50"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-100 text-green-700">
                <Package size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-gray-900">
                  #{found.number}
                  {found.customerName ? ` · ${found.customerName}` : ''}
                </span>
                <span className="block text-xs text-gray-500">
                  {[
                    humanizeStatus(found.status),
                    found.itemCount != null ? `${found.itemCount} item${found.itemCount === 1 ? '' : 's'}` : null,
                    money(found),
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'Order'}
                </span>
              </span>
              <span className="shrink-0 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white">
                Share
              </span>
            </button>
          ) : missed ? (
            <p className="py-8 text-center text-sm text-gray-400">No order found for that number.</p>
          ) : (
            <p className="py-8 text-center text-sm text-gray-400">
              Type an order number to find it.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
