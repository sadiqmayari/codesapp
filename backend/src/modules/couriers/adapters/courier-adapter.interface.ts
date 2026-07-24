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
  raw: unknown;
}

export interface GenerateLoadsheetResult {
  loadsheetId: string;
  pdfUrl?: string;
  pdfBuffer?: Buffer;
  raw: unknown;
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

  /** Not all couriers support pull-tracking; omit if webhook-only. */
  queryTracking?(
    creds: unknown,
    trackingNumber: string,
  ): Promise<{ rawStatus: string } | null>;

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
}
