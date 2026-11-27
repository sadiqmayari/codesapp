import { AdPlatformAuthError, AdPlatformRateLimitError } from '../ad-platform.types';
import { httpJson } from '../http';

/**
 * Shared Google Ads REST plumbing for the adapter (read) and writer (manage):
 * token parsing, access-token cache, GAQL searchStream, mutate, error mapping.
 * Pure helpers are exported for unit tests.
 */

export const DEFAULT_API_VERSION = 'v26';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** What an ad account stores (encrypted) as its "token". */
export interface GoogleAccountToken {
  /** OAuth refresh token of the Google user who connected the account. */
  r: string;
  /** Manager (MCC) id to send as login-customer-id, when the account is reached through one. */
  l?: string | null;
  /** The Google Ads customer id (digits). */
  c?: string | null;
}

/** Stored token → parts. Legacy rows hold the bare refresh token. */
export function parseGoogleToken(raw: string): GoogleAccountToken {
  const s = (raw ?? '').trim();
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s) as GoogleAccountToken;
      if (j && typeof j.r === 'string') return { r: j.r, l: digits(j.l), c: digits(j.c) };
    } catch {
      /* fall through */
    }
  }
  return { r: s, l: null, c: null };
}

export function serializeGoogleToken(t: GoogleAccountToken): string {
  return JSON.stringify({ r: t.r, l: digits(t.l), c: digits(t.c) });
}

export function digits(v: unknown): string | null {
  if (v == null) return null;
  const d = String(v).replace(/\D/g, '');
  return d || null;
}

/** Major units → Google micros. */
export const toMicros = (v: number) => Math.round(v * 1_000_000);
export const fromMicros = (v: unknown) => (v == null || v === '' ? null : Number(v) / 1_000_000);

/** YYYY-MM-DD guard for GAQL date literals (never interpolate anything else). */
export function gaqlDate(d: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`Bad date ${d}`);
  return d;
}

/** Numeric id guard for GAQL literals. */
export function gaqlId(id: string): string {
  if (!/^\d{1,20}$/.test(id)) throw new Error(`Bad id ${id}`);
  return id;
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{ errors?: Array<{ errorCode?: Record<string, string>; message?: string }> }>;
  };
}

/** One sentence from a Google Ads error body + the machine code (e.g. DEVELOPER_TOKEN_NOT_APPROVED). */
export function googleErrorOf(body: unknown, status: number): { message: string; code: string | null; http: number } {
  const b = (Array.isArray(body) ? body[0] : body) as GoogleErrorBody | undefined;
  const err = b?.error;
  const first = err?.details?.flatMap((d) => d.errors ?? [])[0];
  const code = first?.errorCode ? Object.values(first.errorCode)[0] ?? null : null;
  const message = first?.message || err?.message || `Google Ads API error ${status}`;
  return { message, code, http: err?.code ?? status };
}

/** Google error → the platform error classes the sync/manage layers understand. */
export function mapGoogleError(body: unknown, status: number): Error {
  const { message, code, http } = googleErrorOf(body, status);
  // Access is per Google Cloud project since the developer-token sunset (2026-09-09):
  // a project on Test access can only reach test accounts.
  if (
    code === 'DEVELOPER_TOKEN_NOT_APPROVED' || code === 'DEVELOPER_TOKEN_PROHIBITED' ||
    /test account|access level|not approved|explorer access/i.test(message) && http === 403
  ) {
    return new AdPlatformAuthError(
      'CodesApp\'s Google Ads API access level is still being upgraded by Google (Test → Explorer/Basic). Only Google Ads test accounts work until then.',
      'permission',
    );
  }
  if (http === 429 || code === 'RESOURCE_EXHAUSTED' || code === 'RESOURCE_TEMPORARILY_EXHAUSTED') {
    return new AdPlatformRateLimitError('Google Ads quota reached; retrying later.', 30 * 60_000);
  }
  if (http === 401 || code === 'OAUTH_TOKEN_EXPIRED' || code === 'OAUTH_TOKEN_REVOKED' || code === 'OAUTH_TOKEN_INVALID') {
    return new AdPlatformAuthError('Google sign-in expired. Reconnect the account in Growth → Connections.', 'token');
  }
  if (code === 'USER_PERMISSION_DENIED' || code === 'CUSTOMER_NOT_ENABLED' || http === 403) {
    return new AdPlatformAuthError(message, 'permission');
  }
  return new AdPlatformAuthError(message.slice(0, 900), 'other');
}

export interface GoogleAdsConfig {
  /** Optional since Google retired developer tokens (2026-09-09); sent only when set. */
  devToken: string;
  clientId: string;
  clientSecret: string;
  version: string;
  /** Env fallback MCC for legacy tokens. */
  defaultLoginCustomerId: string | null;
}

