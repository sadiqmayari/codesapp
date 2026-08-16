import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { CourierType } from '@prisma/client';
import {
  CourierInvoiceParser,
} from './courier-invoice-parser.interface';
import { DeductionComponent, ParsedInvoice, ParsedInvoiceLine } from './courier-invoice.types';

/**
 * Leopards "Cheque Detail" settlement — an HTML document saved with an .xls
 * extension (NOT a real spreadsheet), verified against a real Sois file
 * (Invoice 20260811-3309426, cheque IBKI3309426, net PKR 614,308.00).
 *
 * Structure (three regions):
 *   - Meta: Invoice No., Payment/Cheque No., Amount, period.
 *   - COD collection table — the DELIVERED parcels: Booking Date | Order Id | CN# |
 *     Destination | COD Amount | WHT.IT 2% | WHT.ST 2% | Gross Collected Amount.
 *   - Delivery charges table — a DIFFERENT/overlapping parcel set: … | Net Charges |
 *     Fuel | Gst | Total. These are aggregate deductions, not per-delivered-parcel.
 *   - SUMMARY: Gross payable − Total Billed Charged − adjustments = Net Payable.
 *
 * Money model (verified to the cheque):
 *   - Delivered parcels remit COD; WHT.IT 2% (→`wht`) + WHT.ST 2% (→`sst`) retained.
 *     Gross Collected = COD − IT − ST.
 *   - Delivery charges (freight+fuel) and their GST are SETTLEMENT-LEVEL (charged on
 *     a broader set), carried as `extraDeductions`, NOT on delivered lines.
 *   - Net Payable = Gross payable − delivery charges − GST (± summary adjustments).
 *
 * IMPORTANT: parse with a direct <tr>/<td> extractor. `pandas.read_html` (and some
 * table-inference readers) DOUBLE this nested-table HTML — every value comes out 2×.
 * We anchor totals to the SUMMARY's authoritative "Net Payable Amount".
 */
@Injectable()
export class LeopardsInvoiceParser implements CourierInvoiceParser {
  readonly courier: CourierType = 'leopards';
  readonly formatName = 'Leopards Cheque Detail report (.xls / HTML)';
  private readonly logger = new Logger(LeopardsInvoiceParser.name);

  private num(s: string): number {
    const x = parseFloat(String(s ?? '').replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(x) ? x : 0;
  }
  private strip(s: string): string {
    return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  }
  private cellsOf(tr: string): string[] {
    return (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map((c) => this.strip(c));
  }
  private parseDate(raw: string): Date | null {
    const s = (raw ?? '').replace(/,/g, '').trim();
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  async parse(buffer: Buffer): Promise<ParsedInvoice> {
    const html = buffer.toString('latin1');
    if (!/Gross Collected Amount|Net Payable Amount|Cheque detail/i.test(html)) {
      throw new BadRequestException(
        "This doesn't look like a Leopards Cheque Detail report — expected a 'Gross Collected Amount' " +
          "and 'Net Payable Amount'. Check you picked the right courier and file.",
      );
    }
    const flat = this.strip(html);

    // --- meta ---
    const invoiceNumber = flat.match(/Invoice No\.?:?\s*([A-Za-z0-9-]+)/i)?.[1] ?? null;
    const chequeNumber = flat.match(/CHEQUE NO\.?:?\s*([A-Za-z0-9]+)/i)?.[1] ?? null;
    const summaryNet = flat.match(/Net Payable Amount\s*:?\s*([\d.,]+)/i)?.[1];
    const netFromSummary = summaryNet ? this.num(summaryNet) : null;
    const reportDate = this.parseDate(flat.match(/Payment Date:?\s*([\d/.\-]+)/i)?.[1] ?? '');

    // --- tables (direct row/cell parse — DO NOT use pandas-style inference) ---
    const trs = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
    let mode: 'cod' | 'chg' | null = null;
    const codRows: string[][] = [];
    const chgRows: string[][] = [];
    for (const tr of trs) {
      const cs = this.cellsOf(tr);
      const j = cs.join(' | ');
      if (/COD Amount/i.test(j) && /Gross Collected/i.test(j)) { mode = 'cod'; continue; }
      if (/Net Charges/i.test(j) && /Total/i.test(j)) { mode = 'chg'; continue; }
      if (/SUMMARY|Gross payable/i.test(j)) mode = null;
      if (mode === 'cod' && cs.length >= 8 && /^KI\d+/i.test(cs[2] || '')) codRows.push(cs);
      if (mode === 'chg' && cs.length >= 11 && /^KI\d+/i.test(cs[2] || '')) chgRows.push(cs);
    }
    if (!codRows.length) {
      throw new BadRequestException('No delivered-parcel rows were found in that Leopards report.');
    }

    // --- delivered lines (COD collection table) ---
    const lines: ParsedInvoiceLine[] = codRows.map((r) => {
      const cod = this.num(r[4]);
      const it = this.num(r[5]); // WHT.IT 2%
      const st = this.num(r[6]); // WHT.ST 2%
      return {
        trackingNumber: (r[2] || '').trim(),
        clientOrderId: (r[1] || '').replace(/[^\d]/g, '') || null,
        status: 'Delivered',
        paid: true,
        codAmount: cod,
        shippingCharge: 0, // delivery charges are settlement-level, not per delivered parcel
        fuelSurcharge: 0,
        gst: 0,
        wht: it,
        sst: st,
        netTotal: this.num(r[7]), // Gross Collected Amount
        city: (r[3] || '').trim() || null,
        customerName: null,
        qty: null,
        createdAt: this.parseDate(r[0]),
      };
    });

    // --- settlement-level delivery charges (a different/overlapping parcel set) ---
    const freightFuel = chgRows.reduce((s, r) => s + this.num(r[7]) + this.num(r[8]), 0); // Net + Fuel
    const deliveryGst = chgRows.reduce((s, r) => s + this.num(r[9]), 0); // Gst

    const codCollected = lines.reduce((s, l) => s + l.codAmount, 0);
    const it = lines.reduce((s, l) => s + l.wht, 0);
    const st = lines.reduce((s, l) => s + l.sst, 0);
    const computed = it + st + freightFuel + deliveryGst;

    let netPayable: number;
    let deductions: number;
    const extraDeductions: DeductionComponent[] = [
      { label: 'Delivery charges', sublabel: `freight + fuel (${chgRows.length} parcels)`, amount: freightFuel },
      { label: 'GST', sublabel: '15% on charges', amount: deliveryGst },
    ];
    if (netFromSummary != null && netFromSummary > 0) {
      netPayable = netFromSummary;
      deductions = codCollected - netPayable;
      const adjustment = Math.round((deductions - computed) * 100) / 100;
      if (Math.abs(adjustment) > 1) {
        extraDeductions.push({ label: 'Adjustments / other', amount: adjustment });
        this.logger.warn(
          `Leopards ${invoiceNumber ?? ''}: summary adjustments of ${adjustment} (net ${netPayable}).`,
        );
      }
    } else {
      deductions = computed;
      netPayable = codCollected - deductions;
    }

    return {
      invoiceNumber,
      chequeNumber,
      reportDate,
      currency: 'PKR',
      lines,
      totals: {
        rows: lines.length,
        paidRows: lines.length,
        codCollected,
        shipping: 0,
        fuel: 0,
        tax: it + st,
        deductions,
        netPayable,
      },
      extraDeductions: extraDeductions.filter((e) => e.amount > 0),
    };
  }
}
