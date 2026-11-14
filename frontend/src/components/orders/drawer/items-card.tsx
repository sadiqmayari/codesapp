'use client';

import { Package } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Section, type MoneyFmt } from './shared';

export interface DrawerItem {
  title: string;
  quantity: number;
  variantTitle: string | null;
  unitPrice: number | null;
  originalUnitPrice?: number | null;
  lineDiscount?: number | null;
  lineTotal: number | null;
  image: string | null;
}

/**
 * Order money lines that always reconcile:
 * Items before discount (gross) − discounts = items after discount
 * + shipping + tax = order total; − received − refunded → COD to collect.
 */
export interface OrderMoney {
  itemsGross: number | null;
  discountTotal: number;
  discounts: Array<{ label: string; detail: string | null; amount: number | null }>;
  itemsAfter: number | null;
  shipping: number | null;
  tax: number | null;
  received: number;
  refunded: number;
  /** cancelled / returned orders are not counted in net sales */
  state: 'kept' | 'cancelled' | 'returned';
}

export function ItemsCard({
  items,
  money,
  m,
  total,
  outstanding,
  paid,
}: {
  items: DrawerItem[];
  money: MoneyFmt;
  m: OrderMoney;
  total: number | null;
  outstanding: number;
  paid: boolean;
}) {
  const units = items.reduce((n, it) => n + (it.quantity ?? 0), 0);
  return (
    <Section
      title="Items"
      icon={<Package size={13} />}
      right={<span className="text-muted">{units} {units === 1 ? 'item' : 'items'}</span>}
    >
      <div className="divide-y divide-line">
        {items.map((it, i) => {
          const struck =
            it.originalUnitPrice != null &&
            it.unitPrice != null &&
            it.originalUnitPrice - it.unitPrice > 0.009;
          return (
            <div key={i} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              {it.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={it.image} alt="" className="h-11 w-11 shrink-0 rounded-xl object-cover" />
              ) : (
                <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-sunken text-muted">
                  <Package size={16} />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-bold leading-snug text-ink min-w-0 break-words [word-break:break-word]">
                  {it.title}
                  <span className="ml-1.5 rounded-md bg-sunken px-1.5 py-px text-xs font-extrabold text-muted">
                    ×{it.quantity}
                  </span>
                </p>
                {it.variantTitle && <p className="text-xs text-muted">{it.variantTitle}</p>}
              </div>
              <div className="shrink-0 text-right text-[12.5px] tabular-nums">
                {struck && (
                  <div className="text-muted line-through">
                    {money((it.originalUnitPrice ?? 0) * (it.quantity ?? 0))}
                  </div>
                )}
                <div className="font-bold text-ink">{money(it.lineTotal ?? it.unitPrice)}</div>
                {it.lineDiscount != null && it.lineDiscount > 0.009 && !struck && (
                  <div className="text-xs text-brand-700">− {money(it.lineDiscount)}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 space-y-1 border-t border-line pt-3 text-[13px] tabular-nums">
        {m.itemsGross != null && (
          <Row label="Items before discount" value={money(m.itemsGross)} hint="gross" />
        )}
        {m.discountTotal > 0.009 &&
          (m.discounts.length > 1 ? (
            <>
              {m.discounts.map((d, i) => (
                <Row
                  key={i}
                  label={`Discount · ${d.label}${d.detail ? ` (${d.detail})` : ''}`}
                  value={d.amount != null ? `− ${money(d.amount)}` : ''}
                  className="text-brand-700"
                />
              ))}
              <Row label="Total discounts" value={`− ${money(m.discountTotal)}`} className="text-brand-700" />
            </>
          ) : (
            <Row
              label={
                m.discounts[0]
                  ? `Discount · ${m.discounts[0].label}${m.discounts[0].detail ? ` (${m.discounts[0].detail})` : ''}`
                  : 'Discount'
              }
              value={`− ${money(m.discountTotal)}`}
              className="text-brand-700"
            />
          ))}
        {m.itemsAfter != null && (m.discountTotal > 0.009 || m.itemsGross == null) && (
          <Row label="Items after discount" value={money(m.itemsAfter)} strong />
        )}
        {m.shipping != null && <Row label="Shipping" value={m.shipping > 0.009 ? `+ ${money(m.shipping)}` : 'Free'} />}
        {m.tax != null && m.tax > 0.009 && <Row label="Tax" value={`+ ${money(m.tax)}`} />}
        <div className="!mt-2 border-t border-line pt-2">
          <Row label="Order total" value={money(total)} strong />
        </div>
        {m.received > 0.009 && outstanding > 0.009 && (
          <Row label="Advance received" value={`− ${money(m.received)}`} />
        )}
        {m.refunded > 0.009 && <Row label="Refunded" value={money(m.refunded)} />}
        {outstanding > 0 ? (
          <Row
            label="COD to collect"
            value={money(outstanding)}
            className="mt-1 rounded-lg bg-amber-50 px-2 py-1.5 font-extrabold text-amber-800"
          />
        ) : (
          <Row
            label="Balance"
            value={paid ? 'Paid' : 'Nothing to collect'}
            className="text-brand-700"
          />
        )}
        {m.state !== 'kept' && m.itemsAfter != null && (
          <p className="pt-1 text-xs font-semibold text-red-600 dark:text-red-400">
            {m.state === 'returned' ? 'Returned' : 'Cancelled'} · {money(m.itemsAfter)} not counted in net sales.
          </p>
        )}
      </div>
    </Section>
  );
}

function Row({
  label,
  value,
  strong,
  className,
  hint,
}: {
  label: string;
  value: string;
  strong?: boolean;
  className?: string;
  hint?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <span className={cn(!className && 'text-muted', strong && 'font-bold text-ink')}>
        {label}
        {hint && <span className="ml-1 text-xs font-normal text-muted">({hint})</span>}
      </span>
      <span className={cn('font-semibold', !className && 'text-ink', strong && 'text-[15px] font-extrabold')}>
        {value}
      </span>
    </div>
  );
}
