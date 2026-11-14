import { apiFetch } from '@/lib/api';

/** Growth module API (owner/admin). Every read takes tenant-local days (YYYY-MM-DD). */

export type Model = 'first' | 'last' | 'lnd' | 'linear' | 'position' | 'decay';
export type CompareMode = 'prev' | 'yoy' | 'none';

export interface GrowthQuery {
  from: string;
  to: string;
  compare?: CompareMode;
  storeId?: number;
  model?: Model;
  win?: number;
}

export const MODEL_LABEL: Record<Model | 'platform', string> = {
  first: 'First click',
  last: 'Last click',
  lnd: 'Last non-direct',
  linear: 'Linear',
  position: 'Position-based',
  decay: 'Time decay',
  platform: 'Platform-reported',
};

export const CHANNEL_COLOR: Record<string, string> = {
  meta_ads: '#1877f2',
  whatsapp_ctwa: '#25d366',
  google_ads: '#ea4335',
  tiktok_ads: '#111827',
  snap_ads: '#eab308',
  influencer: '#7c3aed',
  email_sms: '#0891b2',
  organic_search: '#64748b',
  organic_social: '#a855f7',
  referral: '#d97706',
  direct: '#94a3b8',
  unknown: '#cbd5e1',
};

export interface MetricDef {
  id: string;
  label: string;
  unit: 'money' | 'ratio' | 'pct' | 'count' | 'days';
  higherIsBetter: boolean;
  formula: string;
  description: string;
}

export interface Catalog {
  metrics: MetricDef[];
  models: Model[];
  windows: number[];
  channels: Record<string, string>;
}

export interface KpiPair {
  value: number | null;
  prev: number | null;
}

export interface SeriesPoint {
  date: string;
  gross: number;
  net: number;
  realized: number;
  expected: number;
  spend: number;
  platformValue: number;
  orders: number;
  newCustomers: number;
  roas: number | null;
  prevNet: number | null;
  prevSpend: number | null;
}

export interface ChannelRow {
  channel: string;
  label: string;
  orders: number;
  net: number;
  expected: number;
  delivered: number;
  newCustomers: number;
  spend: number;
  paid: boolean;
  roas: number | null;
  expRoas: number | null;
}

export interface Overview {
  range: { from: string; to: string; days: number; granularity: 'day' | 'week' };
  compare: { from: string; to: string } | null;
  currency: string | null;
  store: 'mariadb' | 'clickhouse';
  generatedAt: string;
  coverage: { breakdownPct: number | null; unitsWithCostPct: number | null; shippingEstimatedPct: number | null };
  kpis: Record<string, KpiPair>;
  series: SeriesPoint[];
  lifecycle: Record<'placed' | 'cancelled' | 'unconfirmed' | 'confirmed' | 'in_transit' | 'delivered' | 'rto', { orders: number; value: number; gross: number }>;
  waterfall: Array<{ label: string; value: number; kind: 'total' | 'delta' }>;
  channels: ChannelRow[];
  anomalies: Array<{ date: string; metric: string; value: number; typical: number; direction: 'up' | 'down' }>;
}

export interface CampaignNode {
  level: 'campaign' | 'adset' | 'ad';
  id: string;
  platform: string;
  name: string;
  status: string | null;
  objective: string | null;
  dailyBudget: number | null;
  thumb: string | null;
  matched: boolean;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  linkClicks: number;
  video3s: number;
  thruplay: number;
  platformPurchases: number;
  platformValue: number;
  messages: number;
  orders: number;
  net: number;
  expected: number;
  delivered: number;
  newCustomers: number;
  firstNet: number;
  lastNet: number;
  ctr: number | null;
  cpm: number | null;
  cpc: number | null;
  cpa: number | null;
  frequency: number | null;
  hookRate: number | null;
  holdRate: number | null;
  roas: number | null;
  expRoas: number | null;
  platformRoas: number | null;
  firstRoas: number | null;
  lastRoas: number | null;
  spark: number[];
  children: CampaignNode[];
}

