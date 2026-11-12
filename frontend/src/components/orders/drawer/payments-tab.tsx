'use client';

import { Check, Clock, Landmark, Wallet } from 'lucide-react';
import { cn, fmtDate } from '@/lib/utils';
import type { OrderDetail, OrderLiveDetail } from '@/lib/orders';
import { Skeleton } from '@/components/ui/skeleton';
import { ActionButton, daysSince, Section, Stat, type MoneyFmt } from './shared';
import { courierName } from './next-step';

export function shortGateway(g: string): string {
  const s = g.toLowerCase();
  if (s.includes('cod') || s.includes('cash on delivery')) return 'Cash on delivery';
  if (s.includes('payfast')) return 'PayFast (prepaid)';
  if (s.includes('manual') || s.includes('bank')) return 'Bank / manual';
  return g.length > 28 ? `${g.slice(0, 28)}…` : g;
}

export function PaymentsTab({
  d,
  live,
  money,
  outstanding,
  hasCOD,
  canMarkPaid,
  payBusy,
  onMarkPaid,
}: {
  d: OrderDetail;
  live: OrderLiveDetail | null;
  money: MoneyFmt;
  outstanding: number;
  hasCOD: boolean;
  canMarkPaid: boolean;
  payBusy: boolean;
  onMarkPaid: () => void;
}) {
  const o = d.order;
  const sh = d.shipment && d.shipment.status !== 'cancelled' ? d.shipment : null;
  const total = o.totalPrice ?? 0;
  const received = Math.max(0, total - outstanding);
  const liveOk = live?.ok ? live : null;

  return (
    <div className="flex flex-col gap-3">
      <Section title="Balance" icon={<Wallet size={13} />}>
        <div className="flex flex-wrap gap-1.5">
          <Stat value={money(total)} label="order total" />
          <Stat value={money(received)} label="received" tone={received > 0 ? 'good' : undefined} />
          <Stat value={money(outstanding)} label="to collect" tone={outstanding > 0 ? 'warn' : undefined} />
        </div>
        <dl className="mt-3 grid grid-cols-[110px_1fr] gap-y-1.5 text-[13px]">
          <dt className="text-muted">Payment method</dt>
          <dd className="font-semibold text-ink">
            {o.paymentGateway ? shortGateway(o.paymentGateway) : hasCOD ? 'Cash on delivery' : '—'}
          </dd>
          <dt className="text-muted">Status</dt>
          <dd className="font-semibold capitalize text-ink">
            {(o.financialStatus ?? '—').replace(/_/g, ' ')}
          </dd>
          {o.courierInvoiceNumber && (
            <>
              <dt className="text-muted">Courier invoice</dt>
              <dd className="font-semibold text-ink">#{o.courierInvoiceNumber}</dd>
            </>
          )}
        </dl>
        {canMarkPaid && (
          <ActionButton
            className="mt-3"
            icon={<Check size={13} />}
            busy={payBusy}
            onClick={onMarkPaid}
          >
            Mark as paid
          </ActionButton>
        )}
      </Section>

      <Section title="Transactions">
        {!live ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full rounded-xl" />
            <Skeleton className="h-10 w-full rounded-xl" />
          </div>
        ) : !liveOk ? (
          <p className="text-[13px] text-muted">
            {live.reason === 'not_connected'
              ? 'Connect Shopify in Settings to see transactions.'
              : 'Shopify is not responding right now. Try Refresh in the ⋯ menu.'}
          </p>
        ) : (
          <>
            {(liveOk.transactions ?? []).length === 0 && (
              <p className="text-[13px] text-muted">No transactions recorded yet.</p>
            )}
            <div className="divide-y divide-line">
              {(liveOk.transactions ?? []).map((t) => (
                <div key={t.id} className="flex items-center gap-2.5 py-2 first:pt-0">
                  <span
                    className={cn(
                      'h-2 w-2 shrink-0 rounded-full',
                      t.status === 'SUCCESS' ? 'bg-brand-500' : 'bg-amber-400',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-bold capitalize text-ink">
                      {(t.kind ?? 'transaction').toLowerCase()} · {(t.status ?? '').toLowerCase()}
                    </p>
                    <p className="text-xs text-muted [overflow-wrap:anywhere]">
                      {t.gateway ?? ''} · {fmtDate(t.processedAt)}
                    </p>
                  </div>
                  <div className="shrink-0 text-[13px] font-extrabold tabular-nums text-ink">
                    {money(t.amount)}
                  </div>
                </div>
              ))}
            </div>
            {(liveOk.refunds ?? []).length > 0 && (
              <div className="mt-2 space-y-1 border-t border-line pt-2">
                {(liveOk.refunds ?? []).map((r) => (
                  <div key={r.id} className="flex items-start justify-between gap-2 text-xs text-muted">
                    <span className="[overflow-wrap:anywhere]">
                      Refund · {fmtDate(r.createdAt)}
                      {r.note ? ` · ${r.note}` : ''}
                    </span>
                    <span className="shrink-0 font-bold text-rose-600">− {money(r.amount)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-2 flex gap-6 border-t border-line pt-2 text-[13px]">
              <span className="text-muted">
                Refunded{' '}
                <b className="text-ink">{liveOk.totalRefunded ? money(liveOk.totalRefunded) : 'None'}</b>
              </span>
              <span className="text-muted">
                Net paid <b className="text-brand-700">{money(liveOk.netPayment)}</b>
              </span>
            </div>
          </>
        )}
      </Section>

      {sh && (
        <Section title="Courier settlement" icon={<Landmark size={13} />}>
          <Settlement d={d} hasCOD={hasCOD} money={money} />
        </Section>
      )}
    </div>
  );
}

function Settlement({ d, hasCOD, money }: { d: OrderDetail; hasCOD: boolean; money: MoneyFmt }) {
  const o = d.order;
  const sh = d.shipment!;
  const courier = courierName(sh.courierType);
  const delivered = sh.status === 'delivered' || !!o.deliveredAt;
  let title: string;
  let sub: string;
  let tone: 'good' | 'warn' | 'muted' = 'muted';
  if (sh.courierType === 'manual') {
    title = 'No courier settlement';
    sub = 'Fulfilled manually, so no courier owes money on this order.';
  } else if (!hasCOD) {
    title = 'Nothing to settle';
    sub = 'Prepaid order. The courier collects no cash.';
  } else if (sh.settledAt) {
    title = `Settled ${fmtDate(sh.settledAt)}`;
    sub = `${courier} paid ${money(o.totalPrice)} on a settlement statement${o.courierInvoiceNumber ? ` (invoice #${o.courierInvoiceNumber})` : ''}.`;
    tone = 'good';
  } else if (delivered) {
    const days = daysSince(sh.deliveredAt ?? o.deliveredAt);
    title = `Awaiting ${courier} statement`;
    sub = `Delivered${days != null ? ` ${days} day${days === 1 ? '' : 's'} ago` : ''}. ${money(o.totalPrice)} is owed by ${courier} until a statement is applied.`;
    tone = 'warn';
  } else {
    title = 'Not delivered yet';
    sub = `${courier} will owe the COD once the parcel is delivered.`;
  }
  return (
    <div className="flex items-center gap-3">
      <div
        className={cn(
          'grid h-9 w-9 shrink-0 place-items-center rounded-xl',
          tone === 'good' ? 'bg-brand-50 text-brand-700' : tone === 'warn' ? 'bg-amber-50 text-amber-700' : 'bg-sunken text-muted',
        )}
      >
        {tone === 'warn' ? <Clock size={16} /> : <Landmark size={16} />}
      </div>
      <div className="min-w-0">
        <div className="text-[13.5px] font-extrabold text-ink">{title}</div>
        <div className="text-[12.5px] text-muted">{sub}</div>
      </div>
    </div>
  );
}
