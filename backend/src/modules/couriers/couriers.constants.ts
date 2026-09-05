import { CourierType, ShipmentStatus } from '@prisma/client';

export const COURIER_BOOKING_QUEUE = 'courier-booking';
export const COURIER_LOADSHEET_QUEUE = 'courier-loadsheet';
export const COURIER_BULK_BOOK_QUEUE = 'courier-bulk-book';
export const COURIER_BULK_CANCEL_QUEUE = 'courier-bulk-cancel';
export const COURIER_INVOICE_APPLY_QUEUE = 'courier-invoice-apply';
export const COURIER_RTO_RECEIVE_QUEUE = 'courier-rto-receive';

/**
 * Human display name per courier — used as Shopify's `trackingInfo.company`
 * and as the courier tag we add to the order (Trax / PostEx / Leopards /
 * Rocket), NOT the lowercase Prisma enum. A recognized carrier name also lets
 * Shopify render its own tracking link.
 */
export const COURIER_DISPLAY_NAME: Record<CourierType, string> = {
  trax: 'Trax',
  postex: 'PostEx',
  leopards: 'Leopards',
  rocket: 'Rocket',
  mnp: 'M&P',
};

/**
 * Public customer tracking-page URL per courier, given the tracking number.
 * Sent to Shopify as `trackingInfo.url` so the order page + customer emails
 * carry a working courier link. Centralized so a courier changing its tracker
 * URL is a one-line fix. Rocket left null until its portal URL is confirmed.
 */
export const COURIER_TRACKING_URL: Record<CourierType, ((tn: string) => string) | null> = {
  trax: (tn) => `https://sonic.pk/tracking?tracking_number=${encodeURIComponent(tn)}`,
  postex: (tn) => `https://postex.pk/tracking?cn=${encodeURIComponent(tn)}`,
  leopards: (tn) => `https://pk.leopardscourier.com/tracking?cn_number=${encodeURIComponent(tn)}`,
  rocket: (tn) => `https://client.rocketcourier.pk/tracking?trackingno=${encodeURIComponent(tn)}`,
  mnp: (tn) => `https://www.mnpcourier.com/track?cn=${encodeURIComponent(tn)}`,
};

export function courierTrackingUrl(courier: CourierType, tn: string): string | undefined {
  const fn = COURIER_TRACKING_URL[courier];
  return fn ? fn(tn) : undefined;
}

/**
 * The ONE place that produces the string sent to Shopify's
 * fulfillmentEventCreate mutation. Centralizing this (instead of each
 * courier-tracking flow building its own string, as the tenant's 3 n8n
 * tracking workflows did) means a single fix here corrects every courier.
 *
 * Values verified against Shopify's FulfillmentEventStatus enum, whose
 * complete membership is:
 *   ATTEMPTED_DELIVERY, CARRIER_PICKED_UP, CONFIRMED, DELAYED, DELIVERED,
 *   FAILURE, IN_TRANSIT, LABEL_PRINTED, LABEL_PURCHASED, OUT_FOR_DELIVERY,
 *   READY_FOR_PICKUP
 * Note the pickup member is CARRIER_PICKED_UP — a bare "PICKED_UP" is NOT
 * a member and would be rejected. Re-check this list if the pinned
 * ShopifyOrderConfig.api_version moves.
 */
export const SHIPMENT_STATUS_TO_SHOPIFY_EVENT: Partial<
  Record<ShipmentStatus, string>
> = {
  in_transit: 'IN_TRANSIT',
  out_for_delivery: 'OUT_FOR_DELIVERY',
  // picked_up is retired in favour of in_transit (a picked parcel is treated as
  // in-transit for both the tab and the Shopify event); mapped to IN_TRANSIT for
  // any legacy row so it never emits the rejected bare "PICKED_UP".
  picked_up: 'IN_TRANSIT',
  ready_for_pickup: 'READY_FOR_PICKUP',
  delivered: 'DELIVERED',
  attempted: 'ATTEMPTED_DELIVERY',
  failed: 'FAILURE',
  // Shopify's FulfillmentEventStatus enum has NO "returned" member, so a
  // completed return is reported to Shopify as FAILURE (the delivery did not
  // succeed) — same bucket the return-in-motion legs (internal 'failed') use.
  returned: 'FAILURE',
  // booked / address_issue / cancelled are internal states with no
  // corresponding Shopify delivery-lifecycle event — intentionally omitted so
  // the tracking handler skips the Shopify call for those.
};

/** Terminal states — a tracking update landing on an already-terminal
 *  Shipment is a duplicate webhook redelivery, not a new event. Comparing
 *  against OUR OWN status (not a Shopify field, which is what the tenant's
 *  n8n Leopards flow did and likely caused its duplicate-blacklist bug).
 *  NOTE `failed` is deliberately NOT terminal: the tenant models
 *  return-IN-MOTION legs (a parcel travelling back to them after a failed
 *  delivery) as 'failed' so they surface on the Failed tab — but those parcels
 *  MUST keep being tracked so they auto-promote to 'returned' when they
 *  physically arrive (Leopards/Rocket confirm that only via the pull API). The
 *  status-sync bounds the failed re-poll by recency (see FAILED_REPOLL_MAX_AGE_MS)
 *  so genuinely-dead 'lost'/'case-closed' parcels aren't polled forever.
 *  `attempted` is likewise non-terminal (re-attempt → delivered/returned). */
export const TERMINAL_SHIPMENT_STATUSES: ShipmentStatus[] = [
  'delivered',
  'cancelled',
  'returned',
];