export interface Campaigns {
  model: Model;
  win: number;
  currency: string | null;
  rows: CampaignNode[];
}

export interface Creative extends CampaignNode {
  campaign: string;
  fatigued: boolean;
  ctrTrend: { ctr: number; prevCtr: number; freq: number } | null;
}

export interface Attribution {
  win: number;
  models: Model[];
  channels: Array<{ channel: string; label: string; byModel: Partial<Record<Model, number>> }>;
  campaigns: Array<{ id: string; name: string; channel: string; byModel: Partial<Record<Model, number>> }>;
  journey: Array<{ from: string; to: string; orders: number; net: number }>;
  lag: Array<{ label: string; orders: number; pct: number }>;
  touches: Array<{ touches: number; orders: number }>;
  ctwa: { adClicks: number; chatsStarted: number; chatsInInbox: number; orders: number; delivered: number; deliveredValue: number };
  labels: Record<string, string>;
}

export interface Customers {
  cohorts: Array<{ cohort: string; size: number; values: number[] }>;
  series: Array<{ date: string; newNet: number; returningNet: number; newOrders: number; returningOrders: number }>;
  newCustomers: number;
  returningShare: number;
  ncac: number | null;
  ltv90: number | null;
  ltvToCac: number | null;
  paybackDays: number | null;
}

export interface ForecastMetric {
  mtd: number;
  projected: { p10: number; p50: number; p90: number };
  lastMonthTotal: number;
  lastMonthToDate: number;
  daily: Array<{ date: string; mid: number; lo: number; hi: number }>;
}

export interface Forecast {
  today: string;
  month: string;
  monthStart: string;
  monthEnd: string;
  currency: string | null;
  actual: Array<{ date: string; net: number; expected: number; spend: number; gross: number }>;
  net: ForecastMetric;
  expected: ForecastMetric;
  spend: ForecastMetric;
  gross: ForecastMetric;
  simulator: Array<{ campaignId: string; name: string; status: string | null; a: number; b: number; dailySpend: number; dailyExpected: number }>;
}

export interface Opportunity {
  id: string;
  kind: 'scale' | 'cut' | 'fatigue' | 'geo' | 'capi' | 'data' | 'setup';
  severity: 'good' | 'bad' | 'warn' | 'info';
  title: string;
  detail: string;
  impact: number | null;
  impactLabel: string;
  entityId?: string;
}

export interface Brief {
  source: 'ai' | 'rules';
  headline: string;
  body: string;
  actions: Array<{ label: string; tone: 'good' | 'bad' | 'warn' | 'info' }>;
  generatedAt: string;
}

export interface ChartSpec {
  type: 'line' | 'bar';
  title: string;
  x: string[];
  series: Array<{ name: string; data: number[] }>;
}

export interface AdAccount {
  id: number;
  platform: 'meta' | 'google' | 'tiktok' | 'snap';
  externalId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  storeId: number | null;
  status: string;
  usingOverrideToken: boolean;
  capiEnabled: boolean;
  capiDatasetId: string | null;
  syncIntervalMin: number | null;
  connectedAt: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  health: 'ok' | 'error' | 'pending' | 'paused';
  currencyMismatch: boolean;
  timezoneMismatch: boolean;
}

export interface Accounts {
  baseCurrency: string | null;
  platforms: Array<{ platform: AdAccount['platform']; label: string; available: boolean }>;
  accounts: AdAccount[];
}

export interface GrowthStatus {
  store: 'mariadb' | 'clickhouse';
  clickhouse: { enabled: boolean; healthy: boolean; mirroredCompanies: number };
  dataVersion: number;
  facts: { orders: number; lastBuiltAt: string | null };
  touchpoints: number;
}