const accessCache = new Map<string, { token: string; until: number }>();

/**
 * OAuth access token for a Google refresh token (Ads AND YouTube share this),
 * cached in-process until ~1 min before Google's expiry.
 */
export async function googleAccessToken(clientId: string, clientSecret: string, refresh: string): Promise<string> {
  const hit = accessCache.get(refresh);
  if (hit && hit.until > Date.now()) return hit.token;
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, client_secret: clientSecret }).toString();
  const res = await httpJson<{ access_token?: string; expires_in?: number; error?: string; error_description?: string }>(
    'POST',
    TOKEN_URL,
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    form,
  );
  if (!res.body.access_token) {
    throw new AdPlatformAuthError(
      res.body.error === 'invalid_grant'
        ? 'Google sign-in was revoked or expired. Reconnect it in Growth → Connections.'
        : `Google rejected the sign-in (${res.body.error_description ?? res.body.error ?? res.status}).`,
      'token',
    );
  }
  const ttl = Math.max(60, (res.body.expires_in ?? 3600) - 60) * 1000;
  accessCache.set(refresh, { token: res.body.access_token, until: Date.now() + ttl });
  return res.body.access_token;
}

/** Thin REST client for one stored account token. */
export class GoogleAdsClient {
  readonly customerId: string | null;
  readonly loginCustomerId: string | null;
  private readonly refresh: string;

  constructor(private readonly cfg: GoogleAdsConfig, token: string | GoogleAccountToken, customerId?: string | null) {
    const t = typeof token === 'string' ? parseGoogleToken(token) : token;
    this.refresh = t.r;
    this.customerId = digits(customerId) ?? t.c ?? null;
    this.loginCustomerId = t.l ?? cfg.defaultLoginCustomerId ?? null;
  }

  get base() {
    return `https://googleads.googleapis.com/${this.cfg.version}`;
  }

  /** Access token from the refresh token (cached per refresh token). */
  access(): Promise<string> {
    return googleAccessToken(this.cfg.clientId, this.cfg.clientSecret, this.refresh);
  }

  async headers(loginCustomerId?: string | null): Promise<Record<string, string>> {
    const login = loginCustomerId === undefined ? this.loginCustomerId : loginCustomerId;
    return {
      Authorization: `Bearer ${await this.access()}`,
      ...(this.cfg.devToken ? { 'developer-token': this.cfg.devToken } : {}),
      ...(login ? { 'login-customer-id': login } : {}),
    };
  }

  private cid(customerId?: string | null): string {
    const c = digits(customerId) ?? this.customerId;
    if (!c) throw new AdPlatformAuthError('This Google Ads account has no customer id. Reconnect it.', 'other');
    return c;
  }

  /** GAQL searchStream → flat result rows. */
  async gaql<T>(query: string, opts: { customerId?: string | null; loginCustomerId?: string | null } = {}): Promise<T[]> {
    const res = await httpJson<unknown>(
      'POST',
      `${this.base}/customers/${this.cid(opts.customerId)}/googleAds:searchStream`,
      await this.headers(opts.loginCustomerId),
      { query },
      60_000,
    );
    const body = res.body as Array<{ results?: T[]; error?: unknown }> | GoogleErrorBody;
    if (res.status >= 400 || !Array.isArray(body) || body.some((b) => b && (b as { error?: unknown }).error)) {
      throw mapGoogleError(body, res.status);
    }
    return body.flatMap((b) => b.results ?? []);
  }

  /** First query that Google accepts (field renames across API versions). */
  async gaqlFirst<T>(queries: string[], opts: { customerId?: string | null } = {}): Promise<T[]> {
    let last: unknown;
    for (const q of queries) {
      try {
        return await this.gaql<T>(q, opts);
      } catch (e) {
        last = e;
        if (!(e instanceof AdPlatformAuthError) || e.kind !== 'other') throw e;
      }
    }
    throw last;
  }

  /** googleAds:mutate (atomic: partialFailure false). Returns per-operation results. */
  async mutate(ops: unknown[], opts: { customerId?: string | null; validateOnly?: boolean } = {}) {
    const res = await httpJson<{ mutateOperationResponses?: Array<Record<string, { resourceName?: string }>> } & GoogleErrorBody>(
      'POST',
      `${this.base}/customers/${this.cid(opts.customerId)}/googleAds:mutate`,
      await this.headers(),
      { mutateOperations: ops, partialFailure: false, validateOnly: !!opts.validateOnly },
      90_000,
    );
    if (res.status >= 400 || res.body.error) throw mapGoogleError(res.body, res.status);
    return (res.body.mutateOperationResponses ?? []).map((r) => Object.values(r)[0]?.resourceName ?? null);
  }

