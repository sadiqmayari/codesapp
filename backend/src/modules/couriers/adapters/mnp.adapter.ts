import { Injectable, Logger } from '@nestjs/common';
import { CourierType, ShipmentStatus } from '@prisma/client';
import {
  BookShipmentInput,
  BookShipmentResult,
  CourierAdapter,
  GenerateLoadsheetResult,
  UnmappedCourierStatusError,
} from './courier-adapter.interface';
import { httpFetch } from './http.util';
import { isReturnedToShipper } from './return-status.util';

/**
 * M&P (Muller & Phipps) COD API credentials. All provisioned out-of-band by
 * M&P — there is no self-service registration. `username`/`password`/`accountNo`
 * authenticate every call (credential-in-payload; no token/OAuth). `locationID`
 * is the origin branch the booking runs through; `returnLocation` the branch a
 * return routes to. `service` is the default shipment service (e.g. Overnight).
 */
export interface MnpCredentials {
  username: string;
  password: string;
  /** M&P parent account number, e.g. "4T154". */
  accountNo: string;
  /** Origin/pickup branch id (from Get_locations). Required for booking. */
  locationID: string;
  /** Return branch id (optional). */
  returnLocation?: string;
  /** Child sub-account id (optional). */
  subAccountId?: string;
  /** Default service, e.g. "Overnight" / "O" / "Second Day" / "S" (optional). */
  service?: string;
  // ── Slip-only fields (not sent to M&P; used to print the in-app shipping slip,
  //    since M&P has no label API). Shipper name comes from the company profile. ──
  /** Shipper contact phone shown on the slip. */
  pickupPhone?: string;
  /** Shipper pickup address shown on the slip (the M&P branch address). */
  pickupAddress?: string;
  /** Origin/From city shown on the slip (e.g. "KARACHI"). */
  originCity?: string;
}

// Main COD API (booking / cities / locations / void). CN tracking lives on a
// SEPARATE host (tracking.mulphilog.com.pk) — see TRACK_URL.
const BASE_URL = 'https://mnpcourier.com/mycodapi/api';
const TRACK_URL = 'https://tracking.mulphilog.com.pk/api';

/**
 * M&P status vocabulary — the FULL documented tracking taxonomy (provided by the
 * tenant from M&P's status sheet). Keys are the tracking value lowercased with
 * en/em dashes normalised to '-' and whitespace collapsed (see normStatus). We
 * key on BOTH the "CODTracking" value M&P actually emits (e.g. "In-transit",
 * "Unsuccessful Delivery Attempt") AND its human "TagDescription" alias (e.g.
 * "Forward - In Transit") so a poll (TrackingStatus) or a push (Status) both
 * resolve regardless of which label M&P sends. Anything unrecognised still falls
 * through to the heuristics in mapStatus and ultimately THROWS (surfaced as
 * "needs attention"), same discipline as the other adapters.
 *
 * Return-family mapping rule: a return LEG still in motion is `failed` (Failed
 * tab, keeps polling, auto-promotes to `returned` on arrival); only the terminal
 * hand-back "Return to Vendor/Return to Shipper" (parcel physically back with the
 * shipper) is `returned`. NB M&P's terminal value says "return TO shipper" (not
 * "returned to"), which the generic isReturnedToShipper does NOT catch — that is
 * exactly why the exact map is consulted FIRST in mapStatus.
 */
