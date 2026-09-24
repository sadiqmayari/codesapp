import { apiFetch, api } from '@/lib/api';

export interface AgentReportRow {
  userId: number;
  name: string;
  role: string;
  confirmed: number;
  addressCorrected: number;
  cancelled: number;
  loggedContacts: number;
  customersContacted: number;
  ordersCreated: number;
  orderValue: number;
  currency: string | null;
  delivered: number;
  failed: number;
}

export interface AgentReportTotals {
  confirmed: number;
  addressCorrected: number;
  cancelled: number;
  loggedContacts: number;
  customersContacted: number;
  ordersCreated: number;
  orderValue: number;
  delivered: number;
  failed: number;
}

export interface AgentsReport {
  range: { from: string; to: string };
  rows: AgentReportRow[];
  totals: AgentReportTotals;
  currency: string | null;
}

export interface AgentActivityItem {
  action: string;
  orderName: string | null;
  orderGid: string | null;
  contactId: number | null;
  at: string;
}

function qs(params: { from?: string; to?: string }): string {
  const p = new URLSearchParams();
  if (params.from) p.set('from', params.from);
  if (params.to) p.set('to', params.to);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function getAgentsReport(params: { from?: string; to?: string }) {
  return apiFetch<AgentsReport>(`/analytics/agents-report${qs(params)}`);
}

export function getAgentActivity(userId: number, params: { from?: string; to?: string }) {
  return apiFetch<AgentActivityItem[]>(
    `/analytics/agents-report/${userId}/activity${qs(params)}`,
  );
}

/** Fetch the report CSV (auth header attached by the axios instance) and save it. */
export async function downloadAgentsReportCsv(params: { from?: string; to?: string }) {
  const res = await api.get('/analytics/agents-report/export', {
    params,
    responseType: 'blob',
  });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'agent-performance.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Log an agent contacting a customer (a call / follow-up, not a WhatsApp msg). */
export function logOrderContact(body: {
  orderGid?: string;
  orderName?: string;
  contactId?: number;
}) {
  return apiFetch<{ ok: true }>('/shopify/orders/log-contact', {
    method: 'POST',
    body,
  });
}
