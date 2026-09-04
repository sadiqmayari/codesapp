import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CourierType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CourierRegistryService } from './courier-registry.service';
import { ShopifyFulfillmentClient } from './shopify-fulfillment-client.service';
import { ShipmentService } from './shipment.service';
import {
  COURIER_DISPLAY_NAME,
  SHIPMENT_STATUS_TO_SHOPIFY_EVENT,
  TERMINAL_SHIPMENT_STATUSES,
} from './couriers.constants';
import { UnmappedCourierStatusError } from './adapters/courier-adapter.interface';
import { isReturnedToShipper } from './adapters/return-status.util';
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
    // PostEx signals an RTO via the `returnRequested` BOOLEAN, not via
    // orderStatus (which stays a delivery status like "Attempted" / "En-Route
    // to … warehouse"). This mirrors the tenant's n8n "Sois | PostEx Tracking"
    // `returnRequested` Switch branch — without it a return would map to
    // attempted/in_transit and the RTO automation (blacklist + cancel + archive)
    // would never fire from the webhook. Force a return so mapStatus → 'returned'.
    const isReturn =
      body.returnRequested === true || String(body.returnRequested) === 'true';
    return {
      trackingNumber: String(body.trackingNumber),
      rawStatus: isReturn ? 'Return to Shipper' : String(body.orderStatus),
      reason: body.lastAttemptReason ? String(body.lastAttemptReason) : undefined,
    };
  }
  if (courierType === 'trax') {
    if (!body?.tracking_number || !body?.status) return null;
    return {
      trackingNumber: String(body.tracking_number),
      rawStatus: String(body.status),
      reason: body.status_reason ? String(body.status_reason) : body.reason ? String(body.reason) : undefined,
    };
  }
  if (courierType === 'leopards') {
    // Leopards delivers a batch: { data: [{ cn_number, status, ... }] }.
    // The webhook controller fans out per-item before calling this, so by
    // the time we get here `body` is already a single item.
    const cn = body?.cn_number ?? body?.booked_packet_id;
    if (!cn || !body?.status) return null;
    return {
      trackingNumber: String(cn),
      rawStatus: String(body.status),
      reason: body.reason ? String(body.reason) : undefined,
    };
  }
  if (courierType === 'rocket') {
    // Rocket's status-webhook payload isn't in the published API doc, so accept
    // the common key spellings for the tracking ref and status. `shipped_ref`
    // is Rocket's own tracking id (what a CodesApp-booked Rocket shipment
    // stores). Unmatched shapes fall through to the "unrecognized payload" log
    // in handleWebhookItem so we can calibrate against a real sample.
    const tn =
      body?.tracking_number ??
      body?.trackingno ??
      body?.trackingnos ??
      body?.shipped_ref ??
      body?.shippedref ??
      body?.cn_no ??
      body?.cn;
    const st =
      body?.status ??
      body?.current_status ??
      body?.delivery_status ??
      body?.order_status ??
      body?.tracking_status;
    if (!tn || !st) return null;
    return {
      trackingNumber: String(tn),
      rawStatus: String(st),
      reason: body?.reason
        ? String(body.reason)
        : body?.remarks
          ? String(body.remarks)
          : body?.description
            ? String(body.description)
            : undefined,
    };
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
    // Rocket (aggregator) reroute: when a parcel is reassigned to a different
    // carrier it gets a NEW tracking ref and Rocket sends a status-less event —
    // {message:"…rerouted…new tracking number", old_shipped_ref, current_shipped_ref}.
    // We must re-point the shipment's tracking number to the new ref, otherwise
    // every later status webhook (which references the new ref) matches no
    // shipment and the parcel freezes at its last status. Handle it before
    // normalizeEvent (which requires a `status` and would drop this).
    if (courierType === 'rocket') {
      const handled = await this.handleRocketReroute(companyId, rawItem);
      if (handled) return;
    }

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

    const adapter = this.registry.getAdapter(courierType);

    // Idempotency against OUR OWN status, not a Shopify field value (the
    // tenant's n8n Leopards flow compared against a Shopify field that's
    // never actually populated the way it assumed, likely re-firing its
    // failure side-effects on every webhook redelivery).
    //
    // EXCEPTION: a COMPLETED physical return always wins, even over a terminal
    // status. A parcel that failed / was marked not_delivered can still be
    // handed back to the shipper afterwards; that final "Returned to shipper"
    // must be allowed through so it lands in the Returned tab and drives the
    // receive-flow. Only this specific promotion bypasses the terminal guard.
    if (TERMINAL_SHIPMENT_STATUSES.includes(shipment.status)) {
      const promotesToReturned =
        shipment.status !== 'returned' && isReturnedToShipper(event.rawStatus);
      if (!promotesToReturned) return;
    }

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

    // Same-status de-dup: many in-flight hops map to the SAME status (PostEx
    // fires several "En-Route to {N} warehouse" events that all → in_transit).
    // If the mapped status is UNCHANGED (and it's not an address-issue
    // transition), just refresh the raw status text + last webhook and SKIP the
    // Shopify push — re-pushing an identical IN_TRANSIT fulfillment event on
    // every hop is redundant noise (and re-triggers Shopify's own update webhook
    // → the WhatsApp delivery template). Mirrors the status-sync's
    // `mapped === s.status` skip.
    if (mapped === shipment.status && !isAddressIssue) {
      await this.prisma.shipment.update({
        where: { id: shipment.id },
        data: {
          last_courier_status_raw: event.rawStatus,
          raw_last_webhook: rawItem as object,
          ...(mapped === 'attempted' || mapped === 'failed'
            ? { last_status_reason: event.reason ?? shipment.last_status_reason ?? null }
            : {}),
        },
      });
      return;
    }

    // Keep a human reason for attempted/failed rows so agents see WHY. Clear it
    // once the parcel moves on to a clean status.
    const reasonUpdate =
      mapped === 'attempted' || mapped === 'failed'
        ? { last_status_reason: event.reason ?? shipment.last_status_reason ?? null }
        : { last_status_reason: null };

    await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: isAddressIssue
        ? {
            status: 'address_issue',
            address_issue_reason: event.reason,
            address_issue_notified_at: new Date(),
            last_courier_status_raw: event.rawStatus,
            last_status_reason: event.reason ?? null,
            raw_last_webhook: rawItem as object,
          }
        : {
            status: mapped,
            last_courier_status_raw: event.rawStatus,
            raw_last_webhook: rawItem as object,
            delivered_at: mapped === 'delivered' ? new Date() : undefined,
            // Stamp the fail time on the transition INTO failed (the same-status
            // dedup above guarantees we only reach here on a real status change),
            // so orders-analytics can bucket failed deliveries by when they failed.
            failed_at: mapped === 'failed' ? new Date() : undefined,
            ...reasonUpdate,
          },
    });

    // First FAILED delivery → early-warning blacklist TAG (contact + Shopify
    // customer), no cancel/archive. The same-status dedup above guarantees we
    // only reach here on a real transition, so this fires once per parcel when it
    // first fails (NOT on 'attempted', NOT on 'returned').
    if (mapped === 'failed' && !isAddressIssue) {
      void this.shipments.tagBlacklistOnFailed(companyId, shipment.id);
    }

    // Courier reported a bad address → ask the customer to confirm it, via
    // the same gated proactive-template path every other delivery
    // notification uses (event key `address_issue`). Non-blocking.
    if (isAddressIssue) {
      void this.addressIssueNotifier.notify(shipment.id);
      return;
    }

    // Parcel returned (RTO): the shipment status is now 'returned' (set above),
    // so it lands in the Returned tab — and we STOP there. We deliberately do
    // NOT auto-cancel / archive / blacklist on a courier return signal alone.
    // That destructive step happens ONLY when a human marks the parcel
    // "received" (processReturn via the mark-received action). A Shopify-side
    // cancel still mirrors back into CodesApp via the order sync. No Shopify
    // fulfillment-event is pushed for a return (there is no such event).
    if (mapped === 'returned') {
      return;
    }

    const shopifyEventStatus = SHIPMENT_STATUS_TO_SHOPIFY_EVENT[mapped];
    if (!shopifyEventStatus) return; // internal-only state, no Shopify event

    // Resolve the Shopify fulfillment GID. Most shipments were created OUTSIDE
    // the booking job (reconcile/import, or fulfilled in n8n), so
    // shopify_fulfillment_gid is null — which used to silently drop this push
    // and leave Shopify stale. That's the root cause of "Leopards statuses not
    // up to date in Shopify": Leopards webhooks land here FIRST, advance our DB,
    // and (without a stored GID) never reached Shopify; the later pull-sync then
    // saw no change and also skipped. Look the GID up live (same source the sync
    // uses) and persist it, so this and every future webhook can push. A null
    // result means the order genuinely has no Shopify fulfillment yet → skip
    // (unchanged behaviour, no regression).
    let fulfillmentGid = shipment.shopify_fulfillment_gid;
    if (!fulfillmentGid) {
      fulfillmentGid = await this.shopify
        .getFulfillmentGid(companyId, shipment.shopify_order_gid)
        .catch(() => null);
      if (fulfillmentGid) {
        await this.prisma.shipment
          .update({
            where: { id: shipment.id },
            data: { shopify_fulfillment_gid: fulfillmentGid },
          })
          .catch(() => undefined);
      }
    }
    if (!fulfillmentGid) return; // order not fulfilled in Shopify yet

    await this.shopify.createFulfillmentEvent(
      companyId,
      fulfillmentGid,
      shopifyEventStatus,
      event.reason,
    );
    // Once fulfillmentEventCreate lands, Shopify's own fulfillments/update
    // webhook fires routeDeliveryNotification -> the tenant's configured
    // WhatsApp delivery template for this event — no extra send code needed
    // here (see ShopifyService.DELIVERY_EVENTS / ShopifyOrderConfig.
    // delivery_notifications).
  }

  /**
   * Detect + apply a Rocket reroute event (parcel reassigned a new tracking
   * ref). Returns true when the event WAS a reroute (so the caller stops).
   * Idempotent: if the shipment already carries the new ref, it's a no-op.
   * Never throws — a reroute we can't match is logged, not 500'd.
   */
  private async handleRocketReroute(
    companyId: number,
    rawItem: unknown,
  ): Promise<boolean> {
    const b = rawItem as any;
    const oldRef = b?.old_shipped_ref ?? b?.old_shippedref ?? b?.old_ref;
    const newRef =
      b?.current_shipped_ref ?? b?.current_shippedref ?? b?.new_shipped_ref;
    // Only treat as a reroute when both refs are present and actually differ.
    if (!oldRef || !newRef || String(oldRef) === String(newRef)) return false;

    const shipment = await this.prisma.shipment.findFirst({
      where: {
        company_id: companyId,
        courier_type: 'rocket',
        courier_tracking_number: String(oldRef),
      },
    });
    if (!shipment) {
      // Already re-linked (new ref) or never ours — nothing to do, but it WAS a
      // reroute event, so don't fall through to the "unrecognized payload" warn.
      const already = await this.prisma.shipment.findFirst({
        where: {
          company_id: companyId,
          courier_type: 'rocket',
          courier_tracking_number: String(newRef),
        },
        select: { id: true },
      });
      if (!already) {
        this.logger.warn(
          `Rocket reroute for unknown ref ${oldRef}→${newRef} (company ${companyId}).`,
        );
      }
      return true;
    }

    await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        courier_tracking_number: String(newRef),
        last_courier_status_raw: `rerouted:${oldRef}->${newRef}`,
        raw_last_webhook: rawItem as object,
      },
    });
    this.logger.log(
      `Rocket reroute applied: shipment ${shipment.id} ref ${oldRef}→${newRef} (company ${companyId}).`,
    );
    return true;
  }

  /** "Redeliver" = a re-attempt shipper advice on an in-flight parcel. Now
   *  courier-agnostic (delegates to the adapter's sendShipperAdvice). */
  async redeliver(companyId: number, shipmentId: number): Promise<void> {
    await this.sendShipperAdvice(
      companyId,
      shipmentId,
      'reattempt',
      'Customer confirmed address, please redeliver.',
    );
  }

  /**
   * Send shipper advice (request a re-attempt or a return) on an attempted
   * parcel — works for any courier whose adapter implements sendShipperAdvice
   * (PostEx/Trax/Leopards; Rocket has none). Records what was sent + advances
   * a re-attempt to in_transit so the courier's own webhooks keep moving it.
   */
  async sendShipperAdvice(
    companyId: number,
    shipmentId: number,
    action: 'return' | 'reattempt',
    remarks: string,
  ): Promise<{ ok: boolean }> {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id: shipmentId, company_id: companyId },
    });
    if (!shipment || !shipment.courier_tracking_number) {
      throw new NotFoundException('Shipment not found or not yet booked.');
    }
    const adapter = this.registry.getAdapter(shipment.courier_type);
    if (!adapter.sendShipperAdvice) {
      throw new BadRequestException(
        `Shipper advice isn't available for ${COURIER_DISPLAY_NAME[shipment.courier_type]} yet.`,
      );
    }
    const { creds } = await this.registry.requireCredentials(companyId, shipment.courier_type);
    const { ok, raw } = await adapter.sendShipperAdvice(
      creds,
      shipment.courier_tracking_number,
      action,
      remarks,
    );
    if (!ok) {
      throw new BadRequestException(
        `Courier rejected the shipper advice: ${JSON.stringify(raw).slice(0, 200)}`,
      );
    }
    await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        shipper_advice_status: action,
        shipper_advice_remarks: remarks || null,
        shipper_advice_at: new Date(),
        // A re-attempt puts the parcel back in flight; a return request leaves
        // the status as-is (the courier's webhook will report the return).
        ...(action === 'reattempt'
          ? { status: 'in_transit' as const, address_confirmed_at: new Date() }
          : {}),
      },
    });
    return { ok: true };
  }
}
