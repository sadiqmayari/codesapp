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
import { MediaService } from '../../common/services/media.service';
import { CourierRegistryService } from './courier-registry.service';
import { ShopifyFulfillmentClient } from './shopify-fulfillment-client.service';
import { COURIER_DISPLAY_NAME, COURIER_LOADSHEET_QUEUE } from './couriers.constants';
import {
  buildManifestPdf,
  buildPicklistPdf,
  buildDispatchListPdf,
  DispatchListRow,
  DispatchPayment,
  PicklistRow,
} from './pdf.util';
import { httpFetch } from './adapters/http.util';

type BatchWithShipments = {
  id: number;
  company_id: number;
  courier_type: CourierType;
  created_at: Date;
  shipments: Array<{
    shopify_order_gid: string;
    shopify_order_name: string | null;
    courier_tracking_number: string | null;
    destination_city: string | null;
  }>;
};

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

  async listBatches(
    companyId: number,
    opts: { courier?: CourierType; from?: Date; to?: Date; limit?: number } = {},
  ) {
    const take = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    return this.prisma.loadsheetBatch.findMany({
      where: {
        company_id: companyId,
        ...(opts.courier ? { courier_type: opts.courier } : {}),
        ...(opts.from || opts.to
          ? {
              created_at: {
                ...(opts.from ? { gte: opts.from } : {}),
                ...(opts.to ? { lte: opts.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { created_at: 'desc' },
      take,
    });
  }

  // A parcel is loadsheet-eligible while it's still with us pre-dispatch: freshly
  // booked OR courier-confirmed ready_for_pickup (the status the sync assigns a
  // parcel sitting at the merchant's origin warehouse awaiting pickup). Both must
  // still be manifestable.
  private static readonly LOADSHEETABLE: ShipmentStatus[] = ['booked', 'ready_for_pickup'];

  /** Batches not-yet-loadsheeted, loadsheet-eligible shipments for one courier
   *  into a new manifest-generation run. `shipmentIds` restricts to a selection
   *  (used by the "generate for selected" flow); omitted = every eligible parcel
   *  of that courier. */
  async generateLoadsheet(
    companyId: number,
    courierType: CourierType,
    createdByUserId?: number,
    shipmentIds?: number[],
  ) {
    const ids = shipmentIds?.filter((n) => Number.isFinite(n));
    const shipments = await this.prisma.shipment.findMany({
      where: {
        company_id: companyId,
        courier_type: courierType,
        status: { in: LoadsheetService.LOADSHEETABLE },
        loadsheet_batch_id: null,
        courier_tracking_number: { not: null },
        ...(ids?.length ? { id: { in: ids } } : {}),
      },
    });
    if (!shipments.length) {
      throw new BadRequestException(
        `No loadsheet-eligible ${courierType} shipments to generate a loadsheet for.`,
      );
    }
    return this.createBatchFor(companyId, courierType, shipments.map((s) => s.id), createdByUserId);
  }

  /**
   * ONE action → a loadsheet per courier for the SELECTED parcels, generated in
   * parallel (each courier's batch is created + enqueued; the loadsheet worker,
   * concurrency 2, processes them concurrently). Groups the selection by courier
   * so a mixed-courier selection produces one manifest each. Returns the batches.
   */
  async generateLoadsheetsForSelection(
    companyId: number,
    shipmentIds: number[],
    createdByUserId?: number,
  ): Promise<{ batches: { id: number; courier: CourierType; count: number }[] }> {
    const ids = [...new Set((shipmentIds || []).filter((n) => Number.isFinite(n)))];
    if (!ids.length) throw new BadRequestException('No parcels selected.');
    const shipments = await this.prisma.shipment.findMany({
      where: {
        company_id: companyId,
        id: { in: ids },
        status: { in: LoadsheetService.LOADSHEETABLE },
        loadsheet_batch_id: null,
        courier_tracking_number: { not: null },
      },
      select: { id: true, courier_type: true },
    });
    if (!shipments.length) {
      throw new BadRequestException(
        'None of the selected parcels are loadsheet-eligible (booked/ready, un-manifested).',
      );
    }
    const byCourier = new Map<CourierType, number[]>();
    for (const s of shipments) {
      const arr = byCourier.get(s.courier_type) ?? [];
      arr.push(s.id);
      byCourier.set(s.courier_type, arr);
    }
    const batches = await Promise.all(
      [...byCourier.entries()].map(([courier, sids]) =>
        this.createBatchFor(companyId, courier, sids, createdByUserId).then((b) => ({
          id: b.id,
          courier,
          count: sids.length,
        })),
      ),
    );
    return { batches };
  }

  /**
   * Pre-generation readiness for a loadsheet scope. A parcel that's been booked
   * but whose courier API call hasn't returned a tracking number yet (status
   * 'booked'/'ready_for_pickup' + tracking NULL) is STILL BOOKING — the generate
   * query silently drops it (it filters `courier_tracking_number: not null`), so
   * warn the user before they manifest, or they leave parcels behind (exactly the
   * "20 missing from the loadsheet" case). `ready` = manifestable now; `pending`
   * = still booking. Same scope as the two generate paths (courier or selection).
   */
  async loadsheetReadiness(
    companyId: number,
    scope: { courierType?: CourierType; shipmentIds?: number[] },
  ): Promise<{ ready: number; pending: number; pendingNames: string[] }> {
    const ids = scope.shipmentIds?.filter((n) => Number.isFinite(n));
    const base = {
      company_id: companyId,
      status: { in: LoadsheetService.LOADSHEETABLE },
      loadsheet_batch_id: null,
      ...(scope.courierType ? { courier_type: scope.courierType } : {}),
      ...(ids?.length ? { id: { in: ids } } : {}),
    };
    const [ready, pending, pendingSample] = await Promise.all([
      this.prisma.shipment.count({
        where: { ...base, courier_tracking_number: { not: null } },
      }),
      this.prisma.shipment.count({
        where: { ...base, courier_tracking_number: null },
      }),
      this.prisma.shipment.findMany({
        where: { ...base, courier_tracking_number: null },
        select: { shopify_order_name: true },
        orderBy: { id: 'asc' },
        take: 10,
      }),
    ]);
    return {
      ready,
      pending,
      pendingNames: pendingSample
        .map((s) => s.shopify_order_name ?? '')
        .filter(Boolean),
    };
  }

  /** Create a loadsheet batch for a specific set of shipment ids (already
   *  validated as one courier's eligible parcels) + enqueue its generation. */
  private async createBatchFor(
    companyId: number,
    courierType: CourierType,
    shipmentIds: number[],
    createdByUserId?: number,
  ) {
    const batch = await this.prisma.loadsheetBatch.create({
      data: {
        company_id: companyId,
        courier_type: courierType,
        status: 'generating',
        shipment_count: shipmentIds.length,
        created_by_user_id: createdByUserId,
      },
    });
    await this.prisma.shipment.updateMany({
      where: { id: { in: shipmentIds } },
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
    const [company, orders] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { company_name: true },
      }),
      gids.length
        ? this.prisma.shopifyOrder.findMany({
            where: { company_id: companyId, shopify_order_gid: { in: gids } },
            select: { order_name: true, line_items: true },
          })
        : Promise.resolve([]),
    ]);

    // Aggregate per product/variant: sum qty, collect order names, keep a
    // variant GID for the image lookup.
    type Agg = {
      product: string;
      variant: string | null;
      qty: number;
      orders: Set<string>;
      variantId: string | null;
    };
    const agg = new Map<string, Agg>();
    for (const o of orders) {
      const items = Array.isArray(o.line_items) ? o.line_items : [];
      const orderName = o.order_name ?? '';
      for (const raw of items) {
        const it = raw as Record<string, unknown>;
        const product = String(it?.title ?? it?.name ?? 'Item').trim() || 'Item';
        const vRaw = (it?.variantTitle ?? it?.variant_title ?? null) as string | null;
        const variant =
          vRaw && String(vRaw).trim() && !/default title/i.test(String(vRaw))
            ? String(vRaw).trim()
            : null;
        const qty = Number(it?.quantity ?? it?.qty ?? 1) || 1;
        const variantId = (it?.variantId ??
          (it?.variant_id != null
            ? `gid://shopify/ProductVariant/${it.variant_id}`
            : null)) as string | null;
        const key = `${product.toLowerCase()}|||${(variant ?? '').toLowerCase()}`;
        const cur = agg.get(key);
        if (cur) {
          cur.qty += qty;
          if (orderName) cur.orders.add(orderName);
          if (!cur.variantId && variantId) cur.variantId = variantId;
        } else {
          agg.set(key, {
            product,
            variant,
            qty,
            orders: new Set(orderName ? [orderName] : []),
            variantId,
          });
        }
      }
    }

    // Fetch product/variant images (best-effort), then download the bytes.
    const variantIds = [...agg.values()].map((a) => a.variantId).filter((v): v is string => !!v);
    const imgUrlByVariant = await this.shopify
      .getVariantImages(companyId, variantIds)
      .catch(() => new Map<string, string>());
    const imgBytesByUrl = new Map<string, { bytes: Buffer; mime: string }>();
    await Promise.all(
      [...new Set([...imgUrlByVariant.values()])].map(async (u) => {
        try {
          const sep = u.includes('?') ? '&' : '?';
          const res = await httpFetch(`${u}${sep}width=120`, {}, 8000);
          if (!res.ok) return;
          const mime = res.headers.get('content-type') || '';
          // pdf-lib embeds JPG/PNG only — skip anything else (e.g. webp).
          if (!/jpe?g|png/i.test(mime)) return;
          imgBytesByUrl.set(u, { bytes: Buffer.from(await res.arrayBuffer()), mime });
        } catch {
          /* ignore a broken image */
        }
      }),
    );

    // Order names sort naturally by their numeric part (#34659 < #34660).
    const orderNum = (n: string) => Number(n.replace(/[^0-9]/g, '')) || 0;
    const rows: PicklistRow[] = [...agg.values()]
      .sort(
        (a, b) =>
          a.product.localeCompare(b.product) ||
          (a.variant ?? '').localeCompare(b.variant ?? ''),
      )
      .map((a) => {
        const url = a.variantId ? imgUrlByVariant.get(a.variantId) : undefined;
        return {
          product: a.product,
          variant: a.variant,
          qty: a.qty,
          orders: [...a.orders].sort((x, y) => orderNum(x) - orderNum(y)),
          image: url ? imgBytesByUrl.get(url) ?? null : null,
        };
      });
    if (!rows.length) {
      throw new BadRequestException(
        'This loadsheet has no parcels with products to pick.',
      );
    }
    const totalUnits = rows.reduce((s, r) => s + r.qty, 0);

    const dateLabel = batch.created_at.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const pdf = await buildPicklistPdf({
      companyName: company?.company_name || 'Pick list',
      courierName: COURIER_DISPLAY_NAME[batch.courier_type],
      dateLabel,
      rows,
      totalUnits,
    });

    const saved = this.media.saveBuffer(pdf, 'application/pdf', companyId);
    const rel = saved.path.split(/storage[\\/]media[\\/]/)[1];
    const url = rel ? `/storage/media/${rel.replace(/\\/g, '/')}` : '';
    if (!url) throw new BadRequestException('Failed to build the picklist.');
    return { url, skus: rows.length, totalUnits, parcels: batch.shipments.length };
  }

  /**
   * A dispatch / invoicing list PDF for a loadsheet batch — one row per order:
   * Date · Order No. · Invoice (blank) · Item(s) · Total value · Payment. The
   * Payment column classifies each order: outstanding > 0 → "Pending"; prepaid
   * via a real online gateway → "Gateway"; prepaid via an offline/manual method
   * (bank deposit, transfer, cash, manual) → "Online".
   */
  async buildDispatchList(
    companyId: number,
    batchId: number,
  ): Promise<{ url: string; orders: number }> {
    const batch = await this.prisma.loadsheetBatch.findFirst({
      where: { id: batchId, company_id: companyId },
      include: { shipments: true },
    });
    if (!batch) throw new NotFoundException('Loadsheet not found.');
    if (!batch.shipments.length) {
      throw new BadRequestException('This loadsheet has no parcels.');
    }

    const gids = batch.shipments.map((s) => s.shopify_order_gid);
    const [company, orders] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { company_name: true, timezone: true },
      }),
      this.prisma.shopifyOrder.findMany({
        where: { company_id: companyId, shopify_order_gid: { in: gids } },
        select: {
          shopify_order_gid: true,
          order_name: true,
          line_items: true,
          total_price: true,
          total_outstanding: true,
          currency: true,
          financial_status: true,
          payment_gateway: true,
        },
      }),
    ]);
    const orderByGid = new Map(orders.map((o) => [o.shopify_order_gid, o]));

    // Tenant-timezone date formatter → "15-Aug-2026" (matches the app-wide format).
    const tz = company?.timezone ?? undefined;
    const fmtDMY = (d: Date): string => {
      const parts = new Intl.DateTimeFormat('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: tz,
      }).formatToParts(d);
      const day = parts.find((p) => p.type === 'day')?.value ?? '';
      const mon = parts.find((p) => p.type === 'month')?.value ?? '';
      const yr = parts.find((p) => p.type === 'year')?.value ?? '';
      return `${day}-${mon}-${yr}`;
    };

    const currency = orders.find((o) => o.currency)?.currency || 'PKR';
    const orderNum = (n: string) => Number((n || '').replace(/[^0-9]/g, '')) || 0;

    const rows: DispatchListRow[] = batch.shipments
      .slice()
      .sort(
        (a, b) => orderNum(a.shopify_order_name ?? '') - orderNum(b.shopify_order_name ?? ''),
      )
      .map((s) => {
        const o = orderByGid.get(s.shopify_order_gid);
        const rawItems = Array.isArray(o?.line_items) ? (o!.line_items as unknown[]) : [];
        const items = rawItems.map((raw) => {
          const it = raw as Record<string, unknown>;
          const title = String(it?.title ?? it?.name ?? 'Item').trim() || 'Item';
          const vRaw = (it?.variantTitle ?? it?.variant_title ?? null) as string | null;
          const variant =
            vRaw && String(vRaw).trim() && !/default title/i.test(String(vRaw))
              ? String(vRaw).trim()
              : null;
          const qty = Number(it?.quantity ?? it?.qty ?? 1) || 1;
          return { qty, title, variant };
        });
        return {
          date: fmtDMY(s.booked_at ?? s.created_at),
          orderName: o?.order_name ?? s.shopify_order_name ?? '—',
          items,
          totalValue: o?.total_price != null ? Number(o.total_price) : null,
          payment: this.classifyPayment(
            o?.total_outstanding != null ? Number(o.total_outstanding) : null,
            o?.financial_status ?? null,
            o?.payment_gateway ?? null,
          ),
        };
      });

    const dateLabel = fmtDMY(batch.created_at);
    const pdf = await buildDispatchListPdf({
      companyName: company?.company_name || 'Dispatch List',
      courierName: COURIER_DISPLAY_NAME[batch.courier_type],
      dateLabel,
      currency,
      rows,
    });

    const saved = this.media.saveBuffer(pdf, 'application/pdf', companyId);
    const rel = saved.path.split(/storage[\\/]media[\\/]/)[1];
    const url = rel ? `/storage/media/${rel.replace(/\\/g, '/')}` : '';
    if (!url) throw new BadRequestException('Failed to build the dispatch list.');
    return { url, orders: rows.length };
  }

  /** Payment classification for the dispatch list. Mirrors the app's prepaid
   *  offline-vs-online split (OFFLINE_GATEWAY_REGEXP). */
  private classifyPayment(
    outstanding: number | null,
    financialStatus: string | null,
    gateway: string | null,
  ): DispatchPayment {
    // COD / unpaid: an outstanding balance (or, when unknown, a not-paid status).
    const isPending =
      outstanding != null
        ? outstanding > 0
        : (financialStatus ?? '').toLowerCase() !== 'paid';
    if (isPending) return 'Pending';
    // Prepaid: a REAL online gateway → "Gateway"; an offline/manual method
    // (bank deposit/transfer/cash/manual/COD-marked-paid) or unknown → "Online".
    const OFFLINE =
      /cod|cash on delivery|manual|bank deposit|bank transfer|deposit|money order|offline|transfer|cheque/;
    const gw = (gateway ?? '').toLowerCase();
    if (!gw || OFFLINE.test(gw)) return 'Online';
    return 'Gateway';
  }

  /** Our own dispatch manifest PDF for a batch (used when the courier returns no
   *  loadsheet PDF). Joins the order mirror for COD + a company-name header. */
  private async buildManifestPdfFor(
    batch: BatchWithShipments,
  ): Promise<Buffer | undefined> {
    const ships = batch.shipments.filter((s) => s.courier_tracking_number);
    if (!ships.length) return undefined;
    const [company, orders] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: batch.company_id },
        select: { company_name: true },
      }),
      this.prisma.shopifyOrder.findMany({
        where: {
          company_id: batch.company_id,
          shopify_order_gid: { in: ships.map((s) => s.shopify_order_gid) },
        },
        select: {
          shopify_order_gid: true,
          city: true,
          total_outstanding: true,
          currency: true,
        },
      }),
    ]);
    const byGid = new Map(orders.map((o) => [o.shopify_order_gid, o]));
    const currency =
      orders.find((o) => o.currency)?.currency || 'Rs';
    const rows = ships.map((s) => {
      const o = byGid.get(s.shopify_order_gid);
      return {
        tracking: s.courier_tracking_number as string,
        order: s.shopify_order_name,
        city: s.destination_city || o?.city || null,
        cod: o?.total_outstanding == null ? null : Number(o.total_outstanding),
      };
    });
    return buildManifestPdf({
      companyName: company?.company_name || 'Load Sheet',
      courierName: COURIER_DISPLAY_NAME[batch.courier_type],
      dateLabel: batch.created_at.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
      rows,
      currency,
    });
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

      // Fall back to OUR OWN dispatch manifest when the courier returns no PDF —
      // Rocket has no loadsheet API, and Trax's receiving-sheet PDF sometimes
      // isn't ready — so every loadsheet still yields a downloadable sheet.
      const pdfBuffer =
        result.pdfBuffer ?? (await this.buildManifestPdfFor(batch));

      let pdfMediaUrl: string | undefined;
      if (pdfBuffer) {
        const saved = this.media.saveBuffer(
          pdfBuffer,
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
