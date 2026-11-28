import { apiFetch } from '@/lib/api';

/** Dashboard v3 API (backend `modules/dashboard`). */

export interface BriefItem {
  tone: 'bad' | 'warn' | 'good';
  text: string;
  why: string;
  cta: string;
  href: string;
}

export interface SparkDay {
  day: string;
  gross: number;
  net: number;
  orders: number;
  aov: number;
}

export interface ManagerData {
  needs: { unread: number; unreadOldestMin: number | null; overdueTickets: number | null; unconfirmedOld: number } | null;
  sparks: SparkDay[] | null;
  ads: { spend: number; spendPrev: number; roas: number | null; daily: number[] } | null;
  quality: {
    deliveryRate: number | null;
    deliveryRatePrev: number | null;
    rtoRate: number | null;
    rtoRatePrev: number | null;
    parcels: number;
  } | null;
  flow: {
    placed: number;
    confirmed: number;
    shipped: number;
    delivered: number;
    rto: number;
    rtoValue: number;
    cancelledBeforeBooking: number;
    inTransit: number;
  } | null;
  heat: { grid: number[][]; max: number; peak: { d: number; h: number; c: number } | null; weeks: number } | null;
  target: {
    month: string;
    target: number | null;
    net: number | null;
    pct: number | null;
    projected: number | null;
    neededPerDay: number | null;
    onTrack: boolean | null;
  } | null;
  hotspots: {
    storeRate: number | null;
    cities: { city: string; parcels: number; rtoRate: number; bestCourier: { courier: string; deliveryRate: number } | null }[];
  } | null;
  cod: { amount: number; parcels: number; oldestDays: number | null } | null;
  conversations: {
    chats: number;
    openChats: number;
    deliveredRate: number;
    readRate: number;
    replyRate: number;
    aiShare: number | null;
    firstReplySec: number | null;
    firstReplySecPrev: number | null;
  } | null;
  brief: BriefItem[];
  modules: Record<string, boolean>;
}

export interface PlanLimit {
  key: string;
  label: string;
  used: number;
  limit: number;
  planLimit: number;
  custom: boolean;
}

export interface PlanAccess {
  plan: string | null;
  status: string;
  cycle: { start: string; end: string } | null;
  graceUntil: string | null;
  unpaid: { count: number; amount: number };
  limits: PlanLimit[];
  usageLimitAction: { value: 'block' | 'warn_only'; custom: boolean };
  ai: {
    on: boolean;
    adminDisabled: boolean;
    spentCents: number;
    tenantCapCents: number | null;
    ceilingCents: number | null;
    ceilingCustom: boolean;
    effectiveCapCents: number | null;
  } | null;
  modules: { key: string; label: string; group: string; on: boolean; note: string | null; setByCodesApp: boolean }[];
  overrides: string[];
}

export interface ActivityEvent {
  at: string;
  kind: 'agent' | 'order' | 'courier' | 'booking' | 'return';
  who: string;
  what: string;
  ref: string | null;
}

export interface MeData {
  queue: { myUnread: number; waitingOver1h: number; pool: number; assignedOpen: number } | null;
  nextUp: {
    conversationId: number;
    name: string;
    phone: string | null;
    lastMessage: string | null;
    waitingMin: number | null;
    fromPool: boolean;
    orders: number;
    lifetimeNet: number;
    city: string | null;
  } | null;
  chats: { conversationId: number; name: string; lastMessage: string | null; unread: number; waitingMin: number | null }[];
  today: { replies: number; confirmed: number; created: number } | null;
  avg30: { replies: number | null; confirmed: number | null; created: number | null } | null;
  firstReplySec: number | null;
  teamFirstReplySec: number | null;
  currency: string | null;
}

export interface DashboardLayoutState {
  layout: { hidden: string[] };
  own: boolean;
  teamDefault: { hidden: string[] } | null;
}

export const getManager = (range: { from: string; to: string }, signal?: AbortSignal) =>
  apiFetch<ManagerData>('/dashboard/manager', { params: range, signal });
export const getPlanAccess = () => apiFetch<PlanAccess | null>('/dashboard/plan-access');
export const getActivity = () => apiFetch<{ events: ActivityEvent[] }>('/dashboard/activity');
export const getMe = () => apiFetch<MeData>('/dashboard/me');
export const getLayout = () => apiFetch<DashboardLayoutState>('/dashboard/layout');
export const saveLayout = (layout: { hidden: string[] } | null, teamDefault = false) =>
  apiFetch<DashboardLayoutState>('/dashboard/layout', { method: 'PUT', body: { layout, teamDefault } });

/** Widget ids the Customise panel can hide (order = page order). */
export const WIDGETS = [
  { id: 'notice', label: 'Notice from CodesApp' },
  { id: 'hero', label: 'Sales, target and brief' },
  { id: 'needs', label: 'Needs you now' },
  { id: 'kpis', label: 'Business health' },
  { id: 'flow', label: 'Order flow' },
  { id: 'feed', label: 'Live activity' },
  { id: 'heat', label: 'When customers message' },
  { id: 'team', label: 'Team today' },
  { id: 'couriers', label: 'Couriers and return hotspots' },
  { id: 'plan', label: 'Plan and access' },
] as const;
export type WidgetId = (typeof WIDGETS)[number]['id'];

/** "4m 10s" / "1h 05m" / "—". */
export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** "12 min" / "1h 22m". */
export function fmtWait(min: number | null | undefined): string {
  if (min == null) return '—';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h >= 48 ? `${Math.floor(h / 24)} d` : `${h}h ${String(min % 60).padStart(2, '0')}m`;
}

/** Percent change (null when undefined). */
export function deltaPct(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  if (prev === 0) return cur === 0 ? 0 : null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

export const COURIER_LABEL: Record<string, string> = {
  trax: 'Trax', leopards: 'Leopards', postex: 'PostEx', rocket: 'Rocket', mnp: 'M&P', rapidxpk: 'RapidXpk', tcs: 'TCS',
};
