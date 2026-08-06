import { Injectable, Logger } from '@nestjs/common';
import { CourierType, ShipmentStatus } from '@prisma/client';
import {
  BookShipmentInput,
  BookShipmentResult,
  CourierAdapter,
  CourierLabelResult,
  GenerateLoadsheetResult,
  ShipperAdviceAction,
  UnmappedCourierStatusError,
} from './courier-adapter.interface';

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
  'picked by postex': 'picked_up',
  booked: 'ready_for_pickup',
  attempted: 'attempted',
  'delivery under review': 'attempted',
  // Return-to-shipper (RTO) → drives the return automation. PostEx's exact
  // returned label may vary; the mapStatus prefix check below also catches it.
  returned: 'returned',
  'returned to shipper': 'returned',
  'return to shipper': 'returned',
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
      items: input.pieces,
      orderRefNumber: input.shopifyOrderName,
      orderType: 'Normal',
      pickupAddressCode: creds.pickupAddressCode,
      orderDetail: input.itemsDescription,
    };

    const res = await fetch(`${BASE_URL}/v3/create-order`, {
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
    const res = await fetch(`${BASE_URL}/v2/generate-load-sheet`, {
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
    const res = await fetch(`${BASE_URL}/v1/get-invoice?trackingNumbers=${tns}`, {
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
    const res = await fetch(`${BASE_URL}/v1/cancel-order`, {
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
    const res = await fetch(`${BASE_URL}/v2/save-shipper-advice/`, {
      method: 'PUT',
      headers: { token: creds.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackingNumber, statusId, remarks: remarks || '' }),
    });
    const raw = await res.json().catch(() => ({}));
    return { ok: res.ok, raw };
  }

  mapStatus(rawStatus: string): ShipmentStatus {
    const key = rawStatus.trim().toLowerCase();
    // n8n matches "En-Route to" with CONTAINS; real payloads look like
    // "En-Route to {14} warehouse" — use includes so any en-route hop counts.
    if (key.includes('en-route')) return 'in_transit';
    if (key.startsWith('return')) return 'returned';
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
      const res = await fetch(
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
}

/** Pull the human reason out of PostEx's "Attempt Made: <reason>" status text. */
function extractPostexReason(msg: string): string | undefined {
  const m = /attempt made\s*:\s*(.+)/i.exec(msg);
  return m ? m[1].trim() : undefined;
}
