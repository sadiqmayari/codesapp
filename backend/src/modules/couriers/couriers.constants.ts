import { ShipmentStatus } from '@prisma/client';

export const COURIER_BOOKING_QUEUE = 'courier-booking';
export const COURIER_LOADSHEET_QUEUE = 'courier-loadsheet';

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
  picked_up: 'CARRIER_PICKED_UP',
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
