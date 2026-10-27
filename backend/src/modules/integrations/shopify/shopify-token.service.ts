import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as https from 'https';
import { EncryptionService } from '../../../common/services/encryption.service';
import { CacheService } from '../../../common/services/cache.service';

/**
 * Minimal shape of a shopify_stores row needed to obtain an Admin API token.
 * Passed in by each caller (which already loads the store) so this service holds
 * no Prisma dependency and can be injected anywhere without a module cycle.
 */
export interface StoreTokenSource {
  id: number;
  auth_mode?: string | null;
  shop_domain: string;
  admin_token_encrypted: string;
  client_id_encrypted?: string | null;
  client_secret_encrypted?: string | null;
}

const TOKEN_TIMEOUT_MS = 10_000;
// Refresh this many seconds before Shopify's stated expiry, so a token is never
// handed out within the danger window (clock skew / in-flight requests).
const EXPIRY_SKEW_SECONDS = 60;
// Fallback TTL if Shopify ever omits expires_in (the doc says it's always
// 86399 ≈ 24h, but never trust a single field).
const DEFAULT_EXPIRES_IN = 86_400;

/**
 * Resolves the Shopify Admin API access token for a store, abstracting the two
 * auth models:
 *   - 'legacy'             → a permanent admin custom-app token, decrypted from
 *                            the stored column (unchanged behaviour).
 *   - 'client_credentials' → a Dev Dashboard app; mint a short-lived (~24h)
 *                            token from the stored client_id/secret, cache it
 *                            in-process until ~60s before expiry, and re-mint on
 *                            demand. The minted token is NEVER persisted.
 *
 * This is the single source of truth for store token resolution — every caller
 * that used to `encryption.decrypt(admin_token_encrypted)` goes through
 * `resolveStoreToken` instead, so the client-credentials path is picked up
 * everywhere (orders, products, webhooks, fulfilment, sync) without touching
 * the GraphQL helper or any call site.
 */
@Injectable()
export class ShopifyTokenService {
  private readonly logger = new Logger(ShopifyTokenService.name);
  // Single-flight: collapse concurrent mints for the same store into one request
  // so a burst of parallel calls doesn't hammer the token endpoint.
  private readonly inflight = new Map<number, Promise<string>>();

  constructor(
    private readonly encryption: EncryptionService,
    private readonly cache: CacheService,
  ) {}

  /** Resolve the Admin API token for a store (legacy decrypt or CC mint+cache). */
  async resolveStoreToken(store: StoreTokenSource): Promise<string> {
    if ((store.auth_mode ?? 'legacy') !== 'client_credentials') {
      return this.encryption.decrypt(store.admin_token_encrypted);
    }
    const cacheKey = this.cacheKey(store.id);
    const cached = this.cache.get<string>(cacheKey);
    if (cached) return cached;

    const existing = this.inflight.get(store.id);
    if (existing) return existing;

    const p = this.mintForStore(store, cacheKey).finally(() =>
      this.inflight.delete(store.id),
    );
    this.inflight.set(store.id, p);
    return p;
  }

  /** Drop a client-credentials store's cached token (e.g. after a 401). */
  invalidateToken(storeId: number): void {
    this.cache.del(this.cacheKey(storeId));
  }

  /**
   * Validate a client ID/secret against a store by minting a token once, and
   * return the granted scopes. Used at save time so broken credentials are
   * rejected immediately (and a missing scope is visible). Also primes the
   * cache so the first real call doesn't have to mint again.
   */
  async validateCredentials(
    shopDomain: string,
    clientId: string,
    clientSecret: string,
    storeIdToPrime?: number,
  ): Promise<{ scope: string }> {
    const minted = await this.mint(
      this.normalizeDomain(shopDomain),
      clientId,
      clientSecret,
    );
    if (storeIdToPrime != null) {
      const ttl = Math.max(
        EXPIRY_SKEW_SECONDS,
        minted.expiresIn - EXPIRY_SKEW_SECONDS,
      );
      this.cache.set(this.cacheKey(storeIdToPrime), minted.accessToken, ttl);
    }
    return { scope: minted.scope };
  }

  private cacheKey(storeId: number): string {
    return `shopifyCcToken:${storeId}`;
  }

  private async mintForStore(
    store: StoreTokenSource,
    cacheKey: string,
  ): Promise<string> {
    const clientId = store.client_id_encrypted
      ? this.encryption.decrypt(store.client_id_encrypted)
      : '';
    const clientSecret = store.client_secret_encrypted
      ? this.encryption.decrypt(store.client_secret_encrypted)
      : '';
    if (!clientId || !clientSecret) {
      throw new ServiceUnavailableException(
        'This store uses client-credentials auth but has no Client ID/secret set.',
      );
    }
    const shopDomain = this.normalizeDomain(store.shop_domain);
    if (!shopDomain) {
      throw new ServiceUnavailableException('No Shopify store domain set.');
    }
    const minted = await this.mint(shopDomain, clientId, clientSecret);
    const ttl = Math.max(
      EXPIRY_SKEW_SECONDS,
      minted.expiresIn - EXPIRY_SKEW_SECONDS,
    );
    this.cache.set(cacheKey, minted.accessToken, ttl);
    this.logger.log(
      `Minted client-credentials token for store ${store.id} (${shopDomain}); expires_in=${minted.expiresIn}s`,
    );
    return minted.accessToken;
  }

  /** POST the client_credentials grant; parse access_token/expires_in/scope. */
  private async mint(
    shopDomain: string,
    clientId: string,
    clientSecret: string,
  ): Promise<{ accessToken: string; expiresIn: number; scope: string }> {
    const body =
      `grant_type=client_credentials` +
      `&client_id=${encodeURIComponent(clientId)}` +
      `&client_secret=${encodeURIComponent(clientSecret)}`;
    const { status, raw } = await this.postToken(shopDomain, body);
    let parsed: {
      access_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    } = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* non-JSON body handled below */
    }
    if (status === 200 && parsed.access_token) {
      return {
        accessToken: parsed.access_token,
        expiresIn: Number(parsed.expires_in) || DEFAULT_EXPIRES_IN,
        scope: parsed.scope ?? '',
      };
    }
    const desc =
      parsed.error_description ||
      parsed.error ||
      (raw ? raw.slice(0, 200) : `HTTP ${status}`);
    throw new BadRequestException(
      `Shopify client-credentials token request failed: ${desc}`,
    );
  }

  private postToken(
    shopDomain: string,
    body: string,
  ): Promise<{ status: number; raw: string }> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: shopDomain,
          method: 'POST',
          path: '/admin/oauth/access_token',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
            'content-length': Buffer.byteLength(body),
          },
          timeout: TOKEN_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              raw: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('timeout', () =>
        req.destroy(new Error('Shopify token request timed out')),
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private normalizeDomain(raw: string | null | undefined): string {
    return (raw || '')
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .trim();
  }
}
