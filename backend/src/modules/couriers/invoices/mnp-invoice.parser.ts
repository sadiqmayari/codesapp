import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { CourierType } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { CourierInvoiceParser } from './courier-invoice-parser.interface';
import { DeductionComponent, ParsedInvoice, ParsedInvoiceLine } from './courier-invoice.types';

/**
 * M&P (Mulphilog) "IBFT Consignment Report" COD settlement (.xlsx), verified to the
 * rupee against a real Sois file (242 consignments, Payment ID 20261532521) and its
 * portal Payment Summary (COD 755,889 − Total Invoice 36,590 − WH Tax 29,155 =
 * Net Payable 690,044).
 *
 * ONE flat sheet, no summary/totals block. Header row (cols A..T):
 *   Consignment Number | Order Ref No | Booking Date | RR Date | Consignee |
 *   Location Name | Location ID | Branch | Zone | Origin | Destination | Weight |
 *   CN Status | COD Amount | Shipping Charges | Invoice Amount | Taxable Amount |
 *   Income Tax Amount | Sales Tax Amount | WTH Tax
 *
 * Money model — the two things that make the net match the portal:
 *
 *   1. M&P bills the delivery service (Shipping + 10% Fuel + 15% GST) on EVERY
 *      parcel, but the per-row `Invoice Amount` column is populated ONLY on
 *      delivered/paid rows — it omits the shipping charged on undelivered/returned
 *      legs. Summing that column under-counts deductions by ~₨9.6k. So we IGNORE it
 *      for totals and recompute the charge from the `Shipping Charges` column (which
 *      IS complete across all rows and matches the portal exactly) × a fixed
 *      multiplier. The multiplier is SELF-CALIBRATED from the file: on any row that
 *      carries BOTH Shipping and Invoice Amount, Invoice/Shipping == 1.265 (= 1.10
 *      fuel × 1.15 GST). We read it off the data and fall back to 1.265 only if no
 *      such row exists, so a future rate change is picked up automatically.
 *      Per parcel: charge = Shipping × mult ; fuel = 10% of Shipping ;
 *      gst = 15% of (Shipping + fuel). Fuel + GST ride as `extraDeductions` (not
 *      per-paid-parcel), mirroring Leopards.
 *
 *   2. `paid` (= delivered → promote + flow) is `CN Status === 'DELIVERED'` (EXACT —
 *      a loose /deliver/ would catch "UNDELIVERED") OR `COD Amount > 0`. The file has
 *      a parcel marked UNDELIVERED that still remitted ₨4,499 COD with full tax — the
 *      cash column is the truth, so COD>0 overrides the status. The status side also
 *      flows the prepaid-delivered parcels (status DELIVERED, COD 0) a COD-only rule
 *      would drop. COD is only *settled* where there's cash (codAmount drives the
 *      downstream mark-paid), so prepaid parcels are marked delivered but not paid.
 *
 * WTH Tax (col T) already bundles the 2% income + 2% sales withholding (= Income +
 * Sales columns); we take it from WTH directly and don't re-add the split.
 *
 * netPayable = Σ COD − (Σ Shipping × mult) − Σ WTH. The portal's own summary carries
 * a ~₨100 rounding against its own line items — that residual is left for the
 * tenant's manual settlement `adjustment`, not forced here.
 *
 * The file carries no invoice number; we derive `MNP-YYYY-MM-DD` from the filename
 * date (IBFTConsignmentReport_2026-10-03.xlsx), falling back to the content hash in
 * the service's resolveInvoiceNumber when absent.
 */
@Injectable()
export class MnpInvoiceParser implements CourierInvoiceParser {
  readonly courier: CourierType = 'mnp';
  readonly formatName = 'M&P IBFT Consignment Report (.xlsx)';
  private readonly logger = new Logger(MnpInvoiceParser.name);

