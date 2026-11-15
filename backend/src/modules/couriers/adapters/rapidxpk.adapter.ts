import { Injectable, Logger } from '@nestjs/common';
import { CourierType, ShipmentStatus } from '@prisma/client';
import * as crypto from 'crypto';
import {
  BookShipmentInput,
  BookShipmentResult,
  CourierAdapter,
  CourierChangeCursor,
  CourierChangePage,
  GenerateLoadsheetResult,
  TrackingCheckpoint,
  TrackingProbe,
  UnmappedCourierStatusError,
} from './courier-adapter.interface';
import { httpFetch } from './http.util';

/**
 * RapidXpk (api.rapidxpk.com/v1) credentials. Issued by RapidXpk at onboarding;
 * `rxp_test_…` keys are accepted but never dispatched, `rxp_live_…` are real.
 *  - apiKey        sent as `X-API-Key` on every call (secret).
 *  - citiesServed  comma list of cities RapidXpk delivers to for this tenant.
 *                  Synced into tenant-scoped courier_city_mappings rows on save
 *                  (RapidXpk has no city list API / city field).
 *  - service       optional service name agreed with RapidXpk; printed on the
 *                  label (default "STANDARD 24 HR").
 */
export interface RapidxpkCredentials {
  apiKey: string;
  citiesServed?: string;
  service?: string;
  /** Optional: signing secret pasted from the RapidXpk portal when the webhook
   *  URL was set there instead of auto-registered. Accepted alongside the
   *  auto-registered secret (courier_credentials.webhook_secret_encrypted). */
  webhookSecret?: string;
}

export const RAPIDXPK_BASE_URL = 'https://api.rapidxpk.com/v1';
export const RAPIDXPK_DEFAULT_SERVICE = 'STANDARD 24 HR';

/** One order as RapidXpk returns it (Get one order / sync item / webhook body). */
export interface RapidxpkOrder {
  order_id: string;
  external_id?: string;
  status: string;
  reason?: string | null;
  attempts?: number;
  packed_at?: string | null;
  dispatched_at?: string | null;
  delivered_at?: string | null;
  returned_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  occurred_at?: string | null;
  cod?: { amount?: number; collected?: boolean; settled?: boolean };
  tracking_url?: string;
}

/** Documented RapidXpk status vocabulary → our ShipmentStatus. `rto` (return
 *  leg in motion) is `failed` — it MUST resolve here, before any generic
 *  return heuristic (`isReturnedToShipper` treats a bare "rto" as complete). */
const STATUS_MAP: Record<string, ShipmentStatus> = {
  received: 'booked',
  packed: 'ready_for_pickup',
  dispatched: 'out_for_delivery',
  delivered: 'delivered',
  failed_attempt: 'attempted',
  rto: 'failed',
  returned: 'returned',
  cancelled: 'cancelled',
};

const STATUS_LABEL: Record<string, string> = {
  received: 'Received by RapidXpk',
  packed: 'Packed — ready for rider',
  dispatched: 'Out for delivery',
  delivered: 'Delivered',
  failed_attempt: 'Delivery attempt failed',
  rto: 'Returning to origin',
  returned: 'Returned',
  cancelled: 'Cancelled',
};

/** Max pages one change-feed pull walks (500 per page) before yielding; the
 *  saved cursor resumes from there on the next run. */
const MAX_CHANGE_PAGES = 20;

/** Normalise a Pakistani mobile to the 11-digit `03XXXXXXXXX` RapidXpk wants.
 *  Accepts 03…, +92…, 92…, 0092…, and bare 3XXXXXXXXX. Anything else is sent
 *  as digits and RapidXpk's own `invalid_phone` error surfaces. */
export function toRapidxpkPhone(raw: string): string {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('0092')) d = d.slice(4);
  else if (d.startsWith('92') && d.length === 12) d = d.slice(2);
  if (d.length === 10 && d.startsWith('3')) return `0${d}`;
  if (d.length === 11 && d.startsWith('03')) return d;
  return d;
}

/** external_id base = the order number without `#` (RapidXpk's sample uses
 *  `YG-1001`). Replacement refs already carry `-R1`. */
export function rapidxpkExternalBase(orderName: string): string {
  return String(orderName || '').replace(/#/g, '').trim();
}

/**
 * Verify a RapidXpk webhook: `X-RapidXpk-Signature` = "sha256=" + HMAC-SHA256
 * of `${timestamp}.${rawBody}` keyed with the webhook signing secret; reject a
 * timestamp more than 5 minutes off. Constant-time compare.
 */
export function verifyRapidxpkSignature(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: Buffer | string,
  nowMs: number = Date.now(),
): boolean {
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > 300) return false;
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Error carrying RapidXpk's human `message` (written to be shown to a person). */
export class RapidxpkApiError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
    public readonly raw: unknown,
  ) {
    super(message);
    this.name = 'RapidxpkApiError';
  }
}

