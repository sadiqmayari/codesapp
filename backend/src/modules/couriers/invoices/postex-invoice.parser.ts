import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { CourierType } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import { CourierInvoiceParser } from './courier-invoice-parser.interface';
import { ParsedInvoice, ParsedInvoiceLine } from './courier-invoice.types';

/**
 * PostEx "Cash Payment Receipt" transactions export (.csv), verified against a
 * real Sois file (CPR-GQ01G905532, 270 parcels — 247 delivered / 23 returned).
 *
 * PostEx ships the settlement as a PDF *and* a CSV. The CSV is what we read: it's
 * structured, and unlike the PDF it carries `ORDER_REF_NUMBER`, so we can match on
 * both tracking number and Shopify order name.
 *
 * Columns (header row 1):
 *   ORDER_REF_NUMBER, TRACKING_NUMBER, WEIGHT (Kg), ORDER_PICKUP_DATE, ORIGIN_CITY,
 *   DELIVERY_CITY, STATUS, COD_AMOUNT, UPFRONT_AMOUNT, RESERVE_AMOUNT, D/R Date,
 *   SHIPPING_CHARGES, UPFRONT_CHARGES, GST, DEDUCTION (4%), NET_AMOUNT
 *
 * Money model (all verified against the CPR summary):
 *   - Only DELIVERED parcels remit COD (COD_AMOUNT on a Return is the order value,
 *     NOT collected) — so codCollected sums PAID rows only.
 *   - Every parcel (delivered AND returned) is charged SHIPPING_CHARGES + GST.
 *   - GST is 15% on the shipping/service charge.
 *   - "DEDUCTION (4%)" is 4% of COD, and is really TWO taxes: Advance Income Tax 2%
 *     + Withholding Sales Tax 2%. The CSV gives them lumped, so we split in half
 *     (each == 2% of COD) and keep the sum exact. We map AIT → `wht`, WST → `sst`.
 *   - deductions = shipping + GST + AIT + WST ; netPayable = codCollected − deductions.
 *
 * The CSV carries NO invoice/CPR number and no report date — the service resolves
 * the invoice number (user-entered CPR, else a content hash), and we set the report
 * date to the latest D/R (settlement) date in the file.
 */
@Injectable()
export class PostexInvoiceParser implements CourierInvoiceParser {
  readonly courier: CourierType = 'postex';
  readonly formatName = 'PostEx CPR transactions export (.csv)';
  private readonly logger = new Logger(PostexInvoiceParser.name);

  private num(v: unknown): number {
    const n = parseFloat(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  /** "#30376-Complain" / "# 30376" → "30376"; keeps the numeric order core only. */
  private normalizeRef(raw: unknown): string | null {
    const m = String(raw ?? '').match(/#?\s*(\d{3,})/);
    return m ? m[1] : null;
  }

  private parseDate(raw: unknown): Date | null {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    const d = new Date(s.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  async parse(buffer: Buffer): Promise<ParsedInvoice> {
    let rows: Record<string, string>[];
    try {
      rows = parse(buffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
      });
    } catch {
      throw new BadRequestException(
        'That file could not be read as a CSV. Upload the PostEx CPR transactions export (.csv), unmodified.',
      );
    }
    if (!rows.length) {
      throw new BadRequestException('The PostEx CSV has no data rows.');
    }

    // Resolve columns by a normalized (lowercased, alphanumeric-only) header key,
    // so minor spacing/case drift in PostEx's export doesn't break the parser.
    const headerKeys = Object.keys(rows[0]);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const keyMap = new Map(headerKeys.map((k) => [norm(k), k]));
    const K = (...aliases: string[]): string | null => {
      for (const a of aliases) {
        const hit = keyMap.get(norm(a));
        if (hit) return hit;
      }
      return null;
    };

    const cTracking = K('TRACKING_NUMBER', 'tracking');
    const cStatus = K('STATUS');
    const cCod = K('COD_AMOUNT');
    const cNet = K('NET_AMOUNT');
    if (!cTracking || !cStatus || !cCod || !cNet) {
      throw new BadRequestException(
        "This doesn't look like a PostEx CPR export — expected TRACKING_NUMBER, STATUS, " +
          'COD_AMOUNT and NET_AMOUNT columns. Check you picked the right courier and file.',
      );
    }
    const cRef = K('ORDER_REF_NUMBER', 'order_ref');
    const cShip = K('SHIPPING_CHARGES', 'shipping');
    const cGst = K('GST');
    const cDed = K('DEDUCTION (4%)', 'DEDUCTION', 'deduction4');
    const cCity = K('DELIVERY_CITY', 'delivery_city');
    const cPickup = K('ORDER_PICKUP_DATE', 'pickup_date');
    const cDr = K('D/R Date', 'dr_date', 'drdate');

    const lines: ParsedInvoiceLine[] = [];
    let reportDate: Date | null = null;

    for (const r of rows) {
      const tracking = String(r[cTracking] ?? '').trim();
      const status = (cStatus ? String(r[cStatus] ?? '') : '').trim() || null;
      if (!tracking && !status) continue; // stray blank row

      const paid = /deliver/i.test(status ?? '');
      const ded = cDed ? this.num(r[cDed]) : 0;
      // Split the lumped 4% into its two 2% components, keeping the sum exact.
      const ait = Math.round(ded * 0.5 * 100) / 100; // Advance Income Tax 2%
      const wst = Math.round((ded - ait) * 100) / 100; // Withholding Sales Tax 2%

      const drDate = cDr ? this.parseDate(r[cDr]) : null;
      if (drDate && (!reportDate || drDate > reportDate)) reportDate = drDate;

      lines.push({
        trackingNumber: tracking,
        clientOrderId: cRef ? this.normalizeRef(r[cRef]) : null,
        status,
        paid,
        // COD is only collected on delivered parcels; a Return's COD_AMOUNT is the
        // order value the courier did NOT collect.
        codAmount: paid ? this.num(r[cCod]) : 0,
        shippingCharge: cShip ? this.num(r[cShip]) : 0,
        fuelSurcharge: 0,
        gst: cGst ? this.num(r[cGst]) : 0,
        sst: wst, // Withholding Sales Tax (2%)
        wht: ait, // Advance Income Tax (2%)
        netTotal: this.num(r[cNet]),
        city: cCity ? String(r[cCity] ?? '').trim() || null : null,
        customerName: null,
        qty: null,
        createdAt: cPickup ? this.parseDate(r[cPickup]) : null,
      });
    }

    if (!lines.length) {
      throw new BadRequestException('No parcel rows were found in that PostEx CSV.');
    }

    const totals = lines.reduce(
      (acc, l) => {
        acc.rows += 1;
        if (l.paid) {
          acc.paidRows += 1;
          acc.codCollected += l.codAmount;
        }
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
      // The CSV has no CPR number — the service supplies the user-entered one or a
      // content hash for the dedup key.
      invoiceNumber: null,
      reportDate,
      currency: 'PKR',
      lines,
      totals,
    };
  }
}
