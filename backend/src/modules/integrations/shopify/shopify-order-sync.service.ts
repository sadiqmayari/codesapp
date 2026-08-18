import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma, CourierType, ShipmentStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { EncryptionService } from '../../../common/services/encryption.service';
import { JobQueueService } from '../../../common/services/job-queue.service';
import { formatLineItemsSummary } from '../../../common/utils/line-items-summary';

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
  /** Comma-joined Shopify payment gateway names (e.g. "payfast" / "manual"). */
  paymentGateway?: string | null;
  /** null / '' from Shopify means UNFULFILLED. */
  fulfillmentStatus?: string | null;
  // Delivery tracking backfilled from an order's fulfillments during import.
  trackingCompany?: string | null;
  deliveryStatus?: string | null;
  deliveredAt?: Date | null;
  lineItems?: unknown;
  lineItemsSummary?: string | null;
  shopifyCreatedAt?: Date | null;
  cancelledAt?: Date | null;
}

interface ImportJob {
  kind: 'import';
  companyId: number;
  // Optional Shopify search filter (default 'status:open' — only orders still
  // open in Shopify). Pass 'status:any' explicitly for a full-record backfill
  // (open + archived + cancelled).
  filter?: string;
}

const RECONCILE_QUEUE = 'shopify-order-reconcile';