function isTransient(err: unknown): boolean {
  if (err instanceof RapidxpkApiError) return err.httpStatus >= 500 || err.httpStatus === 429;
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /abort|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket/i.test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class RapidxpkAdapter implements CourierAdapter {
  readonly type: CourierType = 'rapidxpk';
  private readonly logger = new Logger(RapidxpkAdapter.name);

  /** JSON call with X-API-Key. Throws RapidxpkApiError on a non-2xx reply. */
  async call<T = any>(
    creds: RapidxpkCredentials,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    if (!creds?.apiKey) {
      throw new RapidxpkApiError(401, 'missing_api_key', 'RapidXpk API key is not set.', null);
    }
    const res = await httpFetch(`${RAPIDXPK_BASE_URL}${path}`, {
      method,
      headers: {
        'X-API-Key': creds.apiKey.trim(),
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok && res.status !== 207) {
      throw new RapidxpkApiError(
        res.status,
        String(data?.error ?? `http_${res.status}`),
        String(data?.message ?? `RapidXpk request failed (HTTP ${res.status}).`),
        data,
      );
    }
    return { status: res.status, data: data as T };
  }

  /** Look an order up by our external_id. null when RapidXpk has none. */
  async findByExternalId(
    creds: RapidxpkCredentials,
    externalId: string,
  ): Promise<RapidxpkOrder | null> {
    try {
      const { data } = await this.call<any>(
        creds,
        'GET',
        `/orders?external_id=${encodeURIComponent(externalId)}`,
      );
      // Accept either a single order object or a list wrapper.
      if (data?.order_id) return data as RapidxpkOrder;
      const list = Array.isArray(data?.orders) ? data.orders : Array.isArray(data) ? data : [];
      return (list.find((o: any) => o?.external_id === externalId) as RapidxpkOrder) ?? null;
    } catch (err) {
      if (err instanceof RapidxpkApiError && err.httpStatus === 404) return null;
      throw err;
    }
  }

  /**
   * Pick the external_id to book with. Base = order number without '#'.
   *  - nothing at RapidXpk under it          → use it
   *  - a LIVE (non-cancelled) parcel under it → our own lost-reply retry: adopt it
   *  - a CANCELLED parcel under it            → order re-booked after a release:
   *                                             try `-2`, `-3`, …
   */
  private async resolveExternalId(
    creds: RapidxpkCredentials,
    orderName: string,
  ): Promise<{ externalId: string; existing: RapidxpkOrder | null }> {
    const base = rapidxpkExternalBase(orderName);
    if (!base) throw new Error('RapidXpk booking needs an order number.');
    for (let n = 1; n <= 20; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      const existing = await this.findByExternalId(creds, candidate);
      if (!existing) return { externalId: candidate, existing: null };
      if (String(existing.status).toLowerCase() !== 'cancelled') {
        return { externalId: candidate, existing };
      }
    }
    throw new Error(`RapidXpk already has 20 cancelled bookings for ${base}.`);
  }

  async bookShipment(
    creds: RapidxpkCredentials,
    input: BookShipmentInput,
  ): Promise<BookShipmentResult> {
    const { externalId, existing } = await this.resolveExternalId(creds, input.shopifyOrderName);
    if (existing) {
      this.logger.log(
        `RapidXpk already holds ${externalId} (${existing.order_id}, ${existing.status}) — adopting it instead of booking twice.`,
      );
      return {
        trackingNumber: String(existing.order_id),
        trackingUrl: existing.tracking_url,
        raw: { ...existing, adopted: true },
      };
    }

    const cod = Math.max(0, Math.round(input.codAmount));
    const address = [input.destination.address1, input.destination.address2, input.destination.city]
      .map((x) => (x ?? '').trim())
      .filter(Boolean)
      .join(', ');
    const items =
      input.items && input.items.length
        ? input.items.map((i) => ({
            ...(i.sku ? { sku: i.sku } : {}),
            name: i.name || 'Item',
            qty: Math.max(1, Math.round(i.qty || 1)),
          }))
        : [
            {
              name: input.itemsDescription || 'Order',
              qty: Math.max(
                1,
                Math.round(input.totalQuantity != null ? input.totalQuantity : input.pieces),
              ),
            },
          ];
    const body: Record<string, unknown> = {
      external_id: externalId,
      customer: {
        name: input.destination.name,
        phone: toRapidxpkPhone(input.destination.phone),
        address,
      },
      items,
      payment_method: cod > 0 ? 'cod' : 'prepaid',
      cod_amount: cod,
      ...(input.totalPrice != null ? { order_value: Math.max(0, Math.round(input.totalPrice)) } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      ...(creds.service?.trim() ? { service: creds.service.trim() } : {}),
    };

    // Creating is idempotent on external_id, so a lost reply / 502 is safe to
    // retry once — RapidXpk returns the first order (200) instead of a 2nd parcel.
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { data } = await this.call<RapidxpkOrder & { mode?: string }>(
          creds,
          'POST',
          '/orders',
          body,
        );
        if (!data?.order_id) {
          throw new Error(`RapidXpk booking returned no order_id: ${JSON.stringify(data).slice(0, 300)}`);
        }
        if (data.mode === 'test') {
          this.logger.warn(`RapidXpk booked ${externalId} on a TEST key — it will never be dispatched.`);
        }
        return { trackingNumber: String(data.order_id), trackingUrl: data.tracking_url, raw: data };
      } catch (err) {
        lastErr = err;
        if (attempt < 2 && isTransient(err)) {
          await sleep(2000);
          continue;
        }
        if (err instanceof RapidxpkApiError) {
          throw new Error(`RapidXpk: ${err.message}`);
        }
        throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('RapidXpk booking failed.');
  }

  /** No loadsheet API — LoadsheetService builds RapidXpk's loadsheet format
   *  itself (rapidxpk-loadsheet.util). */
  async generateLoadsheet(
    _creds: RapidxpkCredentials,
    trackingNumbers: string[],
  ): Promise<GenerateLoadsheetResult> {
    return {
      loadsheetId: `rapidxpk-manifest-${trackingNumbers.length}`,
      pdfBuffer: undefined,
      raw: null,
    };
  }

  async cancelShipment(
    creds: RapidxpkCredentials,
    trackingNumber: string,
  ): Promise<{ ok: boolean; raw: unknown }> {
    try {
      const { data } = await this.call(
        creds,
        'POST',
        `/orders/${encodeURIComponent(trackingNumber)}/cancel`,
        { reason: 'Cancelled from CodesApp' },
      );
      return { ok: true, raw: data };
    } catch (err) {
      if (err instanceof RapidxpkApiError) {
        // 409 too_late = the rider already has it; 404 = unknown ref.
        return { ok: false, raw: { error: err.code, message: err.message, ...(err.raw as object) } };
      }
      return { ok: false, raw: { error: 'transport', message: (err as Error)?.message } };
    }
  }

  /** Full order (Get one order). null on 404 / transport failure. */
  async getOrder(creds: RapidxpkCredentials, trackingNumber: string): Promise<RapidxpkOrder | null> {
    try {
      const { data } = await this.call<RapidxpkOrder>(
        creds,
        'GET',
        `/orders/${encodeURIComponent(trackingNumber)}`,
      );
      return data?.order_id ? data : null;
    } catch {
      return null;
    }
  }

  async queryTrackingResult(
    creds: RapidxpkCredentials,
    trackingNumber: string,
  ): Promise<TrackingProbe> {
    const o = await this.getOrder(creds, trackingNumber);
    if (!o?.status) return { kind: 'none' };
    const raw = String(o.status);
    const mapped = STATUS_MAP[raw.toLowerCase()];
    const when = o.updated_at ? new Date(o.updated_at) : undefined;
    return {
      kind: 'status',
      rawStatus: raw,
      mapped,
      happenedAt: when && !Number.isNaN(when.getTime()) ? when : undefined,
      reason: o.reason ?? undefined,
    };
  }

  async queryTracking(
    creds: RapidxpkCredentials,
    trackingNumber: string,
  ): Promise<{ rawStatus: string; happenedAt?: Date; reason?: string } | null> {
    const r = await this.queryTrackingResult(creds, trackingNumber);
    return r.kind === 'status'
      ? { rawStatus: r.rawStatus, happenedAt: r.happenedAt, reason: r.reason }
      : null;
  }

  /** RapidXpk exposes no scan list — synthesise the timeline from the order's
   *  milestone timestamps + its current status. */
  async queryTrackingHistory(
    creds: RapidxpkCredentials,
    trackingNumber: string,
  ): Promise<TrackingCheckpoint[]> {
    const o = await this.getOrder(creds, trackingNumber);
    return o ? synthesizeRapidxpkHistory(o) : [];
  }

  /**
   * One run of the "changes since" feed: walk pages oldest-change-first from
   * `cursor`, return every order seen and the cursor to resume from.
   */
  async listChanges(
    creds: RapidxpkCredentials,
    cursor: CourierChangeCursor,
  ): Promise<CourierChangePage> {
    let since = cursor.since;
    let afterId = cursor.afterId ?? 0;
    const items: RapidxpkOrder[] = [];
    for (let page = 0; page < MAX_CHANGE_PAGES; page++) {
      const { data } = await this.call<any>(
        creds,
        'GET',
        `/orders?updated_since=${encodeURIComponent(since)}&after_id=${afterId}&limit=500`,
      );
      const orders: RapidxpkOrder[] = Array.isArray(data?.orders) ? data.orders : [];
      items.push(...orders);
      if (data?.next_since) since = String(data.next_since);
      if (data?.next_id != null) afterId = Number(data.next_id) || afterId;
      if (!data?.has_more) return { items, cursor: { since, afterId }, hasMore: false };
    }
    return { items, cursor: { since, afterId }, hasMore: true };
  }

  mapStatus(rawStatus: string): ShipmentStatus {
    const key = String(rawStatus || '')
      .trim()
      .toLowerCase()
      .replace(/^order\./, '')
      .replace(/[\s-]+/g, '_');
    const mapped = STATUS_MAP[key];
    if (mapped) return mapped;
    throw new UnmappedCourierStatusError('rapidxpk', rawStatus);
  }

  isAddressIssueReason(rawReason: string): boolean {
    return /wrong address|incorrect address|address.*(not found|invalid|incomplete)|incomplete address|location not found|no such (house|building|address)/i.test(
      rawReason,
    );
  }

  // No isAwaitingShipperAdvice (no explicit signal — the 24h aged-attempt
  // fallback applies) and no sendShipperAdvice (RapidXpk has no advice API).

  // ── Settings helpers (not part of CourierAdapter) ───────────────────────

  /** Validate a key cheaply. Returns 'test' | 'live' from the prefix on success. */
  async validateKey(creds: RapidxpkCredentials): Promise<'test' | 'live'> {
    await this.call(creds, 'GET', `/orders?updated_since=${encodeURIComponent(new Date().toISOString())}&limit=1`);
    return keyMode(creds.apiKey) ?? 'live';
  }

  /** Register (or replace) our webhook URL. Returns the one-time signing secret. */
  async registerWebhook(
    creds: RapidxpkCredentials,
    url: string,
  ): Promise<{ secret: string; raw: unknown }> {
    const { data } = await this.call<any>(creds, 'POST', '/webhooks', { url });
    const secret = data?.secret ?? data?.signing_secret ?? data?.webhook_secret;
    if (!secret) {
      throw new Error(`RapidXpk webhook registration returned no secret: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return { secret: String(secret), raw: data };
  }

  /** Current webhook URL + last success/failure, as RapidXpk reports it. */
  async getWebhook(creds: RapidxpkCredentials): Promise<unknown> {
    const { data } = await this.call(creds, 'GET', '/webhooks');
    return data;
  }
}

export function keyMode(apiKey: string | undefined): 'test' | 'live' | null {
  const k = String(apiKey || '').trim();
  if (k.startsWith('rxp_test_')) return 'test';
  if (k.startsWith('rxp_live_')) return 'live';
  return null;
}

/** Timeline from an order's milestone timestamps (oldest → newest). */
export function synthesizeRapidxpkHistory(o: RapidxpkOrder): TrackingCheckpoint[] {
  const out: TrackingCheckpoint[] = [];
  const iso = (v?: string | null) => {
    if (!v) return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  };
  if (o.created_at) out.push({ status: STATUS_LABEL.received, at: iso(o.created_at) });
  if (o.packed_at) out.push({ status: STATUS_LABEL.packed, at: iso(o.packed_at) });
  if (o.dispatched_at) out.push({ status: STATUS_LABEL.dispatched, at: iso(o.dispatched_at) });
  if (o.delivered_at) out.push({ status: STATUS_LABEL.delivered, at: iso(o.delivered_at) });
  if (o.returned_at) out.push({ status: STATUS_LABEL.returned, at: iso(o.returned_at) });

  // Current status, when it isn't already represented by a milestone above.
  const st = String(o.status || '').toLowerCase();
  const covered =
    (st === 'received' && !!o.created_at) ||
    (st === 'packed' && !!o.packed_at) ||
    (st === 'dispatched' && !!o.dispatched_at) ||
    (st === 'delivered' && !!o.delivered_at) ||
    (st === 'returned' && !!o.returned_at);
  if (st && !covered) {
    const detail = [
      o.reason || '',
      o.attempts ? `attempt ${o.attempts}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    out.push({
      status: STATUS_LABEL[st] ?? o.status,
      detail: detail || undefined,
      at: iso(o.occurred_at) ?? iso(o.updated_at),
    });
  }
  return out.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
}
