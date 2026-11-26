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
  TrackingProbe,
  UnmappedCourierStatusError,
} from './courier-adapter.interface';
import { httpFetch, isPdf } from './http.util';
import { isReturnedToShipper } from './return-status.util';
import { ParsedInvoice, ParsedInvoiceLine } from '../invoices/courier-invoice.types';

/**
 * TCS "E-COM" API credentials (production only — https://ociconnect.tcscourier.com).
 * TCS uses TWO tokens:
 *  - `bearerToken` — a long-lived JWT TCS issues to the merchant. Sent as the
 *    `Authorization: Bearer` header on EVERY call. (Older accounts got a Client
 *    ID/Secret instead; Settings can still turn those into a bearer token once.)
 *  - the e-com `accesstoken` — minted from `username` + `password`
 *    (`GET /ecom/api/authentication/token`), sent INSIDE each request (query for
 *    GET, JSON body for POST). Long expiry → stored encrypted with its expiry
 *    (`ecomToken`/`ecomTokenExpiry`) and only re-minted when expired or rejected.
 * `accountNo` is the TCS account (booking `tcsaccount`, inquiry `customerno`);
 * `costCenterCode` picks the pickup/return address TCS holds.
 */
export interface TcsCredentials {
  bearerToken?: string;
  username: string;
  password: string;
  accountNo: string;
  costCenterCode?: string;
  /** TCS service code, e.g. "O" (overnight). Default "O". */
  serviceCode?: string;
  /** Default parcel weight in kg (TCS minimum 0.5). */
  defaultWeightKg?: string;
  /** Shipper block on the booking (prefilled from the cost center). */
  shipperName?: string;
  pickupAddress?: string;
  pickupCity?: string;
  pickupCityCode?: string;
  pickupPhone?: string;
  /** print/label `printtype` (1=3 per page, 2=single, 3=6x4 …). Default 2. */
  labelPrintType?: string;
  /** Stored e-com access token (exactly as TCS returned it) + its expiry. */
  ecomToken?: string;
  ecomTokenExpiry?: string;
  /** Legacy: only used once at save time to generate `bearerToken`. */
  clientId?: string;
  clientSecret?: string;
}

/** Persists a freshly minted e-com token (implemented by TcsTokenStore). */
export interface TcsTokenSink {
  save(credentialId: number, token: string, expiryIso: string | null): Promise<void>;
  clear(credentialId: number): Promise<void>;
}

/** Fixed production host — TCS offers no usable sandbox for merchants. */
export const TCS_BASE = 'https://ociconnect.tcscourier.com';

/** TCS caps COD/declared value at 199,999 (Swagger `maximum`). */
export const TCS_MAX_COD = 199_999;
const BOOK_TIMEOUT_MS = 60_000;

/** The DB row id the registry attaches (non-enumerable) to decrypted creds. */
export function tcsCredentialId(c: unknown): number | undefined {
  const id = (c as { credentialId?: unknown } | null)?.credentialId;
  return typeof id === 'number' ? id : undefined;
}

/** Replace every secret in `text` with *** (never log or surface tokens). */
export function maskSecrets(text: string, c?: Partial<TcsCredentials> | null): string {
  let out = String(text ?? '');
  const secrets = [c?.bearerToken, c?.ecomToken, c?.password, c?.clientSecret]
    .map((v) => (v == null ? '' : String(v)))
    .filter((v) => v.length >= 4);
  for (const v of secrets) {
    out = out.split(v).join('***');
    try {
      const enc = encodeURIComponent(v);
      if (enc !== v) out = out.split(enc).join('***');
    } catch {
      /* ignore */
    }
  }
  // Belt and braces: any JWT-looking blob.
  return out.replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, '***');
}

/** TCS wants a local Pakistani mobile: 03XXXXXXXXX (11 digits). */
export function toTcsMobile(raw: string | null | undefined): string {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('0092')) d = d.slice(4);
  else if (d.startsWith('92') && d.length >= 12) d = d.slice(2);
  if (d.length === 10 && d.startsWith('3')) d = `0${d}`;
  return d;
}

/** Split a full name into TCS's first/middle/last. TCS requires a first name
 *  of ≥3 chars and a middlename (sent as "-" when there is none). */
export function splitTcsName(full: string): { firstname: string; middlename: string; lastname?: string } {
  const name = String(full ?? '').replace(/\s+/g, ' ').trim();
  const parts = name.split(' ').filter(Boolean);
  let first = parts[0] ?? '';
  let last = parts.slice(1).join(' ');
  if (first.length < 3) {
    first = name;
    last = '';
  }
  if (first.length < 3) first = `${first} Customer`.trim();
  return { firstname: first.slice(0, 50), middlename: '-', ...(last ? { lastname: last.slice(0, 50) } : {}) };
}

