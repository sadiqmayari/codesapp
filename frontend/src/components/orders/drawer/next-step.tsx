'use client';

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  MapPin,
  MessageCircle,
  PackageCheck,
  Phone,
  RotateCcw,
  Send,
  Truck,
  Undo2,
  X,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { OrderDetail } from '@/lib/orders';
import { COURIER_LABELS, type CourierType } from '@/lib/couriers';
import { ActionButton, daysSince, timeAgo, type MoneyFmt } from './shared';

/** Every action the callout can offer. The drawer maps each id to a handler;
 *  an id whose handler is missing (e.g. `book` outside the Orders board, or
 *  any action in read-only mode) is simply not rendered. */
export type NextActionId =
  | 'confirm'
  | 'resend'
  | 'noresp'
  | 'fix_address'
  | 'reattempt'
  | 'return'
  | 'open_chat'
  | 'call'
  | 'book'
  | 'fulfil_manual'
  | 'track';

export interface NextStep {
  tone: 'amber' | 'red' | 'green' | 'blue' | 'grey';
  eyebrow: string;
  title: string;
  detail?: string;
  actions: NextActionId[];
}

export function courierName(t: string | null | undefined): string {
  if (!t) return 'Courier';
  return COURIER_LABELS[t as CourierType] ?? t.charAt(0).toUpperCase() + t.slice(1);
}

/** Pure: what does this order need right now? Derived only from data the
 *  drawer already has (mirror + shipment + confirmation). */
