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
  PayfastSummaryRow,
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

    // When the settlement SUMMARY was uploaded, reproduce PayFast's EXACT payout
    // batches (one per summary row) by partitioning each day's transactions to
    // match its rows' count + amount — so a day PayFast split into 2+ lots on the
    // same bank shows as 2+ settlements, not one. Without a summary, fall back to
    // grouping by (settlement date + rail).
    const batches = parsed.summaryRows.length
      ? batchesFromSummary(recon, parsed.summaryRows)
      : batchesByRail(recon);

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

// ── Batching ────────────────────────────────────────────────────────────────

function railOf(issuer: string): 'card' | 'wallet' {
  return CARD_ISSUER.test(issuer) ? 'card' : 'wallet';
}

function makeBatch(
  date: string | null,
  bank: string,
  txns: ReconciledPayfastTxn[],
  summaryMatched: boolean | null,
): PayfastBatch {
  const cardCount = txns.filter((t) => railOf(t.issuer) === 'card').length;
  return {
    settlementDate: date,
    bank,
    rail: cardCount >= txns.length / 2 ? 'card' : 'wallet',
    count: txns.length,
    gross: round2(txns.reduce((s, t) => s + t.amount, 0)),
    fees: round2(txns.reduce((s, t) => s + t.fee, 0)),
    whtSt: round2(txns.reduce((s, t) => s + t.whtSt, 0)),
    received: round2(txns.reduce((s, t) => s + t.merchantAmount, 0)),
    summaryMatched,
    txns,
  };
}

/** Fallback grouping (no summary uploaded): (settlement date + rail). */
function batchesByRail(recon: ReconciledPayfastTxn[]): PayfastBatch[] {
  const groups = new Map<string, ReconciledPayfastTxn[]>();
  for (const t of recon) {
    const key = `${t.settlementDate ?? 'unknown'}|${railOf(t.issuer)}`;
    const g = groups.get(key);
    if (g) g.push(t);
    else groups.set(key, [t]);
  }
  return [...groups.entries()].map(([key, txns]) =>
    makeBatch(txns[0].settlementDate, key.endsWith('card') ? 'Cards' : 'Wallets / Bank', txns, null),
  );
}

/**
 * Reproduce PayFast's exact payout batches from the summary: one batch per
 * summary row, its transactions the subset of that day's transactions whose
 * count + amount match the row. The largest-count row of each day takes the
 * remainder, so only the smaller lots need a bounded subset search.
 */
function batchesFromSummary(
  recon: ReconciledPayfastTxn[],
  summaryRows: PayfastSummaryRow[],
): PayfastBatch[] {
  const byDate = new Map<string, ReconciledPayfastTxn[]>();
  for (const t of recon) {
    const d = t.settlementDate ?? 'unknown';
    const g = byDate.get(d);
    if (g) g.push(t);
    else byDate.set(d, [t]);
  }
  const sumByDate = new Map<string, PayfastSummaryRow[]>();
  for (const s of summaryRows) {
    const d = s.settlementDate ?? 'unknown';
    const g = sumByDate.get(d);
    if (g) g.push(s);
    else sumByDate.set(d, [s]);
  }

  const out: PayfastBatch[] = [];
  for (const [date, txns] of byDate) {
    const rows = sumByDate.get(date) ?? [];
    const assigned = rows.length ? assignDate(txns, rows) : null;
    if (assigned) out.push(...assigned);
    // No summary rows for this day, or the split couldn't be resolved → the
    // day still reconciles as (date + rail) lots so nothing is dropped.
    else out.push(...railBatchesForDate(txns));
  }
  return out;
}

function railBatchesForDate(txns: ReconciledPayfastTxn[]): PayfastBatch[] {
  const card = txns.filter((t) => railOf(t.issuer) === 'card');
  const wallet = txns.filter((t) => railOf(t.issuer) === 'wallet');
  const res: PayfastBatch[] = [];
  if (card.length) res.push(makeBatch(card[0].settlementDate, 'Cards', card, false));
  if (wallet.length) res.push(makeBatch(wallet[0].settlementDate, 'Wallets / Bank', wallet, false));
  return res;
}

/**
 * Partition one day's transactions to match its summary rows. Splits by RAIL
 * first (cards settle to one bank, wallets/RAAST to another), assigns the day's
 * summary rows to each rail group by count+amount, then splits a rail group that
 * covers 2+ rows via a small subset search. This keeps every subset search tiny
 * (a rail group, not the whole day). Null on failure → caller falls back.
 */
