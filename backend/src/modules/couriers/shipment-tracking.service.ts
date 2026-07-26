import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CourierType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CourierRegistryService } from './courier-registry.service';
import { ShopifyFulfillmentClient } from './shopify-fulfillment-client.service';
import { ShipmentService } from './shipment.service';
import {
  SHIPMENT_STATUS_TO_SHOPIFY_EVENT,
  TERMINAL_SHIPMENT_STATUSES,
} from './couriers.constants';
import { UnmappedCourierStatusError } from './adapters/courier-adapter.interface';
import { AddressIssueNotifier } from './address-issue-notifier.service';

interface NormalizedEvent {
  trackingNumber: string;
  rawStatus: string;
  reason?: string;
}

/** Pulls {trackingNumber, rawStatus, reason} out of each courier's own
 *  webhook payload shape, as observed in the tenant's n8n tracking flows. */
function normalizeEvent(courierType: CourierType, body: any): NormalizedEvent | null {
  if (courierType === 'postex') {
    if (!body?.trackingNumber || !body?.orderStatus) return null;
    return {
      trackingNumber: String(body.trackingNumber),
      rawStatus: String(body.orderStatus),
      reason: body.lastAttemptReason ? String(body.lastAttemptReason) : undefined,
    };
  }
  if (courierType === 'trax') {
    if (!body?.tracking_number || !body?.status) return null;
    return {
      trackingNumber: String(body.tracking_number),
      rawStatus: String(body.status),
    };
  }
  if (courierType === 'leopards') {
    // Leopards delivers a batch: { data: [{ cn_number, status, ... }] }.
    // The webhook controller fans out per-item before calling this, so by
    // the time we get here `body` is already a single item.
    const cn = body?.cn_number ?? body?.booked_packet_id;
    if (!cn || !body?.status) return null;
    return { trackingNumber: String(cn), rawStatus: String(body.status) };
  }
  if (courierType === 'rocket') {
    if (!body?.tracking_number || !body?.status) return null;
    return { trackingNumber: String(body.tracking_number), rawStatus: String(body.status) };
  }
  return null;
}

@Injectable()
export class ShipmentTrackingService {
  private readonly logger = new Logger(ShipmentTrackingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: CourierRegistryService,
    private readonly shopify: ShopifyFulfillmentClient,
    private readonly addressIssueNotifier: AddressIssueNotifier,
    private readonly shipments: ShipmentService,
  ) {}

