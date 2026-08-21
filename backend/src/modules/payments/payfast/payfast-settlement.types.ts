/**
 * Shapes for PayFast settlement reconciliation. The tenant uploads PayFast's
 * transaction export (one row per online payment) and, optionally, the
 * settlement summary (one row per payout batch). We resolve each transaction to
 * a Shopify order via `gateway_payment_ref` (== the file's `Order_Id`), group
 * transactions into payout batches (settlement date + rail/bank), and emit a
 * consolidated statement.
 */

/** One transaction from the PayFast transaction export, normalized. */
export interface PayfastTxn {
  /** PayFast `Order_Id` — equals the order's SALE transaction paymentId. Join key. */
  paymentId: string;
  /** PayFast internal transaction UUID (informational). */
  transactionId: string | null;
  /** Payment method (VISA / MASTER / EasyPaisa / JazzCash / bank / RAAST …). */
  issuer: string;
  txnDate: Date | null;
  /** Date-only payout day (the batching key). ISO yyyy-mm-dd string. */
  settlementDate: string | null;
  /** Gross charged to the customer (Transaction_Amount). */
  amount: number;
  /** Merchant amount after MDR+GST (Merchant_Amount) — what's paid out. */
  merchantAmount: number;
  /** MDR + GST-on-MDR (Total_MDR_Amount) — the combined charge. */
  fee: number;
  /** MDR only (the processing fee, MDR_Amount). */
  mdr: number;
  /** GST charged on the MDR (Tax). fee = mdr + gst. */
  gst: number;
  /** Withholding income + sales tax (Total_Tax_Amount). */
  whtSt: number;
}

/** One payout batch from the settlement summary file (cross-check + bank label). */
export interface PayfastSummaryRow {
  settlementDate: string | null; // yyyy-mm-dd
  bank: string;
  count: number;
  gross: number;
  merchant: number;
}

export interface ParsedPayfast {
  merchantId: string | null;
  periodStart: string | null; // yyyy-mm-dd
  periodEnd: string | null;
  currency: string;
  txns: PayfastTxn[];
  summaryRows: PayfastSummaryRow[]; // [] when no summary file uploaded
  totals: {
    txns: number;
    gross: number;
    fees: number;
    mdr: number;
    gst: number;
    whtSt: number;
    received: number;
  };
}

/** One transaction after order resolution — what a statement line shows. */
export interface ReconciledPayfastTxn extends PayfastTxn {
  /** Resolved Shopify order name (e.g. "#35125"), or null if unmatched. */
  orderName: string | null;
  orderGid: string | null;
}

/** One payout batch = one settlement (date + rail/bank) with its member orders. */
export interface PayfastBatch {
  settlementDate: string | null;
  bank: string; // resolved from the summary when available, else the rail label
  rail: 'card' | 'wallet';
  count: number;
  gross: number;
  fees: number;
  whtSt: number;
  received: number;
  /** Cross-check against the summary file (null when no summary uploaded). */
  summaryMatched: boolean | null;
  txns: ReconciledPayfastTxn[];
}

export interface PayfastReconcileSummary {
  totalTxns: number;
  matchedTxns: number;
  unmatchedTxns: number;
  /** Sample of unmatched paymentIds (for the preview). */
  unmatchedSamples: Array<{ paymentId: string; amount: number; issuer: string }>;
  batches: number;
  /** Grand totals across all batches. */
  grandGross: number;
  grandFees: number;
  grandMdr: number;
  grandGst: number;
  grandWhtSt: number;
  grandReceived: number;
  /** Present after apply. */
  progress?: {
    processed: number;
    total: number;
    reconciled: number;
    markedPaid: number;
    failed: number;
    finished: boolean;
    errors: string[];
  };
}
