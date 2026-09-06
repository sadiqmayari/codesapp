import { Injectable, Logger } from '@nestjs/common';
import { CourierType, ShipmentStatus } from '@prisma/client';
import {
  BookShipmentInput,
  BookShipmentResult,
  CourierAdapter,
  CourierLabelResult,
  GenerateLoadsheetResult,
  ShipperAdviceAction,
  TrackingCheckpoint,
  UnmappedCourierStatusError,
} from './courier-adapter.interface';
import { httpFetch } from './http.util';
import { isReturnedToShipper } from './return-status.util';
import { mergePdfsAsIs } from '../pdf.util';

export interface TraxCredentials {
  bearerToken: string;
  pickupAddressId: string;
  /** Sonic Appendix B item_product_type_id (tenant-selected in settings). */
  itemProductTypeId?: string;
  /** '1' = insurance on, '0'/absent = off (only valid if Trax authorized it). */
  itemInsurance?: string;
  /** Free-text remark printed on the air waybill. */
  specialInstructions?: string;
  /**
   * Sonic `service_type_id` for a REPLACEMENT shipment (booked from a support
   * ticket). Set from your Trax account's service-type list. When set, a
   * replacement books under this id instead of the normal service type (1);
   * unset → a replacement books as a normal delivery.
   */
  replacementServiceTypeId?: string;
}

const BASE_URL = 'https://sonic.pk/api';

/** Trax (Sonic) status vocabulary, exactly as observed in the tenant's n8n
 *  "Sois | Trax Tracking" webhook Switch node. */
const STATUS_MAP: Record<string, ShipmentStatus> = {
  delivered: 'delivered',
  cancelled: 'cancelled',
  'arrived at origin': 'in_transit',
  'in transit': 'in_transit',
  'arrived at destination': 'in_transit',
  'not attempted': 'in_transit',
  misrouted: 'in_transit',
  'misroute forwarded': 'in_transit',
  recalled: 'in_transit',
  'intercept requested': 'in_transit',
  'intercept approved': 'in_transit',
  'arrival service center': 'in_transit',
  'dispatched from warehouse': 'in_transit',
  'out for delivery': 'out_for_delivery',
  // A picked parcel is treated as in-transit (picked_up retired from the tab /
  // Shopify model — a pick is just the first in-transit hop).
  'rider picked': 'in_transit',
  'received from shipper': 'in_transit',
  booked: 'ready_for_pickup',
  'multiple pieces hold': 'attempted',
  'delivery unsuccessful': 'attempted',
  'on hold': 'attempted',
  'reason validation required': 'attempted',
  // A re-attempt (parcel going out for another delivery try) OR a request for
  // one is treated as movement → in_transit (the failed first attempt already
  // showed as 'attempted' at the time; a scheduled retry is forward motion).
  're-attempt': 'in_transit',
  'on hold for self collection': 'attempted',
  're-attempt requested': 'in_transit',
  're-attempt call requested': 'in_transit',
  'without manifest': 'attempted',
  'non-service area': 'attempted',
  'shipper advise requested': 'attempted',
  lost: 'failed',
  'case closed': 'failed',
};

@Injectable()
export class TraxAdapter implements CourierAdapter {
  readonly type: CourierType = 'trax';
  private readonly logger = new Logger(TraxAdapter.name);