const STATUS_MAP: Record<string, ShipmentStatus> = {
  // ── Forward leg ──
  booked: 'ready_for_pickup',
  'order created': 'ready_for_pickup',
  pickup: 'picked_up',
  'picked from shipper facility': 'picked_up',
  picked: 'picked_up',
  'arrived at origin': 'in_transit',
  'arrived at ops facility': 'in_transit',
  arrived: 'in_transit',
  'forward - in transit': 'in_transit',
  'in-transit': 'in_transit',
  'in transit': 'in_transit',
  'reached at destination': 'in_transit',
  'out for delivery': 'out_for_delivery',
  'out-for-delivery': 'out_for_delivery',
  // ── Delivery attempt / advice (undelivered, still live) ──
  attempt: 'attempted',
  'unsuccessful delivery attempt': 'attempted',
  undelivered: 'attempted',
  attempted: 'attempted',
  'hold for advice': 'attempted',
  'hold for advice - on nci': 'attempted',
  're-attempt': 'attempted',
  're-attempt advice': 'attempted',
  // ── Delivered ──
  delivered: 'delivered',
  // ── Return leg in motion → failed (RTO on its way back) ──
  'return - in transit': 'failed',
  'return - reached at origin': 'failed',
  'return - out for delivery': 'failed',
  'return - attempt': 'failed',
  'unsuccessful return attempt': 'failed',
  'failed delivered': 'failed',
  // ── Terminal hand-back → returned (parcel physically back with shipper) ──
  'return to vendor/return to shipper': 'returned',
  'return to shipper': 'returned',
  'return to vendor': 'returned',
};

/** Lowercase, normalise en/em dashes to a plain '-', and collapse whitespace so
 *  "Return – In Transit" and "Return - In Transit" hit the same key. Spacing
 *  around a hyphen is preserved (keys carry the exact spacing M&P uses, e.g.
 *  "in-transit" vs "forward - in transit"). */
