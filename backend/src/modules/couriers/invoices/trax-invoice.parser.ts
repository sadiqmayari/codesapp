import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { CourierType } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { CourierInvoiceParser } from './courier-invoice-parser.interface';
import { ParsedInvoice, ParsedInvoiceLine } from './courier-invoice.types';

/**
 * Trax / Sonic "payment_details" settlement (.xlsx), verified against a real Sois
 * file (payment 1799762, 71 parcels — 32 Delivered / 32 Arrival / 7 Returned).
 *
 * Two regions in ONE sheet:
 *   1. Parcel table (cols A..Y): S. No. | Tracking No. | Booking Date | Type |
 *      Order ID | … | Collection Amount | Total Charges | GST | WHT | COD SST |
 *      Net Disbursement. One row per parcel until S.No. stops being a number.
 *   2. "Charges Summary" block (off to the RIGHT, cols Z/AA): label→value totals,
 *      ending in `IBFT Charges` and `Overall Charges`.
 *
 * Money model (verified to the cent against the file's own summary):
 *   - Only DELIVERED parcels remit COD (Collection Amount). Delivered rows carry
 *     NO delivery charge — only WHT 2% + COD SST 2% are retained (net = COD − 4%).
 *   - Arrival/Returned rows carry Total Charges + GST (15%) and NO COD → negative
 *     Net Disbursement (the merchant is charged for the leg).
 *   - **IBFT Charges** is a FLAT inter-bank-transfer fee on the payout, sitting in
 *     the summary block only — NOT in any parcel row. It must be added to
 *     deductions once, or the net won't match the bank. `Overall Charges` in the
 *     summary == our per-parcel charges + IBFT, and we cross-check against it.
 *   - deductions = Σ(Total Charges) + Σ(GST) + Σ(WHT) + Σ(COD SST) + IBFT ;
 *     netPayable = codCollected − deductions.
 *
 * The payment id lives in the FILENAME (`sonic_payment_details_1799762`), not the
 * sheet — we lift it from `meta.filename` as the invoice/dedup number.
 */
@Injectable()
export class TraxInvoiceParser implements CourierInvoiceParser {
  readonly courier: CourierType = 'trax';
  readonly formatName = 'Trax/Sonic payment_details statement (.xlsx)';
  private readonly logger = new Logger(TraxInvoiceParser.name);