  /** Fuel 10% + GST 15% on (shipping + fuel) == shipping × 1.265. */
  private static readonly FALLBACK_MULT = 1.1 * 1.15;
  private static readonly FUEL_RATE = 0.1;
  private static readonly GST_RATE = 0.15;

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
        'That file could not be read as an Excel workbook (.xlsx). Upload the M&P IBFT Consignment Report, unmodified.',
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
      if (labels['consignmentnumber'] && labels['codamount'] && labels['cnstatus']) {
        headerRow = r;
        Object.assign(headerIndex, labels);
        break;
      }
    }
    if (!headerRow) {
      throw new BadRequestException(
        "This doesn't look like an M&P IBFT Consignment Report — no header row with 'Consignment Number', " +
          "'COD Amount' and 'CN Status' was found. Check you picked the right courier and file.",
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

    const cCn = col('Consignment Number');
    const cOrder = col('Order Ref No');
    const cDate = col('Booking Date');
    const cName = col('Consignee');
    const cCity = col('Destination', 'Location Name');
    const cStatus = col('CN Status');
    const cCod = col('COD Amount');
    const cShip = col('Shipping Charges');
    const cInvoice = col('Invoice Amount');
    const cWht = col('WTH Tax');

    // --- parcel table ---
    const raw: Array<{ line: ParsedInvoiceLine; shipping: number; invoiceCol: number }> = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cn = this.cellStr(at(row, cCn));
      if (!cn) continue;

      const shipping = this.cellNum(at(row, cShip));
      const cod = this.cellNum(at(row, cCod));
      const wht = this.cellNum(at(row, cWht));
      const invoiceCol = this.cellNum(at(row, cInvoice));
      const statusRaw = this.cellStr(at(row, cStatus));
      // A parcel is DELIVERED (→ promote + flow) when M&P's status says so, OR when
      // it carries COD (M&P mislabels some collected parcels "UNDELIVERED" but the
      // cash column is the truth). EXACT 'DELIVERED' match — a loose /deliver/ would
      // wrongly catch "UNDELIVERED". This also flows the prepaid-delivered parcels
      // (status DELIVERED, COD 0) that a COD-only rule was dropping. COD is still
      // only settled where there's cash (codAmount drives mark-paid downstream).
      const delivered = statusRaw.trim().toUpperCase() === 'DELIVERED' || cod > 0;
      raw.push({
        shipping,
        invoiceCol,
        line: {
          trackingNumber: cn,
          clientOrderId: this.normalizeRef(this.cellStr(at(row, cOrder))),
          status: statusRaw || null,
          paid: delivered,
          codAmount: cod,
          shippingCharge: shipping,
          fuelSurcharge: 0, // set below once the multiplier is known
          gst: 0, // set below
          wht, // WTH col already bundles income + sales withholding
          sst: 0, // folded into wht by M&P's WTH column
          netTotal: 0, // set below
          city: this.cellStr(at(row, cCity)) || null,
          customerName: this.cellStr(at(row, cName)) || null,
          qty: null,
          createdAt: this.parseDate(this.cellStr(at(row, cDate))),
        },
      });
    }
    if (!raw.length) {
      throw new BadRequestException('No consignment rows were found in that M&P report.');
    }

    // --- self-calibrate the service multiplier from a row carrying both values ---
    const sample = raw.find((x) => x.shipping > 0 && x.invoiceCol > 0);
    const mult = sample ? sample.invoiceCol / sample.shipping : MnpInvoiceParser.FALLBACK_MULT;
    if (!sample) {
      this.logger.warn(
        `M&P ${meta?.filename ?? '(no filename)'}: no row with both Shipping + Invoice Amount — ` +
          `falling back to multiplier ${MnpInvoiceParser.FALLBACK_MULT}.`,
      );
    }

    // --- per-parcel fuel/gst + net, charged on EVERY parcel's shipping ---
    let codCollected = 0;
    let paidRows = 0;
    let shippingTotal = 0;
    let fuelTotal = 0;
    let gstTotal = 0;
    let whtTotal = 0;
    for (const { line, shipping } of raw) {
      const fuel = shipping * MnpInvoiceParser.FUEL_RATE;
      const gst = (shipping + fuel) * MnpInvoiceParser.GST_RATE;
      line.fuelSurcharge = fuel;
      line.gst = gst;
      line.netTotal = line.codAmount - (shipping + fuel + gst) - line.wht;

      codCollected += line.codAmount;
      if (line.paid) paidRows += 1;
      shippingTotal += shipping;
      fuelTotal += fuel;
      gstTotal += gst;
      whtTotal += line.wht;
    }

    const invoiceCharge = shippingTotal + fuelTotal + gstTotal; // == shippingTotal × mult
    const deductions = invoiceCharge + whtTotal;
    const netPayable = codCollected - deductions;

    // Cross-check: Σ(Shipping) × calibrated mult should equal our fuel+gst build.
    const grossed = shippingTotal * mult;
    if (Math.abs(grossed - invoiceCharge) > 1) {
      this.logger.warn(
        `M&P ${meta?.filename ?? ''}: shipping×mult ${grossed.toFixed(2)} != ` +
          `shipping+fuel+gst ${invoiceCharge.toFixed(2)} (mult ${mult.toFixed(4)}).`,
      );
    }

    const lines = raw.map((x) => x.line);
    const extraDeductions: DeductionComponent[] = [
      { label: 'Fuel surcharge', sublabel: '10% of shipping', amount: fuelTotal },
      { label: 'GST', sublabel: '15% on shipping + fuel', amount: gstTotal },
    ].filter((e) => e.amount > 0);

    // Invoice number: derive MNP-YYYY-MM-DD from the filename date; else let the
    // service fall back to a content hash.
    const dateInName = (meta?.filename ?? '').match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
    const invoiceNumber = dateInName ? `MNP-${dateInName[1]}-${dateInName[2]}-${dateInName[3]}` : null;

    return {
      invoiceNumber,
      reportDate: dateInName ? this.parseDate(`${dateInName[1]}-${dateInName[2]}-${dateInName[3]}`) : null,
      currency: 'PKR',
      lines,
      totals: {
        rows: lines.length,
        paidRows,
        codCollected,
        shipping: shippingTotal,
        fuel: fuelTotal,
        tax: gstTotal + whtTotal,
        deductions,
        netPayable,
      },
      extraDeductions,
    };
  }
}
