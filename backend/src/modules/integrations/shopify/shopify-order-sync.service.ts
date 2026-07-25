import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { EncryptionService } from '../../../common/services/encryption.service';
import { JobQueueService } from '../../../common/services/job-queue.service';

const DEFAULT_API_VERSION = 'v19.0';
const TIMEOUT_MS = 20_000;
const IMPORT_QUEUE = 'shopify-order-import';

/**
 * Normalized order shape written to the `shopify_orders` mirror. All three
 * writers (CodesApp order creation, orders/* webhooks, one-time import)
 * produce this and funnel through `upsertOrder`.
 */
export interface OrderUpsert {
  orderGid: string;
  orderName?: string | null;
  orderNumber?: string | null;
  fulfillmentOrderGid?: string | null;
  customerName?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  address1?: string | null;
  address2?: string | null;
  countryCode?: string | null;
  totalPrice?: number | null;
  totalOutstanding?: number | null;
  currency?: string | null;
  financialStatus?: string | null;
  /** null / '' from Shopify means UNFULFILLED. */
  fulfillmentStatus?: string | null;
  lineItems?: unknown;
  lineItemsSummary?: string | null;
  shopifyCreatedAt?: Date | null;
  cancelledAt?: Date | null;
}

interface ImportJob {
  kind: 'import';
  companyId: number;
}

/**
 * Owns the local Shopify-orders mirror (`shopify_orders`). The mirror lets the
 * fulfilment queue list/filter/bulk-select orders without hitting Shopify on
 * every page load, and is the anti-duplication backbone: every order — created
 * in CodesApp, echoed back by a webhook, or pulled by the one-time import —
 * is keyed by UNIQUE(company_id, shopify_order_gid) and written HERE, so the
 * same order can never land as two rows.
 *
 * Self-contained Shopify GraphQL access (mirrors ShopifyFulfillmentClient's
 * helper) so this service depends only on Prisma/Encryption/JobQueue — the
 * dependency stays one-way (ShopifyService -> this), no DI cycle.
 */
@Injectable()
export class ShopifyOrderSyncService implements OnModuleInit {
  private readonly logger = new Logger(ShopifyOrderSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly jobQueue: JobQueueService,
  ) {}

  onModuleInit(): void {
    this.jobQueue.registerWorker(
      IMPORT_QUEUE,
      async (p: unknown) => {
        await this.runImport((p as ImportJob).companyId);
      },
      1, // one import per tenant at a time
      600,
    );
    this.logger.log('Registered shopify-order-import worker (concurrency=1)');
  }

