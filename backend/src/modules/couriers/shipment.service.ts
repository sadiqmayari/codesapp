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
import { AddressQualityService } from './address-quality.service';
import { AddressIssueNotifier } from './address-issue-notifier.service';
import {
  COURIER_BOOKING_QUEUE,
  COURIER_BULK_BOOK_QUEUE,
} from './couriers.constants';

interface BookJobPayload {
  shipmentId: number;
}

interface BulkBookJobPayload {
  companyId: number;
  orderGids: string[];
  courierType?: CourierType;
  createdByUserId?: number;
  overrideAddressIssue?: boolean;
}

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
      includeFulfilled?: boolean;
    } = {},
  ) {
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize ?? 50)));
    const search = (opts.search ?? '').trim();

    const where: Prisma.ShopifyOrderWhereInput = {
      company_id: companyId,
      cancelled_at: null,
      ...(opts.includeFulfilled ? {} : { fulfillment_status: 'unfulfilled' }),
      ...(search
        ? {
            OR: [
              { order_name: { contains: search } },
              { customer_name: { contains: search } },
              { phone: { contains: search } },
              { city: { contains: search } },
            ],
          }
        : {}),
    };

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
          select: { id: true, shopify_order_gid: true, status: true, courier_type: true, courier_tracking_number: true },
        })
      : [];
    const shipmentByGid = new Map(shipments.map((s) => [s.shopify_order_gid, s]));

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
      { courierType: CourierType; cityCode: string } | null
    >();
    const suggestFor = async (city: string | null) => {
      const key = (city ?? '').toLowerCase().trim();
      if (!key) return null;
      if (suggestionCache.has(key)) return suggestionCache.get(key)!;
      const s = await this.cityMapping.suggestCourier(companyId, city ?? '', active);
      const top = s[0]
        ? { courierType: s[0].courierType, cityCode: s[0].cityCode }
        : null;
      suggestionCache.set(key, top);
      return top;
    };

    const out = [];
    for (const r of rows) {
      const suggestion = await suggestFor(r.city);
      const ship = shipmentByGid.get(r.shopify_order_gid) ?? null;
      out.push({
        orderGid: r.shopify_order_gid,
        orderName: r.order_name,
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
        createdAt: r.shopify_created_at,
        suggestedCourier: suggestion?.courierType ?? null,
        suggestedCityCode: suggestion?.cityCode ?? null,
        // No mapping for this city on any active courier → booking will refuse;
        // surface it so the agent can add a mapping or pick manually.
        needsCityMapping: !suggestion,
        shipment: ship
          ? {
              id: ship.id,
              status: ship.status,
              courierType: ship.courier_type,
              trackingNumber: ship.courier_tracking_number,
            }
          : null,
        assignedUserId: r.assigned_user_id,
        assignedName: r.assigned_user_id ? userById.get(r.assigned_user_id) ?? null : null,
      });
    }
    return { rows: out, total, page, pageSize };
  }

  async listShipments(
    companyId: number,
    filters: { status?: ShipmentStatus; courierType?: CourierType } = {},
  ) {
    return this.prisma.shipment.findMany({
      where: {
        company_id: companyId,
        status: filters.status,
        courier_type: filters.courierType,
      },
      orderBy: { created_at: 'desc' },
      take: 200,
    });
  }

  async getShipment(companyId: number, id: number) {
    const row = await this.prisma.shipment.findFirst({
      where: { id, company_id: companyId },
    });
    if (!row) throw new NotFoundException('Shipment not found');
    return row;
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

    let courierType = params.courierType;
    if (!courierType) {
      const suggestions = await this.listCouriersForCity(
        params.companyId,
        order.shipping.city,
      );
      courierType = suggestions[0]?.courierType;
      if (!courierType) {
        throw new BadRequestException(
          `No courier configured for city "${order.shipping.city}". Choose one manually or add a city mapping in Settings > Courier.`,
        );
      }
    }

    let addressIssueReason: string | null = null;
    if (!params.overrideAddressIssue) {
      const assessment = await this.addressQuality.assess(
        params.companyId,
        order.shipping.address1,
        order.shipping.city,
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
        destination_city: order.shipping.city,
        destination_address: [order.shipping.address1, order.shipping.address2]
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
      if (!order?.shipping || !order.fulfillmentOrderId) {
        throw new Error('Order shipping/fulfillment data unavailable at booking time.');
      }

      const cityCode = await this.cityMapping.requireCode(
        shipment.company_id,
        shipment.courier_type,
        order.shipping.city,
      );

      const { credentialId, creds } = await this.registry.requireCredentials(
        shipment.company_id,
        shipment.courier_type,
      );
      const adapter = this.registry.getAdapter(shipment.courier_type);

      // COD amount the courier must collect = the order's outstanding balance
      // from the local mirror (0 once paid). Replaces the old hardcoded 0 that
      // would have told couriers to collect nothing on COD orders.
      const mirror = await this.prisma.shopifyOrder.findUnique({
        where: {
          company_id_shopify_order_gid: {
            company_id: shipment.company_id,
            shopify_order_gid: shipment.shopify_order_gid,
          },
        },
        select: { total_outstanding: true },
      });
      const codAmount = mirror?.total_outstanding
        ? Number(mirror.total_outstanding)
        : 0;

      const result = await adapter.bookShipment(creds, {
        companyId: shipment.company_id,
        shopifyOrderName: order.orderName,
        destination: {
          name: order.shipping.name,
          phone: order.shipping.phone,
          city: order.shipping.city,
          cityCode,
          address1: order.shipping.address1,
          address2: order.shipping.address2 ?? undefined,
        },
        codAmount,
        itemsDescription: order.lineItemsSummary,
        pieces: 1,
      });

      const { fulfillmentId, errors } = await this.shopify.createFulfillment(
        shipment.company_id,
        order.fulfillmentOrderId,
        result.trackingNumber,
        shipment.courier_type,
      );
      if (errors.length) {
        this.logger.warn(
          `fulfillmentCreate userErrors (shipment ${shipment.id}): ${errors.join('; ')}`,
        );
      }
      await this.shopify.tagOrder(shipment.company_id, order.orderGid, [shipment.courier_type], []);

      await this.prisma.shipment.update({
        where: { id: shipment.id },
        data: {
          status: 'booked',
          courier_credential_id: credentialId,
          courier_tracking_number: result.trackingNumber,
          courier_city_code: cityCode,
          shopify_fulfillment_gid: fulfillmentId,
          booked_at: new Date(),
          booking_error: null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.shipment.update({
        where: { id: shipment.id },
        data: { booking_error: message },
      });
      throw err; // let JobQueueService retry/backoff
    }
  }
}