function normStatus(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[‒-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

@Injectable()
export class MnpAdapter implements CourierAdapter {
  readonly type: CourierType = 'mnp';
  private readonly logger = new Logger(MnpAdapter.name);

  /**
   * Credential fields M&P expects in every request body. The doc uses
   * inconsistent casing per endpoint (username/Username, password/Password), so
   * we send both common spellings + AccountNo — unknown keys are ignored by the
   * API. This hedges the doc's documented casing ambiguity.
   */
  private auth(creds: MnpCredentials): Record<string, string> {
    return {
      username: creds.username,
      Username: creds.username,
      UserName: creds.username,
      password: creds.password,
      Password: creds.password,
      AccountNo: creds.accountNo,
      accountno: creds.accountNo,
    };
  }

  /** username/password/AccountNo as query params, for the GET endpoints (the doc
   *  gives no request body example for GETs). */
  private authQuery(creds: MnpCredentials): string {
    const q = new URLSearchParams({
      username: creds.username,
      password: creds.password,
      AccountNo: creds.accountNo,
    });
    return q.toString();
  }

  async bookShipment(
    creds: MnpCredentials,
    input: BookShipmentInput,
  ): Promise<BookShipmentResult> {
    const qty = Math.max(
      1,
      Math.round(input.totalQuantity != null ? input.totalQuantity : input.pieces),
    );
    // M&P's InsertBookingData is a COD-only endpoint: codAmount is mandatory and
    // MUST be > 0 (the API rejects 0 with "COD amount must be greater than 0").
    // A prepaid order (nothing left to collect) therefore cannot be booked on a
    // COD account — M&P separates COD vs prepaid at the ACCOUNT level via the
    // `IsCod` flag (GetAccounts), so prepaid needs a non-COD account provisioned
    // by M&P. Fail with a clear message rather than leaking M&P's raw error.
    const cod = Math.round(input.codAmount);
    if (!(cod > 0)) {
      throw new Error(
        'M&P is a COD-only account: it cannot book a prepaid order (COD amount is 0). ' +
          'Book this order with another courier, or ask M&P to provision a non-COD account.',
      );
    }
    const body: Record<string, unknown> = {
      ...this.auth(creds),
      locationID: creds.locationID,
      // InsertType is M&P's internal booking type — the doc's example value is the
      // integer 19, NOT the literal string "MP". Sending "MP" made M&P fall back
      // to a default insert that ignored ReturnLocation (slip showed "Return
      // Branch: null").
      InsertType: 19,
      // ReturnLocation is MANDATORY (doc ✔) and must be the NUMERIC branch id
      // (example: 41), same shape as locationID. Always send it — fall back to the
      // origin branch when no dedicated return branch is configured.
      ReturnLocation: Number(creds.returnLocation || creds.locationID),
      ...(creds.subAccountId ? { subAccountId: Number(creds.subAccountId) } : {}),
      // M&P matches the destination by exact city NAME string (no numeric code),
      // resolved through CityMappingService — mnp's city_code IS the M&P name.
      destinationCityName: input.destination.cityCode,
      consigneeName: input.destination.name,
      consigneeMobNo: input.destination.phone.replace(/[^\d+]/g, ''),
      consigneeAddress: [input.destination.address1, input.destination.address2]
        .filter(Boolean)
        .join(', '),
      // Optional but the KEY must be present (M&P errors on omitted keys).
      consigneeEmail: input.email && input.email.includes('@') ? input.email : '',
      pieces: qty,
      weight: 0.5,
      codAmount: cod,
      custRefNo: input.shopifyOrderName,
      productDetails: input.itemsDescription || 'Order',
      fragile: 'No',
      service: creds.service || '',
      insuranceValue: '0',
      remarks: '',
    };

    const res = await httpFetch(`${BASE_URL}/Booking/InsertBookingData`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const raw = await res.json().catch(() => ({}));
    // Response is a JSON ARRAY: [{ isSuccess:"true", orderReferenceId:"..." }].
    const row = Array.isArray(raw) ? raw[0] : raw;
    const trackingNumber = (row as any)?.orderReferenceId;
    const ok = res.ok && isTruthy((row as any)?.isSuccess) && trackingNumber;
    if (!ok) {
      throw new Error(`M&P booking failed: ${JSON.stringify(raw)}`);
    }
    return { trackingNumber: String(trackingNumber), raw };
  }

  /**
   * M&P has NO loadsheet/manifest API. Return no pdfBuffer so LoadsheetService
   * builds our own in-app dispatch manifest instead (same as Rocket).
   */
  async generateLoadsheet(
    _creds: MnpCredentials,
    trackingNumbers: string[],
  ): Promise<GenerateLoadsheetResult> {
    return {
      loadsheetId: `mnp-manifest-${trackingNumbers.length}`,
      pdfBuffer: undefined,
      raw: null,
    };
  }

  /** Void (cancel) a consignment. M&P's only cancel route. */
  async cancelShipment(
    creds: MnpCredentials,
    trackingNumber: string,
  ): Promise<{ ok: boolean; raw: unknown }> {
    const res = await httpFetch(`${BASE_URL}/Booking/VoidConsignment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        ...this.auth(creds),
        locationID: creds.locationID,
        consignmentNumberList: [trackingNumber],
      }),
    });
    const raw = await res.json().catch(() => ({}));
    const row = Array.isArray(raw) ? raw[0] : raw;
    const perCn = (row as any)?.orderReferenceIdList?.[0];
    const ok = res.ok && (isTruthy((row as any)?.isSuccess) || isTruthy(perCn?.success));
    return { ok, raw };
  }

  /**
   * Pull current status from M&P's CN tracking (separate host). `id` is always 4
   * per the doc. The event history is `tracking_Details[0].CNTrackingDetail[]`
   * (chronological) — the last entry is the latest status.
   */
  async queryTracking(
    creds: MnpCredentials,
    trackingNumber: string,
  ): Promise<{ rawStatus: string; happenedAt?: Date; reason?: string } | null> {
    try {
      const res = await httpFetch(
        `${TRACK_URL}/CNTracking?consignment=${encodeURIComponent(trackingNumber)}&id=4`,
        { headers: { Accept: 'application/json' } },
      );
      const j = (await res.json().catch(() => null)) as any;
      const detail = (Array.isArray(j) ? j[0] : j)?.tracking_Details;
      const cn = Array.isArray(detail) ? detail[0] : detail;
      const hist = cn?.CNTrackingDetail;
      if (!Array.isArray(hist) || !hist.length) return null;
      const last = hist[hist.length - 1];
      const status = last?.TrackingStatus;
      if (!status) return null;
      // "MM/DD/YYYY HH:mm:ss" → Date (best-effort; drop if unparseable).
      const when = last?.TransactionTime ? new Date(String(last.TransactionTime)) : null;
      return {
        rawStatus: String(status),
        happenedAt: when && !Number.isNaN(when.getTime()) ? when : undefined,
        reason: firstString(last?.TrackingNarration, last?.Event) || undefined,
      };
    } catch {
      return null;
    }
  }

  mapStatus(rawStatus: string): ShipmentStatus {
    const key = normStatus(rawStatus);
    // 1) Documented vocabulary wins — deterministic, and the ONLY way the
    //    terminal "Return to Vendor/Return to Shipper" resolves to `returned`
    //    (its "return TO shipper" wording is not caught by isReturnedToShipper,
    //    and the return-heuristic below would otherwise mark it `failed`).
    const mapped = STATUS_MAP[key];
    if (mapped) return mapped;
    // 2) Heuristic safety net for any UNDOCUMENTED variant M&P might emit.
    if (isReturnedToShipper(rawStatus)) return 'returned';
    // Return-in-motion / RTO leg → failed (Failed tab; re-polled → promotes to
    // returned on arrival). M&P uses "RS-Return to Shipper" style codes.
    if (key.includes('return') || key.includes('rto') || key.startsWith('rs-')) return 'failed';
    if (
      key.includes('not available') ||
      key.includes('refused') ||
      key.includes('non service') ||
      key.includes('out of city')
    ) {
      return 'attempted';
    }
    throw new UnmappedCourierStatusError('mnp', rawStatus);
  }

  isAddressIssueReason(rawReason: string): boolean {
    return /wrong address|address.*(not found|invalid)|non service area|consignee not available|out of city|no such (building|address|plot)/i.test(
      rawReason,
    );
  }

  // ── Config-support helpers (NOT part of CourierAdapter) ──────────────────

  /**
   * List the account's origin/pickup locations (Get_locations) so Settings can
   * render a dropdown for `locationID`/`returnLocation` instead of a raw id.
   * Returns [{id,label}]. Note M&P's success key is the typo `isSucces`.
   */
  async getLocations(
    creds: MnpCredentials,
  ): Promise<Array<{ id: string; label: string }>> {
    const res = await httpFetch(
      `${BASE_URL}/Locations/Get_locations?${this.authQuery(creds)}`,
      { method: 'GET', headers: { Accept: 'application/json' } },
    );
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`M&P locations failed (${res.status}): ${JSON.stringify(raw)}`);
    }
    const list = (raw as any)?.locationList;
    if (!Array.isArray(list)) return [];
    return list
      .filter((l: any) => l && l.locationID != null)
      .map((l: any) => {
        const name = firstString(l?.locationName, l?.locationAddress) ?? `#${l.locationID}`;
        const addr = l?.locationAddress ? ` — ${l.locationAddress}` : '';
        return { id: String(l.locationID), label: `${name}${addr}`.trim() };
      });
  }

  /**
   * Fetch the full M&P destination-city list (Get_Cities_All → "cities for
   * delivery"). Returns plain city-NAME strings (M&P has no numeric city code;
   * the name IS the booking key). Names carry trailing spaces / mixed casing —
   * the caller normalizes. One-time seed source (not an ongoing sync).
   */
  async listCities(creds: MnpCredentials): Promise<string[]> {
    const res = await httpFetch(
      `${BASE_URL}/Branches/Get_Cities_All?${this.authQuery(creds)}`,
      { method: 'GET', headers: { Accept: 'application/json' } },
    );
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`M&P cities failed (${res.status}): ${JSON.stringify(raw)}`);
    }
    // Shape: [ { "City": ["ATTOCK", "ALI ABAD ", ...] } ]
    const row = Array.isArray(raw) ? raw[0] : raw;
    const cities = (row as any)?.City;
    if (!Array.isArray(cities)) return [];
    return cities
      .map((c: unknown) => (c == null ? '' : String(c).trim()))
      .filter((c: string) => c.length > 0);
  }
}

/** M&P returns isSuccess/success as either the string "true" or a real boolean. */
function isTruthy(v: unknown): boolean {
  return v === true || String(v).toLowerCase() === 'true';
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return undefined;
}
