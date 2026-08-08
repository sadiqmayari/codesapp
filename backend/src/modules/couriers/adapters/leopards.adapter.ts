import { Injectable, Logger } from '@nestjs/common';
import { CourierType, ShipmentStatus } from '@prisma/client';
import {
  BookShipmentInput,
  BookShipmentResult,
  CourierAdapter,
  GenerateLoadsheetResult,
  ShipperAdviceAction,
  TrackingCheckpoint,
  TrackingProbe,
  UnmappedCourierStatusError,
} from './courier-adapter.interface';
import { isReturnedToShipper } from './return-status.util';

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
  // Leopards return-family webhook codes (return to origin / shipper /
  // warehouse / delivery returned) are the parcel MOVING back, not yet
  // received → 'attempted' (non-terminal). Leopards confirms a COMPLETED
  // return only via the pull API's human text "Returned to shipper"
  // (mapLeopardsPullStatus → 'returned'); keeping these codes non-terminal is
  // what lets the pull keep running and catch that final hand-back.
  RO: 'attempted',
  RS: 'attempted',
  RW: 'attempted',
  DR: 'attempted',
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

  async cancelShipment(
    creds: LeopardsCredentials,
    trackingNumber: string,
  ): Promise<{ ok: boolean; raw: unknown }> {
    const res = await fetch(`${BASE_URL}/cancelBookedPackets/format/json/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        api_key: creds.apiKey,
        api_password: creds.apiPassword,
        cn_numbers: trackingNumber,
      }).toString(),
    });
    const raw = await res.json().catch(() => ({}));
    // Leopards: status "1" (or 1) = success, "0" with error = failure.
    const ok = res.ok && String((raw as any)?.status) === '1';
    return { ok, raw };
  }

  async sendShipperAdvice(
    creds: LeopardsCredentials,
    trackingNumber: string,
    action: ShipperAdviceAction,
    remarks: string,
  ): Promise<{ ok: boolean; raw: unknown }> {
    // Leopards updateShipperAdvice: shipper_advice_status 'RA' = return, 'RT' = retry.
    const res = await fetch(`${BASE_URL}/updateShipperAdvice/format/json/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: creds.apiKey,
        api_password: creds.apiPassword,
        data: [
          {
            cn_number: trackingNumber,
            shipper_advice_status: action === 'return' ? 'RA' : 'RT',
            shipper_remarks: remarks || '',
          },
        ],
      }),
    });
    const raw = await res.json().catch(() => ({}));
    const ok = res.ok && String((raw as any)?.status) === '1';
    return { ok, raw };
  }

  mapStatus(rawStatus: string): ShipmentStatus {
    const key = rawStatus.trim().toUpperCase();
    const mapped = STATUS_MAP[key];
    if (mapped) return mapped;
    // Leopards issues SEQUENTIAL delivery-attempt (PN1, PN2, PN3, PN4, …) and
    // return-attempt (RN1, RN2, RN3, …) codes. The static map (and the tenant's
    // n8n Switch) only enumerated PN1/PN2/RN1/RN2, so a 3rd+ attempt (PN3/PN4)
    // was unmapped → the parcel's status froze at its previous value. Any
    // PN<n>/RN<n> is a delivery attempt → 'attempted' (matches the map's intent).
    if (/^(PN|RN)\d+$/.test(key)) return 'attempted';
    throw new UnmappedCourierStatusError('leopards', rawStatus);
  }

  isAddressIssueReason(rawReason: string): boolean {
    return /wrong address|address.*(not found|invalid)|no such (building|address|plot)|consignee not available/i.test(
      rawReason,
    );
  }

  /**
   * Pull the current status from Leopards' merchant API (trackBookedPacket).
   * Leopards is otherwise webhook-only, so this is what lets the status-sync
   * BACK-FILL a Leopards parcel whose webhook was never received. The pull
   * vocabulary is human text ("Dispatched", "Delivered", "Returned"), NOT the
   * 2-letter webhook codes — so we resolve it here and hand the status-sync a
   * PRE-MAPPED status (probe.mapped), bypassing its generic heuristic.
   */
  async queryTrackingResult(
    creds: LeopardsCredentials,
    trackingNumber: string,
  ): Promise<TrackingProbe> {
    try {
      const res = await fetch(`${BASE_URL}/trackBookedPacket/format/json/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          api_key: creds.apiKey,
          api_password: creds.apiPassword,
          track_numbers: trackingNumber,
        }).toString(),
      });
      const j = (await res.json().catch(() => null)) as any;
      const packet = j?.packet_list?.[0];
      if (!packet) return { kind: 'none' };

      const hist = Array.isArray(packet['Tracking Detail'])
        ? packet['Tracking Detail']
        : [];
      const latest = hist.length ? hist[hist.length - 1] : null;
      // Prefer the high-level booked_packet_status; fall back to the latest
      // granular activity Status.
      const rawStatus = String(
        packet.booked_packet_status || latest?.Status || '',
      ).trim();
      if (!rawStatus) return { kind: 'none' };

      const mapped = mapLeopardsPullStatus(rawStatus, packet);
      // Unknown vocabulary → don't guess (and don't let the generic heuristic
      // mis-read Leopards text): report 'none' so the parcel is left as-is.
      if (!mapped) return { kind: 'none' };

      const when = latest?.Activity_datetime
        ? new Date(String(latest.Activity_datetime).replace(' ', 'T'))
        : null;
      return {
        kind: 'status',
        rawStatus,
        mapped,
        happenedAt: when && !Number.isNaN(when.getTime()) ? when : undefined,
        reason: packet.status_remarks ? String(packet.status_remarks) : undefined,
      };
    } catch {
      return { kind: 'none' };
    }
  }

  /**
   * Full checkpoint history from Leopards' merchant API (`packet['Tracking
   * Detail']`, oldest → newest). Powers the in-app tracking view — Leopards'
   * public tracking page can't be embedded (its Track button calls a same-site
   * route that isn't reachable inside a third-party iframe), so we render the
   * timeline ourselves. Returns [] on any error / no history.
   */
  async queryTrackingHistory(
    creds: LeopardsCredentials,
    trackingNumber: string,
  ): Promise<TrackingCheckpoint[]> {
    try {
      const res = await fetch(`${BASE_URL}/trackBookedPacket/format/json/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          api_key: creds.apiKey,
          api_password: creds.apiPassword,
          track_numbers: trackingNumber,
        }).toString(),
      });
      const j = (await res.json().catch(() => null)) as any;
      const packet = j?.packet_list?.[0];
      const hist = Array.isArray(packet?.['Tracking Detail'])
        ? packet['Tracking Detail']
        : [];
      return hist
        .map((h: any): TrackingCheckpoint | null => {
          const status = String(h?.Status ?? '').trim();
          if (!status) return null;
          const rawAt = h?.Activity_datetime ?? h?.activity_datetime ?? null;
          const at = rawAt ? new Date(String(rawAt).replace(' ', 'T')) : null;
          const detail = [h?.Reason, h?.reason, h?.Activity, h?.location]
            .map((v) => (v == null ? '' : String(v).trim()))
            .find((v) => v.length > 0);
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

/** Leopards PULL vocabulary (human strings from trackBookedPacket) → our
 *  ShipmentStatus. Tolerant substring match, ordered most-specific first;
 *  returns null for anything unrecognized (never guesses). A non-empty
 *  `reverseCN` on the packet means a return leg exists → returned. */
function mapLeopardsPullStatus(
  raw: string,
  packet?: any,
): ShipmentStatus | null {
  const k = raw.toLowerCase();
  // Only "Returned to shipper" (completed hand-back) is a true return. A
  // return leg that merely EXISTS (reverseCN present, or "return/rto/reverse"
  // wording) is the parcel still on its way home = a failed delivery in motion
  // → 'attempted' (non-terminal), so the pull keeps checking until the final
  // "Returned to shipper" lands and promotes it to 'returned'.
  if (isReturnedToShipper(raw)) return 'returned';
  if (/return|rto|reverse/.test(k)) return 'attempted';
  if (packet?.reverseCN && String(packet.reverseCN).trim()) return 'attempted';
  if (/delivered/.test(k) && !/undeliver|not deliver|out for/.test(k))
    return 'delivered';
  if (/out for delivery|assign(ed)? to courier|ready for delivery|for delivery/.test(k))
    return 'out_for_delivery';
  if (/attempt|consignee|re-?attempt|on hold|shipper advise|unable to deliver|refused|not available/.test(k))
    return 'attempted';
  // "Pickup Request Sent" / "Booked" = awaiting collection (BEFORE the parcel is
  // actually picked), so match these before the past-tense "Picked".
  if (/pickup request|request sent|ready for pickup|booked|consignment booked/.test(k))
    return 'ready_for_pickup';
  if (/\bpicked\b|received from shipper|pick ?up/.test(k)) return 'picked_up';
  if (/dispatch|in transit|arrived|received at|forwarded|misroute|drop ?off|on the way|hub|station|departed/.test(k))
    return 'in_transit';
  return null;
}
