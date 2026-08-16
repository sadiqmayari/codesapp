import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { CourierType, Prisma } from '@prisma/client';
import * as fs from 'fs';
import { PrismaService } from '../../../prisma/prisma.service';
import { MediaService } from '../../../common/services/media.service';
import { CacheService } from '../../../common/services/cache.service';
import { JobQueueService } from '../../../common/services/job-queue.service';
import { numifyDecimals } from '../../../common/utils/decimal';
import { mediaWebPathToDisk } from '../../../common/utils/media-path';
import { ShopifyFulfillmentClient } from '../shopify-fulfillment-client.service';
import {
  COURIER_DISPLAY_NAME,
  COURIER_INVOICE_APPLY_QUEUE,
  SHIPMENT_STATUS_TO_SHOPIFY_EVENT,
} from '../couriers.constants';
import { buildCourierInvoicePdf } from '../courier-invoice-pdf.util';
import { CourierInvoiceRegistry } from './courier-invoice.registry';
import {
  ParsedInvoice,
  ReconciledLine,
  ReconcileSummary,
} from './courier-invoice.types';

const XLSX_MIMES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream', // some browsers send this for .xlsx
];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Cap the samples we persist/print so a pathological file can't bloat the row. */
const SAMPLE_CAP = 50;

interface ApplyJob {
  companyId: number;
  invoiceId: number;
  userId?: number;
}

/**
 * Upload → reconcile → apply a courier's own settlement statement.
 *
 * Two deliberate phases: uploading only PARSES and PREVIEWS (no shipment is
 * touched), and a separate apply step does the money-affecting writes in a
 * background job. A settlement moves real money, so the tenant must see exactly
 * what will change before it changes.
 */
@Injectable()
export class CourierInvoiceService implements OnModuleInit {
  private readonly logger = new Logger(CourierInvoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly cache: CacheService,
    private readonly jobQueue: JobQueueService,
    private readonly registry: CourierInvoiceRegistry,
    private readonly shopifyFulfillment: ShopifyFulfillmentClient,
  ) {}

  onModuleInit(): void {
    // One apply at a time per process: each line can hit the Shopify Admin API
    // twice (resolve fulfillment + push event), so a wide fan-out would burn the
    // tenant's Shopify rate limit. Lease 900s covers a large statement.
    this.jobQueue.registerWorker(
      COURIER_INVOICE_APPLY_QUEUE,
      (p) => this.processApplyJob(p as unknown as ApplyJob),
      1,
      900,
    );
    this.logger.log('Registered courier-invoice-apply worker (concurrency=1, lease=900s)');
  }

  supportedCouriers(): CourierType[] {
    return this.registry.supportedCouriers();
  }

  // ── Phase 1: upload + preview (no shipment writes) ──────────────────────
  async uploadAndPreview(
    companyId: number,
    courierType: CourierType,
    file: { buffer?: Buffer; mimetype?: string; originalname?: string; size?: number },
    userId?: number,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file was uploaded.');
    }
    if (file.buffer.length > MAX_UPLOAD_BYTES) {
      throw new BadRequestException('That file is larger than the 10MB limit.');
    }
    const name = (file.originalname ?? '').toLowerCase();
    const mimeOk = XLSX_MIMES.includes((file.mimetype ?? '').toLowerCase());
    const extOk = name.endsWith('.xlsx') || name.endsWith('.xls');
    if (!mimeOk && !extOk) {
      throw new BadRequestException(
        'Upload the courier statement as an Excel file (.xlsx).',
      );
    }

    const parsed = await this.registry.getParser(courierType).parse(file.buffer);

    // A statement already applied must not be applied twice — the unique key is
    // (company, courier, invoice_number), so catch it up front with a clear message.
    if (parsed.invoiceNumber) {
      const existing = await this.prisma.courierInvoice.findFirst({
        where: {
          company_id: companyId,
          courier_type: courierType,
          invoice_number: parsed.invoiceNumber,
        },
        select: { id: true, status: true, applied_at: true },
      });
      if (existing?.status === 'applied') {
        throw new BadRequestException(
          `Invoice ${parsed.invoiceNumber} was already applied on ` +
            `${existing.applied_at?.toISOString().slice(0, 10) ?? 'a previous run'}. ` +
            `Open it from the invoice history instead of re-uploading.`,
        );
      }
      // A previous un-applied parse of the same statement is replaced.
      if (existing) {
        await this.prisma.courierInvoice.delete({ where: { id: existing.id } }).catch(() => undefined);
      }
    }

