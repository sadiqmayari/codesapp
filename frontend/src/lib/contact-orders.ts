import { apiFetch } from './api';

export interface ContactOrder {
  orderGid: string;
  orderName: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  shipmentId: number | null;
  shipmentStatus: string | null;
  courierType: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  total: number | null;
  outstanding: number | null;
  currency: string | null;
  createdAt: string | null;
  itemsSummary: string | null;
  cancelled: boolean;
  archived: boolean;
  manualConfirmedAt?: string | null;
  noResponseAt?: string | null;
}

export interface ContactOrders {
  count: number;
  orders: ContactOrder[];
}

/** A contact's Shopify orders from the local mirror (by phone). */
export function getContactOrders(phone: string) {
  return apiFetch<ContactOrders>(
    `/shopify/orders/by-contact?phone=${encodeURIComponent(phone)}`,
  );
}

/** Humanize a raw status code: snake/kebab-case → Title Case words. */
export function humanizeStatus(s?: string | null): string {
  if (!s) return '';
  return s
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The single best display status for an order: courier shipment first, then
 *  fulfillment, then financial. */
export function orderDisplayStatus(o: ContactOrder): string {
  if (o.cancelled) return 'Cancelled';
  const raw = o.shipmentStatus || o.fulfillmentStatus || o.financialStatus;
  return humanizeStatus(raw) || 'Order placed';
}

/**
 * An order whose live courier timeline we can show (and send) from the inbox:
 * it must be fulfilled (NOT unfulfilled), not archived, not cancelled, and have
 * a courier shipment on record. Anything else has no tracking to display.
 */
export function isOrderTrackable(o: ContactOrder): boolean {
  if (o.archived || o.cancelled) return false;
  if (o.shipmentId == null) return false;
  const f = (o.fulfillmentStatus || '').toLowerCase();
  return f !== '' && f !== 'unfulfilled';
}

/** Lower-cased best shipping/fulfillment status text for classification. */
function statusText(o: ContactOrder): string {
  return (o.shipmentStatus || o.fulfillmentStatus || '').toLowerCase();
}

/** Order reached the courier's terminal "delivered" state. */
export function orderIsDelivered(o: ContactOrder): boolean {
  if (o.cancelled) return false;
  const s = statusText(o);
  return /deliver/.test(s) && !/out for|attempt/.test(s);
}

/** Order went wrong: cancelled, returned, or a failed/attempted delivery. */
export function orderIsFailed(o: ContactOrder): boolean {
  if (o.cancelled) return true;
  return /return|fail|attempt/.test(statusText(o));
}

/** Order is still in flight — placed / booked / in transit / out for delivery. */
export function orderIsActive(o: ContactOrder): boolean {
  if (o.cancelled || o.archived) return false;
  return !orderIsDelivered(o) && !orderIsFailed(o);
}

/** True when this order should surface under the panel's "Issues" segment. */
export function orderIsIssue(o: ContactOrder): boolean {
  return orderIsFailed(o) || !!o.noResponseAt;
}

export interface ContactOrderSummary {
  count: number;
  /** Lifetime value = sum of non-cancelled order totals. */
  ltv: number;
  /** Average order value across non-cancelled orders with a total. */
  aov: number;
  currency: string | null;
  /** Delivered ÷ (delivered + returned/failed), 0–100; null if none shipped-terminal. */
  deliveredRate: number | null;
  deliveredCount: number;
  activeCount: number;
  issuesCount: number;
}

/** Roll a contact's orders into the headline signals shown in the info panel.
 *  Everything is derived from orders already fetched — no extra API call. */
export function summarizeContactOrders(
  orders: ContactOrders | null,
): ContactOrderSummary | null {
  if (!orders || orders.count === 0) return null;
  let ltv = 0;
  let valued = 0; // count of orders that contributed a total (for AOV)
  let currency: string | null = null;
  let delivered = 0;
  let rateFailed = 0; // returned/failed only (attempts + cancels excluded from rate)
  let active = 0;
  let issues = 0;
  for (const o of orders.orders) {
    if (!currency && o.currency) currency = o.currency;
    if (o.total != null && !o.cancelled) {
      ltv += o.total;
      valued += 1;
    }
    if (orderIsDelivered(o)) delivered += 1;
    if (!o.cancelled && /return|fail/.test(statusText(o))) rateFailed += 1;
    if (orderIsIssue(o)) issues += 1;
    else if (orderIsActive(o)) active += 1;
  }
  const rateDenom = delivered + rateFailed;
  return {
    count: orders.count,
    ltv,
    aov: valued > 0 ? Math.round(ltv / valued) : 0,
    currency,
    deliveredRate: rateDenom > 0 ? Math.round((delivered / rateDenom) * 100) : null,
    deliveredCount: delivered,
    activeCount: active,
    issuesCount: issues,
  };
}

/** Compact money: "PKR 9.1k" for the tight stat tiles. */
export function moneyCompact(amount: number | null, currency: string | null): string {
  if (amount == null) return '—';
  const cur = currency ? currency + ' ' : '';
  if (amount >= 1000) {
    const k = amount / 1000;
    return `${cur}${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
  }
  return `${cur}${amount.toLocaleString()}`;
}

/** Tailwind tone classes for a status pill, by outcome. */
export function orderStatusTone(o: ContactOrder): string {
  if (o.cancelled) return 'bg-gray-100 text-gray-500';
  const s = (o.shipmentStatus || o.fulfillmentStatus || '').toLowerCase();
  if (/return|fail|attempt/.test(s)) return 'bg-rose-100 text-rose-700';
  if (/deliver/.test(s) && !/out for|attempt/.test(s)) return 'bg-green-100 text-green-700';
  if (s) return 'bg-blue-100 text-blue-700'; // booked / in transit / out for delivery
  const fin = (o.financialStatus || '').toLowerCase();
  if (fin === 'paid') return 'bg-green-100 text-green-700';
  return 'bg-gray-100 text-gray-600';
}
