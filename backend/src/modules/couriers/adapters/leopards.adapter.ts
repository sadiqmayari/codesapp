import { Injectable, Logger } from '@nestjs/common';
import { CourierType, ShipmentStatus } from '@prisma/client';
import {
  BookShipmentInput,
  BookShipmentResult,
  CourierAdapter,
  GenerateLoadsheetResult,
  UnmappedCourierStatusError,
} from './courier-adapter.interface';

export interface LeopardsCredentials {
  apiKey: string;
  apiPassword: string;
  courierName: string;
  courierCode: string;
  shipmentId: string;
}

const BASE_URL = 'https://merchantapi.leopardscourier.com/api';

/** Leopards status-code vocabulary, exactly as observed in the tenant's n8n
 *  "Sois | Leopards Tracking" webhook Switch nodes. */
const STATUS_MAP: Record<string, ShipmentStatus> = {
  DV: 'delivered',
  AC: 'out_for_delivery',
  DW: 'in_transit',
  AR: 'in_transit',
  DP: 'in_transit',
  PN1: 'attempted',
  PN2: 'attempted',
  RN1: 'attempted',
  RN2: 'attempted',
  NR: 'attempted',
  RC: 'ready_for_pickup',
  SP: 'picked_up',
  // Leopards return-family codes (return to origin / shipper / warehouse /
  // delivery returned) → a real return, which drives the RTO automation
  // (blacklist + cancel + archive). Was 'failed' before returns were handled.
  RO: 'returned',
  RS: 'returned',
  RW: 'returned',
  DR: 'returned',
};

@Injectable()
export class LeopardsAdapter implements CourierAdapter {
  readonly type: CourierType = 'leopards';
  private readonly logger = new Logger(LeopardsAdapter.name);

  async bookShipment(
    creds: LeopardsCredentials,
    input: BookShipmentInput,
  ): Promise<BookShipmentResult> {
    const body = {
      api_key: creds.apiKey,
      api_password: creds.apiPassword,
      booked_packet_weight: '1',
      booked_packet_no_piece: String(input.pieces),
      booked_packet_collect_amount: String(Math.max(1, Math.round(input.codAmount))),
      origin_city: creds.shipmentId,
      destination_city: input.destination.cityCode,
      shipment_name_eng: input.destination.name,
      shipment_email: '',
      shipment_phone: input.destination.phone,
      shipment_address: [input.destination.address1, input.destination.address2]
        .filter(Boolean)
        .join(', '),
      order_id: input.shopifyOrderName,
      order_type: 'Normal',
      special_instructions: input.itemsDescription,
    };

    const res = await fetch(`${BASE_URL}/bookPacket/format/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body as Record<string, string>).toString(),
    });
    const raw = await res.json().catch(() => ({}));
    const trackNumbers = (raw as any)?.packet_list?.[0]?.track_number;
    if (!res.ok || !trackNumbers) {
      throw new Error(`Leopards booking failed: ${JSON.stringify(raw)}`);
    }
    return { trackingNumber: String(trackNumbers), raw };
  }

  async generateLoadsheet(
    creds: LeopardsCredentials,
    trackingNumbers: string[],
  ): Promise<GenerateLoadsheetResult> {
    const res = await fetch(`${BASE_URL}/generateLoadSheet/format/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        api_key: creds.apiKey,
        api_password: creds.apiPassword,
        cn_numbers: trackingNumbers.join(','),
        courier_name: creds.courierName,
        courier_code: creds.courierCode,
      }).toString(),
    });
    const raw = await res.json().catch(() => ({}));
    const loadsheetId = (raw as any)?.load_sheet_id;
    if (!res.ok || !loadsheetId) {
      throw new Error(`Leopards loadsheet generation failed: ${JSON.stringify(raw)}`);
    }

    const dl = await fetch(`${BASE_URL}/downloadLoadSheet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        api_key: creds.apiKey,
        api_password: creds.apiPassword,
        load_sheet_id: String(loadsheetId),
        response_type: 'PDF',
      }).toString(),
    });
    const pdfBuffer = dl.ok ? Buffer.from(await dl.arrayBuffer()) : undefined;

    return { loadsheetId: String(loadsheetId), pdfBuffer, raw };
  }

  mapStatus(rawStatus: string): ShipmentStatus {
    const key = rawStatus.trim().toUpperCase();
    const mapped = STATUS_MAP[key];
    if (!mapped) throw new UnmappedCourierStatusError('leopards', rawStatus);
    return mapped;
  }

  isAddressIssueReason(rawReason: string): boolean {
    return /wrong address|address.*(not found|invalid)|no such (building|address|plot)|consignee not available/i.test(
      rawReason,
    );
  }
}
