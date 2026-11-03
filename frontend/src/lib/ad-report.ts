import { apiFetch } from '@/lib/api';

export interface MetaAdsSchedule {
  intervalMinutes: number | null;
  effectiveMinutes: number;
  defaultMinutes: number;
  minMinutes: number;
  maxMinutes: number;
  lastRunAt: string | null;
  nextDueAt: string | null;
}

export function getMetaAdsSchedule() {
  return apiFetch<MetaAdsSchedule>('/meta-ads/sync-schedule');
}
export function setMetaAdsSchedule(intervalMinutes: number | null) {
  return apiFetch<{ intervalMinutes: number | null }>('/meta-ads/sync-schedule', {
    method: 'PUT',
    body: { intervalMinutes },
  });
}
export function triggerMetaAdsSync() {
  return apiFetch<{ started: true }>('/meta-ads/sync', { method: 'POST' });
}
export function backfillAttribution() {
  return apiFetch<{ enqueued: number }>('/meta-ads/attribution/backfill', {
    method: 'POST',
  });
}
export function syncCogs() {
  return apiFetch<{ started: true }>('/meta-ads/cogs/sync', { method: 'POST' });
}
export function backfillFinancials() {
  return apiFetch<{ started: true }>('/meta-ads/financials/backfill', {
    method: 'POST',
  });
}

// ── Ad Report v3 blended summary ──────────────────────────────────────────
export interface FunnelStage {
  orders: number;
  gross: number;
  value?: number;
}
export interface AdsSummary {
  range: { from: string; to: string; spanDays: number };
  currency: string | null;
  generatedAt: string;
  summary: {
    grossSales: number;
    netSales: number;
    discounts: number;
    adSpend: number;
    mer: number | null;
    blendedRoasGross: number | null;
    blendedRoasNet: number | null;
    metaRoas: number | null;
    cogs: number;
    grossProfit: number;
    grossMargin: number | null;
    shippingCost: number;
    feesCost: number;
    netProfit: number;
    netMargin: number | null;
    contributionProfit: number;
    orders: number;
    aov: number | null;
    newCustomers: number;
    newCustomerRoas: number | null;
    ncac: number | null;
  };
  funnel: {
    placed: FunnelStage;
    cancelled: FunnelStage;
    confirmed: FunnelStage;
    fulfilled: FunnelStage;
    inTransit: FunnelStage;
    delivered: FunnelStage;
    returned: FunnelStage;
    net: FunnelStage;
  };
  waterfall: { label: string; value: number; kind: 'abs' | 'delta' }[];
  trend: { date: string; gross: number; net: number; spend: number; metaValue: number }[];
}

export function getAdsSummary(params: { from: string; to: string }) {
  return apiFetch<AdsSummary>('/analytics/ads-summary', { params });
}

export const SYNC_INTERVAL_OPTIONS: Array<[number | null, string]> = [
  [null, 'Auto: 4 hours (default)'],
  [30, 'Auto: 30 min'],
  [60, 'Auto: 1 hour'],
  [120, 'Auto: 2 hours'],
  [240, 'Auto: 4 hours'],
  [360, 'Auto: 6 hours'],
  [720, 'Auto: 12 hours'],
  [1440, 'Auto: Once a day'],
];