  /** POST to a service path under customers/{cid}/… (e.g. assets:mutate). */
  async post<T>(path: string, body: unknown, opts: { customerId?: string | null } = {}): Promise<T> {
    const res = await httpJson<T & GoogleErrorBody>(
      'POST',
      `${this.base}/customers/${this.cid(opts.customerId)}${path}`,
      await this.headers(),
      body,
      120_000,
    );
    if (res.status >= 400 || (res.body as GoogleErrorBody).error) throw mapGoogleError(res.body, res.status);
    return res.body;
  }

  /** Top-level (non-customer) POST, e.g. geoTargetConstants:suggest. */
  async postRoot<T>(path: string, body: unknown): Promise<T> {
    const res = await httpJson<T & GoogleErrorBody>('POST', `${this.base}${path}`, await this.headers(null), body);
    if (res.status >= 400 || (res.body as GoogleErrorBody).error) throw mapGoogleError(res.body, res.status);
    return res.body;
  }

  /** customers:listAccessibleCustomers → customer ids the signed-in user can reach directly. */
  async accessibleCustomers(): Promise<string[]> {
    const res = await httpJson<{ resourceNames?: string[] } & GoogleErrorBody>(
      'GET',
      `${this.base}/customers:listAccessibleCustomers`,
      await this.headers(null),
    );
    if (res.status >= 400 || res.body.error) throw mapGoogleError(res.body, res.status);
    return (res.body.resourceNames ?? []).map((r) => digits(r.split('/')[1]) ?? '').filter(Boolean);
  }
}

/** Google enum status → the Meta-style vocabulary Growth filters on. */
export function gStatus(s: string | null | undefined): string | null {
  if (!s) return null;
  const u = s.toUpperCase();
  if (u === 'ENABLED') return 'ACTIVE';
  if (u === 'PAUSED') return 'PAUSED';
  if (u === 'REMOVED') return 'DELETED';
  return u;
}

/**
 * Google bidding → the normalised BidStrategy + amounts Growth stores.
 * Value-based strategies set optimizationGoal 'VALUE' so the writer keeps the family.
 */
export function normaliseBidding(c: {
  biddingStrategyType?: string;
  targetCpa?: { targetCpaMicros?: string };
  targetRoas?: { targetRoas?: number };
  maximizeConversions?: { targetCpaMicros?: string };
  maximizeConversionValue?: { targetRoas?: number };
}): { bidStrategy: string | null; bidAmount: number | null; roasFloor: number | null; optimizationGoal: string | null } {
  const t = (c.biddingStrategyType ?? '').toUpperCase();
  const cpa = fromMicros(c.maximizeConversions?.targetCpaMicros ?? c.targetCpa?.targetCpaMicros);
  const roas = c.maximizeConversionValue?.targetRoas ?? c.targetRoas?.targetRoas ?? null;
  if (t === 'MAXIMIZE_CONVERSION_VALUE' || t === 'TARGET_ROAS') {
    return roas ? { bidStrategy: 'LOWEST_COST_WITH_MIN_ROAS', bidAmount: null, roasFloor: Number(roas), optimizationGoal: 'VALUE' }
      : { bidStrategy: 'LOWEST_COST_WITHOUT_CAP', bidAmount: null, roasFloor: null, optimizationGoal: 'VALUE' };
  }
  if (t === 'MAXIMIZE_CONVERSIONS' || t === 'TARGET_CPA') {
    return cpa ? { bidStrategy: 'COST_CAP', bidAmount: cpa, roasFloor: null, optimizationGoal: 'OFFSITE_CONVERSIONS' }
      : { bidStrategy: 'LOWEST_COST_WITHOUT_CAP', bidAmount: null, roasFloor: null, optimizationGoal: 'OFFSITE_CONVERSIONS' };
  }
  return { bidStrategy: t || null, bidAmount: null, roasFloor: null, optimizationGoal: null };
}

/** Country code → Google geo target constant (the common ones; others resolved by suggest). */
export const GEO_COUNTRY: Record<string, string> = {
  PK: '2586', AE: '2784', SA: '2682', US: '2840', GB: '2826', IN: '2356', CA: '2124', AU: '2036', QA: '2634', OM: '2512', KW: '2414', BH: '2048',
};

/** Language constants (English, Urdu, Arabic, Hindi). */
export const LANGUAGE: Record<string, string> = { en: '1000', ur: '1041', ar: '1019', hi: '1023' };