  async bookShipment(
    creds: TraxCredentials,
    input: BookShipmentInput,
  ): Promise<BookShipmentResult> {
    const phone = normalizePakPhone(input.destination.phone);
    // Trax (Sonic) /shipment/book takes a JSON body with the RAW Authorization
    // token. Field sources:
    //   amount          = order's outstanding balance (prepaid → 0)
    //   payment_mode_id = 4 (Prepaid, Appendix D) when nothing is collectable,
    //                     else 1 (COD)
    //   item_price      = order's total price (declared goods value, min 1)
    //   item_quantity   = total units across the order's line items
    //   consignee_email = order email, or a safe default when the order has none
    // The tenant-configured settings supply pickup_address_id, product type,
    // insurance flag and special instructions.
    const cod = Math.max(0, Math.round(input.codAmount));
    const itemPrice = Math.max(
      1,
      Math.round(input.totalPrice != null ? input.totalPrice : cod),
    );
    // Trax REJECTS a booking with amount:0 ("Parcel value is required when
    // collection amount is zero, and should be greater than 0" — verified live).
    // So for a prepaid order (nothing to collect) we send the declared value as
    // `amount` together with payment_mode Prepaid (4): Trax records the value but
    // the rider collects nothing. COD orders send the collectable with mode 1.
    const prepaid = cod === 0;
    const amountField = prepaid ? itemPrice : cod;
    const itemQuantity = Math.max(
      1,
      Math.round(input.totalQuantity != null ? input.totalQuantity : input.pieces),
    );
    const productTypeId =
      Number(creds.itemProductTypeId) > 0 ? Number(creds.itemProductTypeId) : 15;
    const insurance =
      creds.itemInsurance === '1' || creds.itemInsurance === 'true' ? 1 : 0;
    const email =
      input.email && input.email.includes('@') ? input.email : 'nomail@gmail.com';
    const specialInstructions =
      (creds.specialInstructions && creds.specialInstructions.trim()) ||
      'Please call before delivery';
    // Prepaid (nothing to collect) → Appendix D Prepaid = 4; otherwise COD = 1.
    const paymentModeId = prepaid ? 4 : 1;
    // Pickup date in Pakistan local time (UTC+5) so a near-midnight UTC run
    // doesn't book a day early.
    const pickupDate = new Date(Date.now() + 5 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    // Normal delivery = service_type_id 1. A replacement (re-send booked from a
    // ticket) books under the tenant's configured replacement service type when
    // set — so Trax records it as a replacement, not a first delivery. Unset →
    // fall back to normal (never guess a service id).
    const replacementServiceTypeId = Number(creds.replacementServiceTypeId);
    const serviceTypeId =
      input.isReplacement && replacementServiceTypeId > 0
        ? replacementServiceTypeId
        : 1;
    const body = {
      service_type_id: serviceTypeId,
      pickup_address_id: Number(creds.pickupAddressId) || creds.pickupAddressId,
      information_display: 1,
      consignee_city_id:
        Number(input.destination.cityCode) || input.destination.cityCode,
      consignee_name: input.destination.name,
      consignee_address: [input.destination.address1, input.destination.address2]
        .filter(Boolean)
        .join(', '),
      consignee_phone_number_1: phone,
      consignee_email_address: email,
      order_id: input.shopifyOrderName,
      item_product_type_id: productTypeId,
      // Trax (SONIC API) documents a 190-character limit on item_description;
      // enforce it here (PostEx/Leopards/Rocket document no limit, so their
      // adapters send the full description).
      item_description: (input.itemsDescription || 'Order').slice(0, 190),
      item_quantity: itemQuantity,
      item_insurance: insurance,
      item_price: itemPrice,
      pickup_date: pickupDate,
      special_instructions: specialInstructions,
      estimated_weight: 0.25,
      shipping_mode_id: 1,
      amount: amountField,
      payment_mode_id: paymentModeId,
      charges_mode_id: 4,
    };

    const res = await httpFetch(`${BASE_URL}/shipment/book`, {
      method: 'POST',
      headers: {
        Authorization: creds.bearerToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Trax booking failed (${res.status}): ${JSON.stringify(raw)}`);
    }
    const trackingNumber = extractTraxTracking(raw);
    if (!trackingNumber) {
      throw new Error(`Trax booking response missing tracking number: ${JSON.stringify(raw)}`);
    }
    return { trackingNumber: String(trackingNumber), raw };
  }

  async generateLoadsheet(
    creds: TraxCredentials,
    trackingNumbers: string[],
  ): Promise<GenerateLoadsheetResult> {
    const res = await httpFetch(`${BASE_URL}/receiving_sheet/create`, {
      method: 'POST',
      headers: {
        Authorization: creds.bearerToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tracking_numbers: trackingNumbers }),
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Trax loadsheet create failed (${res.status}): ${JSON.stringify(raw)}`);
    }
    const loadsheetId = (raw as any)?.receiving_sheet_id;
    if (!loadsheetId) {
      throw new Error(`Trax loadsheet response missing receiving_sheet_id: ${JSON.stringify(raw)}`);
    }
    // Fetch the manifest PDF (receiving_sheet/view, type=1 → PDF). Best-effort:
    // if the URL/bytes aren't ready yet the batch still records the id and the
    // agent can re-open it from the courier portal.
    const pdfBuffer = await this.fetchLoadsheetPdf(creds, String(loadsheetId)).catch(() => undefined);
    return { loadsheetId: String(loadsheetId), pdfBuffer, raw };
  }

  /** List the tenant's registered pickup addresses (Sonic GET /pickup_addresses)
   *  so Settings can render a dropdown instead of asking for a raw numeric id.
   *  Returns [{id,label}] — label = "contact — address, city". */
  async getPickupAddresses(
    creds: TraxCredentials,
  ): Promise<Array<{ id: string; label: string }>> {
    const res = await httpFetch(`${BASE_URL}/pickup_addresses`, {
      method: 'GET',
      headers: { Authorization: creds.bearerToken, Accept: 'application/json' },
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        `Trax pickup addresses failed (${res.status}): ${JSON.stringify(raw)}`,
      );
    }
    const list = (raw as any)?.pickup_addresses;
    if (!Array.isArray(list)) return [];
    return list
      .filter((a: any) => a && a.id != null)
      .map((a: any) => {
        const city = a?.city?.name ? `, ${a.city.name}` : '';
        const who = a?.person_of_contact ? `${a.person_of_contact} — ` : '';
        const label = `${who}${a?.address ?? ''}${city}`.trim() || `#${a.id}`;
        return { id: String(a.id), label };
      });
  }

  /** Trax receiving_sheet/view returns either a PDF URL or the PDF bytes; we
   *  normalize to bytes so LoadsheetService can persist it like the others. */
  private async fetchLoadsheetPdf(
    creds: TraxCredentials,
    receivingSheetId: string,
  ): Promise<Buffer | undefined> {
    // receiving_sheet/view is a GET with query params (POST → 405). `type=1`
    // selects the PDF (omitting it returns a JPEG image of the sheet). Verified
    // live against sonic.pk — returns application/pdf bytes directly.
    const res = await httpFetch(
      `${BASE_URL}/receiving_sheet/view?receiving_sheet_id=${encodeURIComponent(
        receivingSheetId,
      )}&type=1`,
      { method: 'GET', headers: { Authorization: creds.bearerToken } },
    );
    const ctype = res.headers.get('content-type') || '';
    if (res.ok && /pdf|octet-stream/i.test(ctype)) {
      return Buffer.from(await res.arrayBuffer());
    }
    return undefined;
  }

  /** Air-waybill (shipping labels). Like receiving_sheet/view this is a GET with
   *  query params (POST → 405). `type=1` selects the PDF (omit → JPEG image).
   *  The bulk `tracking_numbers[]` form returns ONE combined PDF that Sonic has
   *  ALREADY laid out ~2 labels per A4 page — but it's hard-capped at 5 tracking
   *  numbers per request ("may not have more than 5 items"). So we chunk the
   *  request at 5 and stitch the chunk PDFs together as-is (they're already
   *  print-ready; re-composing 2-up would shrink each label). Verified live
   *  against sonic.pk. */
  async getLabels(
    creds: TraxCredentials,
    trackingNumbers: string[],
  ): Promise<CourierLabelResult> {
    const MAX_PER_REQUEST = 5; // sonic air_waybill tracking_numbers[] hard cap
    const chunkPdfs: Buffer[] = [];
    for (let i = 0; i < trackingNumbers.length; i += MAX_PER_REQUEST) {
      const group = trackingNumbers.slice(i, i + MAX_PER_REQUEST);
      const qs = group
        .map((t) => `tracking_numbers[]=${encodeURIComponent(t)}`)
        .join('&');
      const res = await httpFetch(`${BASE_URL}/shipment/air_waybill?${qs}&type=1`, {
        method: 'GET',
        headers: { Authorization: creds.bearerToken, Accept: 'application/pdf' },
      }).catch(() => null);
      const ctype = res?.headers.get('content-type') || '';
      if (res && res.ok && /pdf|octet-stream/i.test(ctype)) {
        chunkPdfs.push(Buffer.from(await res.arrayBuffer()));
      }
    }
    if (!chunkPdfs.length) return { parts: [], raw: null };
    const pdfBuffer =
      chunkPdfs.length === 1 ? chunkPdfs[0] : await mergePdfsAsIs(chunkPdfs);
    return { pdfBuffer, raw: null };
  }

  async cancelShipment(
    creds: TraxCredentials,
    trackingNumber: string,
  ): Promise<{ ok: boolean; raw: unknown }> {
    const res = await httpFetch(`${BASE_URL}/shipment/cancel`, {
      method: 'POST',
      headers: {
        Authorization: creds.bearerToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tracking_number: trackingNumber }),
    });
    const raw = await res.json().catch(() => ({}));
    // Trax uses status:0 to mean success ("Shipment #... is Cancelled").
    const ok = res.ok && (raw as any)?.status !== 1 && !(raw as any)?.error;
    return { ok, raw };
  }

  async sendShipperAdvice(
    creds: TraxCredentials,
    trackingNumber: string,
    action: ShipperAdviceAction,
    remarks: string,
  ): Promise<{ ok: boolean; raw: unknown }> {
    // Trax Appendix J type: 1 = Return Confirm, 2 = Re-Attempt Request.
    const type = action === 'return' ? 1 : 2;
    // The request/rcp endpoint auths on the RAW token (like tracking, NOT
    // `Bearer <token>` — that returns "Invalid API Token (Authorization).") and
    // validates tracking_number as an Integer, so send the numeric value (all
    // Trax CNs are numeric) rather than a string.
    const tnNumeric = /^\d+$/.test(trackingNumber) ? Number(trackingNumber) : trackingNumber;
    const res = await httpFetch(`${BASE_URL}/request/rcp`, {
      method: 'POST',
      headers: {
        Authorization: creds.bearerToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tracking_number: tnNumeric, type, remarks: remarks || 'Remarks' }),
    });
    const raw = await res.json().catch(() => ({}));
    const ok = res.ok && (raw as any)?.status !== 1;
    return { ok, raw };
  }

