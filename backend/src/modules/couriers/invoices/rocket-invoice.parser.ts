import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { CourierType } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { CourierInvoiceParser } from './courier-invoice-parser.interface';
import { ParsedInvoice, ParsedInvoiceLine } from './courier-invoice.types';

/**
 * Rocket's settlement statement (.xlsx), verified against a real Sois file
 * (invoice 10098024, 253 parcels).
 *
 * Layout:
 *   row 1              "Report Date: 2026-08-16 14:00:45" in column A
 *   row 2              23-column header (S.No. … Store Name)
 *   rows 3..N          one row per parcel, until S.No. stops being a number
 *   (blank rows)
 *   "Advance Shipping Charges Summary"   a SECOND table: S.No. | ID | Tracking ID | Arrival Charges
 *
 * IMPORTANT — the second table is a BREAKDOWN, not extra money. Its 125-per-parcel
 * arrival charges are the same charges already sitting in the main table's
 * `Net Shipping` column for those undelivered parcels. Verified arithmetically on
 * the real file: COD 636,597 − shipping 23,800 − fuel 4,642 = net 608,155, which
 * matches the file's own Net Total column exactly. Adding the second table again
 * would over-deduct by 13,000. We parse it only to cross-check, never to sum.
 *
 * "Paid" is driven by the `Payment Status` column (Yes/No), which on the real
 * file lines up 1:1 with Status Delivered/Arrival (149 Yes / 104 No).
 */
@Injectable()
export class RocketInvoiceParser implements CourierInvoiceParser {
  readonly courier: CourierType = 'rocket';
  readonly formatName = 'Rocket settlement statement (.xlsx)';
  private readonly logger = new Logger(RocketInvoiceParser.name);

  /** exceljs cell values can be rich text / formula objects — flatten to a string. */
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
        return (o.richText as Array<{ text?: string }>)
          .map((r) => r.text ?? '')
          .join('')
          .trim();
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