const qs = (q: GrowthQuery) => {
  const p: Record<string, string> = { from: q.from, to: q.to };
  if (q.compare) p.compare = q.compare;
  if (q.storeId) p.storeId = String(q.storeId);
  if (q.model) p.model = q.model;
  if (q.win) p.win = String(q.win);
  return p;
};

type Opt = { signal?: AbortSignal };

export const growthApi = {
  catalog: () => apiFetch<Catalog>('/growth/catalog'),
  status: () => apiFetch<GrowthStatus>('/growth/status'),
  overview: (q: GrowthQuery, o: Opt = {}) => apiFetch<Overview>('/growth/overview', { params: qs(q), ...o }),
  campaigns: (q: GrowthQuery, o: Opt = {}) => apiFetch<Campaigns>('/growth/campaigns', { params: qs(q), ...o }),
  creatives: (q: GrowthQuery, o: Opt = {}) =>
    apiFetch<{ model: Model; currency: string | null; rows: Creative[] }>('/growth/creatives', { params: qs(q), ...o }),
  attribution: (q: GrowthQuery, o: Opt = {}) => apiFetch<Attribution>('/growth/attribution', { params: qs(q), ...o }),
  customers: (q: GrowthQuery, o: Opt = {}) => apiFetch<Customers>('/growth/customers', { params: qs(q), ...o }),
  forecast: (storeId?: number) => apiFetch<Forecast>('/growth/forecast', { params: storeId ? { storeId: String(storeId) } : {} }),
  opportunities: (q: GrowthQuery, o: Opt = {}) => apiFetch<Opportunity[]>('/growth/opportunities', { params: qs(q), ...o }),
  brief: (q: GrowthQuery, o: Opt = {}) => apiFetch<Brief>('/growth/brief', { params: qs(q), ...o }),
  ask: (q: GrowthQuery, question: string, history: Array<{ role: 'user' | 'assistant'; text: string }>) =>
    apiFetch<{ answer: string; chart: ChartSpec | null }>('/growth/ask', {
      method: 'POST',
      body: { ...qs(q), ...(q.storeId ? { storeId: q.storeId } : {}), ...(q.win ? { win: q.win } : {}), question, history },
    }),
  accounts: () => apiFetch<Accounts>('/growth/accounts'),
  connect: (body: { platform: string; externalId: string; token?: string; storeId?: number | null }) =>
    apiFetch<AdAccount>('/growth/accounts', { method: 'POST', body }),
  updateAccount: (id: number, body: Partial<{ syncIntervalMin: number | null; storeId: number | null; token: string | null; capiEnabled: boolean; capiDatasetId: string | null }>) =>
    apiFetch('/growth/accounts/' + id, { method: 'PATCH', body }),
  disconnect: (id: number) => apiFetch('/growth/accounts/' + id, { method: 'DELETE' }),
  syncAccount: (id: number) => apiFetch('/growth/accounts/' + id + '/sync', { method: 'POST' }),
  syncToday: () => apiFetch<{ started: number; accounts: number }>('/growth/sync/today', { method: 'POST' }),
  syncAll: () => apiFetch<{ started: true; accounts: number }>('/growth/sync', { method: 'POST' }),
  rebuild: () => apiFetch('/growth/rebuild', { method: 'POST' }),
  backfillAttribution: () => apiFetch<{ enqueued: number }>('/growth/backfill/attribution', { method: 'POST' }),
  backfillFinancials: () => apiFetch('/growth/backfill/financials', { method: 'POST' }),
  syncCogs: () => apiFetch('/growth/cogs/sync', { method: 'POST' }),
};

export const SYNC_INTERVALS: Array<[number | null, string]> = [
  [null, 'Every 4 hours (default)'],
  [30, 'Every 30 minutes'],
  [60, 'Every hour'],
  [120, 'Every 2 hours'],
  [360, 'Every 6 hours'],
  [720, 'Every 12 hours'],
  [1440, 'Once a day'],
];
