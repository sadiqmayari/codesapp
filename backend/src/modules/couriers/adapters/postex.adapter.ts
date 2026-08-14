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

export interface PostexCredentials {
  token: string;
  pickupAddressCode: string;
}

const BASE_URL = 'https://api.postex.pk/services/integration/api/order';

/** PostEx status vocabulary, exactly as observed in the tenant's n8n
 *  "Sois | PostEx Tracking" webhook Switch node. Anything unlisted throws
 *  (the n8n Switch's fallback silently mapped everything else to FAILURE —
 *  we surface it as "needs attention" instead). */
const STATUS_MAP: Record<string, ShipmentStatus> = {
  delivered: 'delivered',
  'postex warehouse': 'in_transit',
  // Hub status: parcel is at the delivery center waiting to go out — IN TRANSIT,
  // not delivered (the word "Delivery" made the pull-sync heuristic mis-map it).
  'waiting for delivery': 'in_transit',
  'out for delivery': 'out_for_delivery',
  // A picked parcel is treated as in-transit (picked_up retired from the tab /
  // Shopify model).
  'picked by postex': 'in_transit',
  booked: 'ready_for_pickup',
  attempted: 'attempted',
  'delivery under review': 'attempted',
  // Only a COMPLETED hand-back is a true return. "Returned at Merchant
  // Warehouse" / "Returned to Shipper" (past-tense) = the merchant has it back.
  // "Return to Shipper" / "Return to {city}" / "Return Process Initiated" /
  // "Waiting for Return" are the parcel still moving back = a failed delivery
  // in motion → handled as 'attempted' by mapStatus (kept out of the map so the
  // prefix branch there classifies them).
  returned: 'returned',
  'returned to shipper': 'returned',
  'returned at merchant warehouse': 'returned',
};

@Injectable()
export class PostexAdapter implements CourierAdapter {
  readonly type: CourierType = 'postex';
  private readonly logger = new Logger(PostexAdapter.name);

