import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import {
  ParsedPayfast,
  PayfastSummaryRow,
  PayfastTxn,
} from './payfast-settlement.types';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parses PayFast's CSV exports. TWO different files can be uploaded:
 *  - the TRANSACTION file (one row per payment; carries `Order_Id` == paymentId),
 *  - the SETTLEMENT SUMMARY (one row per payout batch; count + bank + totals).
 *
 * The transaction file is the order-level source (required); the summary is an
 * optional cross-check that also supplies the settlement bank name per batch.
 * We classify each uploaded file by its header, so upload order doesn't matter.
 */
@Injectable()
export class PayfastSettlementParser {
  private readonly logger = new Logger(PayfastSettlementParser.name);

  parse(files: Array<{ buffer: Buffer; originalname?: string }>): ParsedPayfast {
    let txnRows: Record<string, string>[] | null = null;
    let summaryRows: Record<string, string>[] | null = null;

    for (const f of files) {
      const rows = this.readCsv(f.buffer);
      if (!rows.length) continue;
      const header = Object.keys(rows[0]).map((h) => h.toLowerCase().trim());
      if (header.includes('order_id') && header.includes('merchant_amount')) {
        txnRows = rows;
      } else if (
        header.some((h) => h.includes('trx count')) ||
        (header.some((h) => h.includes('merchant amount')) &&
          header.some((h) => h.includes('settlement bank')))
      ) {
        summaryRows = rows;
      }
    }

    if (!txnRows) {
      throw new BadRequestException(
        'The PayFast transaction file is required (the export with an Order_Id column). ' +
          'The settlement summary alone cannot be mapped to orders.',
      );
    }

    const txns = this.parseTxns(txnRows);
    if (!txns.length) {
      throw new BadRequestException('No successful transactions were found in that file.');
    }
    const summary = summaryRows ? this.parseSummary(summaryRows) : [];

    const dates = txns.map((t) => t.settlementDate).filter((d): d is string => !!d).sort();
    const merchantId =
      (summaryRows?.[0] && this.pick(summaryRows[0], ['merchant id'])) ||
      (this.pick(txnRows[0], ['merchant_id', 'merchant id']) ?? null);

    const totals = txns.reduce(
      (a, t) => {
        a.txns += 1;
        a.gross += t.amount;
        a.fees += t.fee;
        a.mdr += t.mdr;
        a.gst += t.gst;
        a.whtSt += t.whtSt;
        a.received += t.merchantAmount;
        return a;
      },
      { txns: 0, gross: 0, fees: 0, mdr: 0, gst: 0, whtSt: 0, received: 0 },
    );

    return {
      merchantId: merchantId ?? null,
      periodStart: dates[0] ?? null,
      periodEnd: dates[dates.length - 1] ?? null,
      currency: 'PKR',
      txns,
      summaryRows: summary,
      totals: {
        txns: totals.txns,
        gross: round2(totals.gross),
        fees: round2(totals.fees),
        mdr: round2(totals.mdr),
        gst: round2(totals.gst),
        whtSt: round2(totals.whtSt),
        received: round2(totals.received),
      },
    };
  }

  private readCsv(buffer: Buffer): Record<string, string>[] {
    try {
      return parse(buffer, {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
        bom: true,
      }) as Record<string, string>[];
    } catch (e) {
      this.logger.warn(`PayFast CSV parse failed: ${e instanceof Error ? e.message : String(e)}`);
      throw new BadRequestException('One of the files could not be read as a CSV.');
    }
  }

  private parseTxns(rows: Record<string, string>[]): PayfastTxn[] {
    const out: PayfastTxn[] = [];
    for (const r of rows) {
      const status = (this.pick(r, ['transaction_status', 'status']) ?? '').toLowerCase();
      // Only settled/successful transactions carry money; skip anything else.
      if (status && status !== 'success') continue;
      const paymentId = (this.pick(r, ['order_id']) ?? '').trim();
      if (!paymentId) continue;
      out.push({
        paymentId,
        transactionId: this.pick(r, ['transaction_id']) ?? null,
        issuer: this.pick(r, ['issuer']) ?? '',
        txnDate: this.parseTxnDate(this.pick(r, ['transaction_date'])),
        settlementDate: this.parseSettlementDate(this.pick(r, ['settlement date', 'settlement_date'])),
        amount: this.num(this.pick(r, ['transaction_amount'])),
        merchantAmount: this.num(this.pick(r, ['merchant_amount'])),
        fee: this.num(this.pick(r, ['total_mdr_amount', 'mdr_amount'])),
        mdr: this.num(this.pick(r, ['mdr_amount'])),
        gst: this.num(this.pick(r, ['tax'])),
        whtSt: this.num(this.pick(r, ['total_tax_amount'])),
      });
    }
    return out;
  }

  private parseSummary(rows: Record<string, string>[]): PayfastSummaryRow[] {
    const out: PayfastSummaryRow[] = [];
    for (const r of rows) {
      const cnt = this.num(this.pick(r, ['trx count']));
      if (!cnt) continue;
      out.push({
        settlementDate: this.parseSettlementDate(this.pick(r, ['settlement date'])),
        bank: (this.pick(r, ['settlement bank']) ?? '').trim(),
        count: Math.round(cnt),
        gross: this.num(this.pick(r, ['trx amount'])),
        merchant: this.num(this.pick(r, ['merchant amount'])),
      });
    }
    return out;
  }

  /** Case-insensitive column lookup by any of the given header aliases. */
  private pick(row: Record<string, string>, aliases: string[]): string | null {
    const want = aliases.map((a) => a.toLowerCase());
    for (const k of Object.keys(row)) {
      if (want.includes(k.toLowerCase().trim())) {
        const v = row[k];
        return v == null ? null : String(v).trim();
      }
    }
    return null;
  }

  private num(raw: string | null): number {
    if (!raw) return 0;
    const s = raw.replace(/,/g, '').trim();
    if (!s || s === '-') return 0;
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }

  /** Settlement date is MONTH-first: "8/19/2026", "08-03-26", or "29-Jul-26". */
  private parseSettlementDate(raw: string | null): string | null {
    if (!raw) return null;
    const s = raw.trim();
    let m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/.exec(s);
    if (m) {
      const mon = MONTHS[m[2].toLowerCase()];
      if (mon) return this.iso(this.y4(m[3]), mon, Number(m[1]));
    }
    m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(s);
    if (m) return this.iso(this.y4(m[3]), Number(m[1]), Number(m[2]));
    return null;
  }

  /** Transaction date is DAY-first: "18-08-26 23:41". Informational only. */
  private parseTxnDate(raw: string | null): Date | null {
    if (!raw) return null;
    const m = /^(\d{1,2})-(\d{1,2})-(\d{2,4})/.exec(raw.trim());
    if (m) {
      const d = new Date(Date.UTC(this.y4(m[3]), Number(m[2]) - 1, Number(m[1])));
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  private y4(y: string): number {
    const n = Number(y);
    return n < 100 ? 2000 + n : n;
  }

  private iso(y: number, mo: number, d: number): string {
    const p = (x: number) => String(x).padStart(2, '0');
    return `${y}-${p(mo)}-${p(d)}`;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
