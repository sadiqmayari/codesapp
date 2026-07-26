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

export interface TraxCredentials {
  bearerToken: string;
  pickupAddressId: string;
}

const BASE_URL = 'https://sonic.pk/api';

/** Trax (Sonic) status vocabulary, exactly as observed in the tenant's n8n
 *  "Sois | Trax Tracking" webhook Switch node. */
const STATUS_MAP: Record<string, ShipmentStatus> = {
  'shipment - delivered': 'delivered',
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
  'multiple pieces hold': 'in_transit',
  'dispatched from warehouse': 'in_transit',
  'out for delivery': 'out_for_delivery',
  'rider picked': 'picked_up',
  'received from shipper': 'picked_up',
  booked: 'ready_for_pickup',
  'delivery unsuccessful': 'attempted',
  'on hold': 'attempted',
  'reason validation required': 'attempted',
  're-attempt': 'attempted',
  'on hold for self collection': 'attempted',
  're-attempt requested': 'attempted',
  're-attempt call requested': 'attempted',
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
    const body = {
      consignee_name: input.destination.name,
      consignee_phone: phone,
      consignee_address: [input.destination.address1, input.destination.address2]
        .filter(Boolean)
        .join(', '),
      consignee_city_id: input.destination.cityCode,
      order_ref_number: input.shopifyOrderName,
      item_quantity: input.pieces,
      amount: Math.max(1, Math.round(input.codAmount)),
      pickup_address_id: creds.pickupAddressId,
      order_details: input.itemsDescription,
    };

    const res = await fetch(`${BASE_URL}/shipment/book`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.bearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Trax booking failed (${res.status}): ${JSON.stringify(raw)}`);
    }
    const trackingNumber =
      (raw as any)?.tracking_number ?? (raw as any)?.cn_number ?? (raw as any)?.data?.tracking_number;
    if (!trackingNumber) {
      throw new Error(`Trax booking response missing tracking number: ${JSON.stringify(raw)}`);
    }
    return { trackingNumber: String(trackingNumber), raw };
  }

  async generateLoadsheet(
    creds: TraxCredentials,
    trackingNumbers: string[],
  ): Promise<GenerateLoadsheetResult> {
    const res = await fetch(`${BASE_URL}/receiving_sheet/create`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.bearerToken}`,
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

  /** Trax receiving_sheet/view returns either a PDF URL or the PDF bytes; we
   *  normalize to bytes so LoadsheetService can persist it like the others. */
  private async fetchLoadsheetPdf(
    creds: TraxCredentials,
    receivingSheetId: string,
  ): Promise<Buffer | undefined> {
    const res = await fetch(`${BASE_URL}/receiving_sheet/view`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.bearerToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/pdf',
      },
      body: JSON.stringify({ receiving_sheet_id: receivingSheetId, type: '1' }),
    });
    const ctype = res.headers.get('content-type') || '';
    if (res.ok && /pdf|octet-stream/i.test(ctype)) {
      return Buffer.from(await res.arrayBuffer());
    }
    // JSON envelope carrying a URL to the PDF → fetch that.
    const j = (await res.json().catch(() => ({}))) as any;
    const url = j?.pdf_url ?? j?.url;
    if (!url) return undefined;
    const pdf = await fetch(String(url));
    return pdf.ok ? Buffer.from(await pdf.arrayBuffer()) : undefined;
  }

  /** Air-waybill (shipping label) — one PDF per tracking number. */
  async getLabels(
    creds: TraxCredentials,
    trackingNumbers: string[],
  ): Promise<CourierLabelResult> {
    const parts: Array<{ trackingNumber: string; pdfBuffer?: Buffer }> = [];
    for (const tn of trackingNumbers) {
      const res = await fetch(`${BASE_URL}/shipment/air_waybill`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.bearerToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/pdf',
        },
        body: JSON.stringify({ tracking_number: tn, type: 1 }),
      }).catch(() => null);
      if (res && res.ok) {
        parts.push({ trackingNumber: tn, pdfBuffer: Buffer.from(await res.arrayBuffer()) });
      }
    }
    return { parts, raw: null };
  }

  async cancelShipment(
    creds: TraxCredentials,
    trackingNumber: string,
  ): Promise<{ ok: boolean; raw: unknown }> {
    const res = await fetch(`${BASE_URL}/shipment/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.bearerToken}`,
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
    const res = await fetch(`${BASE_URL}/request/rcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.bearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tracking_number: trackingNumber, type, remarks: remarks || 'Remarks' }),
    });
    const raw = await res.json().catch(() => ({}));
    const ok = res.ok && (raw as any)?.status !== 1;
    return { ok, raw };
  }

  mapStatus(rawStatus: string): ShipmentStatus {
    const key = rawStatus.trim().toLowerCase();
    // Trax's "Return ..." statuses (return to shipper / RTO) → a real return,
    // which drives the RTO automation (blacklist + cancel + archive).
    if (key.startsWith('return')) return 'returned';
    const mapped = STATUS_MAP[key];
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
      const res = await fetch(
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
}

function normalizePakPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '').replace(/^92/, '0');
  const local = digits.startsWith('0') ? digits : `0${digits}`;
  return local.length === 11 ? `${local.slice(0, 4)}-${local.slice(4)}` : local;
}
