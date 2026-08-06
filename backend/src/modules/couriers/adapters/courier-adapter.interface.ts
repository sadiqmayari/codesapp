import { CourierType, ShipmentStatus } from '@prisma/client';

export interface BookShipmentInput {
  companyId: number;
  shopifyOrderName: string;
  destination: {
    name: string;
    phone: string;
    city: string;
    /**
     * The value THIS courier expects for the destination city, resolved via
     * CityMappingService — never the raw free-text city off the order.
     * A numeric id for Trax/Leopards/Rocket; for PostEx it is PostEx's own
     * canonical city NAME (their API takes `cityName` and their city table
     * has no code column). Either way the lookup is what guarantees the
     * city is one the courier actually serves.
     */
    cityCode: string;
    address1: string;
    address2?: string;
  };
  codAmount: number;
  itemsDescription: string;
  pieces: number;
}

export interface BookShipmentResult {
  trackingNumber: string;
  /**
   * The courier's OWN customer-facing tracking URL, when it returns one in the
   * booking response (Rocket's `data.tracking_url`). Preferred over the
   * constructed COURIER_TRACKING_URL when present — mirrors n8n, which uses
   * Rocket's returned url. Omit when the courier returns no url (Trax/Leopards/
   * PostEx URLs are constructed from the tracking number).
   */
  trackingUrl?: string;
  raw: unknown;
}

export interface GenerateLoadsheetResult {
  loadsheetId: string;
  pdfUrl?: string;
  pdfBuffer?: Buffer;
  raw: unknown;
}

/** Result of pulling shipping labels (airway bills) for one or more parcels of
 *  a SINGLE courier. Either inline PDF bytes (a combined sheet the courier
 *  returns, e.g. PostEx ≤10-per-call) and/or per-parcel external URLs the UI
 *  can open/print (e.g. Leopards slip_link). Never mixes couriers. */
export interface CourierLabelResult {
  /** One combined label PDF covering ALL requested parcels, when the courier
   *  returns a single document for a batch (e.g. PostEx get-invoice ≤10). */
  pdfBuffer?: Buffer;
  /** Per-parcel labels when there's no single batch PDF — either inline bytes
   *  (Trax air_waybill returns one PDF per parcel) or an external courier URL
   *  (Leopards slip_link). The ops service persists any bytes to media and
   *  hands the UI a URL either way. */
  parts?: Array<{ trackingNumber: string; pdfBuffer?: Buffer; url?: string }>;
  raw: unknown;
}

/** Unified shipper-advice intent for an attempted parcel, mapped per courier:
 *  return    -> PostEx statusId 1 / Trax type 1 (Return Confirm) / Leopards 'RA'
 *  reattempt -> PostEx statusId 2 / Trax type 2 (Re-Attempt)     / Leopards 'RT' */
export type ShipperAdviceAction = 'return' | 'reattempt';

/**
 * Richer result of a tracking pull than `queryTracking`'s `{...}|null`. Lets a
 * courier distinguish a **dead** tracking ref (the courier says this ref is no
 * longer valid — e.g. a Rocket parcel that was rerouted and reassigned a NEW
 * ref) from merely "no new status" or a transient failure. The status-sync uses
 * `dead` to FLAG the parcel as needs-attention instead of silently re-checking a
 * ref that will never resolve again.
 */
export type TrackingProbe =
  | {
      kind: 'status';
      rawStatus: string;
      // Optional adapter-resolved status. When set, the status-sync uses it
      // directly instead of its generic `normalize()` heuristic — for couriers
      // whose PULL vocabulary is their own (e.g. Leopards' "Dispatched" /
      // "Delivered" human strings) and would be mis-read by the shared heuristic.
      mapped?: ShipmentStatus;
      happenedAt?: Date;
      reason?: string;
    }
  | { kind: 'dead' } // ref no longer tracks at the courier (e.g. rerouted)
  | { kind: 'none' }; // reachable but nothing status-like / transient

/** One checkpoint in a parcel's tracking history (oldest → newest), normalized
 *  across couriers for the in-app tracking view. */
export interface TrackingCheckpoint {
  /** Raw courier status text, e.g. "Arrived at Origin Hub". */
  status: string;
  /** Optional location / reason / remark for this checkpoint. */
  detail?: string;
  /** ISO datetime string when it happened (omitted if the courier gave none). */
  at?: string;
}

