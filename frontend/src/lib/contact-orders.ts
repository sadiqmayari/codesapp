import { apiFetch } from './api';

export interface ContactOrder {
  orderGid: string;
  orderName: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  shipmentStatus: string | null;
  courierType: string | null;
  trackingNumber: string | null;
  total: number | null;
  outstanding: number | null;
  currency: string | null;
  createdAt: string | null;
  itemsSummary: string | null;
  cancelled: boolean;
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