interface ReconcileJob {
  kind: 'reconcile';
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
        const job = p as ImportJob;
        await this.runImport(job.companyId, { filter: job.filter });
      },
      1, // one import per tenant at a time
      600,
    );
    this.jobQueue.registerWorker(
      RECONCILE_QUEUE,
      async (p: unknown) => {
        await this.reconcileOpenOrders((p as ReconcileJob).companyId);
      },
      1,
      600,
    );
    this.logger.log('Registered shopify-order-import + reconcile workers (concurrency=1)');
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
      payment_gateway: o.paymentGateway ?? undefined,
      // Normalize Shopify's null/'' (= unfulfilled) to the literal 'unfulfilled'
      // so the queue filter is a clean equality check.
      fulfillment_status: o.fulfillmentStatus ? o.fulfillmentStatus : 'unfulfilled',
      tracking_company: o.trackingCompany ?? undefined,
      delivery_status: o.deliveryStatus ?? undefined,
      delivered_at: o.deliveredAt ?? undefined,
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
        // REST order payload → `payment_gateway_names` is an array of the
        // gateways used (e.g. ["payfast"], ["manual"], ["Cash on Delivery (COD)"]).
        paymentGateway: Array.isArray(payload.payment_gateway_names)
          ? (payload.payment_gateway_names as unknown[])
              .map((g) => String(g).trim())
              .filter(Boolean)
              .join(', ')
              .slice(0, 64) || null
          : ((payload.gateway as string) ?? null),
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
        lineItemsSummary: formatLineItemsSummary(
          lineItems.map((li) => ({
            title: li.title != null ? String(li.title) : null,
            quantity: Number(li.quantity ?? 1) || 1,
            variantTitle: li.variant_title != null ? String(li.variant_title) : null,
          })),
        ),
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

  /**
   * Capture delivery tracking from a Shopify fulfillments/* webhook payload
   * (tracking_company = the courier, shipment_status = the delivery lifecycle)
   * onto the mirror. Present for EVERY fulfilled order — including ones
   * fulfilled outside CodesApp — so courier performance reflects the whole
   * catalogue. Targeted, tenant-scoped, never creates a row; never throws.
   */
  async applyFulfillmentEvent(
    companyId: number,
    orderGid: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!orderGid) return;
    const str = (v: unknown): string | undefined => {
      if (v == null) return undefined;
      const s = String(v).trim();
      return s ? s.slice(0, 128) : undefined;
    };
    const shipmentStatus = str(payload.shipment_status)?.toLowerCase();
    const trackingCompany = str(payload.tracking_company);
    // tracking_number can be a string or an array; take the first.
    const rawNum = Array.isArray(payload.tracking_numbers)
      ? payload.tracking_numbers[0]
      : (payload.tracking_number ?? undefined);
    const trackingNumber = str(rawNum);
    if (!shipmentStatus && !trackingCompany && !trackingNumber) return;
    try {
      await this.prisma.shopifyOrder.updateMany({
        where: { company_id: companyId, shopify_order_gid: orderGid },
        data: {
          delivery_status: shipmentStatus ?? undefined,
          tracking_company: trackingCompany ?? undefined,
          tracking_number: trackingNumber ?? undefined,
          delivered_at: shipmentStatus === 'delivered' ? new Date() : undefined,
          synced_at: new Date(),
        },
      });
    } catch (e) {
      this.logger.warn(
        `applyFulfillmentEvent failed (company ${companyId}, ${orderGid}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    // Keep the operational Shipments/Courier-payments tabs live: mirror this
    // fulfilment onto the matching shipment row (create one if the order shipped
    // via a known courier and none exists) — so orders posted to a courier from
    // ANYWHERE (n8n, Shopify admin, another app) show up immediately. We do this
    // as soon as a courier is named, even before Shopify populates
    // shipment_status (a fresh fulfillments/create has none) — a missing status
    // is treated as 'confirmed' → our 'booked'. Non-throwing.
    if (trackingCompany) {
      await this.syncShipmentDelivery(
        companyId,
        orderGid,
        trackingCompany,
        // 'confirmed' maps to 'booked'; a real status (in_transit/…) wins.
        shipmentStatus || 'confirmed',
        trackingNumber ?? null,
      );
    }
  }

  /**
   * Drop a shipment out of the operational tabs + courier payments when its
   * order is cancelled or its fulfilment is removed (from ANYWHERE). Flips any
   * still-active (non-terminal) shipment for the order to 'cancelled' — which is
   * excluded from PAYMENT_ACTIVE_STATUSES, so it stops counting as owed/in
   * transit. A parcel that already delivered/returned is left intact (that COD
   * was really collected/refused — its outstanding self-corrects via the
   * financial reconcile). Tenant-scoped, never throws.
   */
  async cancelShipmentForOrder(
    companyId: number,
    orderGid: string,
    reason: string,
  ): Promise<void> {
    if (!orderGid) return;
    try {
      await this.prisma.shipment.updateMany({
        where: {
          company_id: companyId,
          shopify_order_gid: orderGid,
          status: { notIn: ['delivered', 'returned', 'cancelled'] },
        },
        data: {
          status: 'cancelled',
          last_courier_status_raw: `order ${reason}`.slice(0, 128),
        },
      });
    } catch (e) {
      this.logger.warn(
        `cancelShipmentForOrder failed (company ${companyId}, ${orderGid}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  private static mapCourier(trackingCompany: string): CourierType | null {
    const t = trackingCompany.toLowerCase();
    if (t.includes('trax')) return 'trax';
    if (t.includes('postex')) return 'postex';
    if (t.includes('leopard')) return 'leopards';
    if (t.includes('rocket')) return 'rocket';
    return null;
  }

  private static mapShipmentStatus(shipmentStatus: string): ShipmentStatus | null {
    switch (shipmentStatus.toLowerCase()) {
      case 'delivered':
        return 'delivered';
      case 'in_transit':
        return 'in_transit';
      case 'out_for_delivery':
        return 'out_for_delivery';
      case 'attempted_delivery':
        return 'attempted';
      case 'failure':
      case 'not_delivered':
        return 'failed';
      case 'ready_for_pickup':
        return 'ready_for_pickup';
      case 'confirmed':
      case 'fulfilled':
      case 'label_printed':
      case 'label_purchased':
        return 'booked';
      case 'canceled':
      case 'cancelled':
        return 'cancelled';
      default:
        return null;
    }
  }

  /**
   * Propagate a Shopify delivery event onto the shipments table. Updates an
   * existing (non-terminal) shipment or creates one for a known courier, so the
   * Shipments tab stays live even for orders fulfilled outside CodesApp.
   */
  private async syncShipmentDelivery(
    companyId: number,
    orderGid: string,
    trackingCompany: string,
    shipmentStatus: string,
    trackingNumber: string | null,
  ): Promise<void> {
    const courier = ShopifyOrderSyncService.mapCourier(trackingCompany);
    const status = ShopifyOrderSyncService.mapShipmentStatus(shipmentStatus);
    if (!courier || !status) return;
    const TERMINAL: ShipmentStatus[] = ['delivered', 'cancelled', 'returned'];
    try {
      const existing = await this.prisma.shipment.findFirst({
        where: { company_id: companyId, shopify_order_gid: orderGid },
        select: { id: true, status: true },
      });
      if (existing) {
        if (TERMINAL.includes(existing.status)) return; // done — ignore late echoes
        // Never DOWNGRADE a real progression back to 'booked' when a later
        // fulfilment echo arrives without a shipment_status (mapped to 'booked'
        // via the 'confirmed' fallback). Only advance, or refresh a 'booked' row.
        const nextStatus =
          status === 'booked' && existing.status !== 'booked' ? existing.status : status;
        await this.prisma.shipment.update({
          where: { id: existing.id },
          data: {
            status: nextStatus,
            courier_type: courier,
            courier_tracking_number: trackingNumber ?? undefined,
            last_courier_status_raw: shipmentStatus,
            delivered_at: nextStatus === 'delivered' ? new Date() : undefined,
          },
        });
        return;
      }
      const o = await this.prisma.shopifyOrder.findUnique({
        where: {
          company_id_shopify_order_gid: { company_id: companyId, shopify_order_gid: orderGid },
        },
        select: { order_name: true, city: true, address1: true, address2: true },
      });
      await this.prisma.shipment.create({
        data: {
          company_id: companyId,
          shopify_order_gid: orderGid,
          shopify_order_name: o?.order_name ?? null,
          courier_type: courier,
          courier_tracking_number: trackingNumber ?? null,
          destination_city: o?.city ?? null,
          destination_address:
            [o?.address1, o?.address2].filter(Boolean).join(', ') || null,
          status,
          last_courier_status_raw: shipmentStatus,
          delivered_at: status === 'delivered' ? new Date() : null,
          booked_at: new Date(),
        },
      });
    } catch (e) {
      this.logger.warn(
        `syncShipmentDelivery failed (company ${companyId}, ${orderGid}): ${
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

  /** Enqueue a background reconcile of the mirror's OPEN orders vs Shopify. */
  async requestReconcile(companyId: number): Promise<{ started: boolean }> {
    await this.getAdminApi(companyId);
    await this.jobQueue.enqueue(
      RECONCILE_QUEUE,
      { kind: 'reconcile', companyId } satisfies ReconcileJob,
      { dedupKey: `shopify-order-reconcile:${companyId}` },
    );
    return { started: true };
  }

  /** Cron entry — enqueue a reconcile for every company with Shopify connected. */
  async reconcileAllCompanies(): Promise<{ enqueued: number }> {
    const companies = await this.prisma.company.findMany({
      where: { shopify_admin_token_encrypted: { not: null } },
      select: { id: true },
    });
    for (const c of companies) {
      await this.jobQueue
        .enqueue(
          RECONCILE_QUEUE,
          { kind: 'reconcile', companyId: c.id } satisfies ReconcileJob,
          { dedupKey: `shopify-order-reconcile:${c.id}` },
        )
        .catch(() => undefined);
    }
    return { enqueued: companies.length };
  }

  /**
   * Close the drift between the mirror and Shopify for orders the mirror still
   * thinks are OPEN (archived_at null, cancelled_at null). Sois's store only
   * subscribes to orders/create + fulfillments/* — NOT orders/updated — so an
   * archive/cancel done directly in Shopify admin never reaches the mirror,
   * leaving CodesApp with more "open" orders than Shopify. This pulls the
   * authoritative closed/cancelled/fulfillment state (non-PII) for those gids in
   * batches via nodes(ids) and corrects the mirror. Never throws per batch.
   */
  async reconcileOpenOrders(
    companyId: number,
  ): Promise<{ checked: number; archived: number; cancelled: number; fulfilled: number; paid: number }> {
    const open = await this.prisma.shopifyOrder.findMany({
      where: { company_id: companyId, archived_at: null, cancelled_at: null },
      select: {
        shopify_order_gid: true,
        fulfillment_status: true,
        financial_status: true,
      },
      take: 20000,
    });
    if (!open.length)
      return { checked: 0, archived: 0, cancelled: 0, fulfilled: 0, paid: 0 };

    let checked = 0;
    let archived = 0;
    let cancelled = 0;
    let fulfilled = 0;
    let paid = 0;
    const CHUNK = 50;

    type NodesRes = {
      data?: {
        nodes?: Array<
          | {
              id: string;
              closed?: boolean | null;
              closedAt?: string | null;
              cancelledAt?: string | null;
              displayFulfillmentStatus?: string | null;
              displayFinancialStatus?: string | null;
              paymentGatewayNames?: string[] | null;
              currentTotalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
              totalOutstandingSet?: { shopMoney?: { amount?: string } };
            }
          | null
        >;
      };
    };

    for (let i = 0; i < open.length; i += CHUNK) {
      const slice = open.slice(i, i + CHUNK);
      const ids = slice.map((s) => s.shopify_order_gid);
      const prevByGid = new Map(slice.map((s) => [s.shopify_order_gid, s.fulfillment_status]));
      const prevFinByGid = new Map(slice.map((s) => [s.shopify_order_gid, s.financial_status]));
      try {
        const res = await this.graphql<NodesRes>(
          companyId,
          `query($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Order {
                id closed closedAt cancelledAt
                displayFulfillmentStatus displayFinancialStatus paymentGatewayNames
                currentTotalPriceSet { shopMoney { amount currencyCode } }
                totalOutstandingSet { shopMoney { amount } }
              }
            }
          }`,
          { ids },
        );
        for (const n of res?.data?.nodes ?? []) {
          if (!n?.id) continue;
          checked++;
          const disp = (n.displayFulfillmentStatus ?? '').toLowerCase();
          const fulfillmentStatus =
            disp === 'fulfilled' ? 'fulfilled' : disp === 'partially_fulfilled' ? 'partial' : 'unfulfilled';
          const data: Record<string, unknown> = { synced_at: new Date() };
          if (n.cancelledAt) {
            data.cancelled_at = new Date(n.cancelledAt);
            cancelled++;
          }
          if (n.closed || n.closedAt) {
            data.archived_at = n.closedAt ? new Date(n.closedAt) : new Date();
            archived++;
          }
          const prevFul = prevByGid.get(n.id);
          if (fulfillmentStatus !== prevFul) {
            data.fulfillment_status = fulfillmentStatus;
            if (fulfillmentStatus !== 'unfulfilled') fulfilled++;
          }
          // Any-source cleanup: an order cancelled in Shopify (no orders/*
          // webhook here), OR one whose fulfilment was removed (was fulfilled →
          // now unfulfilled), must drop its parcel out of Courier payments.
          if (n.cancelledAt || (prevFul !== 'unfulfilled' && fulfillmentStatus === 'unfulfilled')) {
            await this.cancelShipmentForOrder(
              companyId,
              n.id,
              n.cancelledAt ? 'cancelled' : 'unfulfilled',
            );
          }
          // Financial drift: the store has no orders/updated (or orders/paid)
          // webhook, so a "Mark as paid" done in Shopify admin never reaches the
          // mirror — leaving the payment tab showing COD still owed. Pull the
          // authoritative financial status + outstanding balance here so paid
          // orders drop out of the receivable and the total refreshes.
          const fin = n.displayFinancialStatus ?? null;
          if (fin && fin !== prevFinByGid.get(n.id)) {
            data.financial_status = fin;
            if (fin.toLowerCase() === 'paid') paid++;
          }
          const gateway = Array.isArray(n.paymentGatewayNames)
            ? n.paymentGatewayNames
                .map((g) => String(g).trim())
                .filter(Boolean)
                .join(', ')
                .slice(0, 64) || null
            : null;
          if (gateway) data.payment_gateway = gateway;
          const outstanding = this.num(n.totalOutstandingSet?.shopMoney?.amount);
          if (outstanding != null) data.total_outstanding = outstanding;
          const total = this.num(n.currentTotalPriceSet?.shopMoney?.amount);
          if (total != null) data.total_price = total;
          const currency = n.currentTotalPriceSet?.shopMoney?.currencyCode;
          if (currency) data.currency = currency;
          await this.prisma.shopifyOrder
            .updateMany({
              where: { company_id: companyId, shopify_order_gid: n.id },
              data,
            })
            .catch(() => undefined);
        }
      } catch (e) {
        this.logger.warn(
          `reconcileOpenOrders batch failed (company ${companyId}): ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    this.logger.log(
      `Order reconcile (company ${companyId}): checked=${checked} archived=${archived} cancelled=${cancelled} fulfilled=${fulfilled} paid=${paid}`,
    );
    return { checked, archived, cancelled, fulfilled, paid };
  }

  /**
   * Page through the store's orders (default 'status:open' — only orders still
   * open in Shopify, which is the working set the fulfilment/courier flow acts
   * on; an explicit 'status:any' can be passed for a full backfill) and upsert
   * each. Per order we also capture the authoritative
   * archived (`closedAt`) and cancelled (`cancelledAt`) state and the delivery
   * tracking from its fulfillments (courier + shipment status), backfilling
   * data the webhooks only provide going forward. Re-runnable and self-healing:
   * every write is an upsert on the canonical key; closure fields clear when an
   * order is reopened/uncancelled. Page size kept small — the nested
   * fulfillments push up Shopify's query cost.
   */
  async runImport(
    companyId: number,
    opts: { filter?: string; maxPages?: number } = {},
  ): Promise<{ imported: number }> {
    // `filter` is the Shopify search string. Default 'status:open' = only orders
    // still OPEN in Shopify (excludes archived/closed) — the working set the
    // fulfilment queue + courier flow actually operate on. (An explicit
    // 'status:any' can still be passed for a full-record backfill.) This also
    // reaches old open orders beyond the 10k newest-order cap a status:any run
    // stops at, since the open set is much smaller.
    const filter = opts.filter ?? 'status:open';
    const maxPages = opts.maxPages ?? 400;
    const query = `query($cursor: String) {
      orders(first: 25, after: $cursor, query: "${filter}", sortKey: CREATED_AT, reverse: true) {
        edges { cursor node {
          id name
          createdAt cancelledAt closedAt
          displayFinancialStatus displayFulfillmentStatus paymentGatewayNames
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          totalOutstandingSet { shopMoney { amount } }
          phone
          customer { firstName lastName phone email }
          shippingAddress { name phone city address1 address2 countryCodeV2 }
          fulfillmentOrders(first: 5) { edges { node { id status } } }
          fulfillments(first: 5) { displayStatus updatedAt trackingInfo { company } }
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
      closedAt?: string | null;
      fulfillments?: Array<{
        displayStatus?: string | null;
        updatedAt?: string | null;
        trackingInfo?: Array<{ company?: string | null }>;
      }>;
      displayFinancialStatus?: string | null;
      displayFulfillmentStatus?: string | null;
      paymentGatewayNames?: string[] | null;
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

    let completed = false;
    let cursor: string | null = null;
    let imported = 0;
    for (let page = 0; page < maxPages; page++) {
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
        // Delivery tracking from the order's fulfillments (latest wins).
        const ful = n.fulfillments ?? [];
        const lastFul = ful.length ? ful[ful.length - 1] : null;
        const trackingCompany =
          ful
            .map((f) => f.trackingInfo?.[0]?.company)
            .filter((c): c is string => !!c)
            .pop() ?? null;
        const deliveryStatus = lastFul?.displayStatus
          ? lastFul.displayStatus.toLowerCase()
          : null;
        const deliveredAt =
          deliveryStatus === 'delivered' && lastFul?.updatedAt
            ? new Date(lastFul.updatedAt)
            : null;
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
            paymentGateway: Array.isArray(n.paymentGatewayNames)
              ? n.paymentGatewayNames
                  .map((g) => String(g).trim())
                  .filter(Boolean)
                  .join(', ')
                  .slice(0, 64) || null
              : null,
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
            lineItemsSummary: formatLineItemsSummary(
              li.map((e) => ({
                title: e.node.title ?? null,
                quantity: e.node.quantity ?? 1,
                variantTitle: e.node.variantTitle ?? null,
              })),
            ),
            shopifyCreatedAt: n.createdAt ? new Date(n.createdAt) : null,
            cancelledAt: n.cancelledAt ? new Date(n.cancelledAt) : null,
            trackingCompany,
            deliveryStatus,
            deliveredAt,
          },
          'import',
        );
        // Authoritative closure state — archived from `closedAt`, cancelled from
        // `cancelledAt`. Explicit so a reopened/uncancelled order clears them.
        await this.prisma.shopifyOrder
          .updateMany({
            where: { company_id: companyId, shopify_order_gid: n.id },
            data: {
              archived_at: n.closedAt ? new Date(n.closedAt) : null,
              cancelled_at: n.cancelledAt ? new Date(n.cancelledAt) : null,
            },
          })
          .catch(() => null);
        imported++;
      }
      if (!res?.data?.orders?.pageInfo?.hasNextPage || !edges.length) {
        completed = true;
        break;
      }
      cursor = edges[edges.length - 1].cursor;
    }

    this.logger.log(
      `Order import complete (company ${companyId}): ${imported} orders${
        completed ? '' : ' (partial — did not finish paging)'
      }`,
    );
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
