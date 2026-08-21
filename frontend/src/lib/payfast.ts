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
  orderName: string | null;
  orderGid: string | null;
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
  batches: number;
  grandGross: number;
  grandFees: number;
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

export function payfastStatementPdf(id: number) {
  return apiFetch<{ url: string }>(`/payfast/settlements/${id}/pdf`, { method: 'POST' });
}