/** Spread an address over TCS's three 120-char lines. */
export function splitTcsAddress(...lines: Array<string | null | undefined>): string[] {
  const full = lines
    .map((l) => String(l ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(', ');
  const out: string[] = [];
  let rest = full;
  while (rest && out.length < 3) {
    if (rest.length <= 120 || out.length === 2) {
      out.push(rest.slice(0, 120));
      break;
    }
    let cut = rest.lastIndexOf(' ', 120);
    if (cut < 60) cut = 120;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return out;
}

/** "Thursday Oct 17, 2024 12:58" (TCS local = PKT) → Date. */
export function parseTcsDate(raw: unknown): Date | undefined {
  if (raw == null) return undefined;
  const s = String(raw).replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  const noDay = s.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+/i, '');
  const hasZone = /(z|[+-]\d{2}:?\d{2}|gmt|utc)\b/i.test(noDay);
  const d = new Date(hasZone ? noDay : `${noDay} GMT+0500`);
  if (!Number.isNaN(d.getTime())) return d;
  const d2 = new Date(s);
  return Number.isNaN(d2.getTime()) ? undefined : d2;
}

/**
 * TCS delivery status CODES (deliveryinfo[].code / Payment "cn status") with a
 * known meaning. Exact, checked before the text rules. Anything else falls to
 * the wording rules and finally throws (surfaced as "needs attention") — the
 * full list is visible in Settings → Couriers → TCS → "Status codes".
 */
const CODE_MAP: Record<string, ShipmentStatus> = {
  // ── From TCS's live setup/deliverystatuslist (2026-11-26) ──
  BT: 'booked',
  LC: 'booked',
  PO: 'in_transit', // processed at origin
  IB: 'in_transit', // inbound scan
  RV: 'in_transit',
  SR: 'in_transit', // short received
  PR: 'in_transit',
  RP: 'in_transit', // re-packed
  SI: 'in_transit', // security inspection
  SM: 'in_transit', // SMS sent
  MR: 'in_transit',
  RA: 'in_transit', // remote area, delivery arranged
  PFC: 'in_transit',
  CP: 'in_transit',
  CR: 'in_transit',
  CD: 'in_transit',
  DHR: 'in_transit',
  BW: 'in_transit', // bad weather
  TD: 'in_transit',
  ND: 'in_transit', // scheduled for next delivery cycle
  DR: 'attempted', // delivery rescheduled
  VHV: 'in_transit',
  VDI: 'in_transit',
  VLI: 'in_transit',
  DVR: 'in_transit',
  DVS: 'in_transit',
  RH: 'in_transit',
  RE: 'in_transit',
  VEC: 'in_transit',
  DOI: 'in_transit',
  TP: 'in_transit', // third-party delivery leg
  TP1: 'in_transit',
  OD: 'out_for_delivery',
  PD: 'delivered', // partial delivery
  POK: 'delivered',
  BR: 'delivered',
  // Undelivered — needs the shipper / customer (attempted)
  BA: 'attempted',
  BD: 'attempted',
  WA: 'attempted',
  UL: 'attempted',
  IA: 'attempted',
  NP: 'attempted', // receiver shifted
  CS: 'attempted',
  HN: 'attempted', // consignee not home
  MO: 'attempted', // mobile switched off
  NM: 'attempted',
  NT: 'attempted',
  WM: 'attempted',
  WP: 'attempted',
  AN: 'attempted',
  VM: 'attempted',
  NC: 'attempted', // need further consignee information
  NS: 'attempted', // out of delivery area
  OS: 'attempted',
  HP: 'attempted', // held for payment
  ST: 'attempted', // stop delivery
  SS: 'attempted',
  CSC: 'attempted',
  CSR: 'attempted',
  PC: 'attempted', // please contact TCS
  DM: 'attempted', // damaged
  PI: 'attempted', // prohibited item
  OH: 'attempted',
  HF: 'attempted',
  CL: 'attempted',
  HC: 'attempted',
  // Lost / abandoned — the delivery failed
  LS: 'failed',
  AB: 'failed',
  OK: 'delivered',
  DL: 'delivered',
  RO: 'failed', // "Returned To Origin" — back at origin city, not yet handed to the shipper (RS)
  RS: 'returned', // returned to shipper
  RT: 'failed',
  SC: 'attempted', // awaiting receiver collection
  CA: 'attempted', // consignee address incorrect
  CNA: 'attempted',
  RFD: 'attempted',
  RF: 'attempted',
  NR: 'attempted',
  DBC: 'in_transit', // delay beyond our control
  DFC: 'in_transit',
  DAE: 'in_transit',
  DFM: 'in_transit',
};

/** Text vocabulary (lowercased) → status; ordered, first match wins. */
const TEXT_RULES: Array<[RegExp, ShipmentStatus]> = [
  [/delay/, 'in_transit'], // "Delay due to Flight Cancelled" is NOT a cancel
  [/cancel/, 'cancelled'],
  [/return|rto|\bro\b/, 'failed'], // terminal hand-back handled before this
  [/out for delivery|on route for delivery|with courier for delivery/, 'out_for_delivery'],
  [/\bdelivered\b|shipment delivered/, 'delivered'],
  [
    /awaiting receiver|receiver collection|not available|refus|incorrect address|address (incorrect|not found|incomplete)|closed|attempt|undeliver|not delivered|hold|shipper advi|consignee (shifted|moved)|no such|unable to deliver|could not deliver/,
    'attempted',
  ],
  [
    /arrived|depart|in transit|transit|dispatch|forward|manifest|facility|hub|station|picked|pickup|collected|received at|loaded|unloaded|connect|delay|route|sorted|bag/,
    'in_transit',
  ],
  [/booked|booking|label|shipment created|order (created|received)|data received|information received/, 'booked'],
];

export function mapTcsStatus(raw: string, code?: string | null): ShipmentStatus {
  const c = String(code ?? '').trim().toUpperCase();
  const text = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (c && CODE_MAP[c]) return CODE_MAP[c];
  if (isReturnedToShipper(text)) return 'returned';
  if (!text) throw new UnmappedCourierStatusError('tcs', raw);
  const bareCode = text.toUpperCase();
  if (CODE_MAP[bareCode]) return CODE_MAP[bareCode];
  for (const [re, st] of TEXT_RULES) if (re.test(text)) return st;
  throw new UnmappedCourierStatusError('tcs', raw);
}

/** An error the booking queue must NOT retry automatically — TCS may already
 *  hold the consignment (TCS has no lookup-by-reference to check). */
export class TcsUnconfirmedBookingError extends Error {
  constructor(order: string, detail: string) {
    super(
      `TCS booking unconfirmed for ${order} (${detail}) — do not retry: check the TCS portal for this order before booking it again.`,
    );
    this.name = 'TcsUnconfirmedBookingError';
  }
}

class TcsHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type TokenEntry = { token: string; exp: number };
// Per-process e-com token cache, seeded from the stored token. Keyed by the
// account identity (username + a fingerprint of the bearer token).
const TOKENS = new Map<string, TokenEntry>();
const INFLIGHT = new Map<string, Promise<string>>();
const ADVICE_IDS = new Map<string, { at: number; ids: Record<ShipperAdviceAction, { actionId: number; detailId: number } | null> }>();

function firstArray(j: any): any[] {
  if (Array.isArray(j)) return j;
  for (const k of ['data', 'detail', 'result', 'details', 'list', 'Data', 'Detail']) {
    if (Array.isArray(j?.[k])) return j[k];
    if (j?.[k] && typeof j[k] === 'object') {
      const inner = firstArray(j[k]);
      if (inner.length) return inner;
    }
  }
  // TCS names its list differently per endpoint (actions, actiondetails,
  // shipperadvicedetails, …) — fall back to the first array value.
  if (j && typeof j === 'object') {
    for (const v of Object.values(j)) if (Array.isArray(v)) return v;
  }
  return [];
}

function pick(o: any, re: RegExp): unknown {
  if (!o || typeof o !== 'object') return undefined;
  for (const [k, v] of Object.entries(o)) if (re.test(k)) return v;
  return undefined;
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

/** Flatten TCS's `{error:[{field:"msg"}], message}` into one readable line. */
export function tcsErrorText(j: any): string {
  const parts: string[] = [];
  if (Array.isArray(j?.error)) {
    for (const e of j.error) {
      if (e && typeof e === 'object') parts.push(...Object.values(e).map((v) => String(v)));
      else if (e) parts.push(String(e));
    }
  }
  const msg = str(j?.message ?? j?.Message ?? j?.MESSAGE ?? j?.response);
  if (msg && !parts.includes(msg)) parts.unshift(msg);
  return parts.filter(Boolean).join('; ') || JSON.stringify(j ?? {}).slice(0, 300);
}

@Injectable()
export class TcsAdapter implements CourierAdapter {
  readonly type: CourierType = 'tcs';
  private readonly logger = new Logger(TcsAdapter.name);
  private sink: TcsTokenSink | null = null;

  /** Wired by TcsTokenStore on boot so refreshed e-com tokens are persisted. */
  setTokenSink(sink: TcsTokenSink): void {
    this.sink = sink;
  }

  // ── Tokens ──────────────────────────────────────────────────────────────

  private expOf(expiry: unknown): number {
    const t = expiry ? new Date(String(expiry)).getTime() : NaN;
    // 5-minute safety margin; unknown expiry → 6 h.
    return Number.isNaN(t) ? Date.now() + 6 * 3600_000 : t - 5 * 60_000;
  }

  private ecomKey(c: TcsCredentials) {
    const b = String(c.bearerToken ?? '');
    return `e:${c.username}:${b.length}:${b.slice(-12)}`;
  }

  /** The merchant-issued bearer token. No auth call at runtime. */
  bearer(c: TcsCredentials): string {
    const t = String(c.bearerToken ?? '').trim();
    if (!t) throw new Error('TCS bearer token not configured — reconnect TCS in Settings › Couriers.');
    return t;
  }

  /** Legacy: turn an old Client ID/Secret into a bearer token (Settings save only). */
  async generateLegacyBearer(clientId: string, clientSecret: string): Promise<string> {
    const q = new URLSearchParams({ ClientID: clientId, ClientSecret: clientSecret });
    const res = await httpFetch(`${TCS_BASE}/auth/api/auth?${q}`, { headers: { Accept: 'application/json' } });
    const j: any = await res.json().catch(() => ({}));
    const token = j?.result?.accessToken ?? j?.result?.accesstoken ?? j?.accessToken;
    if (!res.ok || !token) {
      throw new Error('Could not generate a bearer token from Client ID/Secret — TCS rejected them.');
    }
    return String(token);
  }

  /** Mint a fresh e-com token. Query-string params (TCS ignores GET bodies). */
  private async mintEcom(c: TcsCredentials): Promise<{ token: string; expiry: string | null }> {
    if (!c.username || !c.password) throw new Error('TCS username / password not configured.');
    const q = new URLSearchParams({ username: c.username, password: c.password });
    const res = await httpFetch(`${TCS_BASE}/ecom/api/authentication/token?${q}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${this.bearer(c)}` },
    });
    const j: any = await res.json().catch(() => ({}));
    if (res.status === 401 && /bearer|mismatch configuration/i.test(tcsErrorText(j))) {
      throw new TcsHttpError(401, 'TCS bearer token is invalid — reconnect TCS in Settings › Couriers.');
    }
    const token = j?.accesstoken ?? j?.accessToken ?? j?.result?.accesstoken;
    if (!token) {
      throw new TcsHttpError(res.status || 401, 'Username or password rejected by TCS.');
    }
    const expiry = j?.expiry ?? j?.result?.expiry ?? null;
    return { token: String(token), expiry: expiry ? String(expiry) : null };
  }

  /**
   * The e-com access token, used EXACTLY as TCS returned it (it contains %2F /
   * %2B — never decode or re-encode it). Memory cache → stored token → mint.
   */
  async accessToken(c: TcsCredentials): Promise<string> {
    const key = this.ecomKey(c);
    const hit = TOKENS.get(key);
    if (hit && hit.exp > Date.now()) return hit.token;
    if (c.ecomToken && this.expOf(c.ecomTokenExpiry) > Date.now()) {
      TOKENS.set(key, { token: c.ecomToken, exp: this.expOf(c.ecomTokenExpiry) });
      return c.ecomToken;
    }
    const running = INFLIGHT.get(key);
    if (running) return running;
    const p = this.mintEcom(c)
      .then(async ({ token, expiry }) => {
        TOKENS.set(key, { token, exp: this.expOf(expiry) });
        const id = tcsCredentialId(c);
        if (id && this.sink) await this.sink.save(id, token, expiry).catch(() => undefined);
        return token;
      })
      .finally(() => INFLIGHT.delete(key));
    INFLIGHT.set(key, p);
    return p;
  }

  /** Forget a rejected e-com token (memory + the copy on these creds + stored). */
  private dropEcom(c: TcsCredentials) {
    TOKENS.delete(this.ecomKey(c));
    c.ecomToken = undefined;
    c.ecomTokenExpiry = undefined;
    const id = tcsCredentialId(c);
    if (id && this.sink) void this.sink.clear(id).catch(() => undefined);
  }

  /**
   * One authenticated call to the fixed production host. Bearer header always;
   * GET params in the query string, POST params as JSON. `withAccess` adds the
   * e-com `accesstoken` (appended RAW to a GET query, as-is in a POST body).
   * A 401 "Invalid access token" re-mints the e-com token and retries ONCE; a
   * 401 about the bearer token is final (reconnect needed).
   */
  private async call(
    c: TcsCredentials,
    path: string,
    opts: {
      method?: 'GET' | 'POST';
      query?: Record<string, string | number | boolean | undefined | null>;
      body?: Record<string, unknown>;
      withAccess?: boolean;
      timeoutMs?: number;
      raw?: boolean;
    } = {},
    retried = false,
  ): Promise<{ res: Response; json: any; buf?: Buffer }> {
    const bearer = this.bearer(c);
    const access = opts.withAccess ? await this.accessToken(c) : undefined;
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v != null && v !== '') q.set(k, String(v));
    let qs = q.toString();
    if (access && opts.method !== 'POST') qs = `${qs ? `${qs}&` : ''}accesstoken=${access}`;
    const url = `${TCS_BASE}${path}${qs ? `?${qs}` : ''}`;
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      headers: {
        Accept: opts.raw ? 'application/pdf, application/json' : 'application/json',
        Authorization: `Bearer ${bearer}`,
        ...(opts.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(opts.method === 'POST'
        ? { body: JSON.stringify({ ...(opts.body ?? {}), ...(access ? { accesstoken: access } : {}) }) }
        : {}),
    };
    const res = await httpFetch(url, init, opts.timeoutMs);
    let buf: Buffer | undefined;
    let json: any = null;
    if (opts.raw) {
      buf = Buffer.from(await res.arrayBuffer());
      if (!isPdf(buf)) {
        try {
          json = JSON.parse(buf.toString('utf8'));
        } catch {
          json = null;
        }
      }
    } else {
      const text = await res.text();
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { message: text.slice(0, 300) };
      }
    }
    if (res.status === 401) {
      const why = tcsErrorText(json);
      if (/bearer|mismatch configuration/i.test(why)) {
        throw new TcsHttpError(401, 'TCS bearer token is invalid — reconnect TCS in Settings › Couriers.');
      }
      if (access && !retried) {
        this.dropEcom(c);
        return this.call(c, path, opts, true);
      }
      throw new TcsHttpError(401, `TCS rejected the request: ${maskSecrets(why, c)}`);
    }
    return { res, json, buf };
  }

  /**
   * Connect-time check (never books): (1) the bearer token via a dummy tracking
   * lookup, (2) username/password via a fresh e-com token. Returns the token +
   * expiry to store.
   */
  async validateConnection(c: TcsCredentials): Promise<{ ecomToken: string; expiry: string | null }> {
    const bearer = this.bearer(c);
    const res = await httpFetch(`${TCS_BASE}/tracking/api/Tracking/GetDynamicTrackDetail?consignee=CODESAPPCHECK0`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${bearer}` },
    });
    if (res.status === 401 || res.status === 403) throw new Error('Bearer token is invalid.');
    if (!res.ok) throw new Error(`TCS did not answer the bearer-token check (HTTP ${res.status}).`);
    TOKENS.delete(this.ecomKey(c));
    try {
      const { token, expiry } = await this.mintEcom(c);
      TOKENS.set(this.ecomKey(c), { token, exp: this.expOf(expiry) });
      return { ecomToken: token, expiry };
    } catch (err) {
      const m = (err as Error)?.message || '';
      throw new Error(/bearer/i.test(m) ? 'Bearer token is invalid.' : 'Username or password rejected by TCS.');
    }
  }

  // ── Booking ─────────────────────────────────────────────────────────────

  buildBookingBody(c: TcsCredentials, input: BookShipmentInput): Record<string, unknown> {
    const shipperMobile = toTcsMobile(c.pickupPhone);
    if (!c.accountNo || !c.pickupAddress || !c.pickupCity || shipperMobile.length !== 11) {
      throw new Error(
        'TCS pickup details not configured — set account no, pickup address, city and a 03XXXXXXXXX phone in Settings › Couriers › TCS.',
      );
    }
    const mobile = toTcsMobile(input.destination.phone);
    if (mobile.length < 11 || mobile.length > 14) {
      throw new Error(`Invalid phone for TCS: "${input.destination.phone}" (needs 03XXXXXXXXX).`);
    }
    const addr = splitTcsAddress(input.destination.address1, input.destination.address2);
    if (!addr[0] || addr[0].length < 3) throw new Error('Invalid address for TCS (too short).');
    const cod = Math.max(0, Math.round(Number(input.codAmount) || 0));
    if (cod > TCS_MAX_COD) {
      throw new Error(`Invalid COD for TCS: Rs ${cod} is above TCS's limit of Rs ${TCS_MAX_COD}.`);
    }
    const shipperAddr = splitTcsAddress(c.pickupAddress);
    const weight = Math.max(0.5, Number(c.defaultWeightKg) || 0.5);
    const email = input.email && /\S+@\S+\.\S+/.test(input.email) ? input.email.slice(0, 50) : undefined;
    const cityName = String(input.destination.city || input.destination.cityCode || '').trim();
    const cityCode = String(input.destination.cityCode || '').trim();
    const costCenter = String(c.costCenterCode ?? '').trim();
    if (!costCenter) {
      throw new Error('TCS cost center not configured — set it in Settings › Couriers › TCS.');
    }
    // skus[]: one line per order item (unit price = an even share of COD so the
    // declared value matches what TCS collects); fallback = one line for the order.
    const items = (input.items ?? []).filter((it) => it && it.qty > 0);
    const unitsTotal = items.reduce((n, it) => n + it.qty, 0);
    const perUnit = unitsTotal > 0 ? Math.max(1, Math.round(cod / unitsTotal)) : Math.max(1, cod);
    const skus = items.length
      ? items.slice(0, 50).map((it) => ({
          description: String(it.name || it.sku || 'Item').padEnd(3, '.').slice(0, 200),
          quantity: Math.max(1, Math.round(it.qty)),
          weight: 0.5,
          uom: 'KG',
          unitprice: Math.min(250_000, perUnit),
        }))
      : [
          {
            description: String(input.itemsDescription || 'Order').padEnd(3, '.').slice(0, 200),
            quantity: 1,
            weight,
            uom: 'KG',
            unitprice: Math.min(250_000, Math.max(1, cod)),
          },
        ];
    return {
      consignmentno: null,
      shipperinfo: {
        tcsaccount: c.accountNo,
        shippername: String(c.shipperName || 'Shipper').slice(0, 50),
        address1: shipperAddr[0],
        ...(shipperAddr[1] ? { address2: shipperAddr[1] } : {}),
        ...(shipperAddr[2] ? { address3: shipperAddr[2] } : {}),
        countrycode: 'PK',
        countryname: 'Pakistan',
        ...(c.pickupCityCode ? { citycode: c.pickupCityCode.slice(0, 5) } : {}),
        cityname: c.pickupCity.slice(0, 50),
        mobile: shipperMobile,
      },
      consigneeinfo: {
        ...splitTcsName(input.destination.name),
        address1: addr[0],
        ...(addr[1] ? { address2: addr[1] } : {}),
        ...(addr[2] ? { address3: addr[2] } : {}),
        countrycode: 'PK',
        countryname: 'Pakistan',
        ...(cityCode && cityCode.length <= 5 ? { citycode: cityCode } : {}),
        cityname: cityName.slice(0, 50),
        ...(email ? { email } : {}),
        mobile,
      },
      shipmentinfo: {
        costcentercode: costCenter.slice(0, 20),
        referenceno: String(input.shopifyOrderName).slice(0, 50),
        contentdesc: String(input.itemsDescription || 'Order').slice(0, 999),
        servicecode: String(c.serviceCode || 'O').slice(0, 6),
        currency: 'PKR',
        codamount: cod,
        weightinkg: weight,
        pieces: Math.max(1, Math.round(input.pieces || 1)),
        fragile: false,
        ...(input.notes ? { remarks: String(input.notes).slice(0, 500) } : {}),
        skus,
      },
    };
  }

  async bookShipment(creds: TcsCredentials, input: BookShipmentInput): Promise<BookShipmentResult> {
    const body = this.buildBookingBody(creds, input);
    // Resolve both tokens BEFORE sending, so an auth problem (bad bearer token,
    // rejected password) is reported as such — not as an "unconfirmed booking".
    this.bearer(creds);
    await this.accessToken(creds);
    let res: Response;
    let json: any;
    try {
      ({ res, json } = await this.call(creds, '/ecom/api/booking/create', {
        method: 'POST',
        body,
        withAccess: true,
        timeoutMs: BOOK_TIMEOUT_MS,
      }));
    } catch (err) {
      if (err instanceof TcsHttpError) throw err;
      // Connection never established → TCS never saw it: safe to retry.
      const code = (err as any)?.cause?.code ?? (err as any)?.code;
      if (['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code)) throw err;
      // Timeout / reset AFTER sending: TCS may have created the consignment.
      throw new TcsUnconfirmedBookingError(
        input.shopifyOrderName,
        (err as Error)?.name === 'AbortError' ? 'no reply within 60s' : (err as Error)?.message || 'connection lost',
      );
    }
    const cn = json?.consignmentNo ?? json?.consignmentno ?? json?.ConsignmentNo;
    if (res.ok && cn && json?.status !== false) {
      return { trackingNumber: String(cn), raw: json };
    }
    if (res.status === 502 || res.status === 504) {
      throw new TcsUnconfirmedBookingError(input.shopifyOrderName, `gateway ${res.status}`);
    }
    throw new Error(`TCS booking failed: ${maskSecrets(tcsErrorText(json), creds)}`);
  }

  async cancelShipment(creds: TcsCredentials, trackingNumber: string): Promise<{ ok: boolean; raw: unknown }> {
    const { res, json } = await this.call(creds, '/ecom/api/booking/cancel', {
      method: 'POST',
      body: { consignmentnumber: trackingNumber },
      withAccess: true,
    });
    const msg = str(json?.message ?? json?.Message);
    return { ok: res.ok && /^success/i.test(msg), raw: json };
  }

  /** TCS has no loadsheet API → CodesApp builds its own dispatch manifest. */
  async generateLoadsheet(_creds: TcsCredentials, trackingNumbers: string[]): Promise<GenerateLoadsheetResult> {
    return { loadsheetId: `tcs-manifest-${trackingNumbers.length}`, pdfBuffer: undefined, raw: null };
  }

  /** One `print/label` PDF per consignment. */
  async getLabels(creds: TcsCredentials, trackingNumbers: string[]): Promise<CourierLabelResult> {
    const parts: NonNullable<CourierLabelResult['parts']> = [];
    const raw: unknown[] = [];
    for (const tn of trackingNumbers) {
      try {
        const { buf, json } = await this.call(creds, '/ecom/api/print/label', {
          query: {
            consignmentno: tn,
            shipperDetails: true,
            printtype: Number(creds.labelPrintType) || 2,
          },
          withAccess: true,
          raw: true,
        });
        if (buf && isPdf(buf)) {
          parts.push({ trackingNumber: tn, pdfBuffer: buf });
        } else if (json?.url && /^https?:\/\//i.test(String(json.url))) {
          parts.push({ trackingNumber: tn, url: String(json.url) });
        } else {
          raw.push({ tn, error: maskSecrets(tcsErrorText(json), creds) });
        }
      } catch (err) {
        raw.push({ tn, error: maskSecrets((err as Error)?.message ?? '', creds) });
      }
    }
    if (!parts.length && raw.length) this.logger.warn(`TCS labels failed: ${JSON.stringify(raw).slice(0, 400)}`);
    return { parts, raw };
  }

  // ── Tracking ────────────────────────────────────────────────────────────

  private async track(creds: TcsCredentials, tn: string): Promise<any | null> {
    const { json } = await this.call(creds, '/tracking/api/Tracking/GetDynamicTrackDetail', {
      query: { consignee: tn },
    });
    if (!json || /fail/i.test(str(json?.message)) || (!json.deliveryinfo && !json.checkpoints)) return null;
    return json;
  }

  /** Every event (deliveryinfo + checkpoints), oldest → newest. */
  static events(j: any, cn?: string): Array<{ status: string; code?: string; at?: Date; detail?: string }> {
    const out: Array<{ status: string; code?: string; at?: Date; detail?: string }> = [];
    // GetDynamicTrackDetail also matches REFERENCE numbers, so it can return
    // other parcels — keep only rows for this consignment.
    const mine = (r: any) => !cn || !str(r?.consignmentno) || str(r?.consignmentno) === cn;
    for (const d of Array.isArray(j?.deliveryinfo) ? j.deliveryinfo.filter(mine) : []) {
      const status = str(d?.status);
      if (!status) continue;
      out.push({
        status,
        code: str(d?.code) || undefined,
        at: parseTcsDate(d?.datetime),
        detail: [str(d?.station), d?.recievedby ? `Received by ${str(d.recievedby)}` : '']
          .filter(Boolean)
          .join(' · ') || undefined,
      });
    }
    for (const cp of Array.isArray(j?.checkpoints) ? j.checkpoints.filter(mine) : []) {
      const status = str(cp?.status);
      if (!status) continue;
      const at = parseTcsDate(cp?.datetime);
      // deliveryinfo usually repeats the latest checkpoint — skip exact dups.
      if (out.some((e) => e.at?.getTime() === at?.getTime() && e.status.toLowerCase().includes(status.toLowerCase().replace(/^shipment /, '')))) continue;
      out.push({ status, at, detail: str(cp?.recievedby) || undefined });
    }
    const t = (e: { at?: Date }) => e.at?.getTime() ?? -Infinity;
    return out.sort((a, b) => t(a) - t(b));
  }

  async queryTrackingResult(creds: TcsCredentials, trackingNumber: string): Promise<TrackingProbe> {
    try {
      const j = await this.track(creds, trackingNumber);
      if (!j) return { kind: 'none' };
      const ev = TcsAdapter.events(j, trackingNumber);
      if (!ev.length) return { kind: 'none' };
      // Latest event; on a time tie prefer one carrying a status code.
      const lastT = ev[ev.length - 1].at?.getTime();
      const latest = [...ev].reverse().find((e) => e.at?.getTime() === lastT && e.code) ?? ev[ev.length - 1];
      let mapped: ShipmentStatus | undefined;
      try {
        mapped = mapTcsStatus(latest.status, latest.code);
      } catch {
        mapped = undefined; // let the sync record it as unmapped
      }
      return {
        kind: 'status',
        rawStatus: latest.code ? `${latest.status} (${latest.code})` : latest.status,
        mapped,
        happenedAt: latest.at,
        reason: latest.detail,
      };
    } catch {
      return { kind: 'none' };
    }
  }

  async queryTracking(creds: TcsCredentials, trackingNumber: string) {
    const p = await this.queryTrackingResult(creds, trackingNumber);
    return p.kind === 'status' ? { rawStatus: p.rawStatus, happenedAt: p.happenedAt, reason: p.reason } : null;
  }

  async queryTrackingHistory(creds: TcsCredentials, trackingNumber: string): Promise<TrackingCheckpoint[]> {
    try {
      const j = await this.track(creds, trackingNumber);
      if (!j) return [];
      return TcsAdapter.events(j, trackingNumber).map((e) => ({
        status: e.status,
        detail: e.detail,
        at: e.at?.toISOString(),
      }));
    } catch {
      return [];
    }
  }

  mapStatus(rawStatus: string): ShipmentStatus {
    // rawStatus may carry the code as "Text (CODE)" (see queryTrackingResult).
    const m = /^(.*?)\s*\(([A-Z]{2,4})\)\s*$/.exec(String(rawStatus ?? '').trim());
    return m ? mapTcsStatus(m[1], m[2]) : mapTcsStatus(rawStatus);
  }

  isAddressIssueReason(rawReason: string): boolean {
    return /incorrect address|address (incorrect|not found|incomplete|invalid)|wrong address|no such (address|building|house)|consignee (shifted|moved)|\(CA\)/i.test(
      rawReason,
    );
  }

  isAwaitingShipperAdvice(rawStatus: string, reason?: string): boolean {
    return /shipper advi[cs]e|awaiting (shipper|instruction)|pending (shipper|advice)|hold for (advice|instruction)|need further consignee information|awaiting correct number|\((NC|AN)\)/i.test(
      `${rawStatus} ${reason ?? ''}`,
    );
  }

  // ── Shipper advice ──────────────────────────────────────────────────────

  private async adviceIds(c: TcsCredentials) {
    const key = `${c.accountNo}:${String(c.bearerToken ?? '').slice(-12)}`;
    const hit = ADVICE_IDS.get(key);
    if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.ids;
    const { json } = await this.call(c, '/ecom/api/shipperadvice/getactions', { withAccess: true });
    const actions = firstArray(json).map((a) => ({
      id: Number(pick(a, /^action_?id$|^id$/i) ?? pick(a, /id/i)),
      name: str(pick(a, /name|desc|action$/i)),
    }));
    const ids: Record<ShipperAdviceAction, { actionId: number; detailId: number } | null> = {
      return: null,
      reattempt: null,
    };
    const want: Array<[ShipperAdviceAction, RegExp]> = [
      ['reattempt', /re-?\s*attempt|re-?forward|re-?deliver|deliver again|again/i],
      ['return', /return/i],
    ];
    // Which detail to pick under the action: re-attempt at the SAME address;
    // return = the only detail (RTS).
    const detailWant: Record<ShipperAdviceAction, RegExp> = { reattempt: /same address/i, return: /rts|return/i };
    for (const [kind, re] of want) {
      const a = actions.find((x) => Number.isFinite(x.id) && re.test(x.name));
      if (!a) continue;
      const { json: dj } = await this.call(c, '/ecom/api/shipperadvice/getactiondetailsbyactionid', {
        query: { actionId: a.id },
        withAccess: true,
      });
      const details = firstArray(dj).map((d) => ({
        id: Number(pick(d, /detail_?id$/i) ?? pick(d, /^id$/i) ?? pick(d, /id/i)),
        name: str(pick(d, /name|desc/i)),
      }));
      const d =
        details.find((x) => Number.isFinite(x.id) && detailWant[kind].test(x.name)) ??
        details.find((x) => Number.isFinite(x.id));
      if (d) ids[kind] = { actionId: a.id, detailId: d.id };
    }
    ADVICE_IDS.set(key, { at: Date.now(), ids });
    return ids;
  }

  /** Raw shipper-advice catalogue (Settings → TCS diagnostics). */
  async adviceCatalogue(c: TcsCredentials): Promise<unknown> {
    const { json } = await this.call(c, '/ecom/api/shipperadvice/getactions', { withAccess: true });
    const out: any[] = [];
    for (const a of firstArray(json)) {
      const id = Number(pick(a, /^action_?id$|^id$/i) ?? pick(a, /id/i));
      let details: unknown = null;
      if (Number.isFinite(id)) {
        details = (
          await this.call(c, '/ecom/api/shipperadvice/getactiondetailsbyactionid', {
            query: { actionId: id },
            withAccess: true,
          })
        ).json;
      }
      out.push({ action: a, details });
    }
    return { actions: json, resolved: out };
  }

  async pendingAdvice(c: TcsCredentials): Promise<any[]> {
    const { json } = await this.call(c, '/ecom/api/shipperadvice/pendingtickets', {
      query: { customerno: c.accountNo },
      withAccess: true,
    });
    return firstArray(json);
  }

  async sendShipperAdvice(
    creds: TcsCredentials,
    trackingNumber: string,
    action: ShipperAdviceAction,
    remarks: string,
  ): Promise<{ ok: boolean; raw: unknown; reference?: string }> {
    const ids = (await this.adviceIds(creds))[action];
    if (!ids) {
      return { ok: false, raw: { message: `TCS offers no "${action}" shipper-advice action for this account.` } };
    }
    let ticketno: number | null = null;
    try {
      const t = (await this.pendingAdvice(creds)).find((r) =>
        Object.values(r ?? {}).some((v) => str(v) === trackingNumber),
      );
      const n = Number(pick(t, /ticket/i));
      if (Number.isFinite(n) && n > 0) ticketno = n;
    } catch {
      /* no ticket lookup → null, TCS opens one */
    }
    const { res, json } = await this.call(creds, '/ecom/api/shipperadvice/update', {
      method: 'POST',
      withAccess: true,
      body: {
        customerno: creds.accountNo,
        shipperadvice: {
          consignmentno: trackingNumber,
          ticketno,
          actionid: ids.actionId,
          actiondetailid: ids.detailId,
          remarks: String(remarks || (action === 'return' ? 'Please return to shipper' : 'Please re-attempt delivery'))
            .slice(0, 150),
        },
      },
    });
    const ok = res.ok && (json?.status === true || /success/i.test(str(json?.message)));
    const ref = str(pick(json, /ticket/i)) || (ticketno ? String(ticketno) : '');
    return { ok, raw: json, ...(ref ? { reference: ref } : {}) };
  }

  // ── Setup / payments helpers (not part of CourierAdapter) ───────────────

  async listCities(c: TcsCredentials): Promise<Array<{ code: string; name: string }>> {
    const { json } = await this.call(c, '/ecom/api/setup/citylistbycountry', { query: { countrycode: 'PK' } });
    return firstArray(json)
      .map((r) => ({ code: str(r?.citycode), name: str(r?.cityname) }))
      .filter((r) => r.code && r.name);
  }

  async listCostCenters(c: TcsCredentials): Promise<
    Array<{ code: string; name: string; city: string; phone: string; pickupAddress: string; returnAddress: string }>
  > {
    const { json } = await this.call(c, '/ecom/api/inquiry/costcenterinquiry', {
      query: { customerno: c.accountNo },
      withAccess: true,
    });
    return firstArray(json).map((r) => ({
      code: str(r?.costcentercode),
      name: str(r?.costcentername),
      city: str(r?.costcentercity),
      phone: str(r?.phoneno),
      pickupAddress: str(r?.pickupaddress),
      returnAddress: str(r?.returnaddress),
    }));
  }

  async statusList(c: TcsCredentials): Promise<Array<{ code: string; description: string; mapsTo: string }>> {
    const { json } = await this.call(c, '/ecom/api/setup/deliverystatuslist', {});
    return firstArray(json).map((r) => {
      const code = str(r?.statuscode);
      const description = str(r?.description);
      let mapsTo = 'unmapped';
      try {
        mapsTo = mapTcsStatus(description, code);
      } catch {
        /* unmapped */
      }
      return { code, description, mapsTo };
    });
  }

  /** TCS payment invoice → the normalized statement shape. */
  async getPaymentInvoice(c: TcsCredentials, invoiceNo: string): Promise<ParsedInvoice> {
    const { res, json } = await this.call(c, '/ecom/api/booking/paymentinvoice', {
      query: { invoicenumber: invoiceNo },
      withAccess: true,
      timeoutMs: 90_000,
    });
    const rows = firstArray(json);
    if (!res.ok || !rows.length) {
      throw new Error(`TCS returned no lines for invoice ${invoiceNo}: ${maskSecrets(tcsErrorText(json), c)}`);
    }
    return tcsInvoiceToParsed(invoiceNo, rows);
  }
}

/** Pure: TCS `paymentinvoice` rows → ParsedInvoice (unit-tested). */
export function tcsInvoiceToParsed(invoiceNo: string, rows: any[]): ParsedInvoice {
  const num = (v: unknown) => {
    const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const lines: ParsedInvoiceLine[] = rows
    .filter((r) => str(r?.cnsg_no))
    .map((r) => {
      const status = str(r?.status) || null;
      const cod = num(r?.codamount);
      const charge = num(r?.courier_charges);
      const gst = num(r?.gst);
      let mapped: ShipmentStatus | null = null;
      try {
        mapped = status ? mapTcsStatus(status) : null;
      } catch {
        mapped = null;
      }
      const delivered = mapped === 'delivered';
      return {
        trackingNumber: str(r.cnsg_no),
        clientOrderId: str(r?.cust_ref).replace(/^internet\s+/i, '').replace(/^#/, '') || null,
        status,
        paid: delivered && cod > 0,
        codAmount: delivered ? cod : 0,
        shippingCharge: charge,
        fuelSurcharge: 0,
        gst,
        sst: 0,
        wht: 0,
        netTotal: (delivered ? cod : 0) - charge - gst,
        city: str(r?.dstn) || null,
        customerName: str(r?.consignee).replace(/\s+/g, ' ') || null,
        qty: null,
        createdAt: r?.bkg_dat ? new Date(String(r.bkg_dat)) : null,
        ...(delivered && cod <= 0 ? { needsPrepaidCheck: true } : {}),
      };
    });
  const paid = lines.filter((l) => l.paid);
  const codCollected = lines.reduce((s, l) => s + l.codAmount, 0);
  const shipping = lines.reduce((s, l) => s + l.shippingCharge, 0);
  const tax = lines.reduce((s, l) => s + l.gst, 0);
  const round = (n: number) => Math.round(n * 100) / 100;
  const invoiceNumber = str(rows.find((r) => str(r?.invoiceno))?.invoiceno) || invoiceNo;
  return {
    invoiceNumber,
    reportDate: new Date(),
    currency: 'PKR',
    lines,
    totals: {
      rows: lines.length,
      paidRows: paid.length,
      codCollected: round(codCollected),
      shipping: round(shipping),
      fuel: 0,
      tax: round(tax),
      deductions: round(shipping + tax),
      netPayable: round(codCollected - shipping - tax),
    },
  };
}
