import { CourierType } from '@prisma/client';
import { ParsedInvoice } from './courier-invoice.types';

/**
 * One parser per courier. Every courier's settlement statement has a different
 * shape (column order, header row, extra summary tables, how "paid" is encoded),
 * so a shared/heuristic parser would silently mis-read money. Each parser owns
 * exactly one courier's layout and produces the normalized `ParsedInvoice`.
 *
 * A parser MUST throw a BadRequestException with a human-readable reason when the
 * uploaded file doesn't look like that courier's statement — failing loudly beats
 * importing garbage into a money reconciliation.
 */
export interface CourierInvoiceParser {
  readonly courier: CourierType;
  /** Human name of the format, shown in errors ("Rocket settlement statement"). */
  readonly formatName: string;
  /**
   * `meta.filename` is the uploaded file's original name — some couriers carry
   * their settlement/payment id there and nowhere in the sheet (e.g. Trax's
   * `sonic_payment_details_1799762.xlsx`). Optional; parsers may ignore it.
   */
  parse(buffer: Buffer, meta?: { filename?: string }): Promise<ParsedInvoice>;
}