export function deriveNextStep(d: OrderDetail, money: MoneyFmt): NextStep {
  const o = d.order;
  const sh = d.shipment && d.shipment.status !== 'cancelled' ? d.shipment : null;
  const st = (sh?.status ?? '').toLowerCase();
  const courier = courierName(sh?.courierType ?? o.trackingCompany);
  const outstanding = o.totalOutstanding ?? 0;
  const hasCOD = outstanding > 0 || /cod|cash on delivery/i.test(o.paymentGateway ?? '');
  const fulfilled = ['fulfilled', 'partially_fulfilled'].includes(
    (o.fulfillmentStatus ?? '').toLowerCase(),
  );
  const conf = (d.confirmation?.status ?? '').toLowerCase();
  const confirmed = !!o.manualConfirmedAt || conf === 'confirmed' || !hasCOD;
  const delivered = st === 'delivered' || !!o.deliveredAt;

  if (o.cancelledAt) {
    const returned =
      ['returned', 'failed', 'attempted'].includes(st) ||
      /return|fail|attempt/.test((o.deliveryStatus ?? '').toLowerCase());
    return returned
      ? {
          tone: 'red',
          eyebrow: 'Closed',
          title: 'Returned to shipper',
          detail: `The parcel came back and the order was cancelled${sh?.trackingNumber ? ` · ${courier} ${sh.trackingNumber}` : ''}.`,
          actions: ['open_chat'],
        }
      : {
          tone: 'grey',
          eyebrow: 'Closed',
          title: 'Order cancelled',
          detail: `Cancelled ${timeAgo(o.cancelledAt)}. Nothing left to do.`,
          actions: [],
        };
  }

  if (st === 'address_issue') {
    return {
      tone: 'amber',
      eyebrow: 'Next step',
      title: 'Fix the shipping address',
      detail:
        'This parcel was held before booking because the address looks incomplete. Correct it and it returns to To book.',
      actions: ['fix_address', 'open_chat', 'call'],
    };
  }

  if (st === 'attempted' && sh?.shipperAdviceRequiredAt) {
    const raw = sh.shipperAdviceRequiredRaw || sh.lastStatusRaw;
    return {
      tone: 'red',
      eyebrow: 'Courier needs you',
      title: `${courier} is waiting for shipper advice`,
      detail: `Delivery was attempted${raw ? ` (“${raw}”)` : ''}. Tell the courier to re-attempt or return the parcel, ideally after checking with the customer.`,
      actions: ['reattempt', 'return', 'open_chat', 'call'],
    };
  }

  if (st === 'attempted') {
    return {
      tone: 'amber',
      eyebrow: 'Heads up',
      title: 'Delivery was attempted',
      detail: `${courier} couldn't deliver${sh?.lastStatusRaw ? ` (“${sh.lastStatusRaw}”)` : ''}. A quick message to the customer usually saves the parcel.`,
      actions: ['open_chat', 'call', 'track'],
    };
  }

  if (st === 'failed' || st === 'returned') {
    return {
      tone: 'red',
      eyebrow: 'Heads up',
      title: st === 'returned' ? 'Parcel is returning to you' : 'Delivery failed',
      detail: sh?.lastStatusRaw ? `Latest courier status: “${sh.lastStatusRaw}”.` : undefined,
      actions: ['track', 'open_chat'],
    };
  }

  if (delivered) {
    if (!sh || sh.courierType === 'manual' || !hasCOD) {
      return {
        tone: 'green',
        eyebrow: 'All done',
        title: `Delivered${o.deliveredAt ? ` ${timeAgo(o.deliveredAt)}` : ''}`,
        actions: [],
      };
    }
    if (sh.settledAt) {
      return {
        tone: 'green',
        eyebrow: 'All done',
        title: 'Delivered and settled',
        detail: `${courier} paid this COD on a settlement statement ${timeAgo(sh.settledAt)}.`,
        actions: [],
      };
    }
    const days = daysSince(sh.deliveredAt ?? o.deliveredAt);
    return {
      tone: 'green',
      eyebrow: 'Delivered',
      title: `Awaiting ${courier} settlement`,
      detail: `${money(o.totalPrice)} COD collected by ${courier}${days != null ? `, owed for ${days} day${days === 1 ? '' : 's'}` : ''}. It clears when the courier statement is applied.`,
      actions: [],
    };
  }

  if (sh && ['booked', 'in_transit', 'out_for_delivery', 'picked_up', 'ready_for_pickup'].includes(st)) {
    return {
      tone: 'blue',
      eyebrow: 'On the way',
      title:
        st === 'out_for_delivery'
          ? `Out for delivery with ${courier}`
          : st === 'booked'
            ? `Booked with ${courier}, awaiting pickup`
            : `In transit with ${courier}`,
      detail: sh.lastStatusRaw ? `Latest scan: “${sh.lastStatusRaw}”.` : undefined,
      actions: ['track'],
    };
  }

  if (fulfilled) {
    return {
      tone: 'green',
      eyebrow: 'Fulfilled',
      title: 'Fulfilled outside CodesApp',
      detail: 'There is no CodesApp booking for this order, so delivery is tracked in Shopify.',
      actions: [],
    };
  }

  if (!confirmed) {
    if (conf === 'cancelled') {
      return {
        tone: 'red',
        eyebrow: 'Customer replied',
        title: 'Customer asked to cancel',
        detail: 'They chose Cancel on the WhatsApp confirmation. Check with them, or cancel the order in Shopify.',
        actions: ['open_chat', 'call', 'confirm'],
      };
    }
    if (conf === 'undeliverable') {
      return {
        tone: 'red',
        eyebrow: 'Next step',
        title: 'Customer is not on WhatsApp',
        detail: 'The confirmation could not be delivered. Call the customer to confirm instead.',
        actions: ['call', 'confirm', 'noresp'],
      };
    }
    const sent = d.confirmation?.sentAt;
    return {
      tone: 'amber',
      eyebrow: 'Next step',
      title: conf === 'no_response' ? 'No response yet' : 'Waiting for the customer to confirm',
      detail: sent
        ? `Confirmation sent on WhatsApp ${timeAgo(sent)}${conf === 'no_response' ? ', marked No response' : ', no reply yet'}.`
        : 'No WhatsApp confirmation has been sent for this order.',
      actions: ['confirm', 'resend', 'noresp'],
    };
  }

  return {
    tone: 'blue',
    eyebrow: 'Next step',
    title: 'Ready to book',
    detail: hasCOD
      ? `Confirmed. Book a courier to ship ${money(outstanding)} COD.`
      : 'Prepaid, so no confirmation is needed. Book a courier to ship it.',
    actions: ['book', 'fulfil_manual'],
  };
}

