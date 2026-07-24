import { Injectable, Logger } from '@nestjs/common';
import { CourierType, ShipmentStatus } from '@prisma/client';
import {
  BookShipmentInput,
  BookShipmentResult,
  CourierAdapter,
  GenerateLoadsheetResult,
  UnmappedCourierStatusError,
} from './courier-adapter.interface';

export interface RocketCredentials {
  clientId: string;
  token: string;
  storeId: string;
}

const BASE_URL = 'https://client.rocketcourier.pk';

/**
 * Rocket had no dedicated tracking webhook in the audited n8n workflows (only
 * booking + loadsheet), so this vocabulary is a conservative placeholder —
 * calibrate against real Rocket webhook/API payloads before relying on it.
 * Anything unmapped throws rather than guessing, same as the other 3.
 */
const STATUS_MAP: Record<string, ShipmentStatus> = {
  delivered: 'delivered',
  booked: 'ready_for_pickup',
  'picked up': 'picked_up',
  'in transit': 'in_transit',
  'out for delivery': 'out_for_delivery',
  returned: 'failed',
  cancelled: 'cancelled',
};

@Injectable()
export class RocketAdapter implements CourierAdapter {
  readonly type: CourierType = 'rocket';
  private readonly logger = new Logger(RocketAdapter.name);

  async bookShipment(
    creds: RocketCredentials,
    input: BookShipmentInput,
  ): Promise<BookShipmentResult> {
    // Fixes the tenant's n8n bug: `city` was hardcoded to "1024" for every
    // order. This now always uses the resolved per-destination city code.
    const body = new URLSearchParams({
      clients: creds.clientId,
      token: creds.token,
      store: creds.storeId,
      city: input.destination.cityCode,
      consignee_name: input.destination.name,
      consignee_phone: input.destination.phone,
      consignee_address: [input.destination.address1, input.destination.address2]
        .filter(Boolean)
        .join(', '),
      order_id: input.shopifyOrderName,
      cod_amount: String(Math.max(0, Math.round(input.codAmount))),
      pieces: String(input.pieces),
      description: input.itemsDescription,
    });

    const res = await fetch(`${BASE_URL}/bookingapi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const raw = await res.json().catch(() => ({}));
    const trackingNumber = (raw as any)?.trackingnos ?? (raw as any)?.cn_no;
    if (!res.ok || !trackingNumber) {
      throw new Error(`Rocket booking failed: ${JSON.stringify(raw)}`);
    }
    return { trackingNumber: String(trackingNumber), raw };
  }

  async generateLoadsheet(
    creds: RocketCredentials,
    trackingNumbers: string[],
  ): Promise<GenerateLoadsheetResult> {
    const res = await fetch(`${BASE_URL}/pdfapi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        clients: creds.clientId,
        token: creds.token,
        trackingnos: [...new Set(trackingNumbers)].join(','),
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`Rocket loadsheet generation failed (${res.status})`);
    }
    const pdfBuffer = Buffer.from(await res.arrayBuffer());
    return { loadsheetId: `rocket-${Date.now()}`, pdfBuffer, raw: null };
  }

  mapStatus(rawStatus: string): ShipmentStatus {
    const key = rawStatus.trim().toLowerCase();
    const mapped = STATUS_MAP[key];
    if (!mapped) throw new UnmappedCourierStatusError('rocket', rawStatus);
    return mapped;
  }

  isAddressIssueReason(rawReason: string): boolean {
    return /wrong address|address.*(not found|invalid)|no such (building|address|plot)/i.test(
      rawReason,
    );
  }
}
