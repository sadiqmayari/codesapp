import { apiFetch } from '@/lib/api';

export type Metric = 'orders' | 'parcels_packed' | 'parcels_booked' | 'parcels_dispatched' | 'returns_received';
export type EarnOn = 'placed' | 'confirmed' | 'delivered';
export type Basis = 'count' | 'value';
export type OrderSource = 'any' | 'inbox' | 'abandoned_cart';
export type CreditTo = 'created' | 'confirmed';

export type Calc =
  | { type: 'per_unit'; rate: number }
  | { type: 'percent'; rate: number }
  | { type: 'slab'; mode: 'whole' | 'marginal'; tiers: { from: number; rate: number }[] }
  | { type: 'target_bonus'; target: number; bonus: number; repeat: boolean }
  | { type: 'pool'; rate: number; splitBy: 'units' | 'hours' | 'equal' };
export type CalcType = Calc['type'];

export interface PlanConfig {
  creditTo: CreditTo;
  earnOn: EarnOn;
  basis: Basis;
  source: OrderSource;
  reverse: boolean;
  min: number;
  cap: number;
  calc: Calc;
}

export interface AppliesTo {
  roles: string[];
  userIds: number[];
}

export interface CommissionPlan {
  id: number;
  name: string;
  active: boolean;
  metric: Metric;
  config: PlanConfig;
  appliesTo: AppliesTo;
  createdAt: string;
  updatedAt: string;
}

export interface PlanRow {
  userId: number;
  name: string;
  role: string;
  units: number;
  amount: number;
  detail: string;
}

export interface PlanStatement {
  planId: number;
  planName: string;
  metric: Metric;
  config: PlanConfig;
  rows: PlanRow[];
  total: number;
}

export interface Statement {
  month: string;
  plans: PlanStatement[];
  leaderboard: { userId: number; name: string; role: string; total: number }[];
  total: number;
}

export interface MyEarnings {
  month: string;
  total: number;
  plans: {
    planId: number;
    planName: string;
    metric: Metric;
    basis: Basis;
    units: number;
    amount: number;
    detail: string;
    next: { at: number; label: string } | null;
    rank: number | null;
    of: number;
  }[];
}

export const METRIC_LABELS: Record<Metric, string> = {
  orders: 'Sales orders',
  parcels_packed: 'Parcels packed',
  parcels_booked: 'Parcels booked',
  parcels_dispatched: 'Parcels dispatched',
  returns_received: 'Returns received',
};
export const METRIC_HINTS: Record<Metric, string> = {
  orders: 'Orders an agent created or confirmed. Choose when they count below.',
  parcels_packed: 'Scanned as packed at the pack station.',
  parcels_booked: 'Booked with a courier by this person.',
  parcels_dispatched: 'On a loadsheet this person generated.',
  returns_received: 'Returns this person scanned in.',
};
export const EARN_ON_LABELS: Record<EarnOn, string> = {
  placed: 'When the order is placed',
  confirmed: 'When it is confirmed',
  delivered: 'When it is delivered',
};
export const CALC_LABELS: Record<CalcType, string> = {
  per_unit: 'Per unit',
  percent: '% of value',
  slab: 'Slabs',
  target_bonus: 'Target bonus',
  pool: 'Team pool',
};

export const DEFAULT_CONFIG: PlanConfig = {
  creditTo: 'created',
  earnOn: 'delivered',
  basis: 'count',
  source: 'any',
  reverse: true,
  min: 0,
  cap: 0,
  calc: { type: 'per_unit', rate: 0 },
};

export function describePlan(p: { metric: Metric; config: PlanConfig }, currency = 'Rs'): string {
  const c = p.config.calc;
  const unit = p.metric === 'orders' ? 'order' : 'parcel';
  const val = p.config.basis === 'value';
  let s = '';
  if (c.type === 'per_unit') s = `${currency} ${c.rate} per ${unit}`;
  else if (c.type === 'percent') s = `${c.rate}% of net value`;
  else if (c.type === 'slab')
    s = `${c.tiers.length} slabs (${c.mode === 'whole' ? 'whole month at reached rate' : 'marginal'})`;
  else if (c.type === 'target_bonus') s = `${currency} ${c.bonus} at ${c.target}${val ? ` ${currency}` : ` ${unit}s`}${c.repeat ? ', repeats' : ''}`;
  else s = `team pool ${val ? `${c.rate}%` : `${currency} ${c.rate} per ${unit}`}, split by ${c.splitBy}`;
  if (p.metric === 'orders') s += ` · ${EARN_ON_LABELS[p.config.earnOn].toLowerCase()}`;
  return s;
}

export const listPlans = () => apiFetch<CommissionPlan[]>('/commissions/plans');
export const createPlan = (body: { name: string; metric: Metric; active?: boolean; config: PlanConfig; appliesTo: AppliesTo }) =>
  apiFetch<CommissionPlan>('/commissions/plans', { method: 'POST', body });
export const updatePlan = (id: number, body: { name: string; metric: Metric; active?: boolean; config: PlanConfig; appliesTo: AppliesTo }) =>
  apiFetch<CommissionPlan>(`/commissions/plans/${id}`, { method: 'PATCH', body });
export const deletePlan = (id: number) => apiFetch<{ ok: true }>(`/commissions/plans/${id}`, { method: 'DELETE' });
export const previewPlan = (body: { name?: string; metric: Metric; config: PlanConfig; appliesTo: AppliesTo; month?: string }) =>
  apiFetch<PlanStatement & { month: string }>('/commissions/preview', { method: 'POST', body });
export const getStatement = (month: string) => apiFetch<Statement>(`/commissions/statement?month=${month}`);
export const getMyEarnings = (month?: string) =>
  apiFetch<MyEarnings>(`/commissions/me${month ? `?month=${month}` : ''}`);
export const backfillAttributions = () => apiFetch<Record<string, unknown>>('/commissions/backfill', { method: 'POST' });

// ── pack station ──
export interface PackParcel {
  shipmentId: number;
  orderName: string | null;
  tracking: string | null;
  courier: string;
  status: string;
  customerName: string | null;
  city: string | null;
  cod: number | null;
  items: { title: string; variant: string | null; sku: string | null; quantity: number; shelf?: string | null; itemCode?: string | null }[];
  packedAt: string | null;
  packedBy: string | null;
}
export const packLookup = (code: string) =>
  apiFetch<PackParcel>(`/shipments/pack/lookup?code=${encodeURIComponent(code)}`);
export const markPacked = (shipmentId: number) =>
  apiFetch<{ ok: true; packedToday: number; packedThisMonth: number }>('/shipments/pack', { method: 'POST', body: { shipmentId } });
export const packStats = () => apiFetch<{ packedToday: number; packedThisMonth: number }>('/shipments/pack/stats');
