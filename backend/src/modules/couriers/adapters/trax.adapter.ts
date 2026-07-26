import { Injectable, Logger } from '@nestjs/common';
import { CourierType, ShipmentStatus } from '@prisma/client';
import {
  BookShipmentInput,
  BookShipmentResult,
  CourierAdapter,
  GenerateLoadsheetResult,
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
    return { loadsheetId: String(loadsheetId), raw };
  }

  /** Trax's manifest PDF isn't ready immediately — caller re-enqueues this
   *  after a delay instead of blocking a job-queue slot on a fixed wait. */
  async fetchLoadsheetPdf(
    creds: TraxCredentials,
    receivingSheetId: string,
  ): Promise<{ pdfUrl?: string; raw: unknown }> {
    const res = await fetch(`${BASE_URL}/receiving_sheet/view`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.bearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ receiving_sheet_id: receivingSheetId, type: '1' }),
    });
    const raw = await res.json().catch(() => ({}));
    return { pdfUrl: (raw as any)?.pdf_url ?? (raw as any)?.url, raw };
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
  ): Promise<{ rawStatus: string; happenedAt?: Date } | null> {
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
      return {
        rawStatus: String(newest.status),
        happenedAt: newest.timestamp
          ? new Date(Number(newest.timestamp) * 1000)
          : undefined,
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
