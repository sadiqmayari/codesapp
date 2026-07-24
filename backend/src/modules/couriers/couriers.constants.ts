import { ShipmentStatus } from '@prisma/client';

export const COURIER_BOOKING_QUEUE = 'courier-booking';
export const COURIER_LOADSHEET_QUEUE = 'courier-loadsheet';

/**
 * The ONE place that produces the string sent to Shopify's
 * fulfillmentEventCreate mutation. Centralizing this (instead of each
 * courier-tracking flow guessing its own string, as the tenant's n8n
 * workflows did — all 3 sent the literal "FAILURE" for a failed delivery)
 * means a single fix here corrects every courier at once.
 *
 * VERIFY before go-live: Shopify's FulfillmentEventStatus enum can change
 * between API versions — confirm these values are valid for the API
 * version pinned in ShopifyOrderConfig.api_version before relying on this
 * in production (see plan verification section).
 */
export const SHIPMENT_STATUS_TO_SHOPIFY_EVENT: Partial<
  Record<ShipmentStatus, string>
> = {
  in_transit: 'IN_TRANSIT',
  out_for_delivery: 'OUT_FOR_DELIVERY',
  picked_up: 'PICKED_UP',
  ready_for_pickup: 'READY_FOR_PICKUP',
  delivered: 'DELIVERED',
  attempted: 'ATTEMPTED_DELIVERY',
  failed: 'FAILURE',
  // booked / address_issue / cancelled / returned are internal states with
  // no corresponding Shopify delivery-lifecycle event — intentionally
  // omitted so the tracking handler skips the Shopify call for those.
};

/** Terminal states — a tracking update landing on an already-terminal
 *  Shipment is a duplicate webhook redelivery, not a new event. Comparing
 *  against OUR OWN status (not a Shopify field, which is what the tenant's
 *  n8n Leopards flow did and likely caused its duplicate-blacklist bug). */
export const TERMINAL_SHIPMENT_STATUSES: ShipmentStatus[] = [
  'delivered',
  'cancelled',
  'returned',
];