  /** Entry point for the per-tenant courier webhook. Never throws on a
   *  business-logic issue (unmapped status, unknown tracking number) — those
   *  are logged + surfaced via last_courier_status_raw, not 500s, so a
   *  courier's retry-on-error behavior doesn't hammer us. */
  async handleWebhookItem(
    companyId: number,
    courierType: CourierType,
    rawItem: unknown,
  ): Promise<void> {
    const event = normalizeEvent(courierType, rawItem);
    if (!event) {
      this.logger.warn(
        `Unrecognized ${courierType} webhook payload shape (company ${companyId}): ${JSON.stringify(rawItem).slice(0, 300)}`,
      );
      return;
    }

    const shipment = await this.prisma.shipment.findFirst({
      where: {
        company_id: companyId,
        courier_type: courierType,
        courier_tracking_number: event.trackingNumber,
      },
    });
    if (!shipment) {
      this.logger.warn(
        `No shipment found for ${courierType} tracking ${event.trackingNumber} (company ${companyId}).`,
      );
      return;
    }

    // Idempotency against OUR OWN status, not a Shopify field value (the
    // tenant's n8n Leopards flow compared against a Shopify field that's
    // never actually populated the way it assumed, likely re-firing its
    // failure side-effects on every webhook redelivery).
    if (TERMINAL_SHIPMENT_STATUSES.includes(shipment.status)) return;

    const adapter = this.registry.getAdapter(courierType);

    let mapped;
    try {
      mapped = adapter.mapStatus(event.rawStatus);
    } catch (err) {
      if (err instanceof UnmappedCourierStatusError) {
        await this.prisma.shipment.update({
          where: { id: shipment.id },
          data: { last_courier_status_raw: event.rawStatus, raw_last_webhook: rawItem as object },
        });
        this.logger.warn(
          `${err.message} (shipment ${shipment.id}) — flagged as needs-attention instead of dropped.`,
        );
        return;
      }
      throw err;
    }

    const isAddressIssue =
      event.reason && adapter.isAddressIssueReason?.(event.reason);

    await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: isAddressIssue
        ? {
            status: 'address_issue',
            address_issue_reason: event.reason,
            address_issue_notified_at: new Date(),
            last_courier_status_raw: event.rawStatus,
            raw_last_webhook: rawItem as object,
          }
        : {
            status: mapped,
            last_courier_status_raw: event.rawStatus,
            raw_last_webhook: rawItem as object,
            delivered_at: mapped === 'delivered' ? new Date() : undefined,
          },
    });

    // Courier reported a bad address → ask the customer to confirm it, via
    // the same gated proactive-template path every other delivery
    // notification uses (event key `address_issue`). Non-blocking.
    if (isAddressIssue) {
      void this.addressIssueNotifier.notify(shipment.id);
      return;
    }

    // Parcel returned (RTO) → run the full return automation (blacklist the
    // customer + cancel & archive the Shopify order). Non-throwing so a courier
    // retry never hammers us. No Shopify fulfillment-event is pushed for a
    // return (there is no such delivery-lifecycle event).
    if (mapped === 'returned') {
      await this.shipments
        .processReturn(companyId, shipment.id, 'auto')
        .catch((err) =>
          this.logger.warn(
            `Auto return-processing failed for shipment ${shipment.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      return;
    }

    if (!shipment.shopify_fulfillment_gid) return;
    const shopifyEventStatus = SHIPMENT_STATUS_TO_SHOPIFY_EVENT[mapped];
    if (!shopifyEventStatus) return; // internal-only state, no Shopify event
    await this.shopify.createFulfillmentEvent(
      companyId,
      shipment.shopify_fulfillment_gid,
      shopifyEventStatus,
      event.reason,
    );
    // Once fulfillmentEventCreate lands, Shopify's own fulfillments/update
    // webhook fires routeDeliveryNotification -> the tenant's configured
    // WhatsApp delivery template for this event — no extra send code needed
    // here (see ShopifyService.DELIVERY_EVENTS / ShopifyOrderConfig.
    // delivery_notifications).
  }

  async redeliver(companyId: number, shipmentId: number): Promise<void> {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id: shipmentId, company_id: companyId },
    });
    if (!shipment || !shipment.courier_tracking_number) {
      throw new NotFoundException('Shipment not found or not yet booked.');
    }
    if (shipment.courier_type !== 'postex') {
      throw new Error(
        `Redeliver isn't implemented for ${shipment.courier_type} yet (only PostEx's save-shipper-advice endpoint is wired).`,
      );
    }
    const { creds } = await this.registry.requireCredentials(companyId, 'postex');
    const token = (creds as { token: string }).token;
    const res = await fetch(
      'https://api.postex.pk/services/integration/api/order/v2/save-shipper-advice/',
      {
        method: 'PUT',
        headers: { token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trackingNumber: shipment.courier_tracking_number,
          statusId: 2,
          remarks: 'Customer confirmed address, please redeliver.',
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`PostEx redeliver request failed (${res.status}).`);
    }
    // The parcel is already with the courier — a redelivery is a fresh
    // attempt on an in-flight shipment, NOT a brand-new booking. Reflect
    // reality with 'in_transit' (non-terminal, so PostEx's own webhooks keep
    // advancing it to out_for_delivery/delivered) instead of 'booked', which
    // read as if the parcel were starting from scratch.
    await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: { status: 'in_transit', address_confirmed_at: new Date() },
    });
  }
}