  mapStatus(rawStatus: string): ShipmentStatus {
    const key = rawStatus.trim().toLowerCase();
    // Only a COMPLETED hand-back ("Return - Delivered to Shipper") is a true
    // return. Every other "Return - ..." status (Confirm / In Transit /
    // Dispatched / Arrived at Origin) is the parcel on its way back after a
    // failed delivery → 'failed' (the Failed tab). 'failed' is re-polled so it
    // still auto-promotes to 'returned' when it physically arrives.
    if (isReturnedToShipper(rawStatus)) return 'returned';
    if (key.startsWith('return')) return 'failed';
    // The WEBHOOK sends every status prefixed "Shipment - X" (e.g. "Shipment -
    // Out for Delivery"); the pull API returns them BARE ("Out for Delivery").
    // The map is keyed on the bare status, so strip a leading "Shipment - " —
    // without this, every non-delivered webhook status threw Unmapped and the
    // parcel froze at its last pulled status (e.g. stuck at in_transit while the
    // webhook already said Out for Delivery).
    const bare = key.replace(/^shipment\s*-\s*/, '');
    const mapped = STATUS_MAP[bare];
    if (!mapped) throw new UnmappedCourierStatusError('trax', rawStatus);
    return mapped;
  }

  /**
   * Pull the current status from Trax (Sonic). The tracking endpoint takes the
   * token as a RAW `Authorization` header (NOT `Bearer <token>` — that returns
   * "Invalid API Token") and requires `type=1`. `tracking_history` is returned
   * oldest-first-ish; we sort by `timestamp` and take the newest event.
   */
  async queryTracking(
    creds: TraxCredentials,
    trackingNumber: string,
  ): Promise<{ rawStatus: string; happenedAt?: Date; reason?: string } | null> {
    try {
      const res = await httpFetch(
        `${BASE_URL}/shipment/track?tracking_number=${encodeURIComponent(trackingNumber)}&type=1`,
        { headers: { Authorization: creds.bearerToken, Accept: 'application/json' } },
      );
      const j = (await res.json().catch(() => null)) as any;
      const hist = j?.details?.tracking_history;
      if (!Array.isArray(hist) || !hist.length) return null;
      const newest = [...hist].sort(
        (a, b) => (Number(b?.timestamp) || 0) - (Number(a?.timestamp) || 0),
      )[0];
      if (!newest?.status) return null;
      const reason = newest.status_reason || newest.reason;
      return {
        rawStatus: String(newest.status),
        happenedAt: newest.timestamp
          ? new Date(Number(newest.timestamp) * 1000)
          : undefined,
        reason: reason ? String(reason) : undefined,
      };
    } catch {
      return null;
    }
  }

