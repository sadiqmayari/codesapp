/**
 * Platform-agnostic ad layer. Every ad network (Meta today; Google, TikTok,
 * Snap next) implements AdPlatformAdapter. Adding a platform = one adapter +
 * one entry in PLATFORMS (platform-registry.ts) — nothing else changes.
 */
export type AdPlatform = 'meta' | 'google' | 'tiktok' | 'snap';

export const AD_PLATFORMS: AdPlatform[] = ['meta', 'google', 'tiktok', 'snap'];

export const PLATFORM_LABEL: Record<AdPlatform, string> = {
  meta: 'Meta Ads',
  google: 'Google Ads',
  tiktok: 'TikTok Ads',
  snap: 'Snapchat Ads',
};

export interface AdAccountInfo {
  externalId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
}

export interface AdEntityRow {
  level: 'campaign' | 'adset' | 'ad';
  externalId: string;
  parentExternalId: string | null;
  campaignId: string | null;
  name: string | null;
  status: string | null;
  objective: string | null;
  dailyBudget: number | null;
  creativeThumbUrl: string | null;
  destinationUrl: string | null;
}

/** One row per ad per day, in the ACCOUNT's currency + timezone. */
export interface AdInsightRow {
  date: string; // YYYY-MM-DD (account timezone)
  campaignId: string;
  adsetId: string | null;
  adId: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  linkClicks: number;
  video3s: number;
  thruplay: number;
  addToCart: number;
  checkouts: number;
  purchases: number;
  purchaseValue: number;
  messagingStarted: number;
}

/** Thrown for credential/permission problems so the UI can say how to fix them. */
export class AdPlatformAuthError extends Error {
  constructor(
    message: string,
    readonly kind: 'token' | 'permission' | 'other',
    readonly code?: number,
  ) {
    super(message);
    this.name = 'AdPlatformAuthError';
  }
}

/** Thrown when the platform throttles us; the sync retries later. */
export class AdPlatformRateLimitError extends Error {
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
    this.name = 'AdPlatformRateLimitError';
  }
}

export interface AdPlatformAdapter {
  readonly platform: AdPlatform;
  /** False while the platform's developer app / API access isn't approved yet. */
  readonly available: boolean;
  getAccountInfo(token: string, externalId: string): Promise<AdAccountInfo>;
  listEntities(token: string, externalId: string): Promise<AdEntityRow[]>;
  fetchInsights(
    token: string,
    externalId: string,
    since: string,
    until: string,
  ): Promise<AdInsightRow[]>;
}
