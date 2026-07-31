import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { CourierType, ShipmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { CourierRegistryService } from './courier-registry.service';
import { CityMappingService } from './city-mapping.service';
import { ShopifyFulfillmentClient } from './shopify-fulfillment-client.service';
import { ShopifyService } from '../integrations/shopify/shopify.service';
import { AddressQualityService } from './address-quality.service';
import { AddressIssueNotifier } from './address-issue-notifier.service';
import {
  COURIER_BOOKING_QUEUE,
  COURIER_BULK_BOOK_QUEUE,
  COURIER_DISPLAY_NAME,
  courierTrackingUrl,
} from './couriers.constants';

interface BookJobPayload {
  shipmentId: number;
}

/** Pull a per-parcel label URL out of a courier's booking response (Leopards
 *  returns `slip_link`, top-level or inside packet_list). Best-effort. */
function extractSlipLink(raw: unknown): string | null {
  const r = raw as any;
  const link = r?.slip_link ?? r?.packet_list?.[0]?.slip_link ?? null;
  return typeof link === 'string' && /^https?:\/\//i.test(link) ? link : null;
}

interface BulkBookJobPayload {
  companyId: number;
  orderGids: string[];
  courierType?: CourierType;
  createdByUserId?: number;
  overrideAddressIssue?: boolean;
}

// Order-state slices + any shipment status (the Orders board's status chips).
export type QueueStatus =
  | 'unfulfilled'
  | 'fulfilled'
  | 'all'
  | 'archived'
  | ShipmentStatus;

// Statuses that count toward courier payments: delivered (receivable) + still
// in the pipeline (with courier). Returned/cancelled are excluded (dead).
const PAYMENT_ACTIVE_STATUSES: ShipmentStatus[] = [
  'delivered',
  'booked',
  'in_transit',
  'out_for_delivery',
  'picked_up',
  'ready_for_pickup',
  'attempted',
  'failed',
  'address_issue',
];

// The ShipmentStatus values the board filters by (orders whose shipment has it).
const SHIPMENT_STATUS_VALUES: readonly string[] = [
  'booked',
  'in_transit',
  'out_for_delivery',
  'picked_up',
  'ready_for_pickup',
  'delivered',
  'attempted',
  'failed',
  'address_issue',
  'returned',
  'cancelled',
];

export interface BookShipmentParams {
  companyId: number;
  shopifyOrderName: string;
  courierType?: CourierType;
  createdByUserId?: number;
  /** Agent explicitly accepted an address-issue warning and wants to book anyway. */
  overrideAddressIssue?: boolean;
}

@Injectable()
export class ShipmentService implements OnModuleInit {
  private readonly logger = new Logger(ShipmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobQueue: JobQueueService,
    private readonly registry: CourierRegistryService,
    private readonly cityMapping: CityMappingService,
    private readonly shopify: ShopifyFulfillmentClient,
    private readonly shopifyService: ShopifyService,
    private readonly addressQuality: AddressQualityService,
    private readonly addressIssueNotifier: AddressIssueNotifier,
  ) {}

  onModuleInit(): void {
    // Courier booking = an external API call + a Shopify fulfillment write;
    // give it the same generous lease Shopify's own worker uses.
    this.jobQueue.registerWorker(
      COURIER_BOOKING_QUEUE,
      (p) => this.processBookingJob(p as BookJobPayload),
      3,
      120,
    );
    this.logger.log('Registered courier-booking worker (concurrency=3, lease=120s)');

    // Bulk booking = a fan-out orchestrator: it turns one "book these N orders"
    // request into N individual bookShipment calls (each of which either books
    // or flags an address issue), on its own queue so a big batch never starves
    // the single-order booking worker. Concurrency 1 per tenant keeps a bulk run
    // from hammering the Shopify Admin API.
    this.jobQueue.registerWorker(
      COURIER_BULK_BOOK_QUEUE,
      (p) => this.processBulkBookJob(p as BulkBookJobPayload),
      1,
      600,
    );
    this.logger.log('Registered courier-bulk-book worker (concurrency=1, lease=600s)');
  }

  /**
   * Enqueue a bulk booking. Returns immediately; each order is booked on the
   * worker and its outcome shows up as that order's shipment status in the
   * fulfilment queue (booked / address_issue / a booking_error) — so partial
   * failures surface per-order instead of failing the whole batch.
   */
  async bulkBook(
    companyId: number,
    orderGids: string[],
    opts: { courierType?: CourierType; createdByUserId?: number } = {},
  ): Promise<{ queued: number }> {
    const unique = Array.from(new Set(orderGids.filter(Boolean))).slice(0, 500);
    if (!unique.length) {
      throw new BadRequestException('No orders selected.');
    }
    await this.jobQueue.enqueue(
      COURIER_BULK_BOOK_QUEUE,
      {
        companyId,
        orderGids: unique,
        courierType: opts.courierType,
        createdByUserId: opts.createdByUserId,
      } satisfies BulkBookJobPayload,
      { maxAttempts: 1 }, // per-order errors are captured; no whole-batch retry
    );
    return { queued: unique.length };
  }

  private async processBulkBookJob(payload: BulkBookJobPayload): Promise<void> {
    let booked = 0;
    let issues = 0;
    let failed = 0;
    for (const gid of payload.orderGids) {
      const order = await this.prisma.shopifyOrder.findUnique({
        where: {
          company_id_shopify_order_gid: {
            company_id: payload.companyId,
            shopify_order_gid: gid,
          },
        },
        select: { order_name: true },
      });
      if (!order?.order_name) {
        failed++;
        continue;
      }
      try {
        const shipment = await this.bookShipment({
          companyId: payload.companyId,
          shopifyOrderName: order.order_name,
          courierType: payload.courierType,
          createdByUserId: payload.createdByUserId,
          overrideAddressIssue: payload.overrideAddressIssue,
        });
        if (shipment.status === 'address_issue') issues++;
        else booked++;
      } catch (err) {
        failed++;
        this.logger.warn(
          `Bulk book: order ${order.order_name} (company ${payload.companyId}) failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    this.logger.log(
      `Bulk book complete (company ${payload.companyId}): booked=${booked} addressIssues=${issues} failed=${failed} of ${payload.orderGids.length}`,
    );
  }

  async listCouriersForCity(
    companyId: number,
    city: string,
  ): Promise<{ courierType: CourierType; cityCode: string; isDefault: boolean }[]> {
    const active = await this.registry.getActiveCouriers(companyId);
    return this.cityMapping.suggestCourier(companyId, city, active);
  }

  /**
   * Shared WHERE for the Orders board (queue list + select-all ids). Order-state
   * slices filter the mirror directly; a shipment-state (ShipmentStatus) resolves
   * to the orders whose CodesApp shipment has that status. Shipment-state views
   * do NOT force cancelled_at/archived_at null — a 'returned' order IS cancelled
   * + archived, yet must still appear under the Returned chip.
   */
  private async buildQueueWhere(
    companyId: number,
    search: string,
    status: QueueStatus,
    confirmation?: 'confirmed' | 'unconfirmed',
  ): Promise<Prisma.ShopifyOrderWhereInput> {
    const searchClause: Prisma.ShopifyOrderWhereInput = search
      ? {
          OR: [
            { order_name: { contains: search } },
            { customer_name: { contains: search } },
            { phone: { contains: search } },
            { city: { contains: search } },
          ],
        }
      : {};

    // Optional confirmation slice (To-book sub-tabs). Confirmed = the order was
    // manually confirmed OR the customer's confirmation-template reply was
    // 'confirmed'; unconfirmed = everything else (awaiting / no WhatsApp / none).
    const confirmationClause = await this.buildConfirmationClause(companyId, confirmation);

    if (SHIPMENT_STATUS_VALUES.includes(status)) {
      const ships = await this.prisma.shipment.findMany({
        where: { company_id: companyId, status: status as ShipmentStatus },
        select: { shopify_order_gid: true },
        take: 20000,
      });
      const gids = ships.map((s) => s.shopify_order_gid);
      return {
        company_id: companyId,
        // No matches → an impossible filter (empty result), not "all".
        shopify_order_gid: gids.length ? { in: gids } : { in: ['__none__'] },
        ...searchClause,
        ...confirmationClause,
      };
    }

    const statusFilter: Prisma.ShopifyOrderWhereInput =
      status === 'archived'
        ? { archived_at: { not: null } }
        : status === 'unfulfilled'
          ? { fulfillment_status: 'unfulfilled', archived_at: null }
          : status === 'fulfilled'
            ? { fulfillment_status: { not: 'unfulfilled' }, archived_at: null }
            : { archived_at: null };

    return {
      company_id: companyId,
      cancelled_at: null,
      ...statusFilter,
      ...searchClause,
      ...confirmationClause,
    };
  }

  /** gid IN/NOT-IN the set of confirmed orders (manual_confirmed_at set OR a
   *  'confirmed' confirmation message). Empty clause when no confirmation slice. */
  private async buildConfirmationClause(
    companyId: number,
    confirmation?: 'confirmed' | 'unconfirmed',
  ): Promise<Prisma.ShopifyOrderWhereInput> {
    if (!confirmation) return {};
    const [manual, replied] = await Promise.all([
      this.prisma.shopifyOrder.findMany({
        where: { company_id: companyId, manual_confirmed_at: { not: null } },
        select: { shopify_order_gid: true },
        take: 50000,
      }),
      this.prisma.shopifyOrderMessage.findMany({
        where: { company_id: companyId, status: 'confirmed' },
        select: { shopify_order_gid: true },
        take: 50000,
      }),
    ]);
    const confirmedGids = Array.from(
      new Set([
        ...manual.map((r) => r.shopify_order_gid),
        ...replied.map((r) => r.shopify_order_gid).filter((g): g is string => !!g),
      ]),
    );
    if (confirmation === 'confirmed') {
      return { shopify_order_gid: confirmedGids.length ? { in: confirmedGids } : { in: ['__none__'] } };
    }
    return confirmedGids.length ? { shopify_order_gid: { notIn: confirmedGids } } : {};
  }

  /**
   * The fulfilment QUEUE — unfulfilled Shopify orders from the local mirror,
   * enriched with a suggested courier (per city, memoized so 50 rows don't fan
   * out to hundreds of queries) and any shipment already booked for the order.
   * Reads the mirror only; no Shopify call. Feeds Phase C bulk fulfilment.
   */
  async listFulfillmentQueue(
    companyId: number,
    opts: {
      search?: string;
      page?: number;
      pageSize?: number;
      // Which slice to show. Order-state: 'unfulfilled' (default) = to book;
      // 'fulfilled' = shipped/record; 'all' = every open order; 'archived'.
      // Shipment-state (a ShipmentStatus, e.g. 'booked'/'in_transit'/'delivered'
      // /'returned'): orders whose CodesApp shipment has that status — the
      // Orders board's status chips. `includeFulfilled` is a back-compat alias.
      status?: QueueStatus;
      includeFulfilled?: boolean;
      // To-book sub-tab: only confirmed / only unconfirmed orders.
      confirmation?: 'confirmed' | 'unconfirmed';
    } = {},
  ) {
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.floor(opts.pageSize ?? 50)));
    const search = (opts.search ?? '').trim();
    const status = opts.status ?? (opts.includeFulfilled ? 'all' : 'unfulfilled');
    const where = await this.buildQueueWhere(companyId, search, status, opts.confirmation);

    // Shop domain (once) for building a clickable Shopify-admin order link.
    const shopDomain = (
      await this.prisma.shopifyOrderConfig
        .findFirst({ where: { company_id: companyId }, select: { shop_domain: true } })
        .catch(() => null)
    )?.shop_domain?.replace(/^https?:\/\//, '').replace(/\/+$/, '') || null;

    const [total, rows] = await Promise.all([
      this.prisma.shopifyOrder.count({ where }),
      this.prisma.shopifyOrder.findMany({
        where,
        orderBy: { shopify_created_at: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    // Existing shipments for this page's orders (so the UI shows "already
    // booked" and disables re-selection).
    const gids = rows.map((r) => r.shopify_order_gid);
    const shipments = gids.length
      ? await this.prisma.shipment.findMany({
          where: { company_id: companyId, shopify_order_gid: { in: gids } },
          select: {
            id: true,
            shopify_order_gid: true,
            status: true,
            courier_type: true,
            courier_tracking_number: true,
            last_status_reason: true,
            shipper_advice_status: true,
            courier_slip_link: true,
          },
        })
      : [];
    const shipmentByGid = new Map(shipments.map((s) => [s.shopify_order_gid, s]));

    // Confirmation state per order (for the soft "not confirmed" flag). Truth =
    // the customer's own reply to the WhatsApp confirmation template
    // (shopify_order_messages.status: confirmed|pending|undeliverable|cancelled),
    // overridden to 'confirmed' when an agent manually confirmed the order.
    const orderMsgs = gids.length
      ? await this.prisma.shopifyOrderMessage.findMany({
          where: { company_id: companyId, shopify_order_gid: { in: gids } },
          select: { shopify_order_gid: true, status: true, updated_at: true },
          orderBy: { updated_at: 'desc' },
        })
      : [];
    const msgStatusByGid = new Map<string, string>();
    for (const m of orderMsgs) {
      // findMany is newest-first; keep the first (latest) per gid.
      if (!msgStatusByGid.has(m.shopify_order_gid)) {
        msgStatusByGid.set(m.shopify_order_gid, m.status);
      }
    }

    // Assigned agent names for this page.
    const userIds = Array.from(
      new Set(rows.map((r) => r.assigned_user_id).filter((v): v is number => v != null)),
    );
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds }, company_id: companyId },
          select: { id: true, name: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u.name]));

    // Suggested courier, memoized per distinct city (suggestCourier is
    // query-heavy; the queue commonly repeats cities).
    const active = await this.registry.getActiveCouriers(companyId);
    const suggestionCache = new Map<
      string,
      { courierType: CourierType; cityCode: string }[]
    >();
    // Full ranked list of couriers serving the city (default first). Top = the
    // suggestion; the rest let the UI offer a per-row/bulk courier override.
    const suggestFor = async (city: string | null) => {
      const key = (city ?? '').toLowerCase().trim();
      if (!key) return [];
      if (suggestionCache.has(key)) return suggestionCache.get(key)!;
      const s = await this.cityMapping.suggestCourier(companyId, city ?? '', active);
      const list = s.map((x) => ({ courierType: x.courierType, cityCode: x.cityCode }));
      suggestionCache.set(key, list);
      return list;
    };

    const out = [];
    for (const r of rows) {
      const serving = await suggestFor(r.city);
      const suggestion = serving[0] ?? null;
      const ship = shipmentByGid.get(r.shopify_order_gid) ?? null;
      const numericOrderId = r.shopify_order_gid.split('/').pop();
      out.push({
        orderGid: r.shopify_order_gid,
        orderName: r.order_name,
        // Clickable deep-link to the order in Shopify admin (null if no domain).
        adminUrl:
          shopDomain && numericOrderId
            ? `https://${shopDomain}/admin/orders/${numericOrderId}`
            : null,
        customerName: r.customer_name,
        phone: r.phone,
        email: r.email,
        city: r.city,
        address: [r.address1, r.address2].filter(Boolean).join(', ') || null,
        totalPrice: r.total_price == null ? null : Number(r.total_price),
        totalOutstanding: r.total_outstanding == null ? null : Number(r.total_outstanding),
        currency: r.currency,
        items: (r.line_items as unknown) ?? [],
        itemsSummary: r.line_items_summary,
        financialStatus: r.financial_status,
        fulfillmentStatus: r.fulfillment_status,
        // 'confirmed' | 'pending' | 'undeliverable' | 'cancelled' | 'none'.
        // Manual override wins; else the customer's confirmation-template reply;
        // else 'none' (no confirmation was ever attempted for this order).
        confirmationStatus: r.manual_confirmed_at
          ? 'confirmed'
          : (msgStatusByGid.get(r.shopify_order_gid) ?? 'none'),
        archived: r.archived_at != null,
        createdAt: r.shopify_created_at,
        suggestedCourier: suggestion?.courierType ?? null,
        suggestedCityCode: suggestion?.cityCode ?? null,
        // Every courier serving this city (default first) — the UI's per-row and
        // bulk courier override picks from here.
        availableCouriers: serving.map((s) => s.courierType),
        // No mapping for this city on any active courier → booking will refuse;
        // surface it so the agent can add a mapping or pick manually.
        needsCityMapping: !suggestion,
        shipment: ship
          ? {
              id: ship.id,
              status: ship.status,
              courierType: ship.courier_type,
              trackingNumber: ship.courier_tracking_number,
              // Why the parcel is attempted/failed (courier reason) + the advice
              // already sent, so the board can show it and gate the advice action.
              lastStatusReason: ship.last_status_reason,
              shipperAdviceStatus: ship.shipper_advice_status,
              slipLink: ship.courier_slip_link,
            }
          : null,
        assignedUserId: r.assigned_user_id,
        assignedName: r.assigned_user_id ? userById.get(r.assigned_user_id) ?? null : null,
      });
    }
    return { rows: out, total, page, pageSize };
  }

  /**
   * All order GIDs matching a queue filter (for "select all N across pages").
   * Lean — GIDs only, capped. The caller's bulk action validates eligibility.
   */
  async listQueueIds(
    companyId: number,
    opts: {
      search?: string;
      status?: QueueStatus;
    } = {},
  ): Promise<string[]> {
    const search = (opts.search ?? '').trim();
    const status = opts.status ?? 'unfulfilled';
    const where = await this.buildQueueWhere(companyId, search, status);
    const rows = await this.prisma.shopifyOrder.findMany({
      where,
      select: { shopify_order_gid: true },
      take: 5000,
    });
    return rows.map((r) => r.shopify_order_gid);
  }

  /**
   * Per-courier delivery performance over a date range (by order date). Reads
   * the ORDERS mirror — the `tracking_company` + `delivery_status` captured
   * from Shopify fulfillments/* webhooks — so it covers EVERY order (including
   * ones fulfilled outside CodesApp), not just app-booked shipments. Courier =
   * the store's `tracking_company` label. Also a per-city breakdown so the
   * tenant can see which courier delivers best where.
   */
  async courierPerformance(companyId: number, from: Date, to: Date) {
    const n = (v: bigint | number | null): number => (v == null ? 0 : Number(v));
    // Performance = the delivery outcome of orders that ACTUALLY shipped via a
    // courier. Per tenant direction, orders that were CANCELLED (a customer/
    // admin cancellation) or are UNFULFILLED have nothing to do with courier
    // performance and are excluded entirely. A RETURN (RTO) is a real courier
    // outcome, so it's driven by the SHIPMENT reaching 'returned' (the courier
    // reported it back) — NOT by the order being cancelled (an RTO cancels the
    // order too, but so does a plain cancel; the shipment status is what tells
    // them apart).
    const RETURNED_EXISTS = `EXISTS (SELECT 1 FROM shipments s WHERE s.company_id = o.company_id AND s.shopify_order_gid = o.shopify_order_gid AND s.status = 'returned')`;
    const DELIVERED = `(o.cancelled_at IS NULL AND o.delivery_status = 'delivered')`;
    const FAILED = `(o.cancelled_at IS NULL AND o.delivery_status IN ('failure','attempted_delivery','not_delivered'))`;
    const INPROG = `(o.cancelled_at IS NULL AND (o.delivery_status IN ('confirmed','in_transit','out_for_delivery','ready_for_pickup','label_printed','label_purchased') OR o.delivery_status IS NULL))`;
    // Population: fulfilled + courier-shipped orders, EXCLUDING plain
    // cancellations (kept only if the parcel actually came back as a return).
    const POP = Prisma.raw(
      `o.tracking_company IS NOT NULL AND o.tracking_company <> '' ` +
        `AND o.fulfillment_status = 'fulfilled' ` +
        `AND (o.cancelled_at IS NULL OR ${RETURNED_EXISTS})`,
    );

    type Agg = {
      courier: string;
      total: bigint | number;
      delivered: bigint | number;
      returned: bigint | number;
      failed: bigint | number;
      in_progress: bigint | number;
      avg_lead_hours: number | null;
    };
    const rows = await this.prisma.$queryRaw<Agg[]>(Prisma.sql`
      SELECT o.tracking_company AS courier,
        COUNT(*) AS total,
        SUM(${Prisma.raw(DELIVERED)}) AS delivered,
        SUM(CASE WHEN ${Prisma.raw(RETURNED_EXISTS)} THEN 1 ELSE 0 END) AS returned,
        SUM(${Prisma.raw(FAILED)}) AS failed,
        SUM(${Prisma.raw(INPROG)}) AS in_progress,
        AVG(CASE WHEN ${Prisma.raw(DELIVERED)} AND o.delivered_at IS NOT NULL AND o.shopify_created_at IS NOT NULL
              THEN TIMESTAMPDIFF(HOUR, o.shopify_created_at, o.delivered_at) END) AS avg_lead_hours
      FROM shopify_orders o
      WHERE o.company_id = ${companyId} AND ${POP}
        AND o.shopify_created_at BETWEEN ${from} AND ${to}
      GROUP BY o.tracking_company
    `);

    const couriers = rows.map((r) => {
      const delivered = n(r.delivered);
      const returned = n(r.returned);
      const failed = n(r.failed);
      const resolved = delivered + returned + failed;
      return {
        courier: r.courier,
        total: n(r.total),
        delivered,
        returned,
        failed,
        inProgress: n(r.in_progress),
        // Rates over RESOLVED shipments only (in-progress excluded).
        deliveryRate: resolved ? delivered / resolved : null,
        returnRate: delivered + returned ? returned / (delivered + returned) : null,
        avgLeadDays: r.avg_lead_hours != null ? Number(r.avg_lead_hours) / 24 : null,
      };
    });

    type CityAgg = {
      city: string | null;
      courier: string;
      total: bigint | number;
      delivered: bigint | number;
      returned: bigint | number;
      failed: bigint | number;
    };
    const cityRows = await this.prisma.$queryRaw<CityAgg[]>(Prisma.sql`
      SELECT o.city AS city, o.tracking_company AS courier,
        COUNT(*) AS total,
        SUM(${Prisma.raw(DELIVERED)}) AS delivered,
        SUM(CASE WHEN ${Prisma.raw(RETURNED_EXISTS)} THEN 1 ELSE 0 END) AS returned,
        SUM(${Prisma.raw(FAILED)}) AS failed
      FROM shopify_orders o
      WHERE o.company_id = ${companyId} AND ${POP}
        AND o.city IS NOT NULL AND o.city <> ''
        AND o.shopify_created_at BETWEEN ${from} AND ${to}
      GROUP BY o.city, o.tracking_company
    `);
    const byCity = new Map<
      string,
      {
        city: string;
        total: number;
        couriers: Array<{
          courier: string;
          total: number;
          delivered: number;
          returned: number;
          failed: number;
          deliveryRate: number | null;
        }>;
      }
    >();
    for (const c of cityRows) {
      const city = c.city as string;
      if (!byCity.has(city)) byCity.set(city, { city, total: 0, couriers: [] });
      const entry = byCity.get(city)!;
      const delivered = n(c.delivered);
      const returned = n(c.returned);
      const failed = n(c.failed);
      const total = n(c.total);
      entry.total += total;
      const res = delivered + returned + failed;
      entry.couriers.push({
        courier: c.courier,
        total,
        delivered,
        returned,
        failed,
        deliveryRate: res ? delivered / res : null,
      });
    }
    const cities = Array.from(byCity.values()).sort((a, b) => b.total - a.total);

    return { couriers, cities };
  }

  /**
   * The Shipments list — server-side filtered + paginated. Was previously a
   * flat `take: 200` with the status tabs filtered client-side; with thousands
   * of shipments that meant the tabs (and Refresh) only ever saw the 200
   * newest-by-created_at rows, so most statuses looked empty. Filtering +
   * paging on the server fixes that. `needsAttention` = an unmappable courier
   * status on a still-booked row, or a booking error.
   */
  async listShipments(
    companyId: number,
    filters: {
      status?: ShipmentStatus;
      courierType?: CourierType;
      needsAttention?: boolean;
      // Only booked shipments not yet on a loadsheet — the Shipments tab's
      // worklist ("generate a loadsheet for these").
      loadsheetPending?: boolean;
      page?: number;
      pageSize?: number;
    } = {},
  ) {
    const page = Math.max(1, Math.floor(filters.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.floor(filters.pageSize ?? 50)));
    const where: Prisma.ShipmentWhereInput = {
      company_id: companyId,
      ...(filters.courierType ? { courier_type: filters.courierType } : {}),
      ...(filters.loadsheetPending
        ? { status: 'booked', loadsheet_batch_id: null }
        : filters.needsAttention
        ? {
            OR: [
              { booking_error: { not: null } },
              {
                AND: [
                  { last_courier_status_raw: { not: null } },
                  { status: 'booked' },
                ],
              },
            ],
          }
        : filters.status
          ? { status: filters.status }
          : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.shipment.count({ where }),
      this.prisma.shipment.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { rows, total, page, pageSize };
  }

  async getShipment(companyId: number, id: number) {
    const row = await this.prisma.shipment.findFirst({
      where: { id, company_id: companyId },
    });
    if (!row) throw new NotFoundException('Shipment not found');
    return row;
  }

  /**
   * Courier pending payments, split into two buckets per courier:
   *  - RECEIVABLE: COD owed NOW = delivered, unsettled parcels that still carry
   *    an outstanding balance (>0). Count matches the amount (already-settled /
   *    prepaid delivered parcels have 0 balance and drop out).
   *  - WITH COURIER (in transit): parcels still out (booked/in_transit/out for
   *    delivery/attempted/failed/…) — not collectable yet; shown as a count +
   *    the COD expected once they deliver. Returned/cancelled are excluded.
   * Everything is scoped to `courier_settled_at IS NULL` (unreconciled).
   */
  async courierPendingPayments(companyId: number) {
    const n = (v: bigint | number | string | null): number =>
      v == null ? 0 : Number(v);
    const rows = await this.prisma.$queryRaw<
      Array<{
        courier: CourierType;
        receivable: string | number | null;
        receivable_count: bigint | number;
        in_transit_count: bigint | number;
        in_transit_expected: string | number | null;
        currency: string | null;
      }>
    >(Prisma.sql`
      SELECT s.courier_type AS courier,
        SUM(CASE WHEN s.status = 'delivered' AND COALESCE(o.total_outstanding,0) > 0
              THEN o.total_outstanding ELSE 0 END) AS receivable,
        SUM(CASE WHEN s.status = 'delivered' AND COALESCE(o.total_outstanding,0) > 0
              THEN 1 ELSE 0 END) AS receivable_count,
        SUM(CASE WHEN s.status <> 'delivered' THEN 1 ELSE 0 END) AS in_transit_count,
        SUM(CASE WHEN s.status <> 'delivered' THEN COALESCE(o.total_outstanding,0) ELSE 0 END) AS in_transit_expected,
        MAX(o.currency) AS currency
      FROM shipments s
      LEFT JOIN shopify_orders o
        ON o.company_id = s.company_id AND o.shopify_order_gid = s.shopify_order_gid
      WHERE s.company_id = ${companyId}
        AND s.courier_settled_at IS NULL
        AND s.status IN (${Prisma.join(PAYMENT_ACTIVE_STATUSES)})
      GROUP BY s.courier_type
    `);
    const couriers = rows
      .map((r) => ({
        courier: r.courier,
        receivable: n(r.receivable),
        receivableCount: n(r.receivable_count),
        inTransitCount: n(r.in_transit_count),
        inTransitExpected: n(r.in_transit_expected),
        currency: r.currency,
      }))
      // Drop couriers with nothing outstanding and nothing in transit.
      .filter((c) => c.receivableCount > 0 || c.inTransitCount > 0);
    const currency = couriers.find((c) => c.currency)?.currency ?? null;
    return {
      couriers,
      totals: {
        receivable: couriers.reduce((s, c) => s + c.receivable, 0),
        receivableCount: couriers.reduce((s, c) => s + c.receivableCount, 0),
        inTransitCount: couriers.reduce((s, c) => s + c.inTransitCount, 0),
        inTransitExpected: couriers.reduce((s, c) => s + c.inTransitExpected, 0),
      },
      currency,
    };
  }

  /**
   * Drill-down list for one courier, per bucket:
   *  - 'receivable': delivered + unsettled + outstanding COD > 0 (money owed
   *    now), biggest first — these carry the Mark-paid checkboxes.
   *  - 'transit': still with the courier (non-delivered active statuses),
   *    most-recent first — a read-only tracking list with expected COD.
   * Joined to the mirror for the order's outstanding balance, tenant-scoped.
   */
  async listPendingPayments(
    companyId: number,
    opts: {
      courierType?: CourierType;
      bucket?: 'receivable' | 'transit';
      page?: number;
      pageSize?: number;
    } = {},
  ) {
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.floor(opts.pageSize ?? 50)));
    const bucket = opts.bucket ?? 'receivable';
    const n = (v: bigint | number | string | null): number =>
      v == null ? 0 : Number(v);

    const bucketClause =
      bucket === 'receivable'
        ? Prisma.sql`s.status = 'delivered' AND COALESCE(o.total_outstanding,0) > 0`
        : Prisma.sql`s.status <> 'delivered' AND s.status IN (${Prisma.join(
            PAYMENT_ACTIVE_STATUSES,
          )})`;
    const courierClause = opts.courierType
      ? Prisma.sql`AND s.courier_type = ${opts.courierType}`
      : Prisma.empty;
    const orderBy =
      bucket === 'receivable'
        ? Prisma.sql`o.total_outstanding DESC`
        : Prisma.sql`s.updated_at DESC`;

    const where = Prisma.sql`
      FROM shipments s
      LEFT JOIN shopify_orders o
        ON o.company_id = s.company_id AND o.shopify_order_gid = s.shopify_order_gid
      WHERE s.company_id = ${companyId}
        AND s.courier_settled_at IS NULL
        ${courierClause}
        AND (${bucketClause})
    `;

    const countRows = await this.prisma.$queryRaw<Array<{ c: bigint | number }>>(
      Prisma.sql`SELECT COUNT(*) AS c ${where}`,
    );
    const total = n(countRows[0]?.c ?? 0);

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: number;
        shopify_order_name: string | null;
        courier_type: CourierType;
        destination_city: string | null;
        status: ShipmentStatus;
        delivered_at: Date | null;
        phone: string | null;
        total_outstanding: string | number | null;
        currency: string | null;
      }>
    >(Prisma.sql`
      SELECT s.id, s.shopify_order_name, s.courier_type, s.destination_city,
        s.status, s.delivered_at, o.phone, o.total_outstanding, o.currency
      ${where}
      ORDER BY ${orderBy}
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `);

    const out = rows.map((r) => ({
      shipmentId: r.id,
      orderName: r.shopify_order_name,
      courier: r.courier_type,
      city: r.destination_city,
      status: r.status,
      phone: r.phone,
      receivable: n(r.total_outstanding),
      currency: r.currency,
      deliveredAt: r.delivered_at,
    }));
    return { rows: out, total, page, pageSize };
  }

  /**
   * Mark courier COD as remitted/reconciled — clears the shipments from pending
   * payments. Either an explicit set of shipment ids, or "all delivered
   * unsettled for a courier" (batch reconciliation). Tenant-scoped.
   */
  async settlePayments(
    companyId: number,
    opts: { shipmentIds?: number[]; courierType?: CourierType },
  ): Promise<{ settled: number }> {
    const ids = (opts.shipmentIds ?? []).filter((v) => Number.isFinite(v));
    if (!ids.length && !opts.courierType) {
      throw new BadRequestException(
        'Provide shipmentIds or a courierType to settle.',
      );
    }
    const res = await this.prisma.shipment.updateMany({
      where: {
        company_id: companyId,
        status: 'delivered',
        courier_settled_at: null,
        ...(ids.length ? { id: { in: ids } } : {}),
        ...(opts.courierType ? { courier_type: opts.courierType } : {}),
      },
      data: { courier_settled_at: new Date() },
    });
    return { settled: res.count };
  }

  /**
   * Creates the Shipment row and queues the booking job. Runs
   * AddressQualityService first: an address-issue finding is advisory — it
   * sets the row to `address_issue` (customer reconfirm sent) UNLESS the
   * agent already overrode it, mirroring the fact that the tenant's own
   * manual "Wrong Address" judgment call wasn't a strict formula either.
   */
  async bookShipment(params: BookShipmentParams) {
    const order = await this.shopify.getOrderForBooking(
      params.companyId,
      params.shopifyOrderName,
    );
    if (!order) {
      throw new BadRequestException(
        `Shopify order ${params.shopifyOrderName} not found.`,
      );
    }
    if (!order.shipping) {
      throw new BadRequestException('Order has no shipping address.');
    }
    if (!order.fulfillmentOrderId) {
      throw new BadRequestException(
        'Order has no open fulfillment order (already fulfilled or cancelled?).',
      );
    }

    const existing = await this.prisma.shipment.findUnique({
      where: {
        company_id_shopify_order_gid: {
          company_id: params.companyId,
          shopify_order_gid: order.orderGid,
        },
      },
    });
    if (existing && !['cancelled', 'returned'].includes(existing.status)) {
      throw new BadRequestException(
        `Order ${order.orderName} already has an active shipment (status: ${existing.status}).`,
      );
    }

    // CodesApp's `shopify_orders` mirror is the SOURCE OF TRUTH for the address:
    // it holds the webhook-captured details and any agent correction (which also
    // writes back to Shopify). Shopify's PII gating means its live shipping
    // address is often empty, and a stale live value must never win over a
    // correction made here. So the mirror wins; live Shopify is only a fallback.
    const mirror = await this.prisma.shopifyOrder.findUnique({
      where: {
        company_id_shopify_order_gid: {
          company_id: params.companyId,
          shopify_order_gid: order.orderGid,
        },
      },
      select: { city: true, address1: true, address2: true },
    });
    const shipCity = mirror?.city || order.shipping.city || '';
    const shipAddress1 = mirror?.address1 || order.shipping.address1 || '';
    const shipAddress2 = mirror?.address2 || order.shipping.address2 || undefined;

    let courierType = params.courierType;
    if (!courierType) {
      const suggestions = await this.listCouriersForCity(
        params.companyId,
        shipCity,
      );
      courierType = suggestions[0]?.courierType;
      if (!courierType) {
        throw new BadRequestException(
          `No courier configured for city "${shipCity}". Choose one manually or add a city mapping in Settings > Courier.`,
        );
      }
    }

    let addressIssueReason: string | null = null;
    if (!params.overrideAddressIssue) {
      const assessment = await this.addressQuality.assess(
        params.companyId,
        shipAddress1,
        shipCity,
      );
      if (!assessment.ok) addressIssueReason = assessment.reason;
    }

    const shipment = await this.prisma.shipment.upsert({
      where: {
        company_id_shopify_order_gid: {
          company_id: params.companyId,
          shopify_order_gid: order.orderGid,
        },
      },
      create: {
        company_id: params.companyId,
        shopify_order_gid: order.orderGid,
        shopify_order_name: order.orderName,
        courier_type: courierType,
        destination_city: shipCity,
        destination_address: [shipAddress1, shipAddress2]
          .filter(Boolean)
          .join(', '),
        status: addressIssueReason ? 'address_issue' : 'booked',
        address_issue_reason: addressIssueReason,
        address_issue_notified_at: addressIssueReason ? new Date() : null,
        created_by_user_id: params.createdByUserId,
      },
      update: {
        courier_type: courierType,
        status: addressIssueReason ? 'address_issue' : 'booked',
        address_issue_reason: addressIssueReason,
        address_issue_notified_at: addressIssueReason ? new Date() : null,
        booking_error: null,
      },
    });

    if (addressIssueReason) {
      // Advisory stop — the agent sees the reason in the UI and can either
      // resolve it or override. No booking job is queued; booking resumes
      // via `resolveAddressIssue`. Meanwhile ask the customer to confirm
      // their address (non-blocking, never throws).
      void this.addressIssueNotifier.notify(shipment.id);
      return shipment;
    }

    await this.jobQueue.enqueue(
      COURIER_BOOKING_QUEUE,
      { shipmentId: shipment.id } satisfies BookJobPayload,
      { maxAttempts: 3 },
    );
    return shipment;
  }

  /** Agent resolves an address_issue row — either the customer confirmed
   *  the address, or the agent is overriding the flag — and booking proceeds. */
  async resolveAddressIssue(companyId: number, shipmentId: number) {
    const shipment = await this.getShipment(companyId, shipmentId);
    if (shipment.status !== 'address_issue') {
      throw new BadRequestException('Shipment is not in an address_issue state.');
    }
    await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: { status: 'booked', address_confirmed_at: new Date() },
    });
    await this.jobQueue.enqueue(
      COURIER_BOOKING_QUEUE,
      { shipmentId: shipment.id } satisfies BookJobPayload,
      { maxAttempts: 3 },
    );
  }

  /**
   * Agent manually flags an order's address as wrong. Creates/updates the
   * shipment in `address_issue` (so it leaves To-book, shows the reason, and the
   * customer gets the address-confirm template) WITHOUT booking. The agent then
   * corrects the address (Edit address) and clicks Resolve & book. Never books a
   * parcel; refuses if the order is already actively booked/in-flight.
   */
  async markWrongAddress(
    companyId: number,
    orderGid: string,
    reason?: string,
    courierType?: CourierType,
  ) {
    const orderRow = await this.prisma.shopifyOrder.findUnique({
      where: {
        company_id_shopify_order_gid: { company_id: companyId, shopify_order_gid: orderGid },
      },
      select: { order_name: true, city: true },
    });
    if (!orderRow) throw new NotFoundException('Order not found.');

    const existing = await this.prisma.shipment.findUnique({
      where: {
        company_id_shopify_order_gid: { company_id: companyId, shopify_order_gid: orderGid },
      },
    });
    if (
      existing &&
      ['booked', 'in_transit', 'out_for_delivery', 'picked_up', 'ready_for_pickup', 'delivered'].includes(
        existing.status,
      )
    ) {
      throw new BadRequestException(
        `Order ${orderRow.order_name ?? orderGid} is already booked (${existing.status}). Cancel the booking first.`,
      );
    }

    // Need a courier for the shipment row; the real one is picked at Resolve
    // time. Prefer an explicit choice → the city's suggestion → any active courier.
    let ct = courierType ?? existing?.courier_type ?? undefined;
    if (!ct) {
      const suggestions = await this.listCouriersForCity(companyId, orderRow.city ?? '');
      ct = suggestions[0]?.courierType;
    }
    if (!ct) {
      const active = await this.registry.getActiveCouriers(companyId);
      ct = active[0];
    }
    if (!ct) {
      throw new BadRequestException('Configure a courier first (Settings → Courier).');
    }

    const reasonText = (reason && reason.trim()) || 'Address flagged as incorrect by agent.';
    const shipment = await this.prisma.shipment.upsert({
      where: {
        company_id_shopify_order_gid: { company_id: companyId, shopify_order_gid: orderGid },
      },
      create: {
        company_id: companyId,
        shopify_order_gid: orderGid,
        shopify_order_name: orderRow.order_name,
        courier_type: ct,
        status: 'address_issue',
        address_issue_reason: reasonText,
        address_issue_notified_at: new Date(),
      },
      update: {
        status: 'address_issue',
        address_issue_reason: reasonText,
        address_issue_notified_at: new Date(),
        booking_error: null,
      },
    });
    void this.addressIssueNotifier.notify(shipment.id);
    return shipment;
  }

  /**
   * A parcel came back (RTO). The tenant's return handling: mark the shipment
   * returned, BLACKLIST the customer (`contacts.status='blocked'`), and CANCEL +
   * ARCHIVE the order in Shopify. Runs from the manual "Mark received" action
   * and from the auto path (a courier webhook mapping to `returned`). Idempotent:
   * a shipment already `returned` skips the Shopify cancel/archive re-run (auto
   * webhook redeliveries are harmless) but still ensures the blacklist applied.
   * All destructive steps are best-effort/non-throwing so one failing step
   * (e.g. Shopify already-cancelled) never blocks the others.
   */
  async processReturn(
    companyId: number,
    shipmentId: number,
    source: 'manual' | 'auto',
  ): Promise<{
    blacklisted: boolean;
    cancelled: boolean;
    archived: boolean;
    alreadyProcessed: boolean;
  }> {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id: shipmentId, company_id: companyId },
    });
    if (!shipment) throw new NotFoundException('Shipment not found.');

    const alreadyProcessed =
      shipment.status === 'returned' && shipment.cancelled_at != null;

    // Mark the shipment returned (records when we processed the receipt).
    await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        status: 'returned',
        cancelled_at: shipment.cancelled_at ?? new Date(),
      },
    });

    // Blacklist the customer — by linked contact, else matched on the mirror
    // order's phone (last 10 digits, tolerant of +country-code formatting).
    let blacklisted = false;
    try {
      let contactId = shipment.contact_id ?? null;
      if (!contactId) {
        const order = await this.prisma.shopifyOrder.findUnique({
          where: {
            company_id_shopify_order_gid: {
              company_id: companyId,
              shopify_order_gid: shipment.shopify_order_gid,
            },
          },
          select: { phone: true },
        });
        const digits = (order?.phone ?? '').replace(/\D/g, '');
        const last10 = digits.slice(-10);
        if (last10.length >= 7) {
          const contact = await this.prisma.contact.findFirst({
            where: { company_id: companyId, phone: { contains: last10 } },
            select: { id: true },
          });
          contactId = contact?.id ?? null;
        }
      }
      if (contactId) {
        await this.prisma.contact.update({
          where: { id: contactId },
          data: { status: 'blocked' },
        });
        blacklisted = true;
      }
    } catch (err) {
      this.logger.warn(
        `processReturn: blacklist failed for shipment ${shipment.id} (company ${companyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Cancel + archive the Shopify order (skip the heavy re-run if already done).
    let cancelled = false;
    let archived = false;
    if (!alreadyProcessed) {
      try {
        const r = await this.shopifyService.processOrderReturn(
          companyId,
          shipment.shopify_order_gid,
        );
        cancelled = r.cancelled;
        archived = r.archived;
      } catch (err) {
        this.logger.warn(
          `processReturn: Shopify cancel/archive failed for ${shipment.shopify_order_gid} (company ${companyId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    this.logger.log(
      `Return processed (${source}) shipment ${shipment.id} order ${shipment.shopify_order_name ?? shipment.shopify_order_gid}: blacklisted=${blacklisted} cancelled=${cancelled} archived=${archived}${alreadyProcessed ? ' (already processed)' : ''}`,
    );
    return { blacklisted, cancelled, archived, alreadyProcessed };
  }

  /**
   * Bulk "mark received" (RTO) for many parcels at once — by shipment ids OR by
   * order numbers (with or without a leading '#'). Only failed/attempted/returned
   * shipments are received; anything else is skipped, and order numbers with no
   * matching shipment are reported as not-found. Each parcel runs the full return
   * automation (blacklist + Shopify cancel/archive) via processReturn.
   */
  async bulkReceive(
    companyId: number,
    params: { shipmentIds?: number[]; orderNames?: string[] },
  ): Promise<{ received: number; skipped: number; notFound: string[] }> {
    const RECEIVABLE: ShipmentStatus[] = ['failed', 'attempted', 'returned'];

    let shipments: { id: number; status: ShipmentStatus; shopify_order_name: string | null }[] = [];
    let requested: string[] = [];

    if (params.shipmentIds?.length) {
      const ids = [...new Set(params.shipmentIds.filter((n) => Number.isFinite(n)))];
      shipments = await this.prisma.shipment.findMany({
        where: { company_id: companyId, id: { in: ids } },
        select: { id: true, status: true, shopify_order_name: true },
      });
    } else if (params.orderNames?.length) {
      // Normalize to Shopify's stored "#NNNN" form.
      requested = [
        ...new Set(
          params.orderNames
            .map((n) => (n || '').trim())
            .filter(Boolean)
            .map((n) => `#${n.replace(/^#+/, '')}`),
        ),
      ];
      shipments = await this.prisma.shipment.findMany({
        where: { company_id: companyId, shopify_order_name: { in: requested } },
        select: { id: true, status: true, shopify_order_name: true },
      });
    }

    const foundNames = new Set(shipments.map((s) => s.shopify_order_name));
    const notFound = requested.filter((n) => !foundNames.has(n));

    let received = 0;
    let skipped = 0;
    for (const s of shipments) {
      if (!RECEIVABLE.includes(s.status)) {
        skipped++;
        continue;
      }
      try {
        await this.processReturn(companyId, s.id, 'manual');
        received++;
      } catch {
        skipped++;
      }
    }
    return { received, skipped, notFound };
  }

  private async processBookingJob(payload: BookJobPayload): Promise<void> {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: payload.shipmentId },
    });
    if (!shipment) return;

    try {
      const order = await this.shopify.getOrderForBooking(
        shipment.company_id,
        shipment.shopify_order_name || '',
      );
      if (!order?.fulfillmentOrderId) {
        throw new Error('Order fulfillment data unavailable at booking time.');
      }

      // Fall back to the local mirror for any shipping field the LIVE Shopify
      // order leaves empty. Some orders keep a full address in the mirror
      // (captured at import / edited by an agent) while their live
      // shippingAddress is sparse — often only a city. Booking must use
      // whatever address we actually have, or the courier rejects it with an
      // empty name/phone/address 400 (the shipment then looks "booked" but was
      // never really placed). Mirror is also the COD-amount source.
      const mirror = await this.prisma.shopifyOrder.findUnique({
        where: {
          company_id_shopify_order_gid: {
            company_id: shipment.company_id,
            shopify_order_gid: shipment.shopify_order_gid,
          },
        },
        select: {
          total_outstanding: true,
          customer_name: true,
          phone: true,
          city: true,
          address1: true,
          address2: true,
        },
      });

      // Mirror is the source of truth (agent corrections + webhook data); live
      // Shopify is only a fallback for a field the mirror somehow lacks.
      const live = order.shipping;
      const dest = {
        name: (mirror?.customer_name || live?.name || '').trim(),
        phone: (mirror?.phone || live?.phone || '').trim(),
        city: (mirror?.city || live?.city || '').trim(),
        address1: (mirror?.address1 || live?.address1 || '').trim(),
        address2: (mirror?.address2 || live?.address2 || undefined) ?? undefined,
      };
      if (!dest.name || !dest.phone || !dest.city || !dest.address1) {
        throw new Error(
          `Incomplete shipping details for booking — need name, phone, city and street address. ` +
            `Missing: ${[
              !dest.name && 'name',
              !dest.phone && 'phone',
              !dest.city && 'city',
              !dest.address1 && 'address',
            ]
              .filter(Boolean)
              .join(', ')}.`,
        );
      }

      const cityCode = await this.cityMapping.requireCode(
        shipment.company_id,
        shipment.courier_type,
        dest.city,
      );

      const { credentialId, creds } = await this.registry.requireCredentials(
        shipment.company_id,
        shipment.courier_type,
      );
      const adapter = this.registry.getAdapter(shipment.courier_type);

      const codAmount = mirror?.total_outstanding
        ? Number(mirror.total_outstanding)
        : 0;

      const result = await adapter.bookShipment(creds, {
        companyId: shipment.company_id,
        shopifyOrderName: order.orderName,
        destination: {
          name: dest.name,
          phone: dest.phone,
          city: dest.city,
          cityCode,
          address1: dest.address1,
          address2: dest.address2,
        },
        codAmount,
        itemsDescription: order.lineItemsSummary,
        pieces: 1,
      });

      // Update Shopify with a RECOGNIZED carrier name + a working courier
      // tracking link (was passing the lowercase enum and no URL, so Shopify
      // showed no clickable link and "postex" as the carrier).
      const courierName = COURIER_DISPLAY_NAME[shipment.courier_type];
      const trackingUrl = courierTrackingUrl(shipment.courier_type, result.trackingNumber);
      const { fulfillmentId, errors } = await this.shopify.createFulfillment(
        shipment.company_id,
        order.fulfillmentOrderId,
        result.trackingNumber,
        courierName,
        trackingUrl,
      );
      if (errors.length) {
        this.logger.warn(
          `fulfillmentCreate userErrors (shipment ${shipment.id}): ${errors.join('; ')}`,
        );
      }
      // Tag the order with the courier's proper name (Trax/PostEx/Leopards/
      // Rocket), removing the old lowercase-enum tag if it's still there.
      await this.shopify.tagOrder(
        shipment.company_id,
        order.orderGid,
        [courierName],
        [shipment.courier_type],
      );

      // Capture the courier's per-parcel label link when it hands one back at
      // booking (Leopards slip_link) — used later by the label download.
      const slipLink = extractSlipLink(result.raw);

      await this.prisma.shipment.update({
        where: { id: shipment.id },
        data: {
          status: 'booked',
          courier_credential_id: credentialId,
          courier_tracking_number: result.trackingNumber,
          courier_city_code: cityCode,
          courier_slip_link: slipLink ?? undefined,
          shopify_fulfillment_gid: fulfillmentId,
          booked_at: new Date(),
          booking_error: null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A failed booking must NOT stay 'booked' — it isn't on the courier, isn't
      // fulfilled in Shopify, and isn't tagged. Leaving it 'booked' also made it
      // loadsheet-eligible. Move it to address_issue so it resurfaces in the
      // needs-attention worklist; booking_error carries the real reason. A later
      // retry that succeeds promotes it back to 'booked'. (If the row is already
      // terminal — e.g. a late webhook advanced it — leave that status alone.)
      const revert = shipment.status === 'booked' ? { status: 'address_issue' as const } : {};
      await this.prisma.shipment.update({
        where: { id: shipment.id },
        data: {
          ...revert,
          booking_error: message,
          address_issue_reason:
            shipment.address_issue_reason ?? 'Booking failed — see booking error.',
        },
      });
      throw err; // let JobQueueService retry/backoff
    }
  }
}
