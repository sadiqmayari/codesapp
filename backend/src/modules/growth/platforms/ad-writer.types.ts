import { AdPlatform } from './ad-platform.types';

/**
 * Write side of the ad layer (Growth ad management). One implementation per
 * platform — Meta today. All money is in MAJOR units (e.g. rupees); the writer
 * converts to the platform's minor units. AdManageService / AdCreateService are
 * the only callers.
 */
export type EntityLevel = 'campaign' | 'adset' | 'ad';

export const BID_STRATEGIES = [
  'LOWEST_COST_WITHOUT_CAP',
  'COST_CAP',
  'LOWEST_COST_WITH_MIN_ROAS',
  'LOWEST_COST_WITH_BID_CAP',
] as const;
export type BidStrategy = (typeof BID_STRATEGIES)[number];

export const OPTIMIZATION_GOALS = ['OFFSITE_CONVERSIONS', 'VALUE', 'CONVERSATIONS', 'LANDING_PAGE_VIEWS', 'LINK_CLICKS', 'REACH'] as const;
export type OptimizationGoal = (typeof OPTIMIZATION_GOALS)[number];

export const CONVERSION_EVENTS = ['PURCHASE', 'INITIATED_CHECKOUT', 'ADD_TO_CART'] as const;
export const ATTRIBUTION_WINDOWS = ['7d_click_1d_view', '7d_click', '1d_click'] as const;
export type AttributionWindow = (typeof ATTRIBUTION_WINDOWS)[number];

/** Normalised edit; undefined = leave unchanged. */
export interface EntityPatch {
  status?: 'ACTIVE' | 'PAUSED';
  name?: string;
  dailyBudget?: number;
  lifetimeBudget?: number;
  bidStrategy?: BidStrategy;
  bidAmount?: number | null;
  roasFloor?: number | null;
  optimizationGoal?: OptimizationGoal;
  conversionEvent?: string;
  attributionWindow?: AttributionWindow;
  endTime?: string | null;
}

export interface AdAssets {
  /** `instagramId` = the Instagram business account linked to this Page (if any). */
  pages: Array<{ id: string; name: string; instagramId: string | null }>;
  /** `pageId` = the Page it is linked to, when known. */
  instagram: Array<{ id: string; username: string; pageId: string | null }>;
  pixels: Array<{ id: string; name: string }>;
  /** Google: enabled conversion actions (purchase first). */
  conversionActions?: Array<{ id: string; name: string; category: string | null; primary: boolean }>;
  /** Google: videos of the tenant's connected YouTube channels (filled by AdCreateService). */
  youtubeVideos?: Array<{ id: string; title: string | null; thumb: string | null }>;
  /** TikTok: identities the ad can run under. */
  identities?: Array<{ id: string; type: string; name: string | null; avatar: string | null }>;
  /** TikTok: recent ad videos in the library. */
  videos?: Array<{ id: string; name: string | null; cover: string | null; durationS: number | null }>;
}

export type Objective = 'OUTCOME_SALES' | 'OUTCOME_ENGAGEMENT' | 'OUTCOME_TRAFFIC' | 'OUTCOME_LEADS' | 'OUTCOME_AWARENESS';

export interface CreateDraft {
  name: string;
  objective: Objective;
  cbo: boolean;
  budgetType: 'daily' | 'lifetime';
  budget: number;
  bidStrategy: BidStrategy;
  bidAmount?: number | null;
  roasFloor?: number | null;
  conversionLocation: 'website' | 'whatsapp';
  optimizationGoal: OptimizationGoal;
  conversionEvent?: string | null;
  attributionWindow: AttributionWindow;
  pixelId?: string | null;
  countries: string[];
  excludeCities: Array<{ key: string; name: string }>;
  ageMin: number;
  ageMax: number;
  genders: Array<1 | 2>;
  advantageAudience: boolean;
  advantagePlacements: boolean;
  startTime?: string | null;
  endTime?: string | null;
  pageId: string;
  instagramId?: string | null;
  whatsappNumber?: string | null;
  primaryText: string;
  headline: string;
  cta: string;
  url?: string | null;
  imageHash?: string | null;
  videoId?: string | null;
}