  // ── The single write funnel ────────────────────────────────────────────
  /**
   * Upsert one order into the mirror. Shopify-owned fields are refreshed on
   * every call; CodesApp-owned fields (assigned_user_id, internal_note) are
   * NEVER touched here, and `source` is write-once (set only on first insert),
   * so a webhook echo can't wipe an agent's assignment or the provenance.
   * Race-safe: the unique constraint + a P2002 fallback to update.
   */
  async upsertOrder(
    companyId: number,
    o: OrderUpsert,
    source: 'codesapp' | 'webhook' | 'import',
  ): Promise<void> {
    if (!o.orderGid) return;
    const shopifyOwned = {
      order_name: o.orderName ?? undefined,
      order_number: o.orderNumber ?? undefined,
      fulfillment_order_gid: o.fulfillmentOrderGid ?? undefined,
      customer_name: o.customerName ?? undefined,
      phone: o.phone ?? undefined,
      email: o.email ?? undefined,
      city: o.city ?? undefined,
      address1: o.address1 ?? undefined,
      address2: o.address2 ?? undefined,
      country_code: o.countryCode ?? undefined,
      total_price: o.totalPrice ?? undefined,
      total_outstanding: o.totalOutstanding ?? undefined,
      currency: o.currency ?? undefined,
      financial_status: o.financialStatus ?? undefined,
      // Normalize Shopify's null/'' (= unfulfilled) to the literal 'unfulfilled'
      // so the queue filter is a clean equality check.
      fulfillment_status: o.fulfillmentStatus ? o.fulfillmentStatus : 'unfulfilled',
      line_items: (o.lineItems ?? undefined) as Prisma.InputJsonValue | undefined,
      line_items_summary: o.lineItemsSummary ?? undefined,
      shopify_created_at: o.shopifyCreatedAt ?? undefined,
      cancelled_at: o.cancelledAt ?? undefined,
      synced_at: new Date(),
    };
    try {
      await this.prisma.shopifyOrder.upsert({
        where: {
          company_id_shopify_order_gid: {
            company_id: companyId,
            shopify_order_gid: o.orderGid,
          },
        },
        create: { company_id: companyId, shopify_order_gid: o.orderGid, source, ...shopifyOwned },
        update: shopifyOwned, // NB: no `source`, no assigned_user_id/internal_note
      });
    } catch (e) {
      // Concurrent insert on the same key → fall back to a plain update.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        await this.prisma.shopifyOrder
          .update({
            where: {
              company_id_shopify_order_gid: {
                company_id: companyId,
                shopify_order_gid: o.orderGid,
              },
            },
            data: shopifyOwned,
          })
          .catch((err: unknown) =>
            this.logger.warn(
              `upsertOrder update fallback failed (company ${companyId}, ${o.orderGid}): ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          );
        return;
      }
      this.logger.warn(
        `upsertOrder failed (company ${companyId}, ${o.orderGid}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * Map a Shopify REST orders/* webhook payload to an upsert. The webhook has
   * no fulfillmentOrder GID (GraphQL-only) — the booking path re-fetches it, so
   * we leave it null here.
   */
  async upsertFromWebhook(
    companyId: number,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const gid =
      (payload.admin_graphql_api_id as string) ??
      (payload.id != null ? `gid://shopify/Order/${payload.id}` : '');
    if (!gid) return;
    const customer = (payload.customer ?? {}) as Record<string, unknown>;
    const ship = (payload.shipping_address ?? {}) as Record<string, unknown>;
    const name =
      [customer.first_name, customer.last_name].filter(Boolean).join(' ') ||
      (ship.name as string) ||
      null;
    const lineItems = Array.isArray(payload.line_items)
      ? (payload.line_items as Array<Record<string, unknown>>)
      : [];
    const num = (v: unknown): number | null => {
      if (v == null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    await this.upsertOrder(
      companyId,
      {
        orderGid: gid,
        orderName: (payload.name as string) ?? null,
        orderNumber:
          payload.order_number != null
            ? String(payload.order_number)
            : payload.number != null
              ? String(payload.number)
              : null,
        customerName: name,
        phone:
          (ship.phone as string) ||
          (payload.phone as string) ||
          (customer.phone as string) ||
          null,
        email: (payload.email as string) || (customer.email as string) || null,
        city: (ship.city as string) ?? null,
        address1: (ship.address1 as string) ?? null,
        address2: (ship.address2 as string) ?? null,
        countryCode: (ship.country_code as string) ?? null,
        totalPrice: num(payload.total_price),
        totalOutstanding: num(payload.total_outstanding),
        currency: (payload.currency as string) ?? null,
        financialStatus: (payload.financial_status as string) ?? null,
        fulfillmentStatus: (payload.fulfillment_status as string) ?? null,
        lineItems: lineItems.map((li) => ({
          title: li.title ?? null,
          quantity: Number(li.quantity ?? 1) || 1,
          variantId:
            li.variant_id != null
              ? `gid://shopify/ProductVariant/${li.variant_id}`
              : null,
          variantTitle: li.variant_title ?? null,
          price: li.price != null ? String(li.price) : null,
        })),
        lineItemsSummary: lineItems
          .map((li) => `${li.quantity ?? 1}x ${li.title ?? 'item'}`)
          .join(', '),
        shopifyCreatedAt: payload.created_at
          ? new Date(payload.created_at as string)
          : null,
        cancelledAt: payload.cancelled_at
          ? new Date(payload.cancelled_at as string)
          : null,
      },
      'webhook',
    );
  }

  /**
   * Refresh ONLY the fulfilment status of an already-mirrored order from
   * Shopify's authoritative `displayFulfillmentStatus`. Driven by the
   * `fulfillments/create|update` webhooks (which fire on every fulfilment but
   * are NOT `orders/*`, so they never hit `upsertFromWebhook`) — this is what
   * flips a mirror row to 'fulfilled' the moment the order is fulfilled in
   * Shopify, so it leaves the fulfilment queue.
   *
   * Deliberately a targeted `updateMany` (not `upsertOrder`): the status query
   * is PII-gated to null, so a full upsert path is avoided entirely — we touch
   * only `fulfillment_status` + `cancelled_at` and never create a bare row or
   * overwrite an existing name/phone/address. Never throws.
   */
  async refreshFulfillmentStatus(companyId: number, orderGid: string): Promise<void> {
    if (!orderGid) return;
    const query = `query($id: ID!) {
      order(id: $id) { displayFulfillmentStatus cancelledAt }
    }`;
    type Res = {
      data?: {
        order?: { displayFulfillmentStatus?: string | null; cancelledAt?: string | null } | null;
      };
    };
    try {
      const res = await this.graphql<Res>(companyId, query, { id: orderGid });
      const order = res?.data?.order;
      if (!order) return; // order not found / not accessible — leave the row as-is
      const disp = (order.displayFulfillmentStatus ?? '').toLowerCase();
      const fulfillmentStatus =
        disp === 'fulfilled'
          ? 'fulfilled'
          : disp === 'partially_fulfilled'
            ? 'partial'
            : 'unfulfilled';
      await this.prisma.shopifyOrder.updateMany({
        where: { company_id: companyId, shopify_order_gid: orderGid },
        data: {
          fulfillment_status: fulfillmentStatus,
          cancelled_at: order.cancelledAt ? new Date(order.cancelledAt) : undefined,
          synced_at: new Date(),
        },
      });
    } catch (e) {
      this.logger.warn(
        `refreshFulfillmentStatus failed (company ${companyId}, ${orderGid}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  // ── One-time import (background) ─────────────────────────────────────────
  async requestImport(companyId: number): Promise<{ started: boolean }> {
    await this.getAdminApi(companyId); // clean 4xx if Shopify isn't connected
    await this.jobQueue.enqueue(
      IMPORT_QUEUE,
      { kind: 'import', companyId } satisfies ImportJob,
      { dedupKey: `shopify-order-import:${companyId}` },
    );
    return { started: true };
  }

  /**
   * Page through the store's OPEN orders and upsert each. Open = not archived,
   * not cancelled — the fulfilment-relevant set (both fulfilled and unfulfilled
   * so the mirror is complete; the queue filters unfulfilled). Re-runnable and
   * safe: every write is an upsert on the canonical key.
   */
  async runImport(companyId: number): Promise<{ imported: number }> {
    const query = `query($cursor: String) {
      orders(first: 50, after: $cursor, query: "status:open", sortKey: CREATED_AT, reverse: true) {
        edges { cursor node {
          id name
          createdAt cancelledAt
          displayFinancialStatus displayFulfillmentStatus
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          totalOutstandingSet { shopMoney { amount } }
          phone
          customer { firstName lastName phone email }
          shippingAddress { name phone city address1 address2 countryCodeV2 }
          fulfillmentOrders(first: 5) { edges { node { id status } } }
          lineItems(first: 50) { edges { node { title quantity variantTitle
            variant { id price } } } }
        } }
        pageInfo { hasNextPage }
      }
    }`;
    type Node = {
      id: string;
      name?: string;
      createdAt?: string | null;
      cancelledAt?: string | null;
      displayFinancialStatus?: string | null;
      displayFulfillmentStatus?: string | null;
      currentTotalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
      totalOutstandingSet?: { shopMoney?: { amount?: string } };
      phone?: string | null;
      customer?: {
        firstName?: string | null;
        lastName?: string | null;
        phone?: string | null;
        email?: string | null;
      } | null;
      shippingAddress?: {
        name?: string | null;
        phone?: string | null;
        city?: string | null;
        address1?: string | null;
        address2?: string | null;
        countryCodeV2?: string | null;
      } | null;
      fulfillmentOrders?: { edges: Array<{ node: { id: string; status: string } }> };
      lineItems?: {
        edges: Array<{
          node: {
            title?: string;
            quantity?: number;
            variantTitle?: string | null;
            variant?: { id?: string; price?: string } | null;
          };
        }>;
      };
    };
    type Res = {
      data?: {
        orders?: {
          edges?: Array<{ cursor: string; node?: Node }>;
          pageInfo?: { hasNextPage?: boolean };
        };
      };
      errors?: Array<{ message: string }>;
    };

    let cursor: string | null = null;
    let imported = 0;
    for (let page = 0; page < 400; page++) {
      let res: Res;
      try {
        res = await this.graphql<Res>(companyId, query, { cursor });
      } catch (e) {
        this.logger.warn(
          `Order import page failed (company ${companyId}): ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        break;
      }
      const edges = res?.data?.orders?.edges ?? [];
      for (const edge of edges) {
        const n = edge.node;
        if (!n?.id) continue;
        const li = n.lineItems?.edges ?? [];
        const dispFul = (n.displayFulfillmentStatus ?? '').toLowerCase();
        await this.upsertOrder(
          companyId,
          {
            orderGid: n.id,
            orderName: n.name ?? null,
            orderNumber: n.name ? n.name.replace(/[^0-9]/g, '') : null,
            fulfillmentOrderGid:
              n.fulfillmentOrders?.edges.find(
                (e) => e.node.status !== 'CLOSED' && e.node.status !== 'CANCELLED',
              )?.node.id ?? null,
            customerName:
              [n.customer?.firstName, n.customer?.lastName]
                .filter(Boolean)
                .join(' ') ||
              n.shippingAddress?.name ||
              null,
            phone: n.shippingAddress?.phone || n.phone || n.customer?.phone || null,
            email: n.customer?.email ?? null,
            city: n.shippingAddress?.city ?? null,
            address1: n.shippingAddress?.address1 ?? null,
            address2: n.shippingAddress?.address2 ?? null,
            countryCode: n.shippingAddress?.countryCodeV2 ?? null,
            totalPrice: this.num(n.currentTotalPriceSet?.shopMoney?.amount),
            totalOutstanding: this.num(n.totalOutstandingSet?.shopMoney?.amount),
            currency: n.currentTotalPriceSet?.shopMoney?.currencyCode ?? null,
            financialStatus: n.displayFinancialStatus ?? null,
            // Map Shopify's UNFULFILLED/FULFILLED/PARTIALLY_FULFILLED display
            // enum to the lower-case value the queue filter expects.
            fulfillmentStatus:
              dispFul === 'fulfilled'
                ? 'fulfilled'
                : dispFul === 'partially_fulfilled'
                  ? 'partial'
                  : 'unfulfilled',
            lineItems: li.map((e) => ({
              title: e.node.title ?? null,
              quantity: e.node.quantity ?? 1,
              variantId: e.node.variant?.id ?? null,
              variantTitle: e.node.variantTitle ?? null,
              price: e.node.variant?.price ?? null,
            })),
            lineItemsSummary: li
              .map((e) => `${e.node.quantity ?? 1}x ${e.node.title ?? 'item'}`)
              .join(', '),
            shopifyCreatedAt: n.createdAt ? new Date(n.createdAt) : null,
            cancelledAt: n.cancelledAt ? new Date(n.cancelledAt) : null,
          },
          'import',
        );
        imported++;
      }
      if (!res?.data?.orders?.pageInfo?.hasNextPage || !edges.length) break;
      cursor = edges[edges.length - 1].cursor;
    }
    this.logger.log(`Order import complete (company ${companyId}): ${imported} orders`);
    return { imported };
  }

  private num(v: unknown): number | null {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // ── Self-contained Shopify Admin GraphQL (mirrors the fulfilment client) ──
  private async getAdminApi(
    companyId: number,
  ): Promise<{ token: string; shopDomain: string; apiVersion: string }> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { shopify_admin_token_encrypted: true },
    });
    if (!company?.shopify_admin_token_encrypted) {
      throw new Error('No Shopify Admin API token configured.');
    }
    const token = this.encryption.decrypt(company.shopify_admin_token_encrypted);
    const cfg = await this.prisma.shopifyOrderConfig.findUnique({
      where: { company_id: companyId },
      select: { shop_domain: true, api_version: true },
    });
    const shopDomain = (cfg?.shop_domain || '')
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .trim();
    if (!shopDomain) throw new Error('No Shopify store domain set.');
    return { token, shopDomain, apiVersion: cfg?.api_version || DEFAULT_API_VERSION };
  }

  private async graphql<T>(
    companyId: number,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const api = await this.getAdminApi(companyId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://${api.shopDomain}/admin/api/${api.apiVersion}/graphql.json`,
        {
          method: 'POST',
          headers: {
            'x-shopify-access-token': api.token,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        },
      );
      const json = (await res.json()) as T;
      if (!res.ok) throw new Error(`Shopify API ${res.status}: ${JSON.stringify(json)}`);
      return json;
    } finally {
      clearTimeout(timer);
    }
  }
}
