'use client';

import { useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { getOrderDetail, type OrderKey } from '@/lib/orders';
import { OrderDetailDrawer } from '@/components/orders/order-detail-view';
import {
  getContactOrders,
  orderDisplayStatus,
  orderStatusTone,
  type ContactOrder,
} from '@/lib/contact-orders';
import { CourierPaymentsBoard } from '@/components/orders/courier-payments-board';

/**
 * Finance dashboard for the `finance` role. The finance role is locked to this
 * page (the app shell bounces every other route except self-service Settings).
 *
 * It renders the SAME Courier-payments board owner/admin see under Orders →
 * Courier payments — COD receivable (with the per-parcel drill-down + settle),
 * Prepaid & gateway (card reconcile + PayFast), statement history, shortfalls
 * and (when enabled) invoice import — so finance works the full board here, not
 * a trimmed copy. Deleting applied statements stays owner/admin (those buttons
 * are hidden for finance inside the board). The order lookup on top is a
 * finance-specific convenience the board doesn't carry.
 */
export default function FinancePage() {
  const toast = useToast();
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Finance</h1>
        <p className="text-sm text-gray-500">
          Courier payments, settlements and order lookup.
        </p>
      </div>

      {/* Look up any order (read-only) — number or customer phone */}
      <OrderSearch />

      {/* The full Courier-payments board (shared with the owner/admin Orders view). */}
      <CourierPaymentsBoard toast={toast} />
    </div>
  );
}

/**
 * Order lookup for the finance role. Finance is locked to /finance, so an
 * occasional "where did this order's money land" question is answered here in
 * place: search by order number or customer phone, then view the order in a
 * READ-ONLY drawer (the same OrderDetailContent the Orders board uses, with
 * every mutating control hidden).
 *
 * Routing of the query:
 *  • ≥9 digits  → treated as a phone → by-contact lookup (one-to-many). One hit
 *    opens straight away; several show a pick-list.
 *  • otherwise  → treated as an order number → direct mirror lookup.
 */
function OrderSearch() {
  const [term, setTerm] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ContactOrder[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<OrderKey | null>(null);

  const money = (v: number | null | undefined, cur?: string | null) =>
    v == null ? '—' : `${cur ?? 'PKR'} ${Math.round(v).toLocaleString()}`;

  const run = async () => {
    const raw = term.trim();
    const digits = raw.replace(/\D/g, '');
    if (!digits) {
      setResults(null);
      setMsg('Enter an order number or customer phone.');
      return;
    }
    setBusy(true);
    setMsg(null);
    setResults(null);
    try {
      if (digits.length >= 9) {
        // Phone — a customer may have several orders.
        const res = await getContactOrders(raw);
        if (res.count === 0) setMsg(`No orders found for ${raw}.`);
        else if (res.count === 1) setOpen({ gid: res.orders[0].orderGid });
        else setResults(res.orders);
      } else {
        // Order number — unique. Validate so a bad number shows inline rather
        // than opening an empty drawer, then key the drawer by the resolved gid.
        const d = await getOrderDetail({ number: digits });
        setOpen({ gid: d.order.orderGid });
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMsg(`No order #${digits} found.`);
      else setMsg(e instanceof ApiError ? e.userMessage : 'Could not search — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
        className="flex items-stretch gap-2"
      >
        <div className="flex flex-1 items-center gap-2 rounded-lg border border-gray-300 bg-gray-50 px-3 focus-within:border-green-500 focus-within:ring-2 focus-within:ring-green-100">
          <Search size={16} className="shrink-0 text-gray-400" />
          <input
            value={term}
            onChange={(e) => {
              setTerm(e.target.value);
              if (msg) setMsg(null);
            }}
            placeholder="Search an order — number or customer phone"
            aria-label="Search orders"
            className="min-w-0 flex-1 bg-transparent py-2.5 text-sm text-gray-900 outline-none placeholder:text-gray-400"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-60"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
          <span className="hidden sm:inline">Search</span>
        </button>
      </form>

      <p className="mt-2 text-[11px] text-gray-400">
        View only — opens the order with its payment, courier settlement and
        timeline. No changes are made from here.
      </p>

      {msg && <p className="mt-3 text-sm text-gray-500">{msg}</p>}

      {results && results.length > 0 && (
        <div className="mt-3 divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200">
          <p className="bg-gray-50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            {results.length} orders for this number
          </p>
          {results.map((o) => (
            <button
              key={o.orderGid}
              onClick={() => setOpen({ gid: o.orderGid })}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-gray-50"
            >
              <span className="font-semibold text-gray-800">{o.orderName ?? '—'}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${orderStatusTone(o)}`}
              >
                {orderDisplayStatus(o)}
              </span>
              <span className="ml-auto shrink-0 font-medium tabular-nums text-gray-700">
                {money(o.total, o.currency)}
              </span>
            </button>
          ))}
        </div>
      )}

      {open && (
        <OrderDetailDrawer orderKey={open} readOnly onClose={() => setOpen(null)} />
      )}
    </div>
  );
}
