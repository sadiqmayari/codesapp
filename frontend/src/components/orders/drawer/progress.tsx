'use client';

import { cn, fmtDate, fmtDateTime } from '@/lib/utils';
import type { OrderDetail } from '@/lib/orders';

/** Placed → Confirmed → Booked → In transit → Delivered, derived purely from
 *  the mirror + shipment already loaded (no extra fetch). Each reached step
 *  shows its date underneath. A cancelled order or a returned/failed parcel
 *  ends the line in red at the step it reached. */
export function OrderProgress({ d }: { d: OrderDetail }) {
  const o = d.order;
  const sh = d.shipment && d.shipment.status !== 'cancelled' ? d.shipment : null;
  const st = (sh?.status ?? '').toLowerCase();
  const fulfilled = ['fulfilled', 'partially_fulfilled'].includes((o.fulfillmentStatus ?? '').toLowerCase());
  const delivered = st === 'delivered' || !!o.deliveredAt;
  const moving =
    delivered ||
    ['in_transit', 'out_for_delivery', 'picked_up', 'attempted', 'failed', 'returned'].includes(st);
  const booked = moving || !!sh || fulfilled;
  const confirmed =
    booked || !!o.manualConfirmedAt || (d.confirmation?.status ?? '') === 'confirmed';
  const steps: Array<{ label: string; done: boolean; at?: string | null }> = [
    { label: 'Placed', done: true, at: o.createdAt },
    {
      label: 'Confirmed',
      done: confirmed,
      at:
        o.manualConfirmedAt ??
        ((d.confirmation?.status ?? '') === 'confirmed' ? d.confirmation?.updatedAt : null) ??
        null,
    },
    { label: 'Booked', done: booked, at: sh?.bookedAt ?? null },
    { label: 'In transit', done: moving, at: sh?.attemptedAt ?? null },
    { label: 'Delivered', done: delivered, at: sh?.deliveredAt ?? o.deliveredAt },
  ];
  const broken = !!o.cancelledAt || ['failed', 'returned'].includes(st);
  const reached = steps.filter((x) => x.done).length; // 1..5
  const brokenLabel =
    o.cancelledAt && !['failed', 'returned'].includes(st)
      ? 'Cancelled'
      : st === 'failed'
        ? 'Failed'
        : 'Returned';
  return (
    <ol className="mt-4 grid grid-cols-5 gap-1" aria-label="Order progress">
      {steps.map((step, i) => {
        const isCurrent = i === reached && !broken;
        const isBroken = broken && i === reached;
        const pending = isCurrent && i === 1 && d.confirmation?.sentAt;
        return (
          <li
            key={step.label}
            className="min-w-0"
            title={step.at ? `${step.label} · ${fmtDateTime(step.at)}` : step.label}
          >
            <span
              className={cn(
                'block h-1.5 rounded-full',
                step.done
                  ? 'bg-brand-500'
                  : isBroken
                    ? 'bg-rose-500'
                    : isCurrent
                      ? 'bg-gradient-to-r from-brand-500 from-50% to-line to-50%'
                      : 'bg-line',
              )}
            />
            <span
              className={cn(
                'mt-1 block truncate text-xs font-bold',
                step.done
                  ? 'text-brand-700'
                  : isBroken
                    ? 'text-rose-600'
                    : isCurrent
                      ? 'text-ink'
                      : 'text-muted',
              )}
            >
              {isBroken ? brokenLabel : step.label}
            </span>
            <span className="block truncate text-[11px] text-muted">
              {step.done && step.at
                ? fmtDate(step.at)
                : pending
                  ? 'Awaiting reply'
                  : ' '}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
