import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as fs from 'fs';
import { PrismaService } from '../../../prisma/prisma.service';
import { MediaService } from '../../../common/services/media.service';
import { JobQueueService } from '../../../common/services/job-queue.service';
import { numifyDecimals } from '../../../common/utils/decimal';
import { mediaWebPathToDisk } from '../../../common/utils/media-path';
import { ShopifyService } from '../../integrations/shopify/shopify.service';
import { PayfastSettlementParser } from './payfast-settlement.parser';
import { buildPayfastStatementPdf } from './payfast-statement-pdf.util';
import {
  ParsedPayfast,
  PayfastBatch,
  PayfastReconcileSummary,
  ReconciledPayfastTxn,
} from './payfast-settlement.types';

export const PAYFAST_APPLY_QUEUE = 'payfast-settlement-apply';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UNMATCHED_SAMPLE_CAP = 50;
const CARD_ISSUER = /visa|master|amex|union|card|debit|credit/i;

interface ApplyJob {
  companyId: number;
  settlementId: number;
  userId?: number;
}

/**
 * Upload → reconcile → apply a PayFast settlement. The prepaid/online twin of
 * CourierInvoiceService. Uploading only PARSES + resolves orders + PREVIEWS
 * (no order is touched); a separate apply stamps each matched order's gateway
 * payout reconciled in a background job, then emits the consolidated statement.
 */
@Injectable()
export class PayfastSettlementService implements OnModuleInit {
  private readonly logger = new Logger(PayfastSettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly jobQueue: JobQueueService,
    private readonly parser: PayfastSettlementParser,
    private readonly shopify: ShopifyService,
  ) {}

  onModuleInit(): void {
    this.jobQueue.registerWorker(
      PAYFAST_APPLY_QUEUE,
      (p) => this.processApplyJob(p as unknown as ApplyJob),
      1,
      900,
    );
    this.logger.log('Registered payfast-settlement-apply worker (concurrency=1, lease=900s)');
  }

  // ── Phase 1: upload + preview (no order writes) ─────────────────────────
  async uploadAndPreview(
    companyId: number,
    files: Array<{ buffer?: Buffer; mimetype?: string; originalname?: string; size?: number }>,
    userId?: number,
  ) {
    const clean = (files ?? []).filter((f): f is { buffer: Buffer; originalname?: string } => !!f?.buffer?.length);
    if (!clean.length) throw new BadRequestException('No file was uploaded.');
    for (const f of clean) {
      if (f.buffer.length > MAX_UPLOAD_BYTES) {
        throw new BadRequestException('A file is larger than the 10MB limit.');
      }
      const name = (f.originalname ?? '').toLowerCase();
      if (!name.endsWith('.csv')) {
        throw new BadRequestException('Upload the PayFast exports as CSV (.csv) files.');
      }
    }

    const parsed = this.parser.parse(clean);

    // Dedup: a settlement covering the same period is replaced while unapplied,
    // and refused once applied (its orders are already reconciled).
    const existing = await this.prisma.paymentSettlement.findFirst({
      where: {
        company_id: companyId,
        gateway: 'payfast',
        period_start: parsed.periodStart ? new Date(parsed.periodStart) : null,
        period_end: parsed.periodEnd ? new Date(parsed.periodEnd) : null,
      },
      select: { id: true, status: true, applied_at: true },
    });
    if (existing?.status === 'applied') {
      throw new BadRequestException(
        `A PayFast settlement for ${parsed.periodStart} → ${parsed.periodEnd} was already applied. ` +
          `Open it from the settlement history instead of re-uploading.`,
      );
    }
    if (existing) {
      await this.prisma.paymentSettlement.delete({ where: { id: existing.id } }).catch(() => undefined);
    }

    const { batches, summary } = await this.reconcile(companyId, parsed);

    // Archive both uploaded files.
    let txnUrl: string | null = null;
    let summaryUrl: string | null = null;
    for (const f of clean) {
      const rows = safeHeader(f.buffer);
      const url = this.saveCsv(f.buffer, companyId);
      if (rows.includes('order_id')) txnUrl = url;
      else summaryUrl = url;
    }

    const settlement = await this.prisma.paymentSettlement.create({
      data: {
        company_id: companyId,
        gateway: 'payfast',
        merchant_id: parsed.merchantId,
        period_start: parsed.periodStart ? new Date(parsed.periodStart) : null,
        period_end: parsed.periodEnd ? new Date(parsed.periodEnd) : null,
        currency: parsed.currency,
        source_txn_url: txnUrl,
        source_summary_url: summaryUrl,
        status: 'parsed',
        total_txns: parsed.totals.txns,
        matched_txns: summary.matchedTxns,
        gross: new Prisma.Decimal(parsed.totals.gross.toFixed(2)),
        fees: new Prisma.Decimal(parsed.totals.fees.toFixed(2)),
        wht_st: new Prisma.Decimal(parsed.totals.whtSt.toFixed(2)),
        received: new Prisma.Decimal(parsed.totals.received.toFixed(2)),
        batches: batches as unknown as Prisma.InputJsonValue,
        summary: summary as unknown as Prisma.InputJsonValue,
        created_by_user_id: userId,
      },
    });

    return numifyDecimals({ ...this.publicShape(settlement), batches, summary });
  }

