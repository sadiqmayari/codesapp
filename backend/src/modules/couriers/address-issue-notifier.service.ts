import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ShopifyService } from '../integrations/shopify/shopify.service';
import { ShopifyFulfillmentClient } from './shopify-fulfillment-client.service';

/**
 * Sends the customer-facing "please confirm your delivery address" WhatsApp
 * message when a shipment lands in `address_issue` — the follow-up step the
 * tenant's sheet never had (marking a row "Wrong Address" there just made it
 * vanish from the pipeline with nobody told).
 *
 * Reuses the existing proactive-template path (ShopifyService.processNotify
 * + ShopifyOrderConfig.delivery_notifications) under the new `address_issue`
 * event key, so it inherits the same plan/feature gating, template approval
 * requirement, contact/conversation get-or-create, and per-event enable
 * toggle as every other delivery notification. No new send infrastructure.
 *
 * NEVER throws — a notification failure must not roll back or block the
 * shipment state change that triggered it.
 */
@Injectable()
export class AddressIssueNotifier {
  private readonly logger = new Logger(AddressIssueNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopify: ShopifyService,
    private readonly fulfillmentClient: ShopifyFulfillmentClient,
  ) {}

  async notify(shipmentId: number): Promise<void> {
    try {
      const shipment = await this.prisma.shipment.findUnique({
        where: { id: shipmentId },
      });
      if (!shipment?.shopify_order_name) return;

      const order = await this.fulfillmentClient.getOrderForBooking(
        shipment.company_id,
        shipment.shopify_order_name,
      );
      if (!order?.shipping?.phone) {
        this.logger.warn(
          `Address-issue notice skipped for shipment ${shipmentId}: no customer phone on the order.`,
        );
        return;
      }

      await this.shopify.processNotify(shipment.company_id, 'address_issue', {
        id: order.orderGid,
        name: order.orderName,
        phone: order.shipping.phone,
        shipping_address: {
          phone: order.shipping.phone,
          city: order.shipping.city,
          address1: order.shipping.address1,
          address2: order.shipping.address2 ?? undefined,
        },
      });

      await this.prisma.shipment.update({
        where: { id: shipmentId },
        data: { address_issue_notified_at: new Date() },
      });
    } catch (err) {
      this.logger.warn(
        `Address-issue notice failed for shipment ${shipmentId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
