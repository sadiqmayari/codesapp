import { apiFetch, postMultipart } from '@/lib/api';

export interface PayfastSettlement {
  id: number;
  gateway: string;
  merchantId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  currency: string | null;
  sourceTxnUrl: string | null;
  sourceSummaryUrl: string | null;
  pdfUrl: string | null;
  status: 'parsed' | 'applying' | 'applied' | 'failed';
  totalTxns: number;
  matchedTxns: number;
  gross: number | null;
  fees: number | null;
  whtSt: number | null;
  received: number | null;
  appliedAt: string | null;
  erpPostedAt?: string | null;
  erpPostedBy?: string | null;
  createdAt: string;
}

export interface PayfastTxnRow {
  paymentId: string;
  transactionId: string | null;
  issuer: string;
  settlementDate: string | null;
  amount: number;
  merchantAmount: number;
  fee: number;
  whtSt: number;
  /** WHT actually withheld for this txn (0 unless its batch carries withholding). */
  actualWht: number;
  orderName: string | null;
  orderGid: string | null;
  /** Courier invoice number stamped on the order (invoice-import), when enabled. */
  courierInvoiceNumber?: string | null;
  /** This order was already reconciled by an earlier statement (overlap). */
  alreadyReconciled?: boolean;
}

export interface PayfastBatch {
  settlementDate: string | null;
  bank: string;
  rail: 'card' | 'wallet';
  count: number;
  gross: number;
  fees: number;
  whtSt: number;
  received: number;
  summaryMatched: boolean | null;
  txns: PayfastTxnRow[];
}

export interface PayfastSummary {
  totalTxns: number;
  matchedTxns: number;
  unmatchedTxns: number;
  unmatchedSamples: Array<{ paymentId: string; amount: number; issuer: string }>;
  /** Matched orders an earlier statement already reconciled (overlap warning). */
  alreadyReconciledTxns?: number;
  alreadyReconciledSamples?: Array<{ paymentId: string; amount: number; orderName: string }>;
  batches: number;
  grandGross: number;
  grandFees: number;
  grandMdr: number;
  grandGst: number;
  grandWhtSt: number;
  grandReceived: number;
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

export interface PayfastPreview extends PayfastSettlement {
  batches: PayfastBatch[];
  summary: PayfastSummary;
}

/** Upload PayFast's transaction export (+ optional settlement summary) → preview. */
export function uploadPayfastSettlement(files: File[]) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  return postMultipart<PayfastPreview>('/payfast/settlements/upload', fd);
}

export function applyPayfastSettlement(id: number) {
  return apiFetch<{ started: boolean; settlementId: number; total: number }>(
    `/payfast/settlements/${id}/apply`,
    { method: 'POST' },
  );
}

/** One settlement + its batches (also the apply-progress poll). */
export function getPayfastSettlement(id: number) {
  return apiFetch<PayfastPreview>(`/payfast/settlements/${id}`);
}

export function listPayfastSettlements() {
  return apiFetch<PayfastSettlement[]>('/payfast/settlements');
}

/** Mark/unmark a PayFast statement as posted into the tenant's ERP. */
export function setPayfastErpPosted(id: number, posted: boolean) {
  return apiFetch<{ ok: boolean; posted: boolean }>(
    `/payfast/settlements/${id}/erp-posted`,
    { method: 'PATCH', body: { posted } },
  );
}

export function payfastStatementPdf(id: number) {
  return apiFetch<{ url: string }>(`/payfast/settlements/${id}/pdf`, { method: 'POST' });
}

/** Manually link an unmatched transaction to an order by order number. */
export function matchPayfastTxn(id: number, paymentId: string, orderNumber: string) {
  return apiFetch<{ matched: boolean; orderName: string; reconciled: boolean; status: string }>(
    `/payfast/settlements/${id}/match`,
    { method: 'POST', body: { paymentId, orderNumber } },
  );
}

/** Delete a PayFast settlement (owner/admin) — un-reconciles its orders. */
export function deletePayfastSettlement(id: number) {
  return apiFetch<{ deleted: boolean; unsettled: number }>(
    `/payfast/settlements/${id}`,
    { method: 'DELETE' },
  );
}
