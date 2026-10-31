import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaService } from '../../common/services/media.service';
import { CourierRegistryService } from './courier-registry.service';
import { ShopifyFulfillmentClient } from './shopify-fulfillment-client.service';
import { COURIER_DISPLAY_NAME } from './couriers.constants';
import { compose2Up, mergePdfsAsIs } from './pdf.util';
import { buildMnpSlipPdf, MnpSlipData } from './mnp-slip.util';
import { buildRocketSlipSheetPdf, RocketSlipData } from './rocket-slip.util';
import { MnpCredentials } from './adapters/mnp.adapter';
import { RocketCredentials } from './adapters/rocket.adapter';

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
    opts: { skipCourierCancel?: boolean } = {},
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
    // `skipCourierCancel` is used by the status-sync path: the courier ALREADY
    // cancelled the parcel on its own portal (that's what we detected), so a
    // second cancel call would just error. We still run the Shopify unfulfill +
    // tag-strip + row-delete so the order is freed back to "To book".
    // `manual` fulfilments have NO courier booking (and no adapter) — even when a
    // tracking number was entered by hand — so skip the courier-cancel entirely;
    // getAdapter('manual') would throw "No courier adapter for 'manual'".
    if (
      !opts.skipCourierCancel &&
      shipment.courier_type !== 'manual' &&
      shipment.courier_tracking_number
    ) {
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
        .getFulfillmentGid(companyId, shipment.shopify_order_gid, shipment.shopify_store_id)
        .catch(() => null);
    }
    if (fulfillmentGid) {
      const r = await this.shopifyFulfillment
        .cancelFulfillment(companyId, fulfillmentGid, shipment.shopify_store_id)
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
        shipment.shopify_store_id,
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

    // M&P has NO label/AWB API — we generate the slip ourselves (one PDF per
    // parcel), saved to media and served like any other label.
    if (courier === 'mnp') {
      const { creds } = await this.registry.requireCredentials(companyId, courier);
      const slips = await this.buildMnpSlips(companyId, shipments, creds as MnpCredentials);
      for (const s of slips) {
        const url = this.savePdf(s.buffer, companyId);
        if (url) labels.push({ shipmentId: s.shipmentId, trackingNumber: s.trackingNumber, url });
      }
      if (!labels.length) {
        throw new BadRequestException('Could not build any M&P slips for the selected parcels.');
      }
      return { courier: COURIER_DISPLAY_NAME[courier], labels };
    }

    // Rocket: when the CodesApp-slip toggle is on (default), generate our own
    // slip per parcel (replaces Rocket's /pdfapi label). When it's '0', fall
    // through to the adapter path below for Rocket's ORIGINAL label.
    if (courier === 'rocket') {
      const { creds } = await this.registry.requireCredentials(companyId, courier);
      if ((creds as RocketCredentials).codesappSlip !== '0') {
        const slips = await this.buildRocketSlips(companyId, shipments, creds as RocketCredentials);
        for (const s of slips) {
          const buffer = await buildRocketSlipSheetPdf([s.data]);
          const url = this.savePdf(buffer, companyId);
          if (url) labels.push({ shipmentId: s.shipmentId, trackingNumber: s.trackingNumber, url });
        }
        if (!labels.length) {
          throw new BadRequestException('Could not build any Rocket slips for the selected parcels.');
        }
        return { courier: COURIER_DISPLAY_NAME[courier], labels };
      }
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
  /**
   * Same 2-up slip PDF, but for every shipment on a loadsheet BATCH — the
   * "Slips" button beside a batch's PDF/Picklist links. Resolves the batch's
   * currently-linked shipments (cancelled parcels are unlinked/deleted, so a
   * batch whose parcels were all cancelled correctly has nothing to slip).
   */
  async generateSlipSheetForBatch(
    companyId: number,
    batchId: number,
  ): Promise<{ courier: string; url: string; parcels: number }> {
    const batch = await this.prisma.loadsheetBatch.findFirst({
      where: { id: batchId, company_id: companyId },
      include: { shipments: { select: { id: true } } },
    });
    if (!batch) throw new NotFoundException('Loadsheet not found.');
    const ids = batch.shipments.map((s) => s.id);
    if (!ids.length) {
      throw new BadRequestException(
        'This loadsheet has no active parcels to slip (they may have been cancelled).',
      );
    }
    return this.generateSlipSheet(companyId, ids);
  }

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

    // M&P: generate each parcel's slip ourselves, then 2-up onto A4 (each slip is
    // one compact wide label, so compose2Up — not mergePdfsAsIs).
    if (courier === 'mnp') {
      const { creds } = await this.registry.requireCredentials(companyId, courier);
      const slips = await this.buildMnpSlips(companyId, shipments, creds as MnpCredentials);
      if (!slips.length) {
        throw new BadRequestException('Could not build any M&P slips for the selected parcels.');
      }
      const merged = await compose2Up(slips.map((s) => s.buffer), {});
      const url = this.savePdf(merged, companyId);
      if (!url) throw new BadRequestException('Failed to build the slip sheet.');
      return { courier: COURIER_DISPLAY_NAME[courier], url, parcels: slips.length };
    }

    // Rocket: when the CodesApp-slip toggle is on (default), generate our own
    // slips and pack them greedily onto A4 (NOT compose2Up — that scales each
    // slip to a fixed slot). When it's '0', fall through to the adapter path for
    // Rocket's ORIGINAL label (merged 2-up as before).
    if (courier === 'rocket') {
      const { creds } = await this.registry.requireCredentials(companyId, courier);
      if ((creds as RocketCredentials).codesappSlip !== '0') {
        const slips = await this.buildRocketSlips(companyId, shipments, creds as RocketCredentials);
        if (!slips.length) {
          throw new BadRequestException('Could not build any Rocket slips for the selected parcels.');
        }
        const merged = await buildRocketSlipSheetPdf(slips.map((s) => s.data));
        const url = this.savePdf(merged, companyId);
        if (!url) throw new BadRequestException('Failed to build the slip sheet.');
        return { courier: COURIER_DISPLAY_NAME[courier], url, parcels: slips.length };
      }
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

    // PostEx/Trax/Rocket hand back a PDF that's ALREADY print-ready in their own
    // multi-per-A4 layout (PostEx → 3/page, Trax bulk air_waybill → ~2/page,
    // Rocket → 2/page), so re-composing 2-up would just shrink each page to half
    // an A4. Merge them unchanged. (Rocket only reaches here when its CodesApp-slip
    // toggle is OFF — otherwise it returned above with our own slip.)
    // `compose2Up` stays only for a future courier with one compact per-parcel label.
    const nativeLayout =
      courier === 'rocket' || courier === 'postex' || courier === 'trax';
    const merged = nativeLayout
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

  /**
   * Build the in-app M&P slip PDF for each shipment (M&P has no label API). Pulls
   * consignee / COD / product / city from the order mirror, shipper block from
   * the company + M&P creds (pickup phone/address/origin city), and generates a
   * per-parcel single-page slip. Best-effort per parcel — a missing mirror still
   * yields a slip with whatever the shipment row carries.
   */
  private async buildMnpSlips(
    companyId: number,
    shipments: Array<{
      id: number;
      shopify_order_gid: string;
      shopify_order_name: string | null;
      courier_tracking_number: string | null;
      courier_city_code: string | null;
      destination_city: string | null;
      destination_address: string | null;
    }>,
    creds: MnpCredentials,
  ): Promise<Array<{ shipmentId: number; trackingNumber: string; buffer: Buffer }>> {
    const gids = [...new Set(shipments.map((s) => s.shopify_order_gid))];
    const [mirrors, company] = await Promise.all([
      this.prisma.shopifyOrder.findMany({
        where: { company_id: companyId, shopify_order_gid: { in: gids } },
      }),
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { company_name: true, timezone: true },
      }),
    ]);
    const byGid = new Map(mirrors.map((m) => [m.shopify_order_gid, m]));
    const tz = company?.timezone || 'Asia/Karachi';
    const printOn = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .format(new Date())
      .replace(',', '');

    // "Overnight" / "O" / "Second Day" / "S" -> display label.
    const svc = (creds.service || '').trim().toLowerCase();
    const service =
      svc === 's' || svc.startsWith('second') ? 'SECOND DAY' : 'OVERNIGHT';

    const out: Array<{ shipmentId: number; trackingNumber: string; buffer: Buffer }> = [];
    for (const s of shipments) {
      if (!s.courier_tracking_number) continue;
      const m = byGid.get(s.shopify_order_gid);
      // Total pieces = sum of line-item quantities (fallback 1).
      let pieces = 1;
      try {
        const li = typeof m?.line_items === 'string' ? JSON.parse(m.line_items) : m?.line_items;
        if (Array.isArray(li)) {
          const sum = li.reduce(
            (acc: number, it: any) =>
              acc + (Number(it?.currentQuantity ?? it?.quantity) || 0),
            0,
          );
          if (sum > 0) pieces = sum;
        }
      } catch {
        /* keep default */
      }
      const consigneeAddr =
        [m?.address1, m?.address2].filter(Boolean).join(', ') ||
        s.destination_address ||
        '';
      const data: MnpSlipData = {
        cn: s.courier_tracking_number,
        service,
        destCity: s.destination_city || m?.city || s.courier_city_code || '',
        originCity: creds.originCity || '',
        consignee: m?.customer_name || '',
        consigneePhone: m?.phone || '',
        consigneeAddr,
        shipper: company?.company_name || '',
        shipperPhone: creds.pickupPhone || '',
        shipperAddr: creds.pickupAddress || '',
        cod: Number(m?.total_outstanding ?? 0),
        pieces,
        weight: '0.5 KG',
        returnBranch: creds.originCity || '',
        returnAddr: 'Same as above',
        printOn,
        orderId: s.shopify_order_name || m?.order_name || '',
        product: m?.line_items_summary || '',
        remarks: '',
      };
      out.push({
        shipmentId: s.id,
        trackingNumber: s.courier_tracking_number,
        buffer: await buildMnpSlipPdf(data),
      });
    }
    return out;
  }

  /**
   * Assemble our CodesApp Rocket slip data for each shipment. Pulls consignee /
   * COD / products / city from the order mirror; the shipper block from the
   * Company row (Rocket creds carry no pickup/origin fields). Returns the slip
   * DATA (not the PDF) so callers can either pack all parcels onto one sheet
   * (slips) or build one PDF per parcel (labels).
   */
  private async buildRocketSlips(
    companyId: number,
    shipments: Array<{
      id: number;
      shopify_order_gid: string;
      shopify_order_name: string | null;
      courier_tracking_number: string | null;
      courier_city_code: string | null;
      destination_city: string | null;
      destination_address: string | null;
      booked_at: Date | null;
    }>,
    creds: RocketCredentials,
  ): Promise<Array<{ shipmentId: number; trackingNumber: string; data: RocketSlipData }>> {
    const gids = [...new Set(shipments.map((s) => s.shopify_order_gid))];
    const [mirrors, company] = await Promise.all([
      this.prisma.shopifyOrder.findMany({
        where: { company_id: companyId, shopify_order_gid: { in: gids } },
      }),
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { company_name: true, address: true, timezone: true },
      }),
    ]);
    const byGid = new Map(mirrors.map((m) => [m.shopify_order_gid, m]));
    const tz = company?.timezone || 'Asia/Karachi';
    const fmtDate = (d: Date | null): string => {
      if (!d) return '';
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
        .format(d)
        .replace(',', '');
    };

    const out: Array<{ shipmentId: number; trackingNumber: string; data: RocketSlipData }> = [];
    for (const s of shipments) {
      if (!s.courier_tracking_number) continue;
      const m = byGid.get(s.shopify_order_gid);
      // Products from line_items (string-or-array; camel/snake tolerant). Falls
      // back to the flattened summary as a single line when the array is empty.
      let products: { qty: number; title: string }[] = [];
      let pieces = 0;
      try {
        const li = typeof m?.line_items === 'string' ? JSON.parse(m.line_items) : m?.line_items;
        if (Array.isArray(li)) {
          for (const it of li as any[]) {
            const title = String(it?.title ?? it?.name ?? 'Item').trim() || 'Item';
            const qty = Number(it?.currentQuantity ?? it?.quantity ?? it?.qty ?? 1) || 1;
            products.push({ qty, title });
            pieces += qty;
          }
        }
      } catch {
        /* ignore malformed line_items */
      }
      if (!products.length && m?.line_items_summary) {
        products = [{ qty: 0, title: m.line_items_summary }];
      }
      if (pieces <= 0) pieces = 1;

      const consigneeAddr =
        [m?.address1, m?.address2].filter(Boolean).join(', ') || s.destination_address || '';
      const destCity = s.destination_city || m?.city || s.courier_city_code || '';
      const data: RocketSlipData = {
        cn: s.courier_tracking_number,
        destCity,
        originCity: creds.originCity || '',
        consignee: m?.customer_name || '',
        consigneePhone: m?.phone || '',
        consigneeAddr,
        shipper: company?.company_name || '',
        shipperPhone: creds.pickupPhone || '',
        shipperAddr: creds.pickupAddress || company?.address || '',
        cod: Number(m?.total_outstanding ?? 0),
        pieces,
        weight: '1.00 Kg',
        customerRef: creds.customerRef || company?.company_name || '',
        bookingDate: fmtDate(s.booked_at),
        orderId: s.shopify_order_name || m?.order_name || '',
        products,
      };
      out.push({ shipmentId: s.id, trackingNumber: s.courier_tracking_number, data });
    }
    return out;
  }
}
