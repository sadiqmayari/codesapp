import { apiFetch } from '@/lib/api';

export type GameMetric =
  | 'orders'
  | 'revenue'
  | 'chats'
  | 'conversion'
  | 'carts'
  | 'points';
export type TargetPeriod = 'daily' | 'weekly' | 'monthly';

export const METRIC_LABELS: Record<GameMetric, string> = {
  orders: 'Orders',
  revenue: 'Revenue',
  chats: 'Chats handled',
  conversion: 'Conversion rate',
  carts: 'Carts recovered',
  points: 'Points',
};

export const PERIOD_LABELS: Record<TargetPeriod, string> = {
  daily: 'Today',
  weekly: 'This week',
  monthly: 'This month',
};

export interface BadgeAward {
  id: string;
  label: string;
}

export interface LeaderboardRow {
  userId: number;
  name: string;
  rank: number;
  points: number;
  orders: number;
  orderValue: number;
  currency: string | null;
  chats: number;
  medianRespSec: number | null;
  conversionRate: number;
  cartsRecovered: number;
  badges: BadgeAward[];
}

export interface LeaderboardResult {
  rows: LeaderboardRow[];
  currency: string | null;
}

export interface ContestStanding {
  userId: number;
  name: string;
  value: number;
}

export interface Contest {
  id: number;
  name: string;
  description: string | null;
  metric: GameMetric;
  targetValue: number | null;
  prize: string | null;
  startsAt: string;
  endsAt: string;
  status: 'scheduled' | 'active' | 'ended';
  leader: ContestStanding | null;
  standings: ContestStanding[];
  myValue: number;
  myRank: number | null;
}

export interface TargetProgress {
  id: number;
  userId: number;
  userName: string | null;
  metric: GameMetric;
  periodType: TargetPeriod;
  targetValue: number;
  current: number;
  pct: number;
}

export interface BadgeDef {
  id: string;
  label: string;
  type: 'rank' | 'metric';
  metric: string;
  op: string;
  threshold: number;
}

export interface GameConfig {
  points: {
    perOrder: number;
    perRevenue1000: number;
    perChat: number;
    perCartRecovered: number;
    conversionBonusMax: number;
    speedBonusMax: number;
  };
  speed: { fastSec: number; slowSec: number };
  badges: BadgeDef[];
}

export function getLeaderboard(range: { from: string; to: string }) {
  return apiFetch<LeaderboardResult>('/gamification/leaderboard', {
    params: range,
  });
}

export function getContests() {
  return apiFetch<Contest[]>('/gamification/contests');
}

export function getTargets() {
  return apiFetch<TargetProgress[]>('/gamification/targets');
}

export function getGameConfig() {
  return apiFetch<GameConfig>('/gamification/settings');
}

export function updateGameConfig(body: Partial<GameConfig>) {
  return apiFetch<GameConfig>('/gamification/settings', {
    method: 'PATCH',
    body,
  });
}

export interface CreateContestBody {
  name: string;
  description?: string;
  metric: GameMetric;
  targetValue?: number;
  prize?: string;
  startsAt: string;
  endsAt: string;
}

export function createContest(body: CreateContestBody) {
  return apiFetch<{ ok: boolean }>('/gamification/contests', {
    method: 'POST',
    body,
  });
}

export function updateContest(id: number, body: Partial<CreateContestBody>) {
  return apiFetch<{ ok: boolean }>(`/gamification/contests/${id}`, {
    method: 'PATCH',
    body,
  });
}

export function deleteContest(id: number) {
  return apiFetch<{ ok: boolean }>(`/gamification/contests/${id}`, {
    method: 'DELETE',
  });
}

export interface SetTargetBody {
  userId: number;
  metric: GameMetric;
  targetValue: number;
  periodType: TargetPeriod;
}

export function setTarget(body: SetTargetBody) {
  return apiFetch<{ ok: boolean }>('/gamification/targets', {
    method: 'POST',
    body,
  });
}

export function deleteTarget(id: number) {
  return apiFetch<{ ok: boolean }>(`/gamification/targets/${id}`, {
    method: 'DELETE',
  });
}

/** Format a metric value for display (revenue → currency, conversion → %). */
export function formatMetricValue(
  metric: GameMetric,
  value: number,
  currency: string | null,
): string {
  if (metric === 'conversion') return `${Math.round(value * 100)}%`;
  if (metric === 'revenue')
    return `${currency ? currency + ' ' : ''}${value.toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })}`;
  return value.toLocaleString();
}

/** Humanize a median-response-time value in seconds. */
export function formatResponse(sec: number | null): string {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}
