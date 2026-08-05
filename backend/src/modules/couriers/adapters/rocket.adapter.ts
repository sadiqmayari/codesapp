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

export interface RocketCredentials {
  clientId: string;
  token: string;
  /** Optional store id (Rocket "client_store_id" — Stores section in portal). */
  storeId?: string;
  /**
   * Rocket is a MULTI-CARRIER AGGREGATOR: every booking must name the carrier
   * it should route to via `shipment_services`
   * (1=TCS, 21=TRAX, 3=LEO, 17=POSTEX, plus RIDER/CALL). Configurable per
   * tenant; defaults to POSTEX (17) — the tenant's primary carrier.
   */
  service?: string;
  /** "1" allows the customer to open the parcel before paying, "0" doesn't. */
  openAllow?: string;
}

// No trailing slash — paths add their own single '/'. (The Postman doc shows a
// double slash purely because its base-URL variable ended in '/'; the same
// server serves the single-slash endpoints too, so single is safe.)
const BASE_URL = 'https://client.rocketcourier.pk';
const DEFAULT_SERVICE = '17'; // POSTEX
const TIMEOUT_MS = 20_000;

/**
 * Rocket status vocabulary — calibrated against real /trackingapi responses
 * (e.g. "Order Created", "Picked", "Arrived at Origin Hub", "Out for Delivery").
 * mapStatus uses ordered substring checks (its statuses are free-text phrases,
 * not a fixed enum). Anything unrecognized throws (never guesses), same
 * discipline as the other 3 adapters.
 */

@Injectable()
export class RocketAdapter implements CourierAdapter {
  readonly type: CourierType = 'rocket';
  private readonly logger = new Logger(RocketAdapter.name);

