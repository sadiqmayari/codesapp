'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ExternalLink,
  Loader2,
  MapPin,
  MessageCircle,
  Package,
  RefreshCw,
  Truck,
  X,
} from 'lucide-react';
import { cn, fmtDate, fmtDateTime } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import {
  getOrderDetail,
  getOrderDetailLive,
  type OrderDetail,
  type OrderKey,
  type OrderLiveDetail,
} from '@/lib/orders';

/* ── Slide-over drawer ──────────────────────────────────────────────────── */
export function OrderDetailDrawer({ orderKey, onClose }: { orderKey: OrderKey; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[95] flex justify-end">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-xl flex-col bg-slate-50 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute right-3 top-3 z-10 rounded-full bg-white/80 p-1.5 text-gray-500 shadow hover:text-gray-900"
          aria-label="Close"
        >
          <X size={18} />
        </button>
        <div className="flex-1 overflow-y-auto">
          <OrderDetailContent orderKey={orderKey} />
        </div>
      </div>
    </div>
  );
}

/* ── Drop-in clickable order number (self-contained drawer) ─────────────── */
/** Renders an order number that opens the CodesApp detail drawer, plus an
 *  optional secondary Shopify link. Manages its own open state, so it can be
 *  dropped into ANY order table with no parent wiring. */
