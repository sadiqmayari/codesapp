/** One (order → courier invoice number) mapping extracted from a statement. */
export interface InvoiceMapping {
  /** Order number WITH the leading '#', e.g. '#39533' (matches order_name). */
  orderName: string;
  /** Courier invoice / voucher number, kept as a string (leading zeros matter). */
  invoiceNumber: string;
  /** Invoice amount (raw, full precision) when the file carries it. */
  amount: number | null;
  /** Invoice date (ISO or parseable string) when present. */
  date: string | null;
  /** Courier this statement is for, if the parser can tell. */
  courier: string | null;
}

/**
 * A per-tenant statement parser. Each tenant's courier/accounting export is a
 * different format, so a parser is CODED per format and selected by the
 * super-admin via `companies.invoice_import_format` (= this `id`).
 */
export interface InvoiceStatementParser {
  /** Format id — must equal the tenant's `invoice_import_format`. */
  readonly id: string;
  /** Human label for the super-admin format dropdown. */
  readonly label: string;
  /** Parse one uploaded file into (order → invoice#) mappings. */
  parse(buffer: Buffer, filename: string): { courier: string | null; mappings: InvoiceMapping[] };
}