    const { lines, summary, currency } = await this.reconcile(companyId, parsed);

    // Archive the original file alongside the reconciliation that consumed it.
    let sourceUrl: string | null = null;
    try {
      const saved = this.media.saveBuffer(
        file.buffer,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        companyId,
      );
      sourceUrl = this.toWebPath(saved.path);
    } catch (err) {
      this.logger.warn(
        `Could not archive the uploaded statement (company ${companyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const invoice = await this.prisma.courierInvoice.create({
      data: {
        company_id: companyId,
        courier_type: courierType,
        invoice_number: parsed.invoiceNumber,
        report_date: parsed.reportDate,
        currency,
        source_file_url: sourceUrl,
        status: 'parsed',
        total_rows: parsed.totals.rows,
        paid_rows: parsed.totals.paidRows,
        cod_collected: new Prisma.Decimal(parsed.totals.codCollected.toFixed(2)),
        deductions: new Prisma.Decimal(parsed.totals.deductions.toFixed(2)),
        net_payable: new Prisma.Decimal(parsed.totals.netPayable.toFixed(2)),
        lines: lines as unknown as Prisma.InputJsonValue,
        summary: summary as unknown as Prisma.InputJsonValue,
        created_by_user_id: userId,
      },
    });

    return numifyDecimals({
      ...this.publicShape(invoice),
      totals: parsed.totals,
      summary,
    });
  }

  /** Match every parsed line to a shipment and classify what applying would do. */
  private async reconcile(
    companyId: number,
    parsed: ParsedInvoice,
  ): Promise<{ lines: ReconciledLine[]; summary: ReconcileSummary; currency: string | null }> {
    const trackings = [...new Set(parsed.lines.map((l) => l.trackingNumber).filter(Boolean))];
    const orderRefs = [
      ...new Set(
        parsed.lines
          .map((l) => l.clientOrderId)
          .filter((v): v is string => !!v)
          .flatMap((v) => [`#${v}`, v]),
      ),
    ];

    const shipments = await this.prisma.shipment.findMany({
      where: {
        company_id: companyId,
        OR: [
          trackings.length ? { courier_tracking_number: { in: trackings } } : undefined,
          orderRefs.length ? { shopify_order_name: { in: orderRefs } } : undefined,
        ].filter(Boolean) as Prisma.ShipmentWhereInput[],
      },
      select: {
        id: true,
        status: true,
        courier_tracking_number: true,
        shopify_order_name: true,
        shopify_order_gid: true,
        courier_settled_at: true,
      },
    });

    const byTracking = new Map(
      shipments.filter((s) => s.courier_tracking_number).map((s) => [s.courier_tracking_number!, s]),
    );
    const byOrder = new Map(
      shipments.filter((s) => s.shopify_order_name).map((s) => [s.shopify_order_name!, s]),
    );

    // Expected COD + currency come from the orders mirror, the same source the
    // Courier Payments panel already uses.
    const gids = shipments.map((s) => s.shopify_order_gid);
    const orders = gids.length
      ? await this.prisma.shopifyOrder.findMany({
          where: { company_id: companyId, shopify_order_gid: { in: gids } },
          select: { shopify_order_gid: true, total_outstanding: true, currency: true },
        })
      : [];
    const orderByGid = new Map(orders.map((o) => [o.shopify_order_gid, o]));
    const currency = orders.find((o) => o.currency)?.currency ?? null;

    const lines: ReconciledLine[] = parsed.lines.map((l) => {
      const s =
        byTracking.get(l.trackingNumber) ??
        (l.clientOrderId
          ? byOrder.get(`#${l.clientOrderId}`) ?? byOrder.get(l.clientOrderId)
          : undefined);
      const matchedBy = !s
        ? 'none'
        : byTracking.get(l.trackingNumber)
          ? 'tracking'
          : 'order';
      const o = s ? orderByGid.get(s.shopify_order_gid) : undefined;
      const expectedCod = o?.total_outstanding != null ? Number(o.total_outstanding) : null;
      const alreadySettled = !!s?.courier_settled_at;
      return {
        ...l,
        matchedBy: matchedBy as ReconciledLine['matchedBy'],
        shipmentId: s?.id ?? null,
        orderName: s?.shopify_order_name ?? null,
        ourStatus: s?.status ?? null,
        expectedCod,
        // Only meaningful on a paid line — an undelivered parcel has no COD yet.
        codMismatch:
          l.paid && expectedCod != null && Math.abs(l.codAmount - expectedCod) > 0.5,
        willPromote: !!s && l.paid && s.status !== 'delivered',
        willSettle: !!s && l.paid && !alreadySettled,
        alreadySettled: l.paid && alreadySettled,
      };
    });

