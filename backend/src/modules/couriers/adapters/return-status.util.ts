/**
 * Central "is this parcel PHYSICALLY back with the shipper/merchant?" test.
 *
 * A status merely mentioning "return"/"rto" is NOT enough. Most return-family
 * statuses are the parcel still MOVING back (return initiated / confirmed / in
 * transit / dispatched, "ready for return", "return to {city}", "return to
 * shipper" present-tense) — those are a FAILED delivery whose parcel is on its
 * way home, and they must NOT sit in the Returned tab. Only the terminal
 * "the shipper/merchant HAS it again" states are true returns; those are the
 * ones the tenant physically receives and that drive the receive-flow, so
 * mislabelling an in-progress return as `returned` would wrongly settle a
 * parcel that's still out.
 *
 * Truly-returned phrases confirmed with the tenant (per courier):
 *   Trax     "Return - Delivered to Shipper"
 *   Leopards "Returned to shipper"          (pull-API text)
 *   PostEx   "Returned at Merchant Warehouse"
 *   Rocket   "Returned to Sender/Shipper"    (+ underlying-carrier equivalents)
 *
 * Everything else return-related → the caller maps to a NON-terminal status
 * (`attempted`) so the parcel keeps tracking and auto-promotes here on arrival.
 *
 * The discriminator is completion wording: past-tense "returned"/"delivered"
 * TO a destination, or "returned AT" a warehouse/merchant — never the
 * present-tense "return to X" / "return <verb>" of an in-progress leg.
 */
export function isReturnedToShipper(rawStatus: string): boolean {
  const k = rawStatus.trim().toLowerCase().replace(/\s+/g, ' ');
  // Bare completion tokens some couriers emit on their own.
  if (k === 'returned' || k === 'rto' || k === 'rto delivered' || k === 'return received')
    return true;
  return (
    // Trax: "Return - Delivered to Shipper"
    /delivered to (shipper|sender|merchant|consignor|origin|seller)/.test(k) ||
    // Leopards / Rocket / generic: past-tense hand-back
    /returned to (shipper|sender|merchant|consignor|warehouse|origin|seller)/.test(k) ||
    // PostEx: "Returned at Merchant Warehouse"
    /returned at .*(warehouse|merchant|origin|shipper|seller)/.test(k) ||
    /rto (delivered|received|complete(d)?)|return complete(d)?|returned successfully/.test(k)
  );
}
