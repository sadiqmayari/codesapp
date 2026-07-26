import { Injectable, Logger } from '@nestjs/common';
import { CourierType, ShipmentStatus } from '@prisma/client';
import {
  BookShipmentInput,
  BookShipmentResult,
  CourierAdapter,
  GenerateLoadsheetResult,
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

  async generateLoadsheet(
    creds: PostexCredentials,
    trackingNumbers: string[],
  ): Promise<GenerateLoadsheetResult> {
    const res = await fetch(`${BASE_URL}/v2/generate-load-sheet`, {
      method: 'POST',
      headers: { token: creds.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackingNumbers }),
    });
    const raw = await res.json().catch(() => ({}));
    const loadsheetId = (raw as any)?.dist?.loadSheetId;
    if (!res.ok || !loadsheetId) {
      throw new Error(`PostEx loadsheet generation failed: ${JSON.stringify(raw)}`);
    }
    return { loadsheetId: String(loadsheetId), raw };
  }

  async queryTracking(
    creds: PostexCredentials,
    trackingNumber: string,
  ): Promise<{ rawStatus: string } | null> {
    const res = await fetch(
      `${BASE_URL}/v1/track-order/${encodeURIComponent(trackingNumber)}`,
      { headers: { token: creds.token } },
    );
    if (!res.ok) return null;
    const raw = await res.json().catch(() => null);
    const status = (raw as any)?.dist?.transactionStatusMessage;
    return status ? { rawStatus: String(status) } : null;
  }

  mapStatus(rawStatus: string): ShipmentStatus {
    const key = rawStatus.trim().toLowerCase();
    if (key.startsWith('en-route to')) return 'in_transit';
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
}