  isAddressIssueReason(rawReason: string): boolean {
    return /wrong address|address.*(not found|invalid)|no such (building|address|plot)/i.test(
      rawReason,
    );
  }

  /** Full checkpoint history (oldest → newest) for the in-app tracking view. */
  async queryTrackingHistory(
    creds: TraxCredentials,
    trackingNumber: string,
  ): Promise<TrackingCheckpoint[]> {
    try {
      const res = await httpFetch(
        `${BASE_URL}/shipment/track?tracking_number=${encodeURIComponent(trackingNumber)}&type=1`,
        { headers: { Authorization: creds.bearerToken, Accept: 'application/json' } },
      );
      const j = (await res.json().catch(() => null)) as any;
      const hist = j?.details?.tracking_history;
      if (!Array.isArray(hist)) return [];
      return [...hist]
        .sort((a, b) => (Number(a?.timestamp) || 0) - (Number(b?.timestamp) || 0))
        .map((h: any): TrackingCheckpoint | null => {
          const status = String(h?.status ?? '').trim();
          if (!status) return null;
          const detail = [h?.status_reason, h?.reason, h?.location, h?.city]
            .map((v) => (v == null ? '' : String(v).trim()))
            .find((v) => v.length > 0);
          const at = h?.timestamp ? new Date(Number(h.timestamp) * 1000) : null;
          return {
            status,
            detail: detail || undefined,
            at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : undefined,
          };
        })
        .filter((x: TrackingCheckpoint | null): x is TrackingCheckpoint => x !== null);
    } catch {
      return [];
    }
  }
}

/** Pull the tracking (CN) number out of Trax's /shipment/book response. Sonic's
 *  success shape isn't fixed across accounts, so scan the common keys plus one
 *  level of nesting (data/information/shipment/dist). */
function extractTraxTracking(raw: unknown): string | null {
  const keyOf = (o: any): string | null => {
    if (!o || typeof o !== 'object') return null;
    const v =
      o.tracking_number ??
      o.trackingNumber ??
      o.cn_number ??
      o.cnNumber ??
      o.cn ??
      o.tracking_no ??
      o.consignment_number ??
      o.awb ??
      o.awb_number;
    return v != null && String(v).trim() ? String(v).trim() : null;
  };
  const r = raw as any;
  return (
    keyOf(r) ??
    keyOf(r?.data) ??
    keyOf(r?.information) ??
    keyOf(r?.shipment) ??
    keyOf(r?.dist) ??
    keyOf(r?.result) ??
    null
  );
}

function normalizePakPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '').replace(/^92/, '0');
  const local = digits.startsWith('0') ? digits : `0${digits}`;
  return local.length === 11 ? `${local.slice(0, 4)}-${local.slice(4)}` : local;
}
