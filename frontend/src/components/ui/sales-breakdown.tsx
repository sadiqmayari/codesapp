'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * ONE sales vocabulary (mirrors backend common/utils/sales.ts):
 *   Gross sales = every order placed, item value before discounts (no shipping/tax)
 *   Net sales   = Gross − discounts − cancelled before shipping − returned (RTO)
 * Discounts / Cancelled / Returned are the breakdown, never headline numbers.
 */
export interface SalesBreakdown {
  orders: number;
  keptOrders: number;
  cancelledOrders: number;
  returnedOrders: number;
  gross: number;
  discounts: number;
  cancelled: number;
  returned: number;
  net: number;
  shipping: number;
  tax: number;
  noBreakdown?: number;
}

export const GROSS_HELP = 'Every order placed, item value before discounts. Includes orders later cancelled or returned. No shipping or tax.';
export const NET_HELP = 'Gross minus discounts, minus orders cancelled before shipping, minus parcels that came back (RTO).';

type Fmt = (v: number) => string;

/** "How Gross becomes Net" rows (used inline, in popovers and tooltips). */
export function SalesBreakdownRows({ b, fmt, className }: { b: SalesBreakdown; fmt: Fmt; className?: string }) {
  const pct = (v: number) => (b.gross > 0 ? `${((v / b.gross) * 100).toFixed(1)}%` : '');
  const rows: Array<[string, number, string]> = [
    ['Discounts', b.discounts, ''],
    ['Cancelled before shipping', b.cancelled, b.cancelledOrders ? `${b.cancelledOrders.toLocaleString()} orders` : ''],
    ['Returned (RTO)', b.returned, b.returnedOrders ? `${b.returnedOrders.toLocaleString()} parcels` : ''],
  ];
  return (
    <div className={cn('grid gap-1.5 text-[13px] tabular-nums', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-semibold text-ink">Gross sales</span>
        <span className="font-semibold text-ink">{fmt(b.gross)}</span>
      </div>
      {rows.map(([l, v, sub]) => (
        <div key={l} className="grid grid-cols-[1fr_auto] items-center gap-x-3">
          <span className="text-muted">
            − {l}
            {sub && <span className="ml-1 text-xs">· {sub}</span>}
          </span>
          <span className="text-right font-medium text-red-600 dark:text-red-400">
            − {fmt(v)} <span className="text-xs font-normal text-muted">{pct(v)}</span>
          </span>
          <span className="col-span-2 h-1 overflow-hidden rounded-full bg-sunken">
            <span className="block h-full rounded-full bg-red-400/80" style={{ width: `${b.gross > 0 ? Math.min(100, (v / b.gross) * 100) : 0}%` }} />
          </span>
        </div>
      ))}
      <div className="mt-0.5 flex items-baseline justify-between gap-3 border-t border-line pt-1.5">
        <span className="font-extrabold text-ink">Net sales</span>
        <span className="font-extrabold text-emerald-700 dark:text-emerald-400">
          {fmt(b.net)} <span className="text-xs font-normal text-muted">{pct(b.net)}</span>
        </span>
      </div>
      <div className="flex flex-wrap justify-between gap-x-3 text-xs text-muted">
        <span>{b.orders.toLocaleString()} orders</span>
        {(b.shipping > 0 || b.tax > 0) && <span>Shipping charged {fmt(b.shipping)}{b.tax ? ` · Tax ${fmt(b.tax)}` : ''} (not in sales)</span>}
      </div>
      {!!b.noBreakdown && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {b.noBreakdown.toLocaleString()} older orders are still missing their discount detail; gross is understated until the backfill finishes.
        </p>
      )}
    </div>
  );
}

/** Small ⓘ button that opens the breakdown in a fixed popover (never clipped by scrolling strips). */
export function SalesBreakdownButton({ b, fmt, label = 'How Gross becomes Net' }: { b: SalesBreakdown | null | undefined; fmt: Fmt; label?: string }) {
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const w = 320;
    setPos({ top: Math.min(window.innerHeight - 280, r.bottom + 6), left: Math.min(window.innerWidth - w - 8, Math.max(8, r.left - w / 2)) });
    const down = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const close = () => setOpen(false);
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);
  if (!b) return null;
  return (
    <>
      <button ref={btn} type="button" aria-label={label} aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className="inline-grid h-5 w-5 place-items-center rounded-full text-muted hover:bg-sunken hover:text-ink">
        <Info size={13} />
      </button>
      {open &&
        createPortal(
          <div ref={box} role="dialog" aria-label={label} style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: 320 }}
            className="fixed z-[70] whitespace-normal rounded-xl border border-line bg-surface p-3 text-left normal-case shadow-2xl">
            <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">{label}</div>
            <SalesBreakdownRows b={b} fmt={fmt} />
          </div>,
          document.body,
        )}
    </>
  );
}
