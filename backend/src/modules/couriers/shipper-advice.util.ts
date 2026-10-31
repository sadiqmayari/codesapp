import { ShipmentStatus } from '@prisma/client';

/**
 * How long an `attempted` parcel may sit with NO advice sent before it is
 * flagged as awaiting shipper advice — the fallback for couriers that expose no
 * explicit "awaiting advice" status (PostEx, Rocket, some Leopards codes). An
 * explicit courier signal flags immediately regardless of age.
 */
export const AGED_ATTEMPT_MS = 24 * 60 * 60 * 1000;

export interface ShipperAdviceInput {
  /** The parcel's CURRENT mapped ShipmentStatus. */
  status: ShipmentStatus;
  /** The raw courier status text (used as the stored `required_raw` reason). */
  rawStatus: string | null;
  /** When the parcel first became `attempted` (shipment.attempted_at). */
  attemptedAt: Date | null;
  /** When the tenant last SENT advice on this parcel (shipment.shipper_advice_at). */
  adviceSentAt: Date | null;
  /** The adapter's explicit verdict: adapter.isAwaitingShipperAdvice(raw, reason). */
  explicit: boolean;
  /** Clock injection for tests; defaults to now. */
  now?: Date;
}

export interface ShipperAdviceResult {
  /** True → set shipper_advice_required_at; false → clear it. */
  required: boolean;
  /** The raw status to store as shipper_advice_required_raw when required. */
  raw: string | null;
}

/**
 * Single source of truth for the "is this parcel awaiting shipper advice?"
 * decision — consumed by BOTH the webhook path (ShipmentTrackingService) and the
 * pull-sync path (CourierStatusSyncService) so the two can never drift.
 *
 * Rules:
 *   - Not `attempted`            → not required (clears the flag).
 *   - Advice already sent        → not required (the operator acted; the courier
 *                                   moves the parcel from here).
 *   - Explicit courier signal    → required immediately.
 *   - Attempt aged >= 24h        → required (fallback for no-signal couriers).
 *   - Otherwise                  → not required (a recent attempt may auto-retry).
 */
export function resolveShipperAdviceRequired(input: ShipperAdviceInput): ShipperAdviceResult {
  const { status, rawStatus, attemptedAt, adviceSentAt, explicit } = input;
  const now = input.now ?? new Date();

  if (status !== 'attempted') return { required: false, raw: null };
  if (adviceSentAt) return { required: false, raw: null };
  if (explicit) return { required: true, raw: rawStatus };
  if (attemptedAt && now.getTime() - attemptedAt.getTime() >= AGED_ATTEMPT_MS) {
    return { required: true, raw: rawStatus };
  }
  return { required: false, raw: null };
}
