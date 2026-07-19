/**
 * Agent-competition (gamification) config. Every workspace can override these
 * via `gamification_settings.config`; when no row exists we fall back to
 * DEFAULT_GAME_CONFIG so the leaderboard works out of the box.
 */

export type GameMetric = 'orders' | 'revenue' | 'chats' | 'conversion' | 'points';

/** Metrics a badge can test — the competition metrics plus response speed. */
export type BadgeMetric = GameMetric | 'medianRespSec';

export interface PointsConfig {
  perOrder: number; // points per order created
  perRevenue1000: number; // points per 1000 of order value
  perChat: number; // points per chat handled
  conversionBonusMax: number; // × conversionRate (0..1)
  speedBonusMax: number; // × speed factor (fast → 1, slow → 0)
}

export interface SpeedConfig {
  fastSec: number; // ≤ this median response → full speed bonus
  slowSec: number; // ≥ this → zero speed bonus (linear between)
}

export interface BadgeDef {
  id: string;
  label: string;
  /** `rank` = tests the agent's rank in `metric`; `metric` = tests the raw value. */
  type: 'rank' | 'metric';
  metric: BadgeMetric;
  op: '<=' | '>=' | '==' | '<' | '>';
  threshold: number;
}

export interface GameConfig {
  points: PointsConfig;
  speed: SpeedConfig;
  badges: BadgeDef[];
}

export const GAME_METRICS: GameMetric[] = [
  'orders',
  'revenue',
  'chats',
  'conversion',
  'points',
];

export const DEFAULT_GAME_CONFIG: GameConfig = {
  points: {
    perOrder: 10,
    perRevenue1000: 5,
    perChat: 1,
    conversionBonusMax: 50,
    speedBonusMax: 20,
  },
  speed: {
    fastSec: 60, // full speed bonus at ≤ 60s
    slowSec: 900, // no speed bonus at ≥ 15 min
  },
  badges: [
    { id: 'top_seller', label: 'Top Seller', type: 'rank', metric: 'orders', op: '==', threshold: 1 },
    { id: 'revenue_king', label: 'Revenue King', type: 'rank', metric: 'revenue', op: '==', threshold: 1 },
    { id: 'speed_demon', label: 'Speed Demon', type: 'metric', metric: 'medianRespSec', op: '<=', threshold: 60 },
    { id: 'centurion', label: 'Centurion', type: 'metric', metric: 'chats', op: '>=', threshold: 100 },
    { id: 'closer', label: 'Closer', type: 'metric', metric: 'conversion', op: '>=', threshold: 0.3 },
  ],
};