  /** Excel guards long numeric refs as text ("'1665872"); strip that + whitespace. */
  private normalizeRef(raw: string): string {
    return raw.replace(/^['`\s]+/, '').replace(/\s+$/, '').trim();
  }

  private parseDate(raw: string): Date | null {
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  async parse(buffer: Buffer): Promise<ParsedInvoice> {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    } catch {
      throw new BadRequestException(
        'That file could not be read as an Excel workbook (.xlsx). Upload the statement Rocket sent, unmodified.',
      );
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new BadRequestException('The workbook has no sheets.');

    // --- locate the header row (don't hardcode row 2) ---
    let headerRow = 0;
    const headerIndex: Record<string, number> = {};
    for (let r = 1; r <= Math.min(15, ws.rowCount); r++) {
      const row = ws.getRow(r);
      const labels: Record<string, number> = {};
      for (let c = 1; c <= 40; c++) {
        const key = this.cellStr(row.getCell(c)).toLowerCase();
        if (key) labels[key] = c;
      }
      if (labels['tracking id'] && labels['net total'] && labels['amount']) {
        headerRow = r;
        Object.assign(headerIndex, labels);
        break;
      }
    }
    if (!headerRow) {
      throw new BadRequestException(
        "This doesn't look like a Rocket statement — no header row with 'Tracking ID', 'Amount' and 'Net Total' was found. Check you picked the right courier and the right file.",
      );
    }

    const col = (name: string): number => headerIndex[name.toLowerCase()] ?? 0;
    const at = (row: ExcelJS.Row, name: string): ExcelJS.Cell | undefined => {
      const c = col(name);
      return c ? row.getCell(c) : undefined;
    };

    // --- report date (row above the header, "Report Date: ...") ---
    let reportDate: Date | null = null;
    for (let r = 1; r < headerRow; r++) {
      const m = /report date\s*:\s*(.+)$/i.exec(this.cellStr(ws.getRow(r).getCell(1)));
      if (m) {
        reportDate = this.parseDate(m[1].trim());
        break;
      }
    }

    // --- main parcel table ---
    const lines: ParsedInvoiceLine[] = [];
    let invoiceNumber: string | null = null;
    const snoCol = col('s.no.') || col('s.no') || 1;

    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const sno = this.cellStr(row.getCell(snoCol));
      const tracking = this.normalizeRef(this.cellStr(at(row, 'tracking id')));
      // The table ends at the first row without a serial number AND without a
      // tracking ref — the blank gap before "Advance Shipping Charges Summary".
      if (!sno && !tracking) break;
      if (!tracking) continue;

      const paymentStatus = this.cellStr(at(row, 'payment status')).toLowerCase();
      const status = this.cellStr(at(row, 'status')) || null;
      const inv = this.cellStr(at(row, 'invoice no'));
      if (inv && !invoiceNumber) invoiceNumber = inv;

      const clientRaw = this.cellStr(at(row, 'client order id'));
      lines.push({
        trackingNumber: tracking,
        clientOrderId: clientRaw ? clientRaw.replace(/^#+/, '').trim() || null : null,
        status,
        // Rocket marks remittance in `Payment Status`; fall back to the status
        // text if a future file drops that column.
        paid: paymentStatus
          ? paymentStatus === 'yes'
          : (status ?? '').toLowerCase() === 'delivered',
        codAmount: this.cellNum(at(row, 'amount')),
        shippingCharge: this.cellNum(at(row, 'net shipping')),
        fuelSurcharge: this.cellNum(at(row, 'net fuel surcharge')),
        gst: this.cellNum(at(row, 'gst')),
        sst: this.cellNum(at(row, 'sst')),
        wht: this.cellNum(at(row, 'wht')),
        netTotal: this.cellNum(at(row, 'net total')),
        city: this.cellStr(at(row, 'city')) || null,
        customerName: this.cellStr(at(row, 'customer name')) || null,
        qty: this.cellNum(at(row, 'qty')) || null,
        createdAt: this.parseDate(this.cellStr(at(row, 'created at'))),
      });
    }

    if (!lines.length) {
      throw new BadRequestException(
        'No parcel rows were found in that statement — the sheet appears to be empty below the header.',
      );
    }

    // --- second table: cross-check only, never summed into deductions ---
    const advance = this.readAdvanceCharges(ws);
    if (advance.count) {
      const unpaidShipping = lines
        .filter((l) => !l.paid)
        .reduce((s, l) => s + l.shippingCharge, 0);
      if (Math.abs(unpaidShipping - advance.total) > 1) {
        this.logger.warn(
          `Rocket invoice ${invoiceNumber ?? '(no number)'}: advance-charges table (${advance.total}) ` +
            `doesn't match unpaid-row shipping (${unpaidShipping}) — using the main table.`,
        );
      }
    }

    const totals = lines.reduce(
      (acc, l) => {
        acc.rows += 1;
        if (l.paid) acc.paidRows += 1;
        acc.codCollected += l.codAmount;
        acc.shipping += l.shippingCharge;
        acc.fuel += l.fuelSurcharge;
        acc.tax += l.gst + l.sst + l.wht;
        return acc;
      },
      { rows: 0, paidRows: 0, codCollected: 0, shipping: 0, fuel: 0, tax: 0, deductions: 0, netPayable: 0 },
    );
    totals.deductions = totals.shipping + totals.fuel + totals.tax;
    totals.netPayable = totals.codCollected - totals.deductions;

    return {
      invoiceNumber,
      reportDate,
      // Rocket's file carries no currency column; the service fills this from the
      // matched orders (which do store one).
      currency: null,
      lines,
      totals,
    };
  }

  /** "Advance Shipping Charges Summary" — the per-parcel arrival-charge breakdown. */
  private readAdvanceCharges(ws: ExcelJS.Worksheet): { count: number; total: number } {
    let start = 0;
    for (let r = 1; r <= ws.rowCount; r++) {
      if (/advance shipping charges/i.test(this.cellStr(ws.getRow(r).getCell(1)))) {
        start = r;
        break;
      }
    }
    if (!start) return { count: 0, total: 0 };
    // Its own header sits directly under the title; charges are the 4th column.
    let count = 0;
    let total = 0;
    for (let r = start + 2; r <= ws.rowCount; r++) {
      const charge = this.cellNum(ws.getRow(r).getCell(4));
      const ref = this.cellStr(ws.getRow(r).getCell(3));
      if (!ref && !charge) break;
      if (charge) {
        count += 1;
        total += charge;
      }
    }
    return { count, total };
  }
}