export function OrderNameButton({
  name,
  gid,
  number,
  adminUrl,
  className,
}: {
  name: string | null;
  gid?: string | null;
  number?: string | null;
  adminUrl?: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const key: OrderKey | null = gid ? { gid } : number ? { number } : null;
  return (
    <span className="inline-flex items-center gap-1">
      {key ? (
        <button
          type="button"
          onClick={(e) => {
            // May be nested inside a clickable row/card (e.g. the chat's trackable
            // order card) — don't also trigger the parent's handler.
            e.stopPropagation();
            setOpen(true);
          }}
          className={cn('font-semibold text-indigo-600 hover:underline', className)}
          title="Open order in CodesApp"
        >
          {name || '—'}
        </button>
      ) : (
        <span className={className}>{name || '—'}</span>
      )}
      {adminUrl && (
        <a
          href={adminUrl}
          target="_blank"
          rel="noreferrer"
          className="text-gray-300 hover:text-green-600"
          title="View in Shopify"
        >
          <ExternalLink size={13} />
        </a>
      )}
      {open && key && <OrderDetailDrawer orderKey={key} onClose={() => setOpen(false)} />}
    </span>
  );
}

/* ── Reusable content (drawer + /orders/[no] page) ──────────────────────── */
export function OrderDetailContent({ orderKey }: { orderKey: OrderKey }) {
  const [d, setD] = useState<OrderDetail | null>(null);
  const [live, setLive] = useState<OrderLiveDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadLive = useCallback(async () => {
    setRefreshing(true);
    try {
      setLive(await getOrderDetailLive(orderKey));
    } catch {
      setLive({ ok: false, reason: 'error' });
    } finally {
      setRefreshing(false);
    }
  }, [orderKey]);

  useEffect(() => {
    let alive = true;
    getOrderDetail(orderKey)
      .then((r) => alive && setD(r))
      .catch((e) => alive && setErr(e instanceof ApiError ? e.userMessage : 'Could not load this order'));
    loadLive();
    return () => {
      alive = false;
    };
  }, [orderKey, loadLive]);

  if (err) return <div className="p-10 text-center text-sm text-gray-500">{err}</div>;
  if (!d)
    return (
      <div className="flex items-center justify-center py-24 text-gray-400">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );

  const o = d.order;
  const cur = o.currency ?? live?.currency ?? 'PKR';
  const money = (v: number | null | undefined) =>
    v == null ? '—' : `${cur} ${Math.round(v).toLocaleString()}`;
  // Money still to collect is the reliable COD signal — the gateway string is
  // unreliable (a COD order can be "manual"/null, not literally "cod").
  const outstanding = o.totalOutstanding ?? 0;
  const paid = outstanding <= 0 && (o.financialStatus ?? '').toUpperCase() === 'PAID';
  const hasCOD = outstanding > 0 || /cod|cash on delivery/i.test(o.paymentGateway ?? '');
  const items =
    live?.ok && live.lineItems?.length
      ? live.lineItems
      : d.lineItems.map((l) => ({
          title: l.title ?? '',
          quantity: l.quantity ?? 0,
          variantTitle: l.variantTitle ?? null,
          unitPrice: l.price ? Number(l.price) : null,
          lineTotal: l.price && l.quantity ? Number(l.price) * l.quantity : null,
          image: null as string | null,
        }));

  return (
    <div>
      {/* Header */}
      <div className="border-b border-gray-200 bg-white px-5 pt-5 pb-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-gray-900">
              {o.orderName ?? `#${o.orderNumber ?? ''}`}
            </h1>
            <p className="mt-0.5 text-xs text-gray-500">
              Placed {fmtDateTime(o.createdAt)} · {o.customerName ?? 'Customer'}
              {o.source ? ` · via ${o.source}` : ''}
            </p>
          </div>
          <div className="text-right">
            <div className="text-xl font-extrabold text-gray-900">{money(o.totalPrice)}</div>
            <div className="text-xs text-gray-500">
              {outstanding > 0
                ? `${money(outstanding)} to collect`
                : paid
                  ? 'Paid'
                  : (o.financialStatus ?? '—').replace(/_/g, ' ')}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <StatusPill kind="financial" value={o.financialStatus} />
          <StatusPill kind="fulfillment" value={o.fulfillmentStatus} />
          {o.deliveryStatus && <StatusPill kind="delivery" value={o.deliveryStatus} />}
          {o.cancelledAt && <span className="pill bg-red-50 text-red-700">Cancelled</span>}
          {o.archivedAt && <span className="pill bg-slate-100 text-slate-600">Archived</span>}
          {o.paymentGateway && (
            <span className="pill bg-slate-100 text-slate-600">{shortGateway(o.paymentGateway)}</span>
          )}
        </div>

        <div className="mt-3.5 flex flex-wrap gap-2">
          {d.conversationId && (
            <Link
              href={`/inbox/${d.conversationId}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#22c35e] px-3 py-2 text-xs font-semibold text-white hover:brightness-95"
            >
              <MessageCircle size={14} /> Open chat
            </Link>
          )}
          <button
            onClick={loadLive}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh from Shopify
          </button>
          {o.publicTrackingUrl && (
            <a
              href={o.publicTrackingUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
            >
              <MapPin size={14} /> Tracking page
            </a>
          )}
          {o.adminUrl && (
            <a
              href={o.adminUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
            >
              <ExternalLink size={14} /> View in Shopify
            </a>
          )}
        </div>
      </div>

      <div className="space-y-3 p-4">
        {/* Customer */}
        <Card title="Customer & shipping" badge="mirror">
          <Grid>
            <Field label="Name" value={o.customerName} />
            <Field
              label="Phone"
              value={
                o.phone ? (
                  <span className="font-mono">{o.phone}</span>
                ) : null
              }
            />
            <Field label="Email" value={o.email} />
            <Field label="City / Country" value={[o.city, o.countryCode].filter(Boolean).join(' · ') || null} />
            <Field
              className="col-span-2"
              label="Address"
              value={[o.address1, o.address2].filter(Boolean).join(', ') || null}
            />
          </Grid>
        </Card>

        {/* Items */}
        <Card title="Items" badge={live?.ok ? 'live' : 'mirror'} icon={<Package size={13} />}>
          <div className="overflow-hidden rounded-lg border border-gray-200">
            {items.map((it, i) => (
              <div
                key={i}
                className={cn('flex items-center gap-3 px-3 py-2.5', i > 0 && 'border-t border-gray-100')}
              >
                {it.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={it.image} alt="" className="h-10 w-10 rounded-md object-cover" />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-gray-100 text-gray-300">
                    <Package size={16} />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-gray-800">{it.title}</p>
                  {it.variantTitle && <p className="text-xs text-gray-400">{it.variantTitle}</p>}
                </div>
                <div className="text-right text-xs text-gray-500">
                  <div>×{it.quantity}</div>
                  <div className="font-semibold text-gray-700">{money(it.lineTotal ?? it.unitPrice)}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 space-y-0.5 px-1 text-sm">
            <Tot label="Order total" value={money(o.totalPrice)} strong />
            <Tot
              label={outstanding > 0 ? 'COD to collect' : 'Outstanding'}
              value={money(outstanding)}
              green={outstanding <= 0}
            />
          </div>
        </Card>

        {/* Payments */}
        <Card title="Payments & transactions" badge="live">
          {!live ? (
            <LiveLoading />
          ) : !live.ok ? (
            <LiveUnavailable reason={live.reason} />
          ) : (
            <>
              {(live.transactions ?? []).length === 0 && (
                <p className="text-xs text-gray-400">No transactions recorded.</p>
              )}
              {(live.transactions ?? []).map((t) => (
                <div
                  key={t.id}
                  className="mb-1.5 flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'h-2 w-2 rounded-full',
                        t.status === 'SUCCESS' ? 'bg-green-500' : 'bg-amber-400',
                      )}
                    />
                    <div>
                      <p className="text-sm font-semibold capitalize text-gray-800">
                        {(t.kind ?? '').toLowerCase() || 'transaction'}
                      </p>
                      <p className="text-[11px] text-gray-400">
                        {t.gateway ?? ''} · {fmtDate(t.processedAt)}
                      </p>
                    </div>
                  </div>
                  <div className="text-sm font-bold text-gray-800">{money(t.amount)}</div>
                </div>
              ))}
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1.5 px-1">
                <Field label="Refunded" value={live.totalRefunded ? money(live.totalRefunded) : 'None'} />
                <Field label="Net paid" value={money(live.netPayment)} valueClass="text-green-700" />
                <Field label="Outstanding" value={money(live.totalOutstanding)} />
              </div>
              {(live.refunds ?? []).length > 0 && (
                <div className="mt-2 border-t border-gray-100 pt-2">
                  {(live.refunds ?? []).map((r) => (
                    <div key={r.id} className="flex items-center justify-between text-xs text-gray-500">
                      <span>Refund · {fmtDate(r.createdAt)}{r.note ? ` · ${r.note}` : ''}</span>
                      <span className="font-semibold text-red-600">- {money(r.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </Card>

        {/* Fulfillment */}
        <Card title="Fulfillment & delivery" badge="mirror" icon={<Truck size={13} />}>
          <Grid>
            <Field label="Courier" value={o.trackingCompany ?? d.shipment?.courierType ?? '—'} />
            <Field
              label="Tracking #"
              value={
                o.trackingNumber || d.shipment?.trackingNumber ? (
                  d.shipment?.trackingUrl ? (
                    <a
                      href={d.shipment.trackingUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-indigo-600 hover:underline"
                    >
                      {o.trackingNumber ?? d.shipment?.trackingNumber} ↗
                    </a>
                  ) : (
                    <span className="font-mono">{o.trackingNumber ?? d.shipment?.trackingNumber}</span>
                  )
                ) : null
              }
            />
            <Field label="Delivery status" value={o.deliveryStatus} valueClass={o.deliveryStatus === 'delivered' ? 'text-green-700 capitalize' : 'capitalize'} />
            <Field label="Delivered on" value={o.deliveredAt ? fmtDateTime(o.deliveredAt) : null} />
            {d.shipment && (
              <>
                <Field label="Booking status" value={d.shipment.status} valueClass="capitalize" />
                <Field label="Booked" value={d.shipment.bookedAt ? fmtDate(d.shipment.bookedAt) : null} />
              </>
            )}
          </Grid>
          {!d.shipment && (
            <p className="mt-2 text-[11px] text-gray-400">Fulfilled outside CodesApp — no local booking.</p>
          )}
        </Card>

        {/* Courier settlement (COD money owed by the courier) */}
        {d.shipment && (
          <Card title="Courier settlement" badge="mirror">
            <Grid>
              <Field
                label="COD status"
                value={
                  !hasCOD
                    ? 'Nothing to collect'
                    : d.shipment.settledAt
                      ? `Settled ${fmtDate(d.shipment.settledAt)}`
                      : 'Awaiting settlement'
                }
                valueClass={d.shipment.settledAt ? 'text-green-700' : ''}
              />
              <Field
                label="Settlement invoice"
                value={d.shipment.invoiceId ? `Invoice #${d.shipment.invoiceId}` : '—'}
              />
            </Grid>
          </Card>
        )}

        {/* Confirmation */}
        <Card title="WhatsApp confirmation" badge="mirror">
          <Grid>
            <Field
              label="Status"
              value={
                d.confirmation?.status
                  ? d.confirmation.status
                  : o.manualConfirmedAt
                    ? 'Manually confirmed'
                    : hasCOD
                      ? 'Not sent'
                      : 'Not required'
              }
              valueClass="capitalize"
            />
            <Field label="Sent" value={d.confirmation?.sentAt ? fmtDateTime(d.confirmation.sentAt) : null} />
          </Grid>
        </Card>

        {/* Timeline */}
        <Card title="Timeline" badge="live">
          {!live ? (
            <LiveLoading />
          ) : !live.ok ? (
            <LiveUnavailable reason={live.reason} />
          ) : (live.timeline ?? []).length === 0 ? (
            <p className="text-xs text-gray-400">No events.</p>
          ) : (
            <ul className="relative ml-1 space-y-3">
              {(live.timeline ?? []).slice(0, 20).map((e, i) => (
                <li key={i} className="relative pl-5">
                  <span className="absolute left-0 top-1 h-2.5 w-2.5 rounded-full bg-indigo-500 ring-2 ring-indigo-100" />
                  <p className="text-[13px] leading-snug text-gray-700">{e.message}</p>
                  <p className="text-[11px] text-gray-400">{fmtDateTime(e.at)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Internal */}
        <Card title="Internal (CodesApp only)" badge="mirror">
          <Grid>
            <Field
              label="Created by"
              value={d.createdByAgent?.name ?? (o.source === 'codesapp' ? 'Agent (unknown)' : '—')}
            />
            <Field label="Assigned to" value={d.assignedAgent?.name ?? 'Unassigned'} />
            <Field label="Source" value={o.source} />
          </Grid>
          {o.internalNote && (
            <div className="mt-2 rounded-lg border border-dashed border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-800">
              {o.internalNote}
            </div>
          )}
        </Card>
      </div>

      <style jsx>{`
        :global(.pill) {
          font-size: 11px;
          font-weight: 700;
          padding: 3px 9px;
          border-radius: 999px;
        }
      `}</style>
    </div>
  );
}

/* ── small presentational helpers ───────────────────────────────────────── */
function Card({
  title,
  badge,
  icon,
  children,
}: {
  title: string;
  badge?: 'mirror' | 'live';
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-2.5 flex items-center gap-2">
        {icon && <span className="text-gray-400">{icon}</span>}
        <h3 className="text-[11px] font-extrabold uppercase tracking-wide text-gray-500">{title}</h3>
        {badge === 'live' && (
          <span className="inline-flex items-center gap-1 rounded bg-sky-100 px-1.5 py-0.5 text-[9px] font-extrabold uppercase text-sky-700">
            <span className="h-1.5 w-1.5 rounded-full bg-sky-500" /> live
          </span>
        )}
        {badge === 'mirror' && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-extrabold uppercase text-slate-500">
            mirror
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-5 gap-y-2.5">{children}</div>;
}

function Field({
  label,
  value,
  className,
  valueClass,
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
  valueClass?: string;
}) {
  return (
    <div className={className}>
      <div className="text-[11px] text-gray-400">{label}</div>
      <div className={cn('text-[13px] font-semibold text-gray-800', valueClass)}>{value ?? '—'}</div>
    </div>
  );
}

function Tot({ label, value, strong, green }: { label: string; value: string; strong?: boolean; green?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={cn('text-gray-500', strong && 'font-semibold text-gray-700')}>{label}</span>
      <span className={cn('font-semibold', green ? 'text-green-700' : 'text-gray-800', strong && 'font-bold')}>
        {value}
      </span>
    </div>
  );
}

function LiveLoading() {
  return (
    <div className="flex items-center gap-2 py-2 text-xs text-gray-400">
      <Loader2 size={13} className="animate-spin" /> Loading from Shopify…
    </div>
  );
}

function LiveUnavailable({ reason }: { reason?: string }) {
  return (
    <p className="text-xs text-gray-400">
      {reason === 'not_connected'
        ? 'Connect Shopify in Settings to see live payments & timeline.'
        : 'Live data unavailable right now — showing CodesApp data above.'}
    </p>
  );
}

function StatusPill({ kind, value }: { kind: 'financial' | 'fulfillment' | 'delivery'; value: string | null }) {
  if (!value) return null;
  const v = value.toLowerCase();
  const tone =
    v === 'paid' || v === 'delivered' || v === 'fulfilled'
      ? 'bg-green-50 text-green-700'
      : v === 'pending' || v === 'unfulfilled' || v === 'partially_paid'
        ? 'bg-amber-50 text-amber-700'
        : v === 'in_transit' || v === 'out_for_delivery'
          ? 'bg-blue-50 text-blue-700'
          : 'bg-slate-100 text-slate-600';
  const label = value.replace(/_/g, ' ');
  return <span className={cn('pill capitalize', tone)}>{label}</span>;
}

function shortGateway(g: string): string {
  const s = g.toLowerCase();
  if (s.includes('cod') || s.includes('cash on delivery')) return 'COD';
  if (s.includes('payfast')) return 'PayFast · prepaid';
  if (s.includes('manual') || s.includes('bank')) return 'Bank / manual';
  return g.length > 22 ? `${g.slice(0, 22)}…` : g;
}