  /**
   * Resolve every transaction to a Shopify order via `gateway_payment_ref`, then
   * group transactions into payout batches (settlement date + rail). Where a
   * summary file was uploaded, each batch is cross-checked and labelled with the
   * real settlement bank.
   */
  private async reconcile(
    companyId: number,
    parsed: ParsedPayfast,
  ): Promise<{ batches: PayfastBatch[]; summary: PayfastReconcileSummary }> {
    const refs = [...new Set(parsed.txns.map((t) => t.paymentId))];

    let map = await this.loadRefMap(companyId, refs);
    // Any unresolved refs → backfill the gateway ref for orders created around
    // this settlement window (payments happen a few days before settlement),
    // then re-query. Bounded + best-effort.
    if (refs.some((r) => !map.has(r)) && parsed.periodStart) {
      const since = shiftDays(parsed.periodStart, -12);
      const until = shiftDays(parsed.periodEnd ?? parsed.periodStart, 2);
      try {
        await this.shopify.backfillGatewayPaymentRefs(companyId, {
          sinceISO: since,
          untilISO: until,
        });
        map = await this.loadRefMap(companyId, refs);
      } catch (e) {
        this.logger.warn(
          `PayFast backfill failed (company ${companyId}): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const recon: ReconciledPayfastTxn[] = parsed.txns.map((t) => {
      const hit = map.get(t.paymentId);
      return { ...t, orderName: hit?.orderName ?? null, orderGid: hit?.orderGid ?? null };
    });

    // Group by (settlement date + rail). Bank label + cross-check from summary.
    const groups = new Map<string, PayfastBatch>();
    for (const t of recon) {
      const rail: 'card' | 'wallet' = CARD_ISSUER.test(t.issuer) ? 'card' : 'wallet';
      const key = `${t.settlementDate ?? 'unknown'}|${rail}`;
      let b = groups.get(key);
      if (!b) {
        b = {
          settlementDate: t.settlementDate,
          bank: rail === 'card' ? 'Cards' : 'Wallets / Bank',
          rail,
          count: 0,
          gross: 0,
          fees: 0,
          whtSt: 0,
          received: 0,
          summaryMatched: null,
          txns: [],
        };
        groups.set(key, b);
      }
      b.txns.push(t);
      b.count += 1;
      b.gross += t.amount;
      b.fees += t.fee;
      b.whtSt += t.whtSt;
      b.received += t.merchantAmount;
    }

    const batches = [...groups.values()].map((b) => ({
      ...b,
      gross: round2(b.gross),
      fees: round2(b.fees),
      whtSt: round2(b.whtSt),
      received: round2(b.received),
    }));

    // Cross-check + bank labels from the summary (when uploaded).
    if (parsed.summaryRows.length) {
      const used = new Set<number>();
      for (const b of batches) {
        const idx = parsed.summaryRows.findIndex(
          (s, i) =>
            !used.has(i) &&
            s.settlementDate === b.settlementDate &&
            s.count === b.count &&
            Math.abs(s.gross - b.gross) < 1,
        );
        if (idx >= 0) {
          used.add(idx);
          b.bank = parsed.summaryRows[idx].bank || b.bank;
          b.summaryMatched = true;
        } else {
          b.summaryMatched = false;
        }
      }
    }

    // Newest settlement first.
    batches.sort((a, b) => (b.settlementDate ?? '').localeCompare(a.settlementDate ?? ''));

    const matched = recon.filter((t) => t.orderGid);
    const summary: PayfastReconcileSummary = {
      totalTxns: recon.length,
      matchedTxns: matched.length,
      unmatchedTxns: recon.length - matched.length,
      unmatchedSamples: recon
        .filter((t) => !t.orderGid)
        .slice(0, UNMATCHED_SAMPLE_CAP)
        .map((t) => ({ paymentId: t.paymentId, amount: t.amount, issuer: t.issuer })),
      batches: batches.length,
      grandGross: parsed.totals.gross,
      grandFees: parsed.totals.fees,
      grandWhtSt: parsed.totals.whtSt,
      grandReceived: parsed.totals.received,
    };

    return { batches, summary };
  }

  private async loadRefMap(
    companyId: number,
    refs: string[],
  ): Promise<Map<string, { orderName: string; orderGid: string }>> {
    const map = new Map<string, { orderName: string; orderGid: string }>();
    if (!refs.length) return map;
    // Chunk the IN() so a huge file doesn't blow the query.
    for (let i = 0; i < refs.length; i += 500) {
      const chunk = refs.slice(i, i + 500);
      const rows = await this.prisma.shopifyOrder.findMany({
        where: { company_id: companyId, gateway_payment_ref: { in: chunk } },
        select: { order_name: true, shopify_order_gid: true, gateway_payment_ref: true },
      });
      for (const r of rows) {
        if (r.gateway_payment_ref && !map.has(r.gateway_payment_ref)) {
          map.set(r.gateway_payment_ref, {
            orderName: r.order_name ?? r.shopify_order_gid.split('/').pop() ?? '',
            orderGid: r.shopify_order_gid,
          });
        }
      }
    }
    return map;
  }

  // ── Phase 2: apply ──────────────────────────────────────────────────────
  async applySettlement(companyId: number, settlementId: number, userId?: number) {
    const s = await this.prisma.paymentSettlement.findFirst({
      where: { id: settlementId, company_id: companyId },
    });
    if (!s) throw new NotFoundException('Settlement not found.');
    if (s.status === 'applied') throw new BadRequestException('This settlement has already been applied.');
    if (s.status === 'applying') throw new BadRequestException('This settlement is already being applied.');

    const summary = (s.summary as unknown as PayfastReconcileSummary) ?? null;
    const total = summary?.matchedTxns ?? 0;
    await this.prisma.paymentSettlement.update({
      where: { id: s.id },
      data: {
        status: 'applying',
        summary: {
          ...(summary ?? {}),
          progress: { processed: 0, total, reconciled: 0, markedPaid: 0, failed: 0, finished: false, errors: [] },
        } as unknown as Prisma.InputJsonValue,
      },
    });
    await this.jobQueue.enqueue(
      PAYFAST_APPLY_QUEUE,
      { companyId, settlementId: s.id, userId } satisfies ApplyJob,
      { maxAttempts: 1 },
    );
    return { started: true, settlementId: s.id, total };
  }

  private async processApplyJob(job: ApplyJob): Promise<void> {
    const s = await this.prisma.paymentSettlement.findFirst({
      where: { id: job.settlementId, company_id: job.companyId },
    });
    if (!s) return;
    const batches = (s.batches as unknown as PayfastBatch[]) ?? [];
    const summary = (s.summary as unknown as PayfastReconcileSummary) ?? ({} as PayfastReconcileSummary);
    const matched = batches.flatMap((b) => b.txns).filter((t) => t.orderGid);

    let processed = 0;
    let reconciled = 0;
    let markedPaid = 0;
    let failed = 0;
    const errors: string[] = [];

    const flush = async (finished = false) => {
      await this.prisma.paymentSettlement
        .update({
          where: { id: s.id },
          data: {
            summary: {
              ...summary,
              progress: { processed, total: matched.length, reconciled, markedPaid, failed, finished, errors: errors.slice(0, 20) },
            } as unknown as Prisma.InputJsonValue,
          },
        })
        .catch(() => undefined);
    };

    for (const t of matched) {
      try {
        // Stamp the gateway payout reconciled + link the settlement. Guarded so a
        // re-apply is a no-op (only stamps orders not already reconciled).
        const res = await this.prisma.shopifyOrder.updateMany({
          where: {
            company_id: job.companyId,
            shopify_order_gid: t.orderGid!,
            gateway_reconciled_at: null,
          },
          data: { gateway_reconciled_at: new Date(), payment_settlement_id: s.id },
        });
        if (res.count) reconciled++;

        // A prepaid PayFast order is normally already PAID at checkout; only mark
        // paid if Shopify still shows an outstanding balance (rare).
        const order = await this.prisma.shopifyOrder.findFirst({
          where: { company_id: job.companyId, shopify_order_gid: t.orderGid! },
          select: { financial_status: true, total_outstanding: true },
        });
        const outstanding = order?.total_outstanding != null ? Number(order.total_outstanding) : 0;
        const alreadyPaid = (order?.financial_status ?? '').toUpperCase() === 'PAID';
        if (outstanding > 0 && !alreadyPaid) {
          const paidRes = await this.shopify.markOrderPaid(job.companyId, t.orderGid!);
          if (paidRes.ok) markedPaid++;
          else if (paidRes.error && errors.length < 20) errors.push(`${t.orderName}: mark-paid — ${paidRes.error}`);
        }
      } catch (err) {
        failed++;
        if (errors.length < 20) errors.push(`${t.orderName ?? t.paymentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      processed++;
      if (processed % 40 === 0) await flush();
    }

    let pdfUrl: string | null = null;
    try {
      pdfUrl = await this.generatePdf(job.companyId, s.id);
    } catch (err) {
      this.logger.warn(`PayFast statement PDF failed (settlement ${s.id}): ${err instanceof Error ? err.message : String(err)}`);
    }

    await this.prisma.paymentSettlement
      .update({
        where: { id: s.id },
        data: {
          status: 'applied',
          applied_at: new Date(),
          pdf_url: pdfUrl ?? undefined,
          summary: {
            ...summary,
            progress: { processed, total: matched.length, reconciled, markedPaid, failed, finished: true, errors: errors.slice(0, 20) },
          } as unknown as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);

    this.logger.log(
      `PayFast settlement ${s.id} applied (company ${job.companyId}): reconciled=${reconciled} markedPaid=${markedPaid} failed=${failed} of ${matched.length}`,
    );
  }

  // ── PDF ─────────────────────────────────────────────────────────────────
  async generatePdf(companyId: number, settlementId: number): Promise<string> {
    const s = await this.prisma.paymentSettlement.findFirst({
      where: { id: settlementId, company_id: companyId },
    });
    if (!s) throw new NotFoundException('Settlement not found.');
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { company_name: true, address: true, logo_url: true, timezone: true },
    });
    const batches = (s.batches as unknown as PayfastBatch[]) ?? [];
    const summary = (s.summary as unknown as PayfastReconcileSummary) ?? ({} as PayfastReconcileSummary);

    const pdf = await buildPayfastStatementPdf({
      companyName: company?.company_name || 'PayFast Settlement',
      companyAddress: company?.address ?? null,
      logo: this.loadLogo(company?.logo_url ?? null),
      merchantId: s.merchant_id,
      periodLabel: this.periodLabel(s.period_start, s.period_end, company?.timezone),
      generatedLabel: this.fmtDate(new Date(), company?.timezone),
      currency: s.currency || 'PKR',
      grand: {
        txns: s.total_txns,
        matched: s.matched_txns,
        gross: Number(s.gross ?? 0),
        fees: Number(s.fees ?? 0),
        whtSt: Number(s.wht_st ?? 0),
        received: Number(s.received ?? 0),
      },
      batches,
      unmatched: summary.unmatchedSamples ?? [],
    });

    const saved = this.media.saveBuffer(pdf, 'application/pdf', companyId);
    const url = this.toWebPath(saved.path);
    if (!url) throw new BadRequestException('Failed to build the statement PDF.');
    await this.prisma.paymentSettlement.update({ where: { id: s.id }, data: { pdf_url: url } }).catch(() => undefined);
    return url;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────
  async getSettlement(companyId: number, settlementId: number) {
    const s = await this.prisma.paymentSettlement.findFirst({
      where: { id: settlementId, company_id: companyId },
    });
    if (!s) throw new NotFoundException('Settlement not found.');
    return numifyDecimals({
      ...this.publicShape(s),
      batches: s.batches as unknown as PayfastBatch[],
      summary: s.summary as unknown as PayfastReconcileSummary,
    });
  }

  async listSettlements(companyId: number) {
    const rows = await this.prisma.paymentSettlement.findMany({
      where: { company_id: companyId },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    return numifyDecimals(rows.map((r) => this.publicShape(r)));
  }

  private publicShape(s: {
    id: number;
    gateway: string;
    merchant_id: string | null;
    period_start: Date | null;
    period_end: Date | null;
    currency: string | null;
    source_txn_url: string | null;
    source_summary_url: string | null;
    pdf_url: string | null;
    status: string;
    total_txns: number;
    matched_txns: number;
    gross: Prisma.Decimal | null;
    fees: Prisma.Decimal | null;
    wht_st: Prisma.Decimal | null;
    received: Prisma.Decimal | null;
    applied_at: Date | null;
    created_at: Date;
  }) {
    return {
      id: s.id,
      gateway: s.gateway,
      merchantId: s.merchant_id,
      periodStart: s.period_start,
      periodEnd: s.period_end,
      currency: s.currency,
      sourceTxnUrl: s.source_txn_url,
      sourceSummaryUrl: s.source_summary_url,
      pdfUrl: s.pdf_url,
      status: s.status,
      totalTxns: s.total_txns,
      matchedTxns: s.matched_txns,
      gross: s.gross,
      fees: s.fees,
      whtSt: s.wht_st,
      received: s.received,
      appliedAt: s.applied_at,
      createdAt: s.created_at,
    };
  }

  private saveCsv(buffer: Buffer, companyId: number): string {
    const saved = this.media.saveBuffer(buffer, 'text/csv', companyId);
    return this.toWebPath(saved.path);
  }

  private toWebPath(diskPath: string): string {
    const rel = diskPath.split(/storage[\\/]media[\\/]/)[1];
    return rel ? `/storage/media/${rel.replace(/\\/g, '/')}` : '';
  }

  private loadLogo(webPath: string | null): { bytes: Buffer; mime: string } | null {
    if (!webPath || !/\.(jpe?g|png)$/i.test(webPath)) return null;
    const disk = mediaWebPathToDisk(webPath);
    if (!disk) return null;
    try {
      return { bytes: fs.readFileSync(disk), mime: /\.png$/i.test(webPath) ? 'image/png' : 'image/jpeg' };
    } catch {
      return null;
    }
  }

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

  private periodLabel(start: Date | null, end: Date | null, tz?: string | null): string {
    if (!start && !end) return '';
    const a = start ? this.fmtDate(start, tz) : '?';
    const b = end ? this.fmtDate(end, tz) : '?';
    return `${a} → ${b}`;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function safeHeader(buffer: Buffer): string[] {
  const firstLine = buffer.toString('utf8').split(/\r?\n/)[0] ?? '';
  return firstLine.split(',').map((h) => h.replace(/^﻿/, '').trim().toLowerCase());
}
