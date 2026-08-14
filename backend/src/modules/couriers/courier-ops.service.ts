import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaService } from '../../common/services/media.service';
import { CourierRegistryService } from './courier-registry.service';
import { ShopifyFulfillmentClient } from './shopify-fulfillment-client.service';
import { COURIER_DISPLAY_NAME } from './couriers.constants';
import { compose2Up, mergePdfsAsIs } from './pdf.util';

export interface GeneratedLabel {
  shipmentId: number;
  trackingNumber: string;
  url: string;
}

/**
 * Courier operational actions that touch the courier AND Shopify: cancelling a
 * booking (unbook) and fetching printable shipping labels. Kept out of the
 * hot booking/tracking services so those stay lean.
 */
@Injectable()
export class CourierOpsService {
  private readonly logger = new Logger(CourierOpsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: CourierRegistryService,
    private readonly media: MediaService,
    private readonly shopifyFulfillment: ShopifyFulfillmentClient,
  ) {}

  /**
   * Cancel/undo a booking: cancel the parcel at the courier, cancel the Shopify
   * fulfillment (order returns to unfulfilled), strip the courier + Dispatched
   * tags, and delete the shipment row so the order drops back into "To book".
   * Every step is best-effort so one failure never blocks the rest.
   */
  async cancelBooking(
    companyId: number,
    shipmentId: number,
  ): Promise<{ cancelledAtCourier: boolean; unfulfilled: boolean; freed: boolean }> {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id: shipmentId, company_id: companyId },
    });
    if (!shipment) throw new NotFoundException('Shipment not found.');
    if (['delivered', 'returned', 'cancelled'].includes(shipment.status)) {
      throw new BadRequestException(
        `Can't cancel a ${shipment.status} shipment — it has already reached a final state.`,
      );
    }

    let cancelledAtCourier = false;
    if (shipment.courier_tracking_number) {
      const adapter = this.registry.getAdapter(shipment.courier_type);
      if (adapter.cancelShipment) {
        const creds = await this.registry
          .requireCredentials(companyId, shipment.courier_type)
          .then((c) => c.creds)
          .catch(() => null);
        if (creds) {
          const r = await adapter
            .cancelShipment(creds, shipment.courier_tracking_number)
            .catch(() => ({ ok: false, raw: null }));
          cancelledAtCourier = r.ok;
          if (!r.ok) {
            this.logger.warn(
              `Courier cancel returned not-ok for shipment ${shipment.id} (${shipment.courier_type}): ${JSON.stringify(r.raw).slice(0, 200)}`,
            );
          }
        }
      }
    }

    // Cancel the Shopify fulfillment so the order returns to "unfulfilled".
    // shopify_fulfillment_gid is only stored by the CodesApp booking job — most
    // shipments (reconcile/import, or fulfilled in n8n) have it null, which used
    // to silently skip the unfulfill even though the order IS fulfilled in
    // Shopify. Look the GID up live when it's missing (same source the tracking
    // service uses) so cancel-booking reliably unfulfills regardless of how the
    // parcel was booked.
    let unfulfilled = false;
    let fulfillmentGid = shipment.shopify_fulfillment_gid;
    if (!fulfillmentGid) {
      fulfillmentGid = await this.shopifyFulfillment
        .getFulfillmentGid(companyId, shipment.shopify_order_gid)
        .catch(() => null);
    }
    if (fulfillmentGid) {
      const r = await this.shopifyFulfillment
        .cancelFulfillment(companyId, fulfillmentGid)
        .catch(() => ({ ok: false, errors: ['cancelFulfillment threw'] }));
      unfulfilled = r.ok;
    }

    // Remove the courier + Dispatched tags (best-effort).
    await this.shopifyFulfillment
      .tagOrder(
        companyId,
        shipment.shopify_order_gid,
        [],
        [COURIER_DISPLAY_NAME[shipment.courier_type], shipment.courier_type, 'Dispatched'],
      )
      .catch(() => undefined);

    // Free the order for re-booking.
    await this.prisma.shipment.delete({ where: { id: shipment.id } }).catch(() => undefined);

    this.logger.log(
      `Cancel booking shipment ${shipment.id} order ${shipment.shopify_order_name ?? shipment.shopify_order_gid}: courier=${cancelledAtCourier} unfulfilled=${unfulfilled}`,
    );
    return { cancelledAtCourier, unfulfilled, freed: true };
  }

  /**
   * Fetch printable shipping labels (airway bills) for the given shipments —
   * which MUST all belong to one courier (labels are printed courier-wise,
   * never merged across couriers). Returns a served URL per parcel (a courier
   * PDF saved to media, or the courier's own slip URL for Leopards).
   */
  async generateLabels(
    companyId: number,
    shipmentIds: number[],
  ): Promise<{ courier: string; labels: GeneratedLabel[] }> {
    const ids = [...new Set((shipmentIds || []).filter((n) => Number.isFinite(n)))];
    if (!ids.length) throw new BadRequestException('No shipments selected.');

    const shipments = await this.prisma.shipment.findMany({
      where: {
        id: { in: ids },
        company_id: companyId,
        courier_tracking_number: { not: null },
      },
    });
    if (!shipments.length) {
      throw new BadRequestException('None of the selected shipments are booked yet.');
    }
    const courier = shipments[0].courier_type;
    if (shipments.some((s) => s.courier_type !== courier)) {
      throw new BadRequestException(
        'Select shipments of a single courier — labels are printed per courier.',
      );
    }

    const labels: GeneratedLabel[] = [];

    // Leopards has no batch label API — the label is the slip_link captured at
    // booking. Return those directly.
    if (courier === 'leopards') {
      for (const s of shipments) {
        if (s.courier_slip_link) {
          labels.push({
            shipmentId: s.id,
            trackingNumber: s.courier_tracking_number as string,
            url: s.courier_slip_link,
          });
        }
      }
      if (!labels.length) {
        throw new BadRequestException(
          'No Leopards label links available for the selected parcels.',
        );
      }
      return { courier: COURIER_DISPLAY_NAME[courier], labels };
    }

    const adapter = this.registry.getAdapter(courier);
    if (!adapter.getLabels) {
      throw new BadRequestException(
        `Labels aren't available for ${COURIER_DISPLAY_NAME[courier]} yet.`,
      );
    }
    const { creds } = await this.registry.requireCredentials(companyId, courier);

    // Chunk by 10 (PostEx get-invoice cap; harmless for the per-parcel couriers).
    const CHUNK = 10;
    for (let i = 0; i < shipments.length; i += CHUNK) {
      const slice = shipments.slice(i, i + CHUNK);
      const tns = slice.map((s) => s.courier_tracking_number as string);
      const result = await adapter.getLabels(creds, tns).catch((err) => {
        this.logger.warn(
          `getLabels failed (${courier}) for [${tns.join(',')}]: ${err instanceof Error ? err.message : err}`,
        );
        return null;
      });
      if (!result) continue;

      // A single combined PDF for the whole chunk (PostEx): one URL for all.
      if (result.pdfBuffer) {
        const url = this.savePdf(result.pdfBuffer, companyId);
        if (url) {
          for (const s of slice) {
            labels.push({
              shipmentId: s.id,
              trackingNumber: s.courier_tracking_number as string,
              url,
            });
          }
        }
      }
      // Per-parcel labels (Trax bytes or external URLs).
      for (const part of result.parts ?? []) {
        const s = slice.find((x) => x.courier_tracking_number === part.trackingNumber);
        const url = part.pdfBuffer ? this.savePdf(part.pdfBuffer, companyId) : part.url;
        if (url) {
          labels.push({
            shipmentId: s?.id ?? 0,
            trackingNumber: part.trackingNumber,
            url,
          });
        }
      }
    }

    if (!labels.length) {
      throw new BadRequestException(
        `Could not fetch any ${COURIER_DISPLAY_NAME[courier]} labels — try again shortly.`,
      );
    }
    return { courier: COURIER_DISPLAY_NAME[courier], labels };
  }

  /**
   * Build ONE downloadable PDF of the couriers' own shipping slips laid out
   * TWO-PER-A4-PAGE, for the selected parcels of a SINGLE courier. Uses the same
   * label bytes as `generateLabels` (Trax = one PDF per parcel, PostEx/Rocket =
   * a combined multi-page PDF) and composes them 2-up. Leopards is intentionally
   * excluded — it has no label-bytes API (only an external slip link); its own
   * combined slips+loadsheet file is used as-is via the existing flow.
   */
  async generateSlipSheet(
    companyId: number,
    shipmentIds: number[],
  ): Promise<{ courier: string; url: string; parcels: number }> {
    const ids = [...new Set((shipmentIds || []).filter((n) => Number.isFinite(n)))];
    if (!ids.length) throw new BadRequestException('No shipments selected.');

    const shipments = await this.prisma.shipment.findMany({
      where: {
        id: { in: ids },
        company_id: companyId,
        courier_tracking_number: { not: null },
      },
    });
    if (!shipments.length) {
      throw new BadRequestException('None of the selected shipments are booked yet.');
    }
    const courier = shipments[0].courier_type;
    if (shipments.some((s) => s.courier_type !== courier)) {
      throw new BadRequestException(
        'Select shipments of a single courier — slips are printed per courier.',
      );
    }
    if (courier === 'leopards') {
      throw new BadRequestException(
        'Leopards slips come as a single combined file — use its own slip links / loadsheet.',
      );
    }
    const adapter = this.registry.getAdapter(courier);
    if (!adapter.getLabels) {
      throw new BadRequestException(
        `Slips aren't available for ${COURIER_DISPLAY_NAME[courier]} yet.`,
      );
    }
    const { creds } = await this.registry.requireCredentials(companyId, courier);

    // Collect label PDF bytes IN ORDER. Chunk by 10 (PostEx get-invoice cap;
    // harmless for the per-parcel couriers).
    const buffers: Buffer[] = [];
    const CHUNK = 10;
    for (let i = 0; i < shipments.length; i += CHUNK) {
      const slice = shipments.slice(i, i + CHUNK);
      const tns = slice.map((s) => s.courier_tracking_number as string);
      const result = await adapter.getLabels(creds, tns).catch((err) => {
        this.logger.warn(
          `getLabels (slips) failed (${courier}) for [${tns.join(',')}]: ${err instanceof Error ? err.message : err}`,
        );
        return null;
      });
      if (!result) continue;
      if (result.pdfBuffer) buffers.push(result.pdfBuffer);
      for (const part of result.parts ?? []) {
        if (part.pdfBuffer) buffers.push(part.pdfBuffer);
      }
    }
    if (!buffers.length) {
      throw new BadRequestException(
        `Could not fetch any ${COURIER_DISPLAY_NAME[courier]} slips — try again shortly.`,
      );
    }

    // Rocket's /pdfapi already lays out 2 labels per A4 page (10 parcels → a
    // 5-page PDF), so it's print-ready as-is — re-composing it would crop away
    // half the labels. Merge Rocket's pages unchanged; 2-up the other couriers'
    // compact per-parcel labels ourselves.
    const merged =
      courier === 'rocket'
        ? await mergePdfsAsIs(buffers)
        : await compose2Up(buffers, {});
    const url = this.savePdf(merged, companyId);
    if (!url) throw new BadRequestException('Failed to build the slip sheet.');
    return { courier: COURIER_DISPLAY_NAME[courier], url, parcels: shipments.length };
  }

  /** Persist a PDF buffer to media and return its served web path. */
  private savePdf(buf: Buffer, companyId: number): string {
    const saved = this.media.saveBuffer(buf, 'application/pdf', companyId);
    const rel = saved.path.split(/storage[\\/]media[\\/]/)[1];
    return rel ? `/storage/media/${rel.replace(/\\/g, '/')}` : '';
  }
}