  async bookShipment(
    creds: PostexCredentials,
    input: BookShipmentInput,
  ): Promise<BookShipmentResult> {
    const body = {
      // PostEx genuinely takes a city NAME, not a numeric code — its city
      // table has a single City column. `cityCode` therefore carries
      // PostEx's canonical spelling of the city (resolved through
      // CityMappingService so an unserved city is rejected before booking).
      cityName: input.destination.cityCode,
      customerName: input.destination.name,
      customerPhone: input.destination.phone.replace(/\D/g, ''),
      deliveryAddress: [input.destination.address1, input.destination.address2]
        .filter(Boolean)
        .join(', '),
      invoiceDivision: 1,
      invoicePayment: Math.max(0, Math.round(input.codAmount)),
      // items = total units across the order's line items (falls back to pieces).
      items: Math.max(
        1,
        Math.round(input.totalQuantity != null ? input.totalQuantity : input.pieces),
      ),
      orderRefNumber: input.shopifyOrderName,
      orderType: 'Normal',
      pickupAddressCode: creds.pickupAddressCode,
      orderDetail: input.itemsDescription,
    };

    const res = await httpFetch(`${BASE_URL}/v3/create-order`, {
      method: 'POST',
      headers: { token: creds.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const raw = await res.json().catch(() => ({}));
    const trackingNumber = (raw as any)?.dist?.trackingNumber;
    if (!res.ok || !trackingNumber) {
      throw new Error(`PostEx booking failed: ${JSON.stringify(raw)}`);
    }
    return { trackingNumber: String(trackingNumber), raw };
  }

  /**
   * PostEx's generate-load-sheet returns the manifest **as a PDF** (not JSON).
   * Read the raw bytes; only fall back to parsing JSON when the response isn't
   * a PDF (that's an error envelope).
   */
  async generateLoadsheet(
    creds: PostexCredentials,
    trackingNumbers: string[],
  ): Promise<GenerateLoadsheetResult> {
    const res = await httpFetch(`${BASE_URL}/v2/generate-load-sheet`, {
      method: 'POST',
      headers: { token: creds.token, 'Content-Type': 'application/json', Accept: 'application/pdf' },
      body: JSON.stringify({ trackingNumbers }),
    });
    const ctype = res.headers.get('content-type') || '';
    if (res.ok && /pdf|octet-stream/i.test(ctype)) {
      const pdfBuffer = Buffer.from(await res.arrayBuffer());
      return { loadsheetId: `postex-${Date.now()}`, pdfBuffer, raw: null };
    }
    // Not a PDF → an error/JSON envelope. Some PostEx tenants still answer JSON
    // with a loadSheetId; surface either the id or a clear error.
    const raw = await res.json().catch(() => ({}));
    const loadsheetId = (raw as any)?.dist?.loadSheetId;
    if (res.ok && loadsheetId) return { loadsheetId: String(loadsheetId), raw };
    throw new Error(`PostEx loadsheet generation failed: ${JSON.stringify(raw)}`);
  }

  /** Airway-bill PDF for up to 10 tracking numbers per call (PostEx cap). The
   *  caller passes a single courier's parcels; we chunk by 10 and return the
   *  first chunk's PDF plus (if >10) note the rest via items is unnecessary —
   *  the ops service chunks upstream so each call here is ≤10. */
  async getLabels(
    creds: PostexCredentials,
    trackingNumbers: string[],
  ): Promise<CourierLabelResult> {
    const tns = trackingNumbers.slice(0, 10).map((t) => encodeURIComponent(t)).join(',');
    const res = await httpFetch(`${BASE_URL}/v1/get-invoice?trackingNumbers=${tns}`, {
      headers: { token: creds.token, Accept: 'application/pdf' },
    });
    if (!res.ok) throw new Error(`PostEx label fetch failed (${res.status}).`);
    const pdfBuffer = Buffer.from(await res.arrayBuffer());
    return { pdfBuffer, raw: null };
  }

  async cancelShipment(
    creds: PostexCredentials,
    trackingNumber: string,
  ): Promise<{ ok: boolean; raw: unknown }> {
    const res = await httpFetch(`${BASE_URL}/v1/cancel-order`, {
      method: 'PUT',
      headers: { token: creds.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackingNumber }),
    });
    const raw = await res.json().catch(() => ({}));
    return { ok: res.ok, raw };
  }

  async sendShipperAdvice(
    creds: PostexCredentials,
    trackingNumber: string,
    action: ShipperAdviceAction,
    remarks: string,
  ): Promise<{ ok: boolean; raw: unknown }> {
    // PostEx statusId: 1 = Mark Return Requested, 2 = Mark Retry Attempt.
    const statusId = action === 'return' ? 1 : 2;
    const res = await httpFetch(`${BASE_URL}/v2/save-shipper-advice/`, {
      method: 'PUT',
      headers: { token: creds.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackingNumber, statusId, remarks: remarks || '' }),
    });
    const raw = await res.json().catch(() => ({}));
    return { ok: res.ok, raw };
  }

  mapStatus(rawStatus: string): ShipmentStatus {
    const key = rawStatus.trim().toLowerCase();
    // Completed hand-back → returned (checked first so "Returned at Merchant
    // Warehouse" can't be caught by the en-route/merchant rules below).
    if (isReturnedToShipper(rawStatus)) return 'returned';
    // A parcel EN ROUTE TO the MERCHANT's warehouse is a RETURN leg (a forward
    // parcel travels to the customer, never back to the merchant) → failed
    // delivery on its way back = 'failed' (the Failed tab; re-polled so it still
    // promotes to 'returned' on arrival). Must beat the generic en-route and the
    // "warehouse" wording below. PostEx writes this both hyphenated and spaced.
    if (/en[\s-]?route to\s+(the\s+)?merchant/.test(key)) return 'failed';
    // Any other "return ..." leg is likewise a return in motion → 'failed'.
    if (key.startsWith('return')) return 'failed';
    // "At {Merchant} Warehouse" (present tense, NOT "Returned at …") = the parcel
    // is sitting at the merchant's origin warehouse awaiting PostEx pickup →
    // ready_for_pickup (Booked tab). Excludes PostEx's own hub wording, which is
    // "PostEx WareHouse" / "Transit Hub" (handled by STATUS_MAP / normalize).
    if (/^at\s+.+\swarehouse$/.test(key) && !key.includes('postex') && !key.includes('transit'))
      return 'ready_for_pickup';
    // n8n matches "En-Route to" with CONTAINS; real payloads look like
    // "En-Route to {14} warehouse" — use includes so any en-route hop counts.
    // Tolerate the spaced form too ("En Route to …").
    if (key.includes('en-route') || key.includes('en route')) return 'in_transit';
    const mapped = STATUS_MAP[key];
    if (!mapped) throw new UnmappedCourierStatusError('postex', rawStatus);
    return mapped;
  }

  isAddressIssueReason(rawReason: string): boolean {
    return /wrong address|address.*(not found|invalid)|consignee not available|no such (building|address|plot)/i.test(
      rawReason,
    );
  }

  /**
   * Pull the current status from PostEx. Auth is the raw `token` header (not
   * Bearer). `dist.transactionStatusHistory` is chronological — the LAST item
   * is the latest. Status text lives in `transactionStatusMessage`.
   */
  async queryTracking(
    creds: PostexCredentials,
    trackingNumber: string,
  ): Promise<{ rawStatus: string; happenedAt?: Date; reason?: string } | null> {
    try {
      const res = await httpFetch(
        `${BASE_URL}/v1/track-order/${encodeURIComponent(trackingNumber)}`,
        { headers: { token: creds.token, Accept: 'application/json' } },
      );
      const j = (await res.json().catch(() => null)) as any;
      const hist = j?.dist?.transactionStatusHistory;
      if (!Array.isArray(hist) || !hist.length) return null;
      const last = hist[hist.length - 1];
      const msg = last?.transactionStatusMessage;
      if (!msg) return null;
      const when = last?.modifiedDatetime || last?.transactionDate;
      return {
        rawStatus: String(msg),
        happenedAt: when ? new Date(when) : undefined,
        // PostEx encodes the attempt reason inline: "Attempt Made: <reason>".
        reason: extractPostexReason(String(msg)),
      };
    } catch {
      return null;
    }
  }

  /** Full checkpoint history (oldest → newest) for the in-app tracking view.
   *  `dist.transactionStatusHistory` is chronological. */
  async queryTrackingHistory(
    creds: PostexCredentials,
    trackingNumber: string,
  ): Promise<TrackingCheckpoint[]> {
    try {
      const res = await httpFetch(
        `${BASE_URL}/v1/track-order/${encodeURIComponent(trackingNumber)}`,
        { headers: { token: creds.token, Accept: 'application/json' } },
      );
      const j = (await res.json().catch(() => null)) as any;
      const hist = j?.dist?.transactionStatusHistory;
      if (!Array.isArray(hist)) return [];
      return hist
        .map((h: any): TrackingCheckpoint | null => {
          const status = String(h?.transactionStatusMessage ?? '').trim();
          if (!status) return null;
          // History items date the checkpoint via `updatedAt` (the top-level
          // track uses modifiedDatetime/transactionDate — keep both as fallback).
          const rawAt = h?.updatedAt || h?.modifiedDatetime || h?.transactionDate;
          const at = rawAt ? new Date(String(rawAt)) : null;
          return {
            status,
            at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : undefined,
          };
        })
        .filter((x: TrackingCheckpoint | null): x is TrackingCheckpoint => x !== null);
    } catch {
      return [];
    }
  }
}

/** Pull the human reason out of PostEx's "Attempt Made: <reason>" status text. */
function extractPostexReason(msg: string): string | undefined {
  const m = /attempt made\s*:\s*(.+)/i.exec(msg);
  return m ? m[1].trim() : undefined;
}
