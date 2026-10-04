import { Injectable, Logger, OnModuleInit, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import { URL } from 'url';
import { PrismaService } from '../../../prisma/prisma.service';
import { EncryptionService } from '../../../common/services/encryption.service';
import { AiRagService } from '../../ai/ai-rag.service';
import { OrderIdempotencyService } from '../../../common/services/order-idempotency.service';
import { JobQueueService } from '../../../common/services/job-queue.service';
import { ShopifyOrderSyncService } from '../shopify/shopify-order-sync.service';

interface WooJob {
  kind: 'syncKnowledge';
  companyId: number;
  storeId?: number;
}
import {
  CommerceProvider,
  CreateCustomerInput,
  CreateOrderInput,
  CreateOrderResult,
  CustomerHit,
  CustomerOrdersResult,
  LastOrderItemsResult,
  NormalizedOrderEvent,
  OrderStatusResult,
  ProductHit,
  ShippingRate,
  ShippingRateInput,
  SyncKnowledgeResult,
} from './commerce-provider.interface';

const WC_TIMEOUT_MS = 15000;
const RAG_DESC_CHARS = 1500;

interface WooApi {
  baseUrl: string; // normalized, no trailing slash
  key: string;
  secret: string;
  storeId: number;
}

/**
 * WooCommerceService — a CommerceProvider implementation over the WooCommerce
 * REST API v3 (`/wp-json/wc/v3/...`). Credentials are a consumer key/secret pair
 * stored encrypted on the `shopify_stores` row (base_url + wc_*). It mirrors the
 * ShopifyService method surface + return shapes so the resolver can hand it to
 * the same AI agent / create-order modal / couriers without any caller branching.
 *
 * Woo differences handled here:
 *  - order create is a single POST /orders (no draft/complete two-step);
 *  - there is NO cart shipping-calc endpoint, so rates come from configured
 *    shipping zones/methods (a documented parity gap vs Shopify);
 *  - webhook auth is base64 HMAC-SHA256 of the raw body in x-wc-webhook-signature.
 */
@Injectable()
export class WooCommerceService implements CommerceProvider, OnModuleInit {
  readonly kind = 'woocommerce' as const;
  private readonly logger = new Logger(WooCommerceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly rag: AiRagService,
    private readonly idempotency: OrderIdempotencyService,
    private readonly orderSync: ShopifyOrderSyncService,
    private readonly jobQueue: JobQueueService,
  ) {}

  onModuleInit(): void {
    // Dedicated queue — a full catalogue sync (paginated fetch + embeddings +
    // inserts) exceeds the HTTP request budget, so it must run in the background.
    this.jobQueue.registerWorker(
      'woocommerce',
      (p) => this.processJob(p as WooJob),
      2,
      120,
    );
    this.logger.log('Registered woocommerce worker (concurrency=2, lease=120s)');
  }

  private async processJob(job: WooJob): Promise<void> {
    if (job.kind === 'syncKnowledge') {
      const res = await this.syncKnowledge(job.companyId, job.storeId);
      this.logger.log(
        `Woo KB sync (company ${job.companyId}): ${res.products} products, mode=${res.mode}`,
      );
    }
  }

  /** Enqueue a background knowledge sync (validates the connection first). */
  async requestKnowledgeSync(companyId: number, storeId?: number): Promise<{ started: boolean }> {
    await this.requireApi(companyId, storeId); // clean 4xx if unconfigured
    await this.jobQueue.enqueue('woocommerce', { kind: 'syncKnowledge', companyId, storeId });
    return { started: true };
  }

  // ── Inbound webhook handling ───────────────────────────────────────────────

  /**
   * Full receiver for a per-store Woo webhook: resolve the store by webhook_key,
   * verify the HMAC with that store's secret, parse the order, and upsert the
   * orders mirror. Never throws (returns {ok:false}); the controller always 200s
   * so Woo does not disable the webhook on a transient error.
   */
  async handleWebhook(
    key: string,
    topic: string,
    signature: string,
    rawBody: Buffer,
  ): Promise<{ ok: boolean }> {
    try {
      const store = await this.prisma.shopifyStore.findFirst({
        where: { webhook_key: key, provider: 'woocommerce' },
      });
      if (!store) return { ok: false };
      // A store with no configured secret can't be authenticated — reject.
      if (!store.webhook_secret_encrypted) return { ok: false };
      const secret = this.encryption.decrypt(store.webhook_secret_encrypted);
      if (!this.verifyWebhook(rawBody, signature, secret)) return { ok: false };

      let body: unknown;
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return { ok: false };
      }
      const event = this.parseWebhook(topic, body);
      if (!event) return { ok: true }; // nothing actionable, but authentic

      await this.mirrorOrder(store.company_id, store.id, event);
      return { ok: true };
    } catch (e) {
      this.logger.warn(`Woo handleWebhook: ${(e as Error)?.message}`);
      return { ok: false };
    }
  }

  private async mirrorOrder(
    companyId: number,
    storeId: number,
    event: { nativeId: string; raw: unknown },
  ): Promise<void> {
    const o = event.raw as any;
    const orderGid = `woo://${storeId}/${event.nativeId}`;
    const b = o.billing || {};
    const sh = o.shipping || {};
    const name = [sh.first_name || b.first_name, sh.last_name || b.last_name].filter(Boolean).join(' ');
    const paid = !!o.date_paid;
    await this.orderSync.upsertOrder(
      companyId,
      {
        orderGid,
        orderName: `#${o.number ?? event.nativeId}`,
        orderNumber: String(o.number ?? event.nativeId),
        customerName: name || null,
        phone: sh.phone || b.phone || null,
        email: b.email || null,
        city: sh.city || b.city || null,
        address1: sh.address_1 || b.address_1 || null,
        address2: sh.address_2 || b.address_2 || null,
        countryCode: sh.country || b.country || null,
        totalPrice: this.num(o.total),
        totalOutstanding: paid ? 0 : this.num(o.total),
        currency: o.currency || null,
        financialStatus: paid ? 'paid' : 'pending',
        paymentGateway: o.payment_method || null,
        fulfillmentStatus: o.status === 'completed' ? 'fulfilled' : 'unfulfilled',
        lineItems: o.line_items ?? undefined,
        lineItemsSummary: (o.line_items || [])
          .map((li: any) => `${li.quantity}× ${li.name}`)
          .join(', '),
        shopifyCreatedAt: o.date_created_gmt ? new Date(`${o.date_created_gmt}Z`) : null,
        cancelledAt: o.status === 'cancelled' && o.date_modified_gmt ? new Date(`${o.date_modified_gmt}Z`) : null,
      },
      'webhook',
      storeId,
      'woocommerce',
    );
  }

  // ── Credential resolution ────────────────────────────────────────────────

  /** Resolve the Woo API creds for a store (explicit id → that store; else the
   *  company's primary active Woo store). Throws clean 4xx when unconfigured. */
  private async requireApi(companyId: number, storeId?: number): Promise<WooApi> {
    const where = storeId
      ? { id: storeId, company_id: companyId }
      : { company_id: companyId, provider: 'woocommerce', status: 'active' as const };
    const store = storeId
      ? await this.prisma.shopifyStore.findFirst({ where })
      : await this.prisma.shopifyStore.findFirst({
          where,
          orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
        });
    if (!store || store.provider !== 'woocommerce') {
      throw new BadRequestException('No WooCommerce store connected.');
    }
    if (!store.base_url || !store.wc_consumer_key_encrypted || !store.wc_consumer_secret_encrypted) {
      throw new ServiceUnavailableException('WooCommerce store is missing credentials.');
    }
    return {
      baseUrl: this.normalizeBaseUrl(store.base_url),
      key: this.encryption.decrypt(store.wc_consumer_key_encrypted),
      secret: this.encryption.decrypt(store.wc_consumer_secret_encrypted),
      storeId: store.id,
    };
  }

  private normalizeBaseUrl(raw: string): string {
    let u = (raw || '').trim();
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    return u.replace(/\/+$/, '');
  }

  // ── REST transport ─────────────────────────────────────────────────────────

  private request<T = any>(
    api: WooApi,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    query?: Record<string, string | number | undefined>,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(`${api.baseUrl}/wp-json/wc/v3/${path.replace(/^\/+/, '')}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const auth = 'Basic ' + Buffer.from(`${api.key}:${api.secret}`).toString('base64');
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    return new Promise<T>((resolve, reject) => {
      const req = lib.request(
        url,
        {
          method,
          headers: {
            Authorization: auth,
            Accept: 'application/json',
            ...(payload
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
              : {}),
          },
          timeout: WC_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode || 0;
            if (status >= 200 && status < 300) {
              try {
                resolve((text ? JSON.parse(text) : {}) as T);
              } catch {
                reject(new Error(`WooCommerce: invalid JSON (${status})`));
              }
              return;
            }
            let msg = `WooCommerce API ${status}`;
            try {
              const j = JSON.parse(text);
              if (j?.message) msg += `: ${j.message}`;
            } catch {
              /* ignore */
            }
            reject(new Error(msg));
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('WooCommerce request timed out')));
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ── Products ─────────────────────────────────────────────────────────────

  async searchProducts(
    companyId: number,
    query: string,
    includeUnlisted = false,
    storeId?: number,
  ): Promise<ProductHit[]> {
    const api = await this.requireApi(companyId, storeId);
    const status = includeUnlisted ? undefined : 'publish';
    const products = await this.request<any[]>(api, 'GET', 'products', {
      search: (query || '').trim(),
      status,
      per_page: 20,
    });
    const hits: ProductHit[] = [];
    for (const p of products || []) {
      if (p.type === 'variable' && Array.isArray(p.variations) && p.variations.length) {
        // Pull real variations so each sellable unit is addressable by id.
        let variations: any[] = [];
        try {
          variations = await this.request<any[]>(api, 'GET', `products/${p.id}/variations`, {
            per_page: 50,
          });
        } catch {
          variations = [];
        }
        for (const v of variations) hits.push(this.toHit(p, v));
        if (!variations.length) hits.push(this.toHit(p, null));
      } else {
        hits.push(this.toHit(p, null));
      }
    }
    return hits;
  }

  private toHit(p: any, v: any | null): ProductHit {
    const regular = this.num(v?.regular_price ?? p.regular_price);
    const sale = this.num(v?.sale_price ?? p.sale_price);
    const price = this.str(v?.price ?? p.price ?? sale ?? regular);
    const compareAt = regular && sale && regular > sale ? this.str(regular) : null;
    const discountPercent =
      regular && sale && regular > sale ? Math.round(((regular - sale) / regular) * 100) : null;
    const variantTitle = v
      ? (v.attributes || []).map((a: any) => a.option).filter(Boolean).join(' / ')
      : '';
    const image = v?.image?.src || p.images?.[0]?.src || null;
    const stockStatus = (v?.stock_status ?? p.stock_status) as string | undefined;
    return {
      variantId: String(v?.id ?? p.id),
      productTitle: p.name || '',
      variantTitle: variantTitle || '',
      description: this.stripHtml(p.short_description || p.description || '') || null,
      price: price || '0',
      compareAtPrice: compareAt,
      discountPercent,
      sku: (v?.sku || p.sku || null) as string | null,
      image,
      productUrl: p.permalink || null,
      available: stockStatus ? stockStatus === 'instock' : true,
    };
  }

  // ── Orders ─────────────────────────────────────────────────────────────────

  async createOrder(
    companyId: number,
    dto: CreateOrderInput,
    _createdByUserId?: number,
  ): Promise<CreateOrderResult> {
    // Honour the tenant's fixed-order-store lock, same as Shopify.
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { order_fixed_store_id: true },
    });
    const effectiveStoreId = company?.order_fixed_store_id ?? dto.storeId;
    const api = await this.requireApi(companyId, effectiveStoreId);

    const idemHash = OrderIdempotencyService.computeHash({
      phone: dto.phone,
      address1: dto.address1,
      city: dto.city,
      countryCode: dto.countryCode,
      lineItems: dto.lineItems,
      prepaid: dto.prepaid,
      identityFallback: dto.conversationId ?? null,
    });
    let reservationId = -1;
    if (idemHash) {
      const reservation = await this.idempotency.reserve(
        companyId,
        dto.conversationId ?? null,
        idemHash,
      );
      if (reservation.kind === 'duplicate') {
        this.logger.warn(
          `Woo order create de-duplicated (company ${companyId}) → returning ${reservation.order.orderName}`,
        );
        return reservation.order;
      }
      reservationId = reservation.reservationId;
      if (api.storeId && reservationId > 0) {
        await this.prisma.pendingOrderHash
          .update({ where: { id: reservationId }, data: { shopify_store_id: api.storeId } })
          .catch(() => undefined);
      }
    }

    try {
      const names = (dto.customerName || '').trim().split(/\s+/).filter(Boolean);
      const firstName = names.shift() || '';
      const lastName = names.join(' ');
      const address = {
        first_name: firstName,
        last_name: lastName,
        address_1: dto.address1 || '',
        city: dto.city || '',
        country: dto.countryCode || '',
        phone: dto.phone || '',
        email: dto.email || '',
      };
      const lineItems = dto.lineItems.map((li) => {
        const base: Record<string, unknown> = { quantity: li.quantity };
        if (li.variantId) {
          // Woo variation ids differ from product ids; the REST API accepts a
          // variation_id alongside its parent product_id, but a bare id also
          // works as product_id for simple products. We send both-safe.
          base.product_id = Number(li.variantId);
        } else if (li.title) {
          base.name = li.title;
          base.total = String((li.price ?? 0) * li.quantity);
        }
        return base;
      });

      const feeLines: Array<Record<string, unknown>> = [];
      if (dto.orderDiscount) {
        // Woo order-level discounts are expressed as a negative fee line (coupons
        // need a pre-created code; a fee keeps it self-contained).
        const amount =
          dto.orderDiscount.type === 'percentage'
            ? undefined // computed below once subtotal is known server-side; omit for safety
            : dto.orderDiscount.value;
        if (amount) feeLines.push({ name: 'Discount', total: String(-Math.abs(amount)) });
      }

      const body: Record<string, unknown> = {
        payment_method: dto.prepaid ? 'prepaid' : 'cod',
        payment_method_title: dto.prepaid ? 'Prepaid' : 'Cash on Delivery',
        set_paid: !!dto.prepaid,
        status: dto.prepaid ? 'processing' : 'pending',
        billing: address,
        shipping: address,
        line_items: lineItems,
        customer_note: dto.note || '',
      };
      if (dto.customerId) body.customer_id = Number(dto.customerId);
      if (feeLines.length) body.fee_lines = feeLines;
      if (dto.shippingLine) {
        body.shipping_lines = [
          { method_id: 'flat_rate', method_title: dto.shippingLine.title, total: String(dto.shippingLine.price) },
        ];
      }

      const order = await this.request<any>(api, 'POST', 'orders', undefined, body);
      const orderId = `woo://${api.storeId}/${order.id}`;
      const orderName = `#${order.number ?? order.id}`;
      const adminUrl = `${api.baseUrl}/wp-admin/post.php?post=${order.id}&action=edit`;
      const ref = { orderId, orderName, adminUrl };

      await this.idempotency
        .finalize(
          reservationId,
          ref,
          { total: order.total ?? null, currency: order.currency ?? null },
          dto.source === 'abandoned_cart' ? 'abandoned_cart' : 'inbox',
        )
        .catch(() => undefined);
      return ref;
    } catch (e) {
      await this.idempotency.release(reservationId).catch(() => undefined);
      throw e;
    }
  }

  async cancelOrder(companyId: number, orderGid: string, storeId?: number): Promise<void> {
    const api = await this.requireApi(companyId, storeId);
    const nativeId = this.nativeIdFromGid(orderGid);
    if (!nativeId) return;
    await this.request(api, 'PUT', `orders/${nativeId}`, undefined, { status: 'cancelled' }).catch(
      (e) => this.logger.warn(`Woo cancelOrder ${orderGid}: ${e?.message}`),
    );
  }

  private nativeIdFromGid(gid: string): string | null {
    const m = /^woo:\/\/\d+\/(\d+)$/.exec(gid || '');
    return m ? m[1] : /^\d+$/.test(gid) ? gid : null;
  }

  async getOrderStatus(companyId: number, orderNumber: string): Promise<OrderStatusResult> {
    const api = await this.requireApi(companyId);
    const num = (orderNumber || '').replace(/^#/, '').trim();
    try {
      const matches = await this.request<any[]>(api, 'GET', 'orders', { search: num, per_page: 5 });
      const order = (matches || []).find((o) => String(o.number) === num || String(o.id) === num) || matches?.[0];
      if (!order) return { found: false };
      return {
        found: true,
        name: `#${order.number}`,
        orderId: `woo://${api.storeId}/${order.id}`,
        adminUrl: `${api.baseUrl}/wp-admin/post.php?post=${order.id}&action=edit`,
        fulfillmentStatus: order.status,
        financialStatus: order.status === 'completed' || order.date_paid ? 'paid' : 'pending',
        statusUpdatedAt: order.date_modified_gmt ? `${order.date_modified_gmt}Z` : null,
        customerPhone: order.billing?.phone || null,
        customerEmail: order.billing?.email || null,
        shippingPhone: order.shipping?.phone || null,
      };
    } catch (e) {
      this.logger.warn(`Woo getOrderStatus: ${(e as Error)?.message}`);
      return { found: false, error: true };
    }
  }

  // ── Customers ────────────────────────────────────────────────────────────

  async searchCustomer(
    companyId: number,
    params: { phone?: string; email?: string },
    storeId?: number,
  ): Promise<CustomerHit[]> {
    const api = await this.requireApi(companyId, storeId);
    const email = (params.email || '').trim();
    const results: CustomerHit[] = [];
    try {
      if (email) {
        const byEmail = await this.request<any[]>(api, 'GET', 'customers', { email, per_page: 5 });
        for (const c of byEmail || []) results.push(this.toCustomer(c));
      }
      if (!results.length && params.phone) {
        const bySearch = await this.request<any[]>(api, 'GET', 'customers', {
          search: params.phone,
          per_page: 5,
        });
        for (const c of bySearch || []) results.push(this.toCustomer(c));
      }
    } catch (e) {
      this.logger.warn(`Woo searchCustomer: ${(e as Error)?.message}`);
    }
    return results;
  }

  async createCustomer(
    companyId: number,
    dto: CreateCustomerInput,
    storeId?: number,
  ): Promise<CustomerHit> {
    const api = await this.requireApi(companyId, storeId);
    const names = (dto.customerName || '').trim().split(/\s+/).filter(Boolean);
    const firstName = names.shift() || '';
    const lastName = names.join(' ');
    const phone = dto.phone ? `+${dto.phone.replace(/\D/g, '')}` : '';
    const email = (dto.email || '').trim() || `${phone.replace(/\D/g, '') || Date.now()}@no-email.invalid`;
    const created = await this.request<any>(api, 'POST', 'customers', undefined, {
      email,
      first_name: firstName,
      last_name: lastName,
      billing: {
        first_name: firstName,
        last_name: lastName,
        phone,
        email,
        address_1: dto.address1 || '',
        city: dto.city || '',
        country: dto.countryCode || '',
      },
    });
    return this.toCustomer(created);
  }

  private toCustomer(c: any): CustomerHit {
    return {
      id: String(c.id),
      firstName: c.first_name || null,
      lastName: c.last_name || null,
      email: c.email || null,
      phone: c.billing?.phone || null,
    };
  }

  async getCustomerOrders(companyId: number, phone: string, email?: string): Promise<CustomerOrdersResult> {
    const api = await this.requireApi(companyId);
    const matches = await this.searchCustomer(companyId, { phone, email });
    const cust = matches[0];
    if (!cust) return { found: false, orders: [] };
    try {
      const orders = await this.request<any[]>(api, 'GET', 'orders', {
        customer: cust.id,
        per_page: 10,
        orderby: 'date',
        order: 'desc',
      });
      return {
        found: true,
        name: [cust.firstName, cust.lastName].filter(Boolean).join(' ') || null,
        email: cust.email,
        orders: (orders || []).map((o) => ({
          name: `#${o.number}`,
          createdAt: o.date_created_gmt ? `${o.date_created_gmt}Z` : '',
          fulfillment: o.status,
          financial: o.date_paid ? 'paid' : 'pending',
          total: o.total,
        })),
      };
    } catch {
      return { found: false, orders: [] };
    }
  }

  async getLastOrderItems(companyId: number, phone: string, email?: string): Promise<LastOrderItemsResult> {
    const api = await this.requireApi(companyId);
    const matches = await this.searchCustomer(companyId, { phone, email });
    const cust = matches[0];
    if (!cust) return { found: false, items: [] };
    try {
      const orders = await this.request<any[]>(api, 'GET', 'orders', {
        customer: cust.id,
        per_page: 1,
        orderby: 'date',
        order: 'desc',
      });
      const o = orders?.[0];
      if (!o) return { found: false, items: [] };
      return {
        found: true,
        name: [cust.firstName, cust.lastName].filter(Boolean).join(' ') || undefined,
        shipping: {
          name: [o.shipping?.first_name, o.shipping?.last_name].filter(Boolean).join(' '),
          phone: o.shipping?.phone || o.billing?.phone,
          address1: o.shipping?.address_1 || o.billing?.address_1,
          city: o.shipping?.city || o.billing?.city,
          countryCode: o.shipping?.country || o.billing?.country,
        },
        items: (o.line_items || []).map((li: any) => ({
          title: li.name,
          quantity: li.quantity,
          variantId: li.variation_id ? String(li.variation_id) : li.product_id ? String(li.product_id) : undefined,
        })),
      };
    } catch {
      return { found: false, items: [] };
    }
  }

  // ── Shipping ───────────────────────────────────────────────────────────────

  async getShippingRates(
    companyId: number,
    _dto: ShippingRateInput,
    storeId?: number,
  ): Promise<ShippingRate[]> {
    const api = await this.requireApi(companyId, storeId);
    // Woo has no cart shipping-calc REST endpoint. Return the store's configured
    // flat/free rates across all zones. [] is valid (not an error).
    try {
      const zones = await this.request<any[]>(api, 'GET', 'shipping/zones');
      const rates: ShippingRate[] = [];
      for (const z of zones || []) {
        let methods: any[] = [];
        try {
          methods = await this.request<any[]>(api, 'GET', `shipping/zones/${z.id}/methods`);
        } catch {
          methods = [];
        }
        for (const m of methods) {
          if (m.enabled === false) continue;
          const cost = m.settings?.cost?.value ?? '0';
          rates.push({
            handle: `${z.id}:${m.instance_id}`,
            title: m.title || m.method_title || 'Shipping',
            amount: String(cost || 0),
            currencyCode: '',
          });
        }
      }
      // De-dup identical title+amount pairs across zones.
      const seen = new Set<string>();
      return rates.filter((r) => {
        const k = `${r.title}|${r.amount}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    } catch (e) {
      this.logger.warn(`Woo getShippingRates: ${(e as Error)?.message}`);
      return [];
    }
  }

  // ── Knowledge sync (RAG) ─────────────────────────────────────────────────

  async syncKnowledge(companyId: number, storeId?: number): Promise<SyncKnowledgeResult> {
    const api = await this.requireApi(companyId, storeId);
    const productItems: { sourceId: string; title: string; content: string }[] = [];
    let page = 1;
    const maxPages = 15;
    while (page <= maxPages) {
      let batch: any[] = [];
      try {
        batch = await this.request<any[]>(api, 'GET', 'products', {
          status: 'publish',
          per_page: 50,
          page,
        });
      } catch (e) {
        this.logger.warn(`Woo syncKnowledge page ${page}: ${(e as Error)?.message}`);
        break;
      }
      if (!batch || !batch.length) break;
      for (const p of batch) productItems.push(await this.buildProductChunk(api, p));
      if (batch.length < 50) break;
      page += 1;
    }

    // Policies: Woo stores keep them as WP pages; expose terms/privacy/shipping
    // via the store settings if present (best-effort, non-fatal).
    const policyItems: { sourceId: string; title: string; content: string }[] = [];

    const pr = await this.rag.indexSource(companyId, 'product', productItems);
    const po = await this.rag.indexSource(companyId, 'policy', policyItems);
    return {
      products: productItems.length,
      policies: policyItems.length,
      mode: pr.embedded || po.embedded ? 'rag' : 'keyword',
    };
  }

  private async buildProductChunk(api: WooApi, p: any): Promise<{ sourceId: string; title: string; content: string }> {
    const lines: string[] = [];
    lines.push(`Product: ${p.name}`);
    const price = this.str(p.price || p.regular_price);
    if (price) lines.push(`Price: ${price}`);
    lines.push(`Availability: ${p.stock_status === 'instock' ? 'in stock' : 'out of stock'}`);
    const cats = (p.categories || []).map((c: any) => c.name).filter(Boolean).join(', ');
    if (cats) lines.push(`Categories: ${cats}`);
    const tags = (p.tags || []).map((t: any) => t.name).filter(Boolean).join(', ');
    if (tags) lines.push(`Tags: ${tags}`);
    if (p.permalink) lines.push(`Link: ${p.permalink}`);

    if (p.type === 'variable') {
      try {
        const variations = await this.request<any[]>(api, 'GET', `products/${p.id}/variations`, { per_page: 50 });
        const vlines = (variations || [])
          .map((v) => {
            const vt = (v.attributes || []).map((a: any) => a.option).filter(Boolean).join(' / ');
            const vp = this.str(v.price || v.regular_price);
            const reg = this.num(v.regular_price);
            const sale = this.num(v.sale_price);
            const disc = reg && sale && reg > sale ? ` after ${Math.round(((reg - sale) / reg) * 100)}% discount (original price ${reg})` : '';
            return `${vt || 'Variant'}${v.sku ? ` [${v.sku}]` : ''} = ${vp}${disc}`;
          })
          .filter(Boolean);
        if (vlines.length) lines.push(`Variants: ${vlines.join('; ')}`);
      } catch {
        /* non-fatal */
      }
    }
    const desc = this.stripHtml(p.description || p.short_description || '');
    if (desc) lines.push(`Description: ${desc.slice(0, RAG_DESC_CHARS)}`);

    return { sourceId: `woo-product-${p.id}`, title: p.name || `Product ${p.id}`, content: lines.join('\n') };
  }

  // ── Webhooks ───────────────────────────────────────────────────────────────

  verifyWebhook(rawBody: Buffer | string, signature: string, secret: string): boolean {
    if (!signature || !secret) return false;
    const buf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
    const expected = crypto.createHmac('sha256', secret).update(buf).digest('base64');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  parseWebhook(topic: string, body: unknown): NormalizedOrderEvent | null {
    const o = body as any;
    if (!o || (o.id === undefined && o.number === undefined)) return null;
    const t = (topic || '').toLowerCase();
    let type: NormalizedOrderEvent['type'] = 'updated';
    if (t.includes('created')) type = 'created';
    else if (t.includes('deleted') || o.status === 'cancelled') type = 'cancelled';
    else if (o.status === 'completed') type = 'fulfilled';
    return { type, nativeId: String(o.id), raw: body };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private num(v: unknown): number | null {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  private str(v: unknown): string {
    const n = this.num(v);
    return n === null ? '' : String(n);
  }
  private stripHtml(html: string): string {
    return (html || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
