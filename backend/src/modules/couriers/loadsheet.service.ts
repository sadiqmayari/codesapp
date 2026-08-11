import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { CourierType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { MediaService } from '../../common/services/media.service';
import { CourierRegistryService } from './courier-registry.service';
import { ShopifyFulfillmentClient } from './shopify-fulfillment-client.service';
import { COURIER_DISPLAY_NAME, COURIER_LOADSHEET_QUEUE } from './couriers.constants';
import { buildPicklistPdf, PicklistRow } from './pdf.util';

interface LoadsheetJobPayload {
  batchId: number;
}

@Injectable()
export class LoadsheetService implements OnModuleInit {
  private readonly logger = new Logger(LoadsheetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobQueue: JobQueueService,
    private readonly registry: CourierRegistryService,
    private readonly media: MediaService,
    private readonly shopify: ShopifyFulfillmentClient,
  ) {}

  onModuleInit(): void {
    this.jobQueue.registerWorker(
      COURIER_LOADSHEET_QUEUE,
      (p) => this.processLoadsheetJob(p as LoadsheetJobPayload),
      2,
      120,
    );
    this.logger.log('Registered courier-loadsheet worker (concurrency=2, lease=120s)');
  }

  async listBatches(companyId: number) {
    return this.prisma.loadsheetBatch.findMany({
      where: { company_id: companyId },
      orderBy: { created_at: 'desc' },
      take: 50,
    });
  }

  /** Batches every not-yet-loadsheeted `booked` shipment for one courier
   *  into a new manifest-generation run. */
  async generateLoadsheet(
    companyId: number,
    courierType: CourierType,
    createdByUserId?: number,
  ) {
    const shipments = await this.prisma.shipment.findMany({
      where: {
        company_id: companyId,
        courier_type: courierType,
        status: 'booked',
        loadsheet_batch_id: null,
        courier_tracking_number: { not: null },
      },
    });
    if (!shipments.length) {
      throw new BadRequestException(
        `No booked, un-manifested ${courierType} shipments to generate a loadsheet for.`,
      );
    }

    const batch = await this.prisma.loadsheetBatch.create({
      data: {
        company_id: companyId,
        courier_type: courierType,
        status: 'generating',
        shipment_count: shipments.length,
        created_by_user_id: createdByUserId,
      },
    });
    await this.prisma.shipment.updateMany({
      where: { id: { in: shipments.map((s) => s.id) } },
      data: { loadsheet_batch_id: batch.id },
    });

    await this.jobQueue.enqueue(
      COURIER_LOADSHEET_QUEUE,
      { batchId: batch.id } satisfies LoadsheetJobPayload,
      { maxAttempts: 3 },
    );
    return batch;
  }

  /**
   * Warehouse PICK SHEET for one loadsheet: every product/variant across all the
   * batch's parcels with the TOTAL quantity to pull, as a downloadable PDF.
   * Aggregated from the orders mirror's `line_items` (tolerant of both the
   * webhook `variant_title` and the sync `variantTitle` shapes). Tenant-scoped.
   */
  async buildPicklist(
    companyId: number,
    batchId: number,
  ): Promise<{ url: string; skus: number; totalUnits: number; parcels: number }> {
    const batch = await this.prisma.loadsheetBatch.findFirst({
      where: { id: batchId, company_id: companyId },
      include: { shipments: true },
    });
    if (!batch) throw new NotFoundException('Loadsheet not found.');

    const gids = batch.shipments.map((s) => s.shopify_order_gid);
    const orders = gids.length
      ? await this.prisma.shopifyOrder.findMany({
          where: { company_id: companyId, shopify_order_gid: { in: gids } },
          select: { line_items: true },
        })
      : [];

    const agg = new Map<string, PicklistRow>();
    for (const o of orders) {
      const items = Array.isArray(o.line_items) ? o.line_items : [];
      for (const raw of items) {
        const it = raw as Record<string, unknown>;
        const product =
          String(it?.title ?? it?.name ?? 'Item').trim() || 'Item';
        const vRaw = (it?.variantTitle ?? it?.variant_title ?? null) as
          | string
          | null;
        const variant =
          vRaw && String(vRaw).trim() && !/default title/i.test(String(vRaw))
            ? String(vRaw).trim()
            : null;
        const qty = Number(it?.quantity ?? it?.qty ?? 1) || 1;
        const key = `${product.toLowerCase()}|||${(variant ?? '').toLowerCase()}`;
        const cur = agg.get(key);
        if (cur) cur.qty += qty;
        else agg.set(key, { product, variant, qty });
      }
    }
    const rows = [...agg.values()].sort(
      (a, b) =>
        a.product.localeCompare(b.product) ||
        (a.variant ?? '').localeCompare(b.variant ?? ''),
    );
    const totalUnits = rows.reduce((s, r) => s + r.qty, 0);

    const pdf = await buildPicklistPdf({
      title: `Picklist — ${COURIER_DISPLAY_NAME[batch.courier_type]}`,
      subtitle: `Loadsheet #${batch.id}${
        batch.courier_loadsheet_id ? ` · ${batch.courier_loadsheet_id}` : ''
      } · ${batch.created_at.toISOString().slice(0, 10)}`,
      rows,
      totalUnits,
      parcelCount: batch.shipments.length,
    });

    const saved = this.media.saveBuffer(pdf, 'application/pdf', companyId);
    const rel = saved.path.split(/storage[\\/]media[\\/]/)[1];
    const url = rel ? `/storage/media/${rel.replace(/\\/g, '/')}` : '';
    if (!url) throw new BadRequestException('Failed to build the picklist.');
    return { url, skus: rows.length, totalUnits, parcels: batch.shipments.length };
  }

  private async processLoadsheetJob(payload: LoadsheetJobPayload): Promise<void> {
    const batch = await this.prisma.loadsheetBatch.findUnique({
      where: { id: payload.batchId },
      include: { shipments: true },
    });
    if (!batch) return;

    try {
      const { creds } = await this.registry.requireCredentials(
        batch.company_id,
        batch.courier_type,
      );
      const adapter = this.registry.getAdapter(batch.courier_type);
      const trackingNumbers = batch.shipments
        .map((s) => s.courier_tracking_number)
        .filter((t): t is string => !!t);

      const result = await adapter.generateLoadsheet(creds, trackingNumbers);

      let pdfMediaUrl: string | undefined;
      if (result.pdfBuffer) {
        const saved = this.media.saveBuffer(
          result.pdfBuffer,
          'application/pdf',
          batch.company_id,
        );
        // saveBuffer writes under storage/media/{companyId}/{YYYY}/{MM}/...;
        // derive the served web path from the same convention (main.ts
        // statics /storage from <cwd>/../storage).
        const relative = saved.path.split(/storage[\\/]media[\\/]/)[1];
        pdfMediaUrl = relative ? `/storage/media/${relative.replace(/\\/g, '/')}` : undefined;
      }

      await this.prisma.loadsheetBatch.update({
        where: { id: batch.id },
        data: {
          status: 'ready',
          courier_loadsheet_id: result.loadsheetId,
          pdf_media_url: pdfMediaUrl,
          completed_at: new Date(),
        },
      });

      // Tag every order Dispatched (reuses tagOrder — mirrors the tenant's
      // n8n LoadSheet Generator, which tagged Shopify orders "Dispatched"
      // after a successful manifest).
      for (const shipment of batch.shipments) {
        await this.shopify
          .tagOrder(batch.company_id, shipment.shopify_order_gid, ['Dispatched'], [])
          .catch((err) =>
            this.logger.warn(
              `Dispatched tag failed for shipment ${shipment.id}: ${err instanceof Error ? err.message : err}`,
            ),
          );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.loadsheetBatch.update({
        where: { id: batch.id },
        data: { status: 'failed', error: message },
      });
      // Release the shipments back for the next generation attempt instead
      // of leaving them permanently pinned to a failed batch.
      await this.prisma.shipment.updateMany({
        where: { loadsheet_batch_id: batch.id },
        data: { loadsheet_batch_id: null },
      });
      throw err;
    }
  }
}
