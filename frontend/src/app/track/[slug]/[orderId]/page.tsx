'use client';

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { Loader2, PackageX, ExternalLink, MapPin, Phone, Package, User } from 'lucide-react';
import { api } from '@/lib/api';
import { cn, mediaUrl, fmtDateTime } from '@/lib/utils';

// Standalone types — the public page must NOT import authed fetchers.
interface TrackItem {
  title: string;
  variant: string | null;
  qty: number;
  price: string | null;
  image: string | null;
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
  brand: { name: string; logo_url: string | null; whatsapp: string | null };
  order: {
    order_name: string;
    created_at: string;
    currency: string | null;
    items: TrackItem[];
    total_price: number | null;
    total_outstanding: number | null;
    financial_status: string | null;
    fulfillment_status: string | null;
    customer_name: string | null;
    phone: string | null;
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

// International digits only (wa.me wants no +/spaces; tel: we re-add the +).
function phoneDigits(raw: string): string {
  return raw.replace(/\D/g, '');
}

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.71.306 1.263.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.002-5.45 4.436-9.884 9.888-9.884a9.82 9.82 0 016.988 2.898 9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
    </svg>
  );
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

  const waDigits = brand.whatsapp ? phoneDigits(brand.whatsapp) : '';
  const waHref = waDigits
    ? `https://wa.me/${waDigits}?text=${encodeURIComponent(
        `Hi, I have a question about my order ${order.order_name}`,
      )}`
    : null;
  const telHref = waDigits ? `tel:+${waDigits}` : null;

  return (
    <div className="min-h-screen bg-gray-50 pb-12">
      {/* Brand header — matches the CodesApp navbar logo treatment
          (small boxed, object-contain) and stays on ONE row on mobile:
          logo + name flex/truncate on the left, contact buttons pinned right. */}
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-xl items-center gap-2.5 px-4 py-3">
          {logo ? (
            // Contain (never crop) so wide/rectangular logos render whole.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logo}
              alt={brand.name}
              className="h-7 w-7 shrink-0 rounded border border-gray-200 bg-gray-50 object-contain"
            />
          ) : (
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-green-600 text-sm font-semibold text-white">
              {brand.name.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800">
            {brand.name}
          </div>

          {/* Contact the store — icon-only on the narrowest screens so the
              header never wraps; label appears from sm up. */}
          {(waHref || telHref) && (
            <div className="flex shrink-0 items-center gap-2">
              {waHref && (
                <a
                  href={waHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full bg-green-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-green-700"
                >
                  <WhatsAppIcon className="h-4 w-4" />
                  <span className="hidden sm:inline">Chat</span>
                </a>
              )}
              {telHref && (
                <a
                  href={telHref}
                  className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50"
                >
                  <Phone size={15} />
                  <span className="hidden sm:inline">Call</span>
                </a>
              )}
            </div>
          )}
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
              <li key={i} className="flex items-center gap-3 py-2.5">
                {it.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={it.image}
                    alt=""
                    className="h-12 w-12 shrink-0 rounded-lg border border-gray-100 object-cover"
                  />
                ) : (
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-gray-100 bg-gray-50 text-gray-300">
                    <Package size={18} />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium leading-snug text-gray-800">
                    {it.title}
                  </div>
                  {it.variant && (
                    <div className="text-xs text-gray-500">{it.variant}</div>
                  )}
                  <div className="mt-0.5 text-xs text-gray-400">Qty {it.qty}</div>
                </div>
                <div className="shrink-0 text-sm font-medium text-gray-700">
                  {it.price != null ? money(Number(it.price), order.currency) : ''}
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

        {/* Contact details */}
        {(order.customer_name || order.phone || order.address || order.city) && (
          <section className="rounded-2xl bg-white p-5 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold text-gray-700">
              Contact details
            </h2>
            <dl className="space-y-3 text-sm">
              {order.customer_name && (
                <div className="flex items-start gap-2.5">
                  <User size={15} className="mt-0.5 shrink-0 text-gray-400" />
                  <div>
                    <dt className="text-xs text-gray-400">Name</dt>
                    <dd className="text-gray-700">{order.customer_name}</dd>
                  </div>
                </div>
              )}
              {order.phone && (
                <div className="flex items-start gap-2.5">
                  <Phone size={15} className="mt-0.5 shrink-0 text-gray-400" />
                  <div>
                    <dt className="text-xs text-gray-400">Number</dt>
                    <dd>
                      <a
                        href={`tel:${order.phone.replace(/[^\d+]/g, '')}`}
                        className="text-gray-700 hover:text-green-700"
                      >
                        {order.phone}
                      </a>
                    </dd>
                  </div>
                </div>
              )}
              {(order.address || order.city) && (
                <div className="flex items-start gap-2.5">
                  <MapPin size={15} className="mt-0.5 shrink-0 text-gray-400" />
                  <div>
                    <dt className="text-xs text-gray-400">Address</dt>
                    <dd className="leading-relaxed text-gray-700">
                      {order.address || order.city}
                    </dd>
                  </div>
                </div>
              )}
            </dl>
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
