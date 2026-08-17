'use client';

import type { ReactNode } from 'react';
import { X, Package, Phone, Mail, Truck, ChevronRight } from 'lucide-react';
import { fmtDate, cn } from '@/lib/utils';
import {
  type ContactOrder,
  type ContactOrders,
  isOrderTrackable,
  orderDisplayStatus,
  orderStatusTone,
} from '@/lib/contact-orders';
import { OrderNameButton } from '@/components/orders/order-detail-view';

function money(amount: number | null, currency: string | null): string | null {
  if (amount == null) return null;
  return `${currency ? currency + ' ' : ''}${amount.toLocaleString()}`;
}

/** Compact header chip: latest order + status, or "N orders". Opens the panel. */
export function ContactOrderChip({
  orders,
  onClick,
}: {
  orders: ContactOrders | null;
  onClick: () => void;
}) {
  if (!orders || orders.count === 0) return null;
  const latest = orders.orders[0];
  const label =
    orders.count > 1 ? `${orders.count} orders` : latest.orderName ?? '1 order';
  return (
    <button
      type="button"
      onClick={onClick}
      title="View this contact's orders"
      className={cn(
        'hidden sm:inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full shrink-0 hover:brightness-95',
        orderStatusTone(latest),
      )}
    >
      <Package size={12} />
      {label}
      {orders.count === 1 && (
        <span className="opacity-70">· {orderDisplayStatus(latest)}</span>
      )}
    </button>
  );
}

/** WhatsApp-style contact info panel — slides in on the right, shrinking the
 *  chat on desktop; full-screen overlay on mobile. Shows contact details + the
 *  contact's orders (from the local mirror). */
export function ContactInfoPanel({
  name,
  phone,
  email,
  orders,
  loading,
  onClose,
  onTrack,
}: {
  name: string | null;
  phone: string | null;
  email: string | null;
  orders: ContactOrders | null;
  loading: boolean;
  onClose: () => void;
  /** Open the courier tracking timeline for a (trackable) order. */
  onTrack?: (o: ContactOrder) => void;
}) {
  return (
    <aside className="fixed inset-0 z-50 flex flex-col bg-white md:static md:z-auto md:w-80 md:shrink-0 md:border-l md:border-gray-200 h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 shrink-0">
        <span className="w-9 h-9 rounded-full bg-green-600 text-white flex items-center justify-center font-semibold shrink-0">
          {(name || phone || '?')[0]?.toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-gray-900 truncate">
            {name || phone || 'Contact'}
          </p>
          {phone && <p className="text-xs text-gray-500 truncate">{phone}</p>}
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600"
          aria-label="Close contact details"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {(phone || email) && (
          <div className="px-4 py-3 space-y-2 border-b border-gray-100">
            {phone && <Row icon={<Phone size={13} />} text={phone} />}
            {email && <Row icon={<Mail size={13} />} text={email} />}
          </div>
        )}

        <div className="px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Orders
            </span>
            {orders && orders.count > 0 && (
              <span className="text-xs text-gray-400">{orders.count}</span>
            )}
          </div>
          {loading ? (
            <div className="text-sm text-gray-400 py-6 text-center">Loading…</div>
          ) : !orders || orders.count === 0 ? (
            <div className="text-sm text-gray-400 py-6 text-center">
              No orders found for this contact.
            </div>
          ) : (
            <div className="space-y-2">
              {orders.orders.map((o) => (
                <OrderCard key={o.orderGid} o={o} onTrack={onTrack} />
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function Row({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-gray-700">
      <span className="text-gray-400 shrink-0">{icon}</span>
      <span className="truncate">{text}</span>
    </div>
  );
}

function OrderCard({
  o,
  onTrack,
}: {
  o: ContactOrder;
  onTrack?: (o: ContactOrder) => void;
}) {
  const total = money(o.total, o.currency);
  const cod =
    o.outstanding && o.outstanding > 0 ? money(o.outstanding, o.currency) : null;
  const trackable = !!onTrack && isOrderTrackable(o);
  return (
    <div
      role={trackable ? 'button' : undefined}
      tabIndex={trackable ? 0 : undefined}
      onClick={trackable ? () => onTrack!(o) : undefined}
      onKeyDown={
        trackable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onTrack!(o);
              }
            }
          : undefined
      }
      className={cn(
        'rounded-lg border border-gray-200 p-3',
        trackable &&
          'cursor-pointer transition hover:border-green-300 hover:bg-green-50/40',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm truncate">
          <OrderNameButton name={o.orderName ?? 'Order'} gid={o.orderGid} />
        </span>
        <span
          className={cn(
            'text-[11px] px-2 py-0.5 rounded-full shrink-0',
            orderStatusTone(o),
          )}
        >
          {orderDisplayStatus(o)}
        </span>
      </div>
      {o.itemsSummary && (
        <p className="text-xs text-gray-500 mt-1 truncate">{o.itemsSummary}</p>
      )}
      <div className="flex items-center justify-between mt-1.5 text-[11px] text-gray-400 gap-2">
        <span className="shrink-0">{o.createdAt ? fmtDate(o.createdAt) : ''}</span>
        {total && (
          <span className="text-gray-700 font-medium truncate text-right">
            {total}
            {cod && <span className="text-rose-600"> · COD {cod}</span>}
          </span>
        )}
      </div>
      {o.trackingNumber && (
        <div className="mt-1.5 flex items-center gap-1 text-[11px] text-gray-500">
          <Truck size={11} className="text-gray-400 shrink-0" />
          <span className="capitalize">{o.courierType ?? 'Courier'}</span>
          <span className="truncate">· {o.trackingNumber}</span>
        </div>
      )}
      {trackable && (
        <div className="mt-2 flex items-center justify-end gap-0.5 text-[11px] font-medium text-green-700">
          View tracking <ChevronRight size={13} />
        </div>
      )}
    </div>
  );
}