  private cellStr(cell: ExcelJS.Cell | undefined): string {
    const v = cell?.value as unknown;
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.text === 'string') return o.text.trim();
      if (Array.isArray(o.richText)) {
        return (o.richText as Array<{ text?: string }>).map((r) => r.text ?? '').join('').trim();
      }
      if (o.result !== undefined && o.result !== null) return String(o.result).trim();
    }
    return String(v).trim();
  }

  private cellNum(cell: ExcelJS.Cell | undefined): number {
    const s = this.cellStr(cell).replace(/,/g, '');
    if (!s) return 0;
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }

  private norm(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private normalizeRef(raw: string): string | null {
    const m = raw.match(/#?\s*(\d{3,})/);
    return m ? m[1] : null;
  }

  private parseDate(raw: string): Date | null {
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  async parse(buffer: Buffer, meta?: { filename?: string }): Promise<ParsedInvoice> {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    } catch {
      throw new BadRequestException(
        'That file could not be read as an Excel workbook (.xlsx). Upload the Trax payment_details file, unmodified.',
      );
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new BadRequestException('The workbook has no sheets.');

    // --- locate the header row + resolve columns by normalized label ---
    let headerRow = 0;
    const headerIndex: Record<string, number> = {};
    for (let r = 1; r <= Math.min(12, ws.rowCount); r++) {
      const row = ws.getRow(r);
      const labels: Record<string, number> = {};
      for (let c = 1; c <= 30; c++) {
        const key = this.norm(this.cellStr(row.getCell(c)));
        if (key) labels[key] = c;
      }
      if (labels['trackingno'] && labels['type'] && labels['collectionamountpkr']) {
        headerRow = r;
        Object.assign(headerIndex, labels);
        break;
      }
    }
    if (!headerRow) {
      throw new BadRequestException(
        "This doesn't look like a Trax payment_details file — no header row with 'Tracking No.', " +
          "'Type' and 'Collection Amount' was found. Check you picked the right courier and file.",
      );
    }
    const col = (...aliases: string[]): number => {
      for (const a of aliases) {
        const hit = headerIndex[this.norm(a)];
        if (hit) return hit;
      }
      return 0;
    };
    const at = (row: ExcelJS.Row, c: number): ExcelJS.Cell | undefined => (c ? row.getCell(c) : undefined);

    const cSno = col('S. No.') || 1;
    const cTrack = col('Tracking No.');
    const cType = col('Type');
    const cOrder = col('Order ID');
    const cCod = col('Collection Amount (PKR)');
    const cCharge = col('Total Charges (PKR)');
    const cGst = col('GST');
    const cWht = col('WHT');
    const cSst = col('COD SST');
    const cNet = col('Net Disbursement Amount (PKR)', 'Net Disbursement Amount');
    const cCity = col('Destination');
    const cName = col('Consignee Name');
    const cDate = col('Booking Date');

    // --- parcel table ---
    const lines: ParsedInvoiceLine[] = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const sno = this.cellStr(at(row, cSno));
      const tracking = this.cellStr(at(row, cTrack));
      if (!sno && !tracking) break; // end of the parcel table (blank gap before summary)
      if (!tracking) continue;

      const status = this.cellStr(at(row, cType)) || null;
      const paid = /deliver/i.test(status ?? '');
      lines.push({
        trackingNumber: tracking,
        clientOrderId: this.normalizeRef(this.cellStr(at(row, cOrder))),
        status,
        paid,
        codAmount: paid ? this.cellNum(at(row, cCod)) : 0,
        shippingCharge: this.cellNum(at(row, cCharge)),
        fuelSurcharge: 0, // folded into Total Charges by Trax
        gst: this.cellNum(at(row, cGst)),
        wht: this.cellNum(at(row, cWht)), // WHT 2%
        sst: this.cellNum(at(row, cSst)), // COD SST 2%
        netTotal: this.cellNum(at(row, cNet)),
        city: this.cellStr(at(row, cCity)) || null,
        customerName: this.cellStr(at(row, cName)) || null,
        qty: null,
        createdAt: this.parseDate(this.cellStr(at(row, cDate))),
      });
    }
    if (!lines.length) {
      throw new BadRequestException('No parcel rows were found in that Trax statement.');
    }

    // --- Charges Summary block: the flat IBFT fee + Overall Charges cross-check ---
    const summary = this.readSummary(ws);

    const base = lines.reduce(
      (acc, l) => {
        acc.rows += 1;
        if (l.paid) {
          acc.paidRows += 1;
          acc.codCollected += l.codAmount;
        }
        acc.shipping += l.shippingCharge;
        acc.fuel += l.fuelSurcharge;
        acc.tax += l.gst + l.wht + l.sst;
        return acc;
      },
      { rows: 0, paidRows: 0, codCollected: 0, shipping: 0, fuel: 0, tax: 0, deductions: 0, netPayable: 0 },
    );
    const ibft = summary.ibft ?? 0;
    base.deductions = base.shipping + base.fuel + base.tax + ibft;
    base.netPayable = base.codCollected - base.deductions;

    // Cross-check against the sheet's own "Overall Charges" (parcels + IBFT).
    if (summary.overall != null && Math.abs(summary.overall - base.deductions) > 1) {
      this.logger.warn(
        `Trax ${meta?.filename ?? '(no filename)'}: computed deductions ${base.deductions.toFixed(2)} ` +
          `!= sheet Overall Charges ${summary.overall.toFixed(2)} (IBFT ${ibft}). Using computed.`,
      );
    }

    // Payment id from the filename (sonic_payment_details_1799762.xlsx).
    const idm = (meta?.filename ?? '').match(/(\d{5,})/);

    return {
      invoiceNumber: idm ? idm[1] : null,
      reportDate: null, // the file carries no statement date
      currency: 'PKR',
      lines,
      totals: base,
    };
  }

  /**
   * The "Charges Summary" block sits to the RIGHT of the parcel table (its own
   * label→value column pair). We don't hardcode the column — find each label cell
   * and read the value immediately to its right.
   */
  private readSummary(ws: ExcelJS.Worksheet): { ibft: number | null; overall: number | null } {
    let ibft: number | null = null;
    let overall: number | null = null;
    ws.eachRow((row) => {
      row.eachCell((cell, col) => {
        const key = this.norm(this.cellStr(cell));
        if (key === 'ibftcharges') ibft = this.cellNum(row.getCell(col + 1));
        else if (key === 'overallcharges') overall = this.cellNum(row.getCell(col + 1));
      });
    });
    return { ibft, overall };
  }
}