const TONE: Record<NextStep['tone'], { box: string; icon: string }> = {
  amber: { box: 'border-amber-200 bg-amber-50', icon: 'text-amber-600' },
  red: { box: 'border-rose-200 bg-rose-50', icon: 'text-rose-600' },
  green: { box: 'border-brand-200 bg-brand-50', icon: 'text-brand-700' },
  blue: { box: 'border-sky-200 bg-sky-50', icon: 'text-sky-700' },
  grey: { box: 'border-line bg-sunken', icon: 'text-muted' },
};

const ACTION_META: Record<
  NextActionId,
  { label: string; icon: React.ReactNode; tone: 'primary' | 'default' | 'warn' | 'danger' }
> = {
  confirm: { label: 'Mark confirmed', icon: <Check size={13} />, tone: 'primary' },
  resend: { label: 'Resend', icon: <Send size={13} />, tone: 'default' },
  noresp: { label: 'No response', icon: <X size={13} />, tone: 'warn' },
  fix_address: { label: 'Fix address', icon: <MapPin size={13} />, tone: 'primary' },
  reattempt: { label: 'Re-attempt delivery', icon: <RotateCcw size={13} />, tone: 'primary' },
  return: { label: 'Return to shipper', icon: <Undo2 size={13} />, tone: 'danger' },
  open_chat: { label: 'Open chat', icon: <MessageCircle size={13} />, tone: 'default' },
  call: { label: 'Call', icon: <Phone size={13} />, tone: 'default' },
  book: { label: 'Book courier', icon: <Truck size={13} />, tone: 'primary' },
  fulfil_manual: { label: 'Fulfil manually', icon: <PackageCheck size={13} />, tone: 'default' },
  track: { label: 'Track parcel', icon: <Truck size={13} />, tone: 'default' },
};

function ToneIcon({ step }: { step: NextStep }) {
  const size = 18;
  if (step.tone === 'red')
    return step.eyebrow === 'Closed' ? <XCircle size={size} /> : <AlertTriangle size={size} />;
  if (step.tone === 'green') return <CheckCircle2 size={size} />;
  if (step.tone === 'blue') return <Truck size={size} />;
  if (step.tone === 'grey') return <XCircle size={size} />;
  return <Clock size={size} />;
}

export function NextStepCallout({
  step,
  handlers,
  busy,
}: {
  step: NextStep;
  /** Handler per action id; missing = not offered here. */
  handlers: Partial<Record<NextActionId, () => void>>;
  busy?: NextActionId | null;
}) {
  const t = TONE[step.tone];
  const actions = step.actions.filter((a) => handlers[a]);
  return (
    <section
      className={cn('grid grid-cols-[auto_1fr] gap-x-3 rounded-2xl border p-3.5', t.box)}
      aria-label="Next step"
    >
      <div className={cn('row-span-2 grid h-9 w-9 place-items-center rounded-xl bg-surface', t.icon)}>
        <ToneIcon step={step} />
      </div>
      <div className="min-w-0">
        <div className="text-[11px] font-extrabold uppercase tracking-wider text-muted">
          {step.eyebrow}
        </div>
        <div className="text-[15px] font-extrabold leading-snug text-ink">{step.title}</div>
        {step.detail && <p className="mt-0.5 text-[13px] leading-snug text-muted">{step.detail}</p>}
      </div>
      {actions.length > 0 && (
        <div className="col-start-2 mt-2.5 flex flex-wrap gap-1.5">
          {actions.map((a) => {
            const m = ACTION_META[a];
            return (
              <ActionButton
                key={a}
                tone={m.tone}
                icon={m.icon}
                busy={busy === a}
                disabled={!!busy && busy !== a}
                onClick={handlers[a]}
              >
                {m.label}
              </ActionButton>
            );
          })}
        </div>
      )}
    </section>
  );
}
