import * as XLSX from 'xlsx';
import type { InvoiceMapping, InvoiceStatementParser } from './invoice-parser.interface';

/**
 * Sois format: the Leopards / Trax "ACCOUNT STATEMENT" ledger (.xls/.xlsx/CSV).
 *
 * Each transaction spans TWO rows: a transaction row, then a row directly below
 * carrying the invoice/voucher number. We take only the SALES (1SI) rows —
 * NARRATION "Sales #<order> <time>", DEBIT = amount — and read the invoice
 * number off the row below. Returns (SR) and payments (2RV) are ignored, exactly
 * like the tenant's original n8n flow. Courier is auto-detected from the TITLE.
 *
 * Read with a two-pass sheet-to-json: `raw:false` (formatted text) preserves the
 * invoice number's leading zeros (e.g. "038483"); `raw:true` keeps the amount's
 * full precision (e.g. 4499.07, which the formatted text rounds).
 */
export class CourierAccountStatementParser implements InvoiceStatementParser {
  readonly id = 'courier_account_statement';
  readonly label = 'Courier account statement (Leopards / Trax)';

  parse(buffer: Buffer, filename: string): { courier: string | null; mappings: InvoiceMapping[] } {
    const isCsv = /\.csv$/i.test(filename);
    let wb: XLSX.WorkBook;
    try {
      wb = isCsv
        ? XLSX.read(buffer.toString('utf8'), { type: 'string' })
        : XLSX.read(buffer, { type: 'buffer' });
    } catch {
      return { courier: null, mappings: [] };
    }
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return { courier: null, mappings: [] };

    const txt = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: null });
    const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });

    // Courier from the TITLE row (or anywhere it appears).
    let courier: string | null = null;
    for (const r of txt) {
      if (!Array.isArray(r)) continue;
      for (const c of r) {
        const s = String(c ?? '');
        if (/LEOPARD/i.test(s)) courier = 'leopards';
        else if (/\bTRAX\b/i.test(s)) courier = 'trax';
        else if (/POSTEX/i.test(s)) courier = 'postex';
        else if (/ROCKET/i.test(s)) courier = 'rocket';
        else if (/\bM&?P\b|MUSLIM COMMERCIAL/i.test(s)) courier = 'mnp';
      }
      if (courier) break;
    }

    const num = (v: unknown): number | null => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      if (v == null) return null;
      const n = parseFloat(String(v).replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    };

    const mappings: InvoiceMapping[] = [];
    for (let i = 0; i < txt.length; i++) {
      const row = txt[i];
      if (!Array.isArray(row)) continue;
      // Find the "Sales #<order>" narration cell (column-shift tolerant).
      const narrIdx = row.findIndex((c) => /Sales\s*#\d+/i.test(String(c ?? '')));
      if (narrIdx < 0) continue;
      const m = String(row[narrIdx]).match(/Sales\s*#(\d+)/i);
      if (!m) continue;

      // Invoice number = the row directly below, its first non-empty cell.
      const below = txt[i + 1];
      let invoice: string | null = null;
      if (Array.isArray(below)) {
        const inv = below.find((c) => c != null && String(c).trim() !== '');
        invoice = inv != null ? String(inv).trim() : null;
      }
      if (!invoice) continue;

      // Amount = the DEBIT: the first numeric cell AFTER the narration (the much
      // larger running balance sits further right, so the first one is the debit).
      const rawRow = raw[i];
      let amount: number | null = null;
      if (Array.isArray(rawRow)) {
        for (let c = narrIdx + 1; c < rawRow.length; c++) {
          const a = num(rawRow[c]);
          if (a != null) {
            amount = a;
            break;
          }
        }
      }

      const dateStr = row[0] != null && String(row[0]).trim() !== '------' ? String(row[0]).trim() : null;
      mappings.push({ orderName: `#${m[1]}`, invoiceNumber: invoice, amount, date: dateStr, courier });
    }

    return { courier, mappings };
  }
}