    const summary: ReconcileSummary = {
      totalRows: lines.length,
      paidRows: lines.filter((l) => l.paid).length,
      matched: lines.filter((l) => l.shipmentId).length,
      unmatched: lines.filter((l) => !l.shipmentId).length,
      toPromote: lines.filter((l) => l.willPromote).length,
      toSettle: lines.filter((l) => l.willSettle).length,
      alreadySettled: lines.filter((l) => l.alreadySettled).length,
      codMismatches: lines.filter((l) => l.codMismatch).length,
      unmatchedTracking: lines.filter((l) => !l.shipmentId).map((l) => l.trackingNumber),
      codMismatchSamples: lines
        .filter((l) => l.codMismatch)
        .slice(0, SAMPLE_CAP)
        .map((l) => ({
          trackingNumber: l.trackingNumber,
          orderName: l.orderName,
          invoiceCod: l.codAmount,
          expectedCod: l.expectedCod,
        })),
      promoteSamples: lines
        .filter((l) => l.willPromote)
        .slice(0, SAMPLE_CAP)
        .map((l) => ({
          trackingNumber: l.trackingNumber,
          orderName: l.orderName,
          ourStatus: l.ourStatus,
        })),
    };

    return { lines, summary, currency };
  }

  // ── Phase 2: apply ──────────────────────────────────────────────────────
  async applyInvoice(companyId: number, invoiceId: number, userId?: number) {
    const inv = await this.prisma.courierInvoice.findFirst({
      where: { id: invoiceId, company_id: companyId },
    });
    if (!inv) throw new NotFoundException('Invoice not found.');
    if (inv.status === 'applied') {
      throw new BadRequestException('This invoice has already been applied.');
    }
    if (inv.status === 'applying') {
      throw new BadRequestException('This invoice is already being applied.');
    }

    const summary = (inv.summary as unknown as ReconcileSummary) ?? null;
    const total = summary?.paidRows ?? 0;
    await this.prisma.courierInvoice.update({
      where: { id: inv.id },
      data: {
        status: 'applying',
        summary: {
          ...(summary ?? {}),
          progress: {
            processed: 0,
            total,
            promoted: 0,
            settled: 0,
            failed: 0,
            finished: false,
            errors: [],
          },
        } as unknown as Prisma.InputJsonValue,
      },
    });

    await this.jobQueue.enqueue(
      COURIER_INVOICE_APPLY_QUEUE,
      { companyId, invoiceId: inv.id, userId } satisfies ApplyJob,
      { maxAttempts: 1 }, // per-line outcomes are recorded; no whole-batch retry
    );
    return { started: true, invoiceId: inv.id, total };
  }

  private async processApplyJob(job: ApplyJob): Promise<void> {
    const inv = await this.prisma.courierInvoice.findFirst({
      where: { id: job.invoiceId, company_id: job.companyId },
    });
    if (!inv) return;

    const lines = (inv.lines as unknown as ReconciledLine[]) ?? [];
    const summary = (inv.summary as unknown as ReconcileSummary) ?? ({} as ReconcileSummary);
    const paid = lines.filter((l) => l.paid && l.shipmentId);

    let processed = 0;
    let promoted = 0;
    let settled = 0;
    let failed = 0;
    const errors: string[] = [];

    const flush = async (finished = false) => {
      await this.prisma.courierInvoice
        .update({
          where: { id: inv.id },
          data: {
            summary: {
              ...summary,
              progress: {
                processed,
                total: paid.length,
                promoted,
                settled,
                failed,
                finished,
                errors: errors.slice(0, 20),
              },
            } as unknown as Prisma.InputJsonValue,
          },
        })
        .catch(() => undefined);
    };

    for (const line of paid) {
      try {
        const shipment = await this.prisma.shipment.findFirst({
          where: { id: line.shipmentId!, company_id: job.companyId },
          select: {
            id: true,
            status: true,
            shopify_order_gid: true,
            shopify_fulfillment_gid: true,
            courier_settled_at: true,
          },
        });
        if (!shipment) {
          processed++;
          continue;
        }

        // 1. The courier says delivered — make CodesApp agree.
        if (shipment.status !== 'delivered') {
          await this.prisma.shipment.update({
            where: { id: shipment.id },
            data: {
              status: 'delivered',
              delivered_at: new Date(),
              last_courier_status_raw: line.status ?? undefined,
              last_status_reason: null,
            },
          });
          await this.prisma.shopifyOrder
            .updateMany({
              where: {
                company_id: job.companyId,
                shopify_order_gid: shipment.shopify_order_gid,
              },
              data: { delivery_status: 'delivered', delivered_at: new Date() },
            })
            .catch(() => undefined);
          await this.pushDeliveredToShopify(job.companyId, shipment);
          promoted++;
        }

        // 2. Settle the COD against this statement. Same guards as
        //    settlePayments, so re-applying is a no-op.
        const res = await this.prisma.shipment.updateMany({
          where: {
            id: shipment.id,
            company_id: job.companyId,
            status: 'delivered',
            courier_settled_at: null,
          },
          data: { courier_settled_at: new Date(), courier_invoice_id: inv.id },
        });
        if (res.count) settled++;
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        if (errors.length < 20) errors.push(`${line.trackingNumber}: ${msg}`);
        this.logger.warn(
          `Invoice apply: line ${line.trackingNumber} failed (company ${job.companyId}): ${msg}`,
        );
      }
      processed++;
      if (processed % 25 === 0) await flush();
    }

    // Generate the branded statement now that the reconciliation is final.
    let pdfUrl: string | null = null;
    try {
      pdfUrl = await this.generatePdf(job.companyId, inv.id);
    } catch (err) {
      this.logger.warn(
        `Invoice apply: PDF generation failed (invoice ${inv.id}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    await this.prisma.courierInvoice
      .update({
        where: { id: inv.id },
        data: {
          status: 'applied',
          applied_at: new Date(),
          pdf_url: pdfUrl ?? undefined,
          summary: {
            ...summary,
            toPromote: promoted,
            toSettle: settled,
            progress: {
              processed,
              total: paid.length,
              promoted,
              settled,
              failed,
              finished: true,
              errors: errors.slice(0, 20),
            },
          } as unknown as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);

    this.logger.log(
      `Courier invoice ${inv.invoice_number ?? inv.id} applied (company ${job.companyId}): ` +
        `promoted=${promoted} settled=${settled} failed=${failed} of ${paid.length}`,
    );
  }

  /**
   * Mirror the delivered status into Shopify, exactly as the courier status-sync
   * does — including the suppress flag that stops OUR proactive WhatsApp
   * "delivered" message from firing for a historical backfill.
   */
  private async pushDeliveredToShopify(
    companyId: number,
    shipment: { id: number; shopify_order_gid: string; shopify_fulfillment_gid: string | null },
  ): Promise<void> {
    const event = SHIPMENT_STATUS_TO_SHOPIFY_EVENT['delivered'];
    if (!event) return;
    let gid = shipment.shopify_fulfillment_gid;
    if (!gid) {
      gid = await this.shopifyFulfillment
        .getFulfillmentGid(companyId, shipment.shopify_order_gid)
        .catch(() => null);
      if (gid) {
        await this.prisma.shipment
          .update({ where: { id: shipment.id }, data: { shopify_fulfillment_gid: gid } })
          .catch(() => undefined);
      }
    }
    if (!gid) return; // order has no fulfillment — nothing to attach an event to
    const numId = shipment.shopify_order_gid.split('/').pop();
    if (numId) this.cache.set(`shopify-sync-suppress:${companyId}:${numId}`, 1, 1800);
    await this.shopifyFulfillment
      .createFulfillmentEvent(companyId, gid, event)
      .catch(() => undefined);
  }

  // ── PDF ─────────────────────────────────────────────────────────────────
  async generatePdf(companyId: number, invoiceId: number): Promise<string> {
    const inv = await this.prisma.courierInvoice.findFirst({
      where: { id: invoiceId, company_id: companyId },
    });
    if (!inv) throw new NotFoundException('Invoice not found.');
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { company_name: true, address: true, logo_url: true, timezone: true },
    });

    const lines = (inv.lines as unknown as ReconciledLine[]) ?? [];
    const summary = (inv.summary as unknown as ReconcileSummary) ?? ({} as ReconcileSummary);
    const shipping = lines.reduce((s, l) => s + (l.shippingCharge || 0), 0);
    const fuel = lines.reduce((s, l) => s + (l.fuelSurcharge || 0), 0);
    const tax = lines.reduce((s, l) => s + (l.gst || 0) + (l.sst || 0) + (l.wht || 0), 0);

    const pdf = await buildCourierInvoicePdf({
      companyName: company?.company_name || 'Courier Settlement',
      companyAddress: company?.address ?? null,
      logo: this.loadLogo(company?.logo_url ?? null),
      courierName: COURIER_DISPLAY_NAME[inv.courier_type],
      invoiceNumber: inv.invoice_number,
      reportDateLabel: inv.report_date ? this.fmtDate(inv.report_date, company?.timezone) : null,
      generatedLabel: this.fmtDate(new Date(), company?.timezone),
      currency: inv.currency || 'PKR',
      totals: {
        rows: inv.total_rows,
        paidRows: inv.paid_rows,
        codCollected: Number(inv.cod_collected ?? 0),
        shipping,
        fuel,
        tax,
        deductions: Number(inv.deductions ?? 0),
        netPayable: Number(inv.net_payable ?? 0),
      },
      lines: lines.map((l) => ({
        ...l,
        createdAt: l.createdAt ? new Date(l.createdAt) : null,
      })),
      summary,
    });

    const saved = this.media.saveBuffer(pdf, 'application/pdf', companyId);
    const url = this.toWebPath(saved.path);
    if (!url) throw new BadRequestException('Failed to build the invoice PDF.');
    await this.prisma.courierInvoice
      .update({ where: { id: inv.id }, data: { pdf_url: url } })
      .catch(() => undefined);
    return url;
  }

  /** pdf-lib embeds JPG/PNG only — anything else returns null and the PDF falls
   *  back to the company name in text. */
  private loadLogo(webPath: string | null): { bytes: Buffer; mime: string } | null {
    if (!webPath) return null;
    if (!/\.(jpe?g|png)$/i.test(webPath)) return null;
    const disk = mediaWebPathToDisk(webPath);
    if (!disk) return null;
    try {
      const bytes = fs.readFileSync(disk);
      return { bytes, mime: /\.png$/i.test(webPath) ? 'image/png' : 'image/jpeg' };
    } catch {
      return null;
    }
  }

  /** dd-MMM-yyyy in the tenant's timezone — the app-wide date format. */
  private fmtDate(d: Date, tz?: string | null): string {
    const parts = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: tz || undefined,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('day')}-${get('month')}-${get('year')}`;
  }

  // ── Reads ───────────────────────────────────────────────────────────────
  async getInvoice(companyId: number, invoiceId: number) {
    const inv = await this.prisma.courierInvoice.findFirst({
      where: { id: invoiceId, company_id: companyId },
    });
    if (!inv) throw new NotFoundException('Invoice not found.');
    return numifyDecimals({
      ...this.publicShape(inv),
      summary: inv.summary as unknown as ReconcileSummary,
      lines: inv.lines as unknown as ReconciledLine[],
    });
  }

  async listInvoices(companyId: number) {
    const rows = await this.prisma.courierInvoice.findMany({
      where: { company_id: companyId },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    return numifyDecimals(rows.map((r) => this.publicShape(r)));
  }

  private publicShape(inv: {
    id: number;
    courier_type: CourierType;
    invoice_number: string | null;
    report_date: Date | null;
    currency: string | null;
    source_file_url: string | null;
    pdf_url: string | null;
    status: string;
    total_rows: number;
    paid_rows: number;
    cod_collected: Prisma.Decimal | null;
    deductions: Prisma.Decimal | null;
    net_payable: Prisma.Decimal | null;
    applied_at: Date | null;
    created_at: Date;
  }) {
    return {
      id: inv.id,
      courierType: inv.courier_type,
      courierName: COURIER_DISPLAY_NAME[inv.courier_type],
      invoiceNumber: inv.invoice_number,
      reportDate: inv.report_date,
      currency: inv.currency,
      sourceFileUrl: inv.source_file_url,
      pdfUrl: inv.pdf_url,
      status: inv.status,
      totalRows: inv.total_rows,
      paidRows: inv.paid_rows,
      codCollected: inv.cod_collected,
      deductions: inv.deductions,
      netPayable: inv.net_payable,
      appliedAt: inv.applied_at,
      createdAt: inv.created_at,
    };
  }

  /** Absolute media path → the served /storage/media/... web path. */
  private toWebPath(diskPath: string): string {
    const rel = diskPath.split(/storage[\\/]media[\\/]/)[1];
    return rel ? `/storage/media/${rel.replace(/\\/g, '/')}` : '';
  }
}