/** Google campaign builder draft (platform 'google'). Money in major units. */
export interface GoogleCreateDraft {
  platform: 'google';
  type: 'search' | 'pmax' | 'video';
  name: string;
  budget: number;
  /** Max conversions · Target CPA (COST_CAP) · Max conversion value (+ optional Target ROAS = MIN_ROAS). */
  bidStrategy: 'LOWEST_COST_WITHOUT_CAP' | 'COST_CAP' | 'LOWEST_COST_WITH_MIN_ROAS';
  /** 'value' = maximise conversion value family (Target ROAS optional). */
  bidFamily: 'conversions' | 'value';
  bidAmount?: number | null;
  roasFloor?: number | null;
  /** ISO-2 countries + geo target constant resource names to exclude. */
  countries: string[];
  excludeCities: Array<{ key: string; name: string }>;
  languages: string[];
  startTime?: string | null;
  endTime?: string | null;
  url: string;
  businessName?: string | null;
  headlines: string[];
  longHeadlines?: string[];
  descriptions: string[];
  /** Search: keywords. */
  keywords?: Array<{ text: string; match: 'BROAD' | 'PHRASE' | 'EXACT' }>;
  /** Asset resource names (uploaded via create/media). */
  landscapeImages?: string[];
  squareImages?: string[];
  logoImages?: string[];
  /** YouTube video ids. */
  youtubeVideoIds?: string[];
  cta?: string | null;
}

/** TikTok campaign builder draft (platform 'tiktok'). Money in major units. */
export interface TikTokCreateDraft {
  platform: 'tiktok';
  objective: 'WEB_CONVERSIONS' | 'TRAFFIC' | 'VIDEO_VIEWS';
  name: string;
  /** Campaign budget optimisation (budget on the campaign) or ad-group budget. */
  cbo: boolean;
  budgetType: 'daily' | 'lifetime';
  budget: number;
  bidStrategy: 'LOWEST_COST_WITHOUT_CAP' | 'COST_CAP' | 'LOWEST_COST_WITH_MIN_ROAS';
  bidAmount?: number | null;
  roasFloor?: number | null;
  pixelId?: string | null;
  /** TikTok optimization_event, e.g. SHOPPING (complete payment). */
  conversionEvent?: string | null;
  locationIds: string[];
  excludeLocationIds?: string[];
  ageGroups: string[];
  gender: 'GENDER_UNLIMITED' | 'GENDER_MALE' | 'GENDER_FEMALE';
  startTime?: string | null;
  endTime?: string | null;
  identityId?: string | null;
  identityType?: string | null;
  /** Used to create a custom identity when no identity is picked. */
  displayName?: string | null;
  videoId: string;
  adText: string;
  cta: string;
  url: string;
}

export type AnyCreateDraft = CreateDraft | GoogleCreateDraft | TikTokCreateDraft;

export interface CreatedIds {
  campaignId?: string;
  adsetId?: string;
  creativeId?: string;
  adId?: string;
}

export interface AdPlatformWriter {
  readonly platform: AdPlatform;
  /** `externalId` = the ad account id (Google customer / TikTok advertiser); Meta ignores it. */
  checkWriteAccess(token: string, externalId?: string): Promise<{ ok: boolean; granted: string[]; missing: string[] }>;
  update(token: string, level: EntityLevel, id: string, patch: EntityPatch, currency: string | null, externalId?: string): Promise<void>;
  copy(token: string, level: EntityLevel, id: string, externalId?: string): Promise<string>;
  /** Platform rules for a patch beyond the shared ones; returns an error sentence or null. */
  validatePatch?(level: EntityLevel, patch: EntityPatch, entity: { objective: string | null; destination_type: string | null; name: string | null }): string | null;
  /** Platform rules for a create draft (non-Meta builders). */
  validateDraft?(draft: AnyCreateDraft): string[];
  listAssets(token: string, externalId: string): Promise<AdAssets>;
  uploadImage(token: string, externalId: string, bytes: Buffer, filename: string): Promise<string>;
  uploadVideo(token: string, externalId: string, bytes: Buffer, filename: string): Promise<string>;
  searchCities(token: string, query: string, country: string, externalId?: string): Promise<Array<{ key: string; name: string; region: string }>>;
  /** Campaign → ad set → creative → ad, all PAUSED. `onStep` records ids as they are created. */
  createAll(
    token: string,
    externalId: string,
    draft: AnyCreateDraft,
    currency: string | null,
    onStep: (ids: CreatedIds) => void,
  ): Promise<Required<CreatedIds>>;
}

/** Currencies Meta treats as having no minor unit (amounts sent as-is). */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD', 'PYG', 'COP', 'IDR']);

/** Major → Meta minor units (PKR/USD ×100; zero-decimal currencies ×1). */
export function toMinor(amount: number, currency: string | null | undefined): number {
  const f = currency && ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100;
  return Math.round(amount * f);
}

export function fromMinor(amount: number | string | null | undefined, currency: string | null | undefined): number | null {
  if (amount == null || amount === '') return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  const f = currency && ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100;
  return n / f;
}
