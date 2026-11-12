'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, MessageCircle, Phone } from 'lucide-react';
import type { OrderDetail } from '@/lib/orders';
import {
  getContactOrders,
  moneyCompact,
  summarizeContactOrders,
  type ContactOrders,
} from '@/lib/contact-orders';
import { fmtDate } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { CopyButton, Section, Stat } from './shared';

function initials(name: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

const isReturned = (o: ContactOrders['orders'][number]) =>
  /return|fail/.test((o.shipmentStatus ?? '').toLowerCase());

export function CustomerCard({
  d,
  onOpenChat,
  onCall,
}: {
  d: OrderDetail;
  onOpenChat?: () => void;
  onCall?: () => void;
}) {
  const o = d.order;
  const [hist, setHist] = useState<ContactOrders | null | 'loading'>(o.phone ? 'loading' : null);

  useEffect(() => {
    if (!o.phone) return;
    let alive = true;
    getContactOrders(o.phone)
      .then((r) => alive && setHist(r))
      .catch(() => alive && setHist(null)); // history is a bonus — fail silent
    return () => {
      alive = false;
    };
  }, [o.phone]);

  const address = [o.address1, o.address2].filter(Boolean).join(', ');
  const fullAddress = [address, o.city].filter(Boolean).join(', ');
  const summary = hist && hist !== 'loading' ? summarizeContactOrders(hist) : null;
  const others =
    hist && hist !== 'loading' ? hist.orders.filter((x) => x.orderGid !== o.orderGid) : [];
  const returned = hist && hist !== 'loading' ? hist.orders.filter(isReturned) : [];
  const lastReturn = others.find(isReturned);

  return (
    <Section title="Customer">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-sm font-extrabold text-brand-700">
          {initials(o.customerName)}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-extrabold text-ink">
            {o.customerName ?? 'Customer'}
          </div>
          {o.phone && (
            <div className="flex items-center gap-0.5 font-mono text-[12.5px] text-muted">
              {o.phone}
              <CopyButton value={o.phone} label="phone" />
            </div>
          )}
        </div>
        <div className="ml-auto flex gap-1.5">
          {onOpenChat && (
            <button
              type="button"
              onClick={onOpenChat}
              aria-label="Open WhatsApp chat"
              title="Open chat"
              className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted hover:bg-sunken hover:text-brand-700"
            >
              <MessageCircle size={15} />
            </button>
          )}
          {onCall && (
            <button
              type="button"
              onClick={onCall}
              aria-label="Call customer"
              title="Call"
              className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted hover:bg-sunken hover:text-brand-700"
            >
              <Phone size={15} />
            </button>
          )}
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-[84px_1fr_auto] items-start gap-x-2.5 gap-y-2 text-[13px]">
        <dt className="text-muted">Address</dt>
        <dd className="font-semibold text-ink [overflow-wrap:anywhere]">{address || '—'}</dd>
        <CopyButton value={fullAddress || null} label="address" />
        <dt className="text-muted">City</dt>
        <dd className="font-semibold text-ink">
          {[o.city, o.countryCode].filter(Boolean).join(' · ') || '—'}
        </dd>
        <span />
        {o.email && (
          <>
            <dt className="text-muted">Email</dt>
            <dd className="font-semibold text-ink [overflow-wrap:anywhere]">{o.email}</dd>
            <CopyButton value={o.email} label="email" />
          </>
        )}
      </dl>

      {hist === 'loading' && (
        <div className="mt-3 flex gap-1.5 border-t border-dashed border-line pt-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 flex-1 rounded-xl" />
          ))}
        </div>
      )}
      {summary && (
        <>
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-dashed border-line pt-3">
            <Stat value={summary.count} label={summary.count === 1 ? 'order' : 'orders'} />
            <Stat value={summary.deliveredCount} label="delivered" />
            <Stat value={returned.length} label="returned" tone={returned.length ? 'bad' : undefined} />
            <Stat value={moneyCompact(summary.ltv, summary.currency)} label="lifetime value" />
          </div>
          {lastReturn ? (
            <div className="mt-2 flex items-center gap-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-[12.5px] font-bold text-rose-700">
              <AlertTriangle size={14} className="shrink-0" />
              <span>
                Returned {lastReturn.orderName ?? 'an order'}
                {lastReturn.createdAt ? ` (${fmtDate(lastReturn.createdAt)})` : ''}. Confirm before
                shipping COD.
              </span>
            </div>
          ) : summary.count === 1 ? (
            <p className="mt-2 text-xs text-muted">First order from this customer.</p>
          ) : null}
        </>
      )}
    </Section>
  );
}