/**
 * Thrown by `mapStatus` when a courier sends a status string the adapter
 * doesn't recognize. Callers must surface this (last_courier_status_raw +
 * a "needs attention" UI filter) rather than silently dropping the event —
 * the n8n Switch nodes this replaces had no fallback branch and lost these.
 */
export class UnmappedCourierStatusError extends Error {
  constructor(
    public readonly courier: CourierType,
    public readonly rawStatus: string,
  ) {
    super(`Unmapped ${courier} status: "${rawStatus}"`);
    this.name = 'UnmappedCourierStatusError';
  }
}

/**
 * One implementation per courier (Trax/Leopards/PostEx/Rocket). Mirrors the
 * modules/ai/providers/LlmProvider abstraction so a 5th courier is a clean
 * add. `creds` is always the already-decrypted, adapter-owned JSON shape
 * (see each adapter's `Credentials` type) — the adapter never touches the
 * DB row or EncryptionService directly.
 */
export interface CourierAdapter {
  readonly type: CourierType;

  bookShipment(
    creds: unknown,
    input: BookShipmentInput,
  ): Promise<BookShipmentResult>;

  generateLoadsheet(
    creds: unknown,
    trackingNumbers: string[],
  ): Promise<GenerateLoadsheetResult>;

  /**
   * Pull the CURRENT status for a tracking number from the courier's own API
   * (used by the status-sync job to catch parcels whose status never synced
   * through Shopify). Returns the latest raw status string + when it happened,
   * or null if the courier can't be reached / has no history. Omit if the
   * courier is webhook-only (Leopards/Rocket have no pull endpoint wired).
   */
  queryTracking?(
    creds: unknown,
    trackingNumber: string,
  ): Promise<{ rawStatus: string; happenedAt?: Date; reason?: string } | null>;

  /**
   * Like `queryTracking` but distinguishes a DEAD ref (`kind:'dead'`) from
   * "no new status" (`kind:'none'`). Optional; when a courier implements it the
   * status-sync prefers it so it can flag rerouted/invalid refs. Couriers
   * without reroute semantics can omit it (the plain `queryTracking` is used).
   */
  queryTrackingResult?(
    creds: unknown,
    trackingNumber: string,
  ): Promise<TrackingProbe>;

  /**
   * Full checkpoint HISTORY (oldest → newest) for the in-app tracking view.
   * Optional — implemented for couriers whose public tracking page can't be
   * embedded in an iframe (e.g. Leopards' page needs a same-site session its
   * iframe can't provide), so we render the timeline natively from the merchant
   * API instead. Returns [] when unreachable / no history.
   */
  queryTrackingHistory?(
    creds: unknown,
    trackingNumber: string,
  ): Promise<TrackingCheckpoint[]>;

  /**
   * Courier's raw status vocabulary -> our internal ShipmentStatus. Must
   * throw UnmappedCourierStatusError for anything it doesn't recognize —
   * never silently return a default.
   */
  mapStatus(rawStatus: string): ShipmentStatus;

  /**
   * Best-effort extraction of a bad-address signal from a raw failure
   * reason string (e.g. PostEx/Leopards "Consignee Not Available" style
   * text). Returns null when the reason doesn't look address-related.
   */
  isAddressIssueReason?(rawReason: string): boolean;

  /**
   * Cancel a booked parcel at the courier (undo a booking). Returns ok=false
   * (never throws for a business rejection) when the courier declines. Omit
   * for couriers with no cancel API wired (Rocket).
   */
  cancelShipment?(
    creds: unknown,
    trackingNumber: string,
  ): Promise<{ ok: boolean; raw: unknown }>;

  /**
   * Fetch shipping labels (airway bills) for parcels of THIS courier. The
   * caller guarantees every tracking number belongs to this courier. Adapters
   * chunk to their own per-call cap internally.
   */
  getLabels?(
    creds: unknown,
    trackingNumbers: string[],
  ): Promise<CourierLabelResult>;

  /**
   * Send shipper advice on an attempted parcel (request re-attempt or return).
   * Omit for couriers with no shipper-advice API wired (Rocket).
   */
  sendShipperAdvice?(
    creds: unknown,
    trackingNumber: string,
    action: ShipperAdviceAction,
    remarks: string,
  ): Promise<{ ok: boolean; raw: unknown }>;
}