function assignDate(
  txns: ReconciledPayfastTxn[],
  rows: PayfastSummaryRow[],
): PayfastBatch[] | null {
  const railGroups = [
    txns.filter((t) => railOf(t.issuer) === 'card'),
    txns.filter((t) => railOf(t.issuer) === 'wallet'),
  ].filter((g) => g.length);

  let unassigned = [...rows];
  const result: PayfastBatch[] = [];
  for (const g of railGroups) {
    const gCount = g.length;
    const gSum = round2(g.reduce((s, t) => s + t.amount, 0));
    const rowSet = pickRowSubset(unassigned, gCount, gSum, 1.5);
    if (!rowSet) return null; // rail split doesn't line up with the summary
    unassigned = unassigned.filter((r) => !rowSet.includes(r));
    const sub = splitGroup(g, rowSet);
    if (!sub) return null;
    result.push(...sub);
  }
  if (unassigned.length) return null; // some summary row had no rail group
  return result;
}

/** Split one rail group's transactions into its (already-matched) summary rows. */
function splitGroup(
  txns: ReconciledPayfastTxn[],
  rows: PayfastSummaryRow[],
): PayfastBatch[] | null {
  if (rows.length === 1) {
    const matched =
      txns.length === rows[0].count &&
      Math.abs(round2(txns.reduce((s, t) => s + t.amount, 0)) - rows[0].gross) < 1.5;
    return [makeBatch(rows[0].settlementDate, rows[0].bank, txns, matched)];
  }
  // Peel the smaller-count lots via subset search; the largest takes the rest.
  const sorted = [...rows].sort((a, b) => a.count - b.count);
  const pool = txns.map((t) => ({ t, used: false }));
  const res: PayfastBatch[] = [];
  for (let r = 0; r < sorted.length - 1; r++) {
    const row = sorted[r];
    const avail = pool.filter((p) => !p.used);
    const pick = pickSubset(avail.map((p) => p.t.amount), row.count, row.gross, 1.0);
    if (!pick) return null;
    const chosen = pick.map((i) => avail[i]);
    chosen.forEach((c) => (c.used = true));
    res.push(makeBatch(row.settlementDate, row.bank, chosen.map((c) => c.t), true));
  }
  const rest = pool.filter((p) => !p.used).map((p) => p.t);
  const last = sorted[sorted.length - 1];
  const matched =
    rest.length === last.count &&
    Math.abs(round2(rest.reduce((s, t) => s + t.amount, 0)) - last.gross) < 1.0;
  res.push(makeBatch(last.settlementDate, last.bank, rest, matched));
  return res;
}

/**
 * Choose the subset of summary `rows` whose counts sum to `targetCount` and
 * grosses sum to `targetGross` (± `tol`). Rows-per-day are few, so brute-force
 * over subsets is fine. Returns the chosen rows or null.
 */
function pickRowSubset(
  rows: PayfastSummaryRow[],
  targetCount: number,
  targetGross: number,
  tol: number,
): PayfastSummaryRow[] | null {
  const n = rows.length;
  if (n === 0 || n > 20) return null;
  for (let mask = 1; mask < 1 << n; mask++) {
    let c = 0;
    let g = 0;
    const picked: PayfastSummaryRow[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        c += rows[i].count;
        g += rows[i].gross;
        picked.push(rows[i]);
      }
    }
    if (c === targetCount && Math.abs(g - targetGross) <= tol) return picked;
  }
  return null;
}

/**
 * Choose exactly `k` of `amounts` summing to `target` (± `tol`). Sorted-desc DFS
 * with reachability pruning + a node budget so a pathological day can't hang;
 * returns the chosen indices (into `amounts`) or null.
 */
function pickSubset(
  amounts: number[],
  k: number,
  target: number,
  tol: number,
): number[] | null {
  const n = amounts.length;
  if (k < 0 || k > n) return null;
  if (k === 0) return Math.abs(target) <= tol ? [] : null;
  const idx = amounts.map((_, i) => i).sort((x, y) => amounts[y] - amounts[x]);
  const a = idx.map((i) => amounts[i]);
  let budget = 200000;
  const chosen: number[] = [];
  const dfs = (start: number, need: number, rem: number): boolean => {
    if (budget-- <= 0) return false;
    if (need === 0) return Math.abs(rem) <= tol;
    if (need > n - start) return false;
    let maxReach = 0;
    for (let i = 0; i < need; i++) maxReach += a[start + i];
    if (maxReach < rem - tol) return false;
    let minReach = 0;
    for (let i = 0; i < need; i++) minReach += a[n - 1 - i];
    if (minReach > rem + tol) return false;
    chosen.push(idx[start]);
    if (dfs(start + 1, need - 1, rem - a[start])) return true;
    chosen.pop();
    return dfs(start + 1, need, rem);
  };
  return dfs(0, k, target) ? [...chosen] : null;
}
