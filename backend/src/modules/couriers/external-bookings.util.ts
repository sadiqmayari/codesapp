import { ExternalBooking } from './adapters/courier-adapter.interface';

/**
 * Attach parcels booked OUTSIDE CodesApp (e.g. in the TCS portal) to the
 * tenant's orders. The courier's bookings report lists every parcel on the
 * account — on a SHARED account other businesses' parcels too — so a booking
 * is only used when its reference names exactly ONE of this tenant's orders.
 * Pure + unit-tested (external-bookings.spec.ts).
 */

export interface ExternalBookingOrder {
  gid: string;
  name: string | null;
  storeId: number | null;
  totalPrice: number | null;
  outstanding: number | null;
  fulfillmentStatus: string | null;
}

export interface ExternalBookingShipment {
  id: number;
  gid: string;
  courierType: string;
  trackingNumber: string | null;
  status: string;
}

export type ExternalBookingAction =
  | { kind: 'create'; order: ExternalBookingOrder; booking: ExternalBooking }
  | { kind: 'fill'; shipmentId: number; order: ExternalBookingOrder; booking: ExternalBooking };

export interface ExternalBookingPlan {
  actions: ExternalBookingAction[];
  matched: number;
  alreadyLinked: number;
  skipped: number;
}

/** Order name / courier reference → comparable key ("#BRF-12" → "BRF-12"). */
export function normRef(v: string | null | undefined): string {
  return String(v ?? '')
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

const TERMINAL = new Set(['delivered', 'returned', 'cancelled']);

function isFulfilled(s: string | null): boolean {
  return /^(fulfil|partial)/i.test(String(s ?? ''));
}

function codMatches(b: ExternalBooking, o: ExternalBookingOrder): boolean {
  const cod = Number(b.codAmount) || 0;
  const near = (x: number | null) => x != null && Math.abs(Number(x) - cod) <= 1;
  return near(o.outstanding) || near(o.totalPrice);
}

export function planExternalBookings(
  bookings: ExternalBooking[],
  orders: ExternalBookingOrder[],
  shipments: ExternalBookingShipment[],
): ExternalBookingPlan {
  // Index the tenant's orders by name; a name used by two orders (two stores
  // with the same numbering) is ambiguous and never matched.
  const byName = new Map<string, ExternalBookingOrder | null>();
  for (const o of orders) {
    const k = normRef(o.name);
    if (!k) continue;
    byName.set(k, byName.has(k) ? null : o);
  }
  const shipByGid = new Map(shipments.map((s) => [s.gid, s]));
  const ownCns = new Set(shipments.map((s) => s.trackingNumber).filter(Boolean) as string[]);

  // Latest booking per order (a re-booked parcel lists both CNs).
  const best = new Map<string, { order: ExternalBookingOrder; booking: ExternalBooking }>();
  let skipped = 0;
  let alreadyLinked = 0;
  for (const b of bookings) {
    if (ownCns.has(b.trackingNumber)) {
      alreadyLinked++;
      continue;
    }
    const k = normRef(b.reference);
    const o = k ? byName.get(k) : undefined;
    if (!o) {
      if (o === null) skipped++;
      continue; // not this tenant's order (shared account) or no reference
    }
    // A bare number ("1821") is common across businesses on a shared account:
    // also require the COD to match this order.
    if (/^\d+$/.test(k) && !codMatches(b, o)) {
      skipped++;
      continue;
    }
    // Only orders already fulfilled in the store — the "booked in the portal,
    // fulfilled in Shopify without tracking" case. An unfulfilled order is
    // either not shipped or had its CodesApp booking cancelled (that CN must
    // not come back).
    if (!isFulfilled(o.fulfillmentStatus)) {
      skipped++;
      continue;
    }
    const prev = best.get(o.gid);
    if (!prev || (b.bookedAt?.getTime() ?? 0) > (prev.booking.bookedAt?.getTime() ?? 0)) {
      best.set(o.gid, { order: o, booking: b });
    }
  }

  const actions: ExternalBookingAction[] = [];
  for (const { order, booking } of best.values()) {
    const s = shipByGid.get(order.gid);
    if (!s) {
      actions.push({ kind: 'create', order, booking });
      continue;
    }
    // A row without a tracking number that is still open (e.g. created from a
    // Shopify fulfilment with no tracking) gets the CN. Anything else — a
    // manual fulfilment, another courier's parcel, a finished row — is left.
    if (!s.trackingNumber && !TERMINAL.has(s.status) && s.courierType !== 'manual') {
      actions.push({ kind: 'fill', shipmentId: s.id, order, booking });
    } else {
      skipped++;
    }
  }
  return { actions, matched: best.size, alreadyLinked, skipped };
}
