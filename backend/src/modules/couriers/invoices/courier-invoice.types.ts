/**
 * Shapes shared by every courier-invoice parser.
 *
 * A courier's settlement statement is their record of what they collected and
 * what they owe the merchant. Every courier formats it differently (Rocket ships
 * a two-table XLSX; the others are unknown until we see a sample), so each gets
 * its own parser producing this ONE normalized shape — everything downstream
 * (matching, applying, the branded PDF) is courier-agnostic.
 */

/** One parcel row on the courier's statement, normalized. */
export interface ParsedInvoiceLine {
  /** Courier tracking / CN number — the primary key we match on. */
  trackingNumber: string;
  /** The merchant's own order reference as the courier recorded it (e.g. "34319"). */
  clientOrderId: string | null;
  /** The courier's raw status text for this parcel (e.g. "Delivered", "Arrival"). */
  status: string | null;
  /**
   * TRUE when the courier is remitting money for this parcel on this statement
   * (delivered + paid). Only paid lines drive shipment writes when applied.
   */
  paid: boolean;
  /** COD the courier collected from the customer (0 for undelivered/prepaid). */
  codAmount: number;
  /** Delivery charge deducted by the courier. */
  shippingCharge: number;
  /** Fuel surcharge deducted. */
  fuelSurcharge: number;
  gst: number;
  sst: number;
  /** Withholding tax deducted. */
  wht: number;
  /** What the merchant actually receives for this line (cod - deductions). */
  netTotal: number;
  city: string | null;
  customerName: string | null;
  qty: number | null;
  /** When the courier booked/created the parcel, if the statement says. */
  createdAt: Date | null;
}

/** Statement-level totals, summed by the parser from its own rows. */
export interface ParsedInvoiceTotals {
  rows: number;
  paidRows: number;
  codCollected: number;
  shipping: number;
  fuel: number;
  tax: number;
  /** shipping + fuel + tax — everything the courier deducted. */
  deductions: number;
  /** codCollected - deductions — what the courier owes the merchant. */
  netPayable: number;
}

/** A courier statement, normalized. */
export interface ParsedInvoice {
  /** The COURIER's invoice number, when the file carries one. */
  invoiceNumber: string | null;
  /** The date the courier generated the statement. */
  reportDate: Date | null;
  currency: string | null;
  lines: ParsedInvoiceLine[];
  totals: ParsedInvoiceTotals;
}

/** How a statement line resolved against our shipments. */
export type InvoiceMatchKind = 'tracking' | 'order' | 'none';

/** A parsed line plus what we found for it in CodesApp. */
export interface ReconciledLine extends ParsedInvoiceLine {
  matchedBy: InvoiceMatchKind;
  shipmentId: number | null;
  orderName: string | null;
  /** Our shipment status at reconcile time. */
  ourStatus: string | null;
  /** What we expect the courier to have collected (shopify_orders.total_outstanding). */
  expectedCod: number | null;
  /** Set when the invoice's COD differs from expectedCod — reported, never auto-fixed. */
  codMismatch: boolean;
  /** Paid line whose shipment isn't delivered yet → will be promoted on apply. */
  willPromote: boolean;
  /** Paid line not yet settled → will get courier_settled_at on apply. */
  willSettle: boolean;
  alreadySettled: boolean;
}

/** Counts + discrepancy lists shown in the preview and printed on the PDF. */
export interface ReconcileSummary {
  totalRows: number;
  paidRows: number;
  matched: number;
  unmatched: number;
  toPromote: number;
  toSettle: number;
  alreadySettled: number;
  codMismatches: number;
  /** Tracking numbers on the statement with no shipment in CodesApp. */
  unmatchedTracking: string[];
  /** Sample of COD discrepancies for the UI/PDF (capped). */
  codMismatchSamples: Array<{
    trackingNumber: string;
    orderName: string | null;
    invoiceCod: number;
    expectedCod: number | null;
  }>;
  /** Order names that will be flipped to delivered (capped sample). */
  promoteSamples: Array<{ trackingNumber: string; orderName: string | null; ourStatus: string | null }>;
  /** Live progress while the apply job runs. */
  progress?: {
    processed: number;
    total: number;
    promoted: number;
    settled: number;
    failed: number;
    finished: boolean;
    errors: string[];
  };
}