  private async post(path: string, body: Record<string, unknown>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private auth(creds: RocketCredentials): { clients: string; token: string } {
    return { clients: creds.clientId, token: creds.token };
  }

  async bookShipment(
    creds: RocketCredentials,
    input: BookShipmentInput,
  ): Promise<BookShipmentResult> {
    const body: Record<string, unknown> = {
      ...this.auth(creds),
      name: input.destination.name,
      mobile: input.destination.phone.replace(/[^\d+]/g, ''),
      // Resolved Rocket city id (via CityMappingService), never raw free text.
      city: input.destination.cityCode,
      address: [input.destination.address1, input.destination.address2]
        .filter(Boolean)
        .join(', '),
      details: input.itemsDescription || 'Order',
      qty: String(Math.max(1, input.pieces)),
      weight: '1',
      total: String(Math.max(0, Math.round(input.codAmount))),
      source: 'CodesApp',
      open_allow: creds.openAllow ?? '1',
      shipment_services: creds.service || DEFAULT_SERVICE,
      client_order_id: input.shopifyOrderName,
      client_store_id: creds.storeId ?? '',
    };

    const res = await this.post('/bookingapi', body);
    const raw = await res.json().catch(() => ({}));
    const trackingNumber = extractTracking(raw);
    if (!res.ok || !trackingNumber) {
      throw new Error(`Rocket booking failed: ${JSON.stringify(raw)}`);
    }
    return { trackingNumber: String(trackingNumber), raw };
  }

  /**
   * Rocket has NO manifest/load-sheet API — the printable dispatch document IS
   * the labels PDF from /pdfapi (comma-separated tracking numbers). We surface
   * it as the loadsheet so the dispatch flow still produces something printable.
   */
  async generateLoadsheet(
    creds: RocketCredentials,
    trackingNumbers: string[],
  ): Promise<GenerateLoadsheetResult> {
    const pdfBuffer = await this.fetchLabelPdf(creds, trackingNumbers);
    return { loadsheetId: `rocket-${Date.now()}`, pdfBuffer, raw: null };
  }

  /** Shipping labels (airway bills) for this courier's parcels, via /pdfapi. */
  async getLabels(
    creds: RocketCredentials,
    trackingNumbers: string[],
  ): Promise<CourierLabelResult> {
    const pdfBuffer = await this.fetchLabelPdf(creds, trackingNumbers);
    return { pdfBuffer, raw: null };
  }

  private async fetchLabelPdf(
    creds: RocketCredentials,
    trackingNumbers: string[],
  ): Promise<Buffer> {
    const res = await this.post('/pdfapi', {
      ...this.auth(creds),
      trackingnos: [...new Set(trackingNumbers)].join(','),
    });
    if (!res.ok) throw new Error(`Rocket label/PDF fetch failed (${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }

  async cancelShipment(
    creds: RocketCredentials,
    trackingNumber: string,
  ): Promise<{ ok: boolean; raw: unknown }> {
    const res = await this.post('/cancelapi', {
      ...this.auth(creds),
      shipped_ref: trackingNumber,
    });
    const raw = await res.json().catch(() => ({}));
    return { ok: res.ok, raw };
  }

  async sendShipperAdvice(
    creds: RocketCredentials,
    trackingNumber: string,
    action: ShipperAdviceAction,
    remarks: string,
  ): Promise<{ ok: boolean; raw: unknown }> {
    // Rocket request_type is INVERTED vs PostEx/Trax: 1 = Re-Attempt, 2 = Return.
    const requestType = action === 'return' ? 2 : 1;
    const res = await this.post('/shipperadvise', {
      ...this.auth(creds),
      shipped_ref: trackingNumber,
      request_type: String(requestType),
      request_description:
        remarks || (action === 'return' ? 'Return to shipper' : 'Re-Attempt Delivery'),
    });
    const raw = await res.json().catch(() => ({}));
    return { ok: res.ok, raw };
  }

  /**
   * Pull current status from Rocket's /trackingapi. Response shape is not in the
   * published doc, so parsing is defensive: it scans common status keys and the
   * latest history entry. Returns null when nothing status-like is found (the
   * status-sync then simply skips this parcel — never mis-maps it).
   */
  async queryTracking(
    creds: RocketCredentials,
    trackingNumber: string,
  ): Promise<{ rawStatus: string; happenedAt?: Date; reason?: string } | null> {
    const r = await this.queryTrackingResult(creds, trackingNumber);
    return r.kind === 'status'
      ? { rawStatus: r.rawStatus, happenedAt: r.happenedAt, reason: r.reason }
      : null;
  }

  /**
   * Richer pull: also detects a DEAD ref. Rocket's /trackingapi answers a
   * reassigned/rerouted (or otherwise unknown) ref with HTTP 200 +
   * {"success":"false","errors":"Order Id Tracking Number and Credentials Do
   * not Match"} — that's a ref that will NEVER track again (the parcel now
   * lives under a new `KI…` ref), so we surface it as `dead` for the status-sync
   * to flag rather than re-poll forever.
   */
  async queryTrackingResult(
    creds: RocketCredentials,
    trackingNumber: string,
  ): Promise<import('./courier-adapter.interface').TrackingProbe> {
    try {
      const res = await this.post('/trackingapi', {
        ...this.auth(creds),
        shipped_ref: trackingNumber,
      });
      const j = (await res.json().catch(() => null)) as any;
      if (!j) return { kind: 'none' };
      // Dead-ref envelope: {success:"false", errors:"…Do not Match"}.
      if (
        !Array.isArray(j) &&
        String(j?.success).toLowerCase() === 'false' &&
        /do not match|not match|invalid|no record|not found/i.test(String(j?.errors ?? ''))
      ) {
        return { kind: 'dead' };
      }
      const latest = pickLatestHistory(j);
      const status = firstString(
        latest?.status,
        latest?.reason,
        latest?.remarks,
        latest?.message,
        j?.status,
        j?.current_status,
        j?.tracking_status,
      );
      if (!status) return { kind: 'none' };
      // Rocket dates look like "30-Jul-2026 - 07:17 pm" (createdon) — parse
      // best-effort, drop it if the format doesn't yield a valid Date.
      const when = firstString(
        latest?.createdon,
        latest?.datetime,
        latest?.date,
        latest?.time,
        latest?.created_at,
      );
      const parsed = when ? new Date(when.replace(' - ', ' ')) : null;
      const reason = firstString(latest?.reason, latest?.remarks);
      return {
        kind: 'status',
        rawStatus: status,
        happenedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined,
        reason: reason || undefined,
      };
    } catch {
      return { kind: 'none' };
    }
  }

  mapStatus(rawStatus: string): ShipmentStatus {
    const k = rawStatus.trim().toLowerCase();
    // Order matters: 'out for delivery' must beat the generic 'deliver'; a
    // return/undelivered must beat 'deliver' too.
    if (k === 'delivered' || k === 'delivery successful') return 'delivered';
    if (k.includes('out for delivery')) return 'out_for_delivery';
    if (k.includes('return') || k.includes('rto')) return 'returned';
    if (k.includes('undeliver') || k.includes('unable to deliver') || k.includes('attempt')) {
      return 'attempted';
    }
    if (k.includes('cancel')) return 'cancelled';
    if (k.includes('picked') || k.includes('pickup')) return 'picked_up';
    if (k.includes('order created') || k === 'booked' || k.includes('consignment booked')) {
      return 'ready_for_pickup';
    }
    if (
      k.includes('hub') ||
      k.includes('transit') ||
      k.includes('arrived') ||
      k.includes('departed') ||
      k.includes('received at') ||
      k.includes('dispatched') ||
      k.includes('on the way')
    ) {
      return 'in_transit';
    }
    if (k.includes('deliver')) return 'delivered'; // any remaining 'delivered' variant
    throw new UnmappedCourierStatusError('rocket', rawStatus);
  }

  isAddressIssueReason(rawReason: string): boolean {
    return /wrong address|address.*(not found|invalid)|incomplete address|no such (building|address|plot)/i.test(
      rawReason,
    );
  }
}

/** Booking response's tracking number can live under several keys — Rocket's
 *  doc has no sample response, so scan the common ones (and one level of
 *  `data`/`result` nesting). */
function extractTracking(raw: unknown): string | null {
  const scan = (o: any): string | null => {
    if (!o || typeof o !== 'object') return null;
    const v =
      o.trackingnos ??
      o.trackingno ??
      o.tracking_no ??
      o.tracking_number ??
      o.shipped_ref ??
      o.shippedref ??
      o.cn_no ??
      o.cn;
    if (v != null && String(v).trim()) return String(v).trim();
    return null;
  };
  const r = raw as any;
  return scan(r) ?? scan(r?.data) ?? scan(r?.result) ?? scan(r?.response);
}

function pickLatestHistory(j: any): any {
  const hist =
    // Rocket's /trackingapi returns a TOP-LEVEL array of {status, createdon},
    // oldest → newest.
    (Array.isArray(j) && j) ||
    (Array.isArray(j?.history) && j.history) ||
    (Array.isArray(j?.tracking) && j.tracking) ||
    (Array.isArray(j?.data?.history) && j.data.history) ||
    (Array.isArray(j?.data) && j.data) ||
    null;
  if (hist && hist.length) return hist[hist.length - 1];
  return j?.data ?? j;
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return undefined;
}
