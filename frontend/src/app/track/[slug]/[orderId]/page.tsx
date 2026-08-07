'use client';

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { Loader2, PackageX, ExternalLink, MapPin } from 'lucide-react';
import { api } from '@/lib/api';
import { cn, mediaUrl, fmtDateTime } from '@/lib/utils';

// Standalone types — the public page must NOT import authed fetchers.
interface TrackItem {
  title: string;
  variant: string | null;
  qty: number;
  price: string | null;
}
interface TrackCheckpoint {
  status: string;
  detail?: string;
  at?: string;
}
interface TrackDelivery {
  courier_name: string;
  status: string;
  tracking_number: string | null;
  courier_url: string | null;
  checkpoints: TrackCheckpoint[];
}
interface TrackData {
  brand: { name: string; logo_url: string | null };
  order: {
    order_name: string;
    created_at: string;
    currency: string | null;
    items: TrackItem[];
    total_price: number | null;
    total_outstanding: number | null;
    financial_status: string | null;
    fulfillment_status: string | null;
    city: string | null;
    address: string | null;
  };
  delivery: TrackDelivery | null;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  booked: 'Booked',
  ready_for_pickup: 'Ready for pickup',
  picked_up: 'Picked up',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  attempted: 'Delivery attempted',
  failed: 'Delivery failed',
  returned: 'Returned',
  cancelled: 'Cancelled',
};

function money(v: number | null | undefined, currency: string | null): string {
  if (v == null) return '—';
  const n = Number(v);
  const amount = Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${amount}` : amount;
}

export default function PublicTrackingPage() {
  const params = useParams<{ slug: string; orderId: string }>();
  const search = useSearchParams();
  const k = search.get('k') ?? '';

  const [data, setData] = useState<TrackData | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.get(
          `/public/track/${params.slug}/${params.orderId}`,
          { params: { k } },
        );
        if (!alive) return;
        setData(res.data?.data ?? res.data);
        setState('ok');
      } catch {
        if (!alive) return;
        setState('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [params.slug, params.orderId, k]);

  if (state === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Loader2 className="animate-spin text-gray-400" size={28} />
      </div>
    );
  }

  if (state === 'error' || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-sm rounded-2xl bg-white p-8 text-center shadow">
          <PackageX className="mx-auto mb-3 text-gray-300" size={40} />
          <h1 className="text-lg font-semibold text-gray-800">Order not found</h1>
          <p className="mt-1 text-sm text-gray-500">
            This tracking link is invalid or has expired. Please check the link
            in your order message.
          </p>
        </div>
      </div>
    );
  }

  const { brand, order, delivery } = data;
  const logo = mediaUrl(brand.logo_url);
  const cod =
    order.total_outstanding != null && Number(order.total_outstanding) > 0
      ? order.total_outstanding
      : null;

  return (
    <div className="min-h-screen bg-gray-50 pb-12">
      {/* Brand header */}
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-xl items-center gap-3 px-4 py-4">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logo}
              alt={brand.name}
              className="h-10 w-10 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-600 text-lg font-semibold text-white">
              {brand.name.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="font-semibold text-gray-800">{brand.name}</div>
        </div>
      </header>

      <main className="mx-auto max-w-xl space-y-4 px-4 pt-5">
        {/* Order summary */}
        <section className="rounded-2xl bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-lg font-semibold text-gray-900">
                {order.order_name}
              </div>
              <div className="mt-0.5 text-xs text-gray-500">
                Placed {fmtDateTime(order.created_at)}
              </div>
            </div>
            {delivery && (
              <span className="rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-green-700">
                {STATUS_LABEL[delivery.status] ?? delivery.status}
              </span>
            )}
          </div>
        </section>

        {/* Items */}
        <section className="rounded-2xl bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Items</h2>
          <ul className="divide-y divide-gray-100">
            {order.items.map((it, i) => (
              <li key={i} className="flex items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-gray-800">
                    {it.title}
                  </div>
                  {it.variant && (
                    <div className="text-xs text-gray-500">{it.variant}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-3 text-sm text-gray-600">
                  <span className="text-gray-400">×{it.qty}</span>
                  <span>{it.price != null ? money(Number(it.price), order.currency) : ''}</span>
                </div>
              </li>
            ))}
            {order.items.length === 0 && (
              <li className="py-2 text-sm text-gray-400">No items listed.</li>
            )}
          </ul>

          <div className="mt-3 space-y-1 border-t border-gray-100 pt-3 text-sm">
            <div className="flex justify-between text-gray-600">
              <span>Order total</span>
              <span className="font-medium text-gray-900">
                {money(order.total_price, order.currency)}
              </span>
            </div>
            {cod != null && (
              <div className="flex justify-between text-green-700">
                <span className="font-medium">Cash to pay on delivery</span>
                <span className="font-semibold">{money(cod, order.currency)}</span>
              </div>
            )}
          </div>
        </section>

        {/* Delivery address */}
        {(order.address || order.city) && (
          <section className="rounded-2xl bg-white p-5 shadow-sm">
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-gray-700">
              <MapPin size={15} className="text-gray-400" /> Delivery address
            </h2>
            <p className="text-sm leading-relaxed text-gray-600">
              {order.address || order.city}
            </p>
          </section>
        )}

        {/* Tracking timeline */}
        <section className="rounded-2xl bg-white p-5 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-gray-700">Tracking</h2>
            {delivery?.tracking_number && (
              <span className="font-mono text-xs text-gray-500">
                {delivery.courier_name} · {delivery.tracking_number}
              </span>
            )}
          </div>

          {delivery && delivery.checkpoints.length > 0 ? (
            <ol className="relative ml-1 space-y-4 border-l border-gray-200 pl-5">
              {[...delivery.checkpoints].reverse().map((c, i) => (
                <li key={i} className="relative">
                  <span
                    className={cn(
                      'absolute -left-[23px] top-1 h-2.5 w-2.5 rounded-full',
                      i === 0 ? 'bg-green-600 ring-2 ring-green-100' : 'bg-gray-300',
                    )}
                  />
                  <div className="text-sm font-medium text-gray-800">{c.status}</div>
                  {c.detail && <div className="text-xs text-gray-500">{c.detail}</div>}
                  {c.at && (
                    <div className="text-[11px] text-gray-400">{fmtDateTime(c.at)}</div>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
              No tracking updates yet.
              {delivery?.courier_url && (
                <>
                  {' '}
                  <a
                    href={delivery.courier_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-green-700 hover:underline"
                  >
                    Track on courier portal <ExternalLink size={12} />
                  </a>
                </>
              )}
            </div>
          )}

          {delivery?.courier_url && delivery.checkpoints.length > 0 && (
            <a
              href={delivery.courier_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-green-700 hover:underline"
            >
              Open on courier portal <ExternalLink size={12} />
            </a>
          )}
        </section>

        <p className="pt-2 text-center text-xs text-gray-400">
          Powered by CodesApp
        </p>
      </main>
    </div>
  );
}
