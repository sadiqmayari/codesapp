import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { CourierType, ShipmentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { CourierRegistryService } from './courier-registry.service';
import { CityMappingService } from './city-mapping.service';
import { ShopifyFulfillmentClient } from './shopify-fulfillment-client.service';
import { AddressQualityService } from './address-quality.service';
import { AddressIssueNotifier } from './address-issue-notifier.service';
import { COURIER_BOOKING_QUEUE } from './couriers.constants';

interface BookJobPayload {
  shipmentId: number;
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
  }

  async listCouriersForCity(
    companyId: number,
    city: string,
  ): Promise<{ courierType: CourierType; cityCode: string; isDefault: boolean }[]> {
    const active = await this.registry.getActiveCouriers(companyId);
    return this.cityMapping.suggestCourier(companyId, city, active);
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
        codAmount: 0,
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
