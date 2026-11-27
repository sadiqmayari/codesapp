import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdAccountInfo,
  AdEntityRow,
  AdInsightRow,
  AdPlatformAdapter,
  AdPlatformAuthError,
  AdPlatformRateLimitError,
  AdStatusRow,
} from '../ad-platform.types';
import { httpJson } from '../http';

const BASE = 'https://business-api.tiktok.com/open_api/v1.3';
const TOKEN_CODES = new Set([40001, 40104, 40105, 40102]);
const RATE_CODES = new Set([40100, 50002]);

interface TtResp<T> {
  code?: number;
  message?: string;
  data?: T;
}
interface TtPage<T> {
  list?: T[];
  page_info?: { page?: number; total_page?: number };
}

const num = (v: unknown) => Number(v ?? 0) || 0;

/** TikTok `operation_status` → the Meta-style vocabulary the Growth UI filters on. */
export function ttStatus(s: string | null | undefined): string | null {
  if (!s) return null;
  const u = s.toUpperCase();
  if (u === 'ENABLE') return 'ACTIVE';
  if (u === 'DISABLE') return 'PAUSED';
  if (u === 'DELETE') return 'DELETED';
  return u;
}

/** TikTok ad-group bidding → the normalised strategy Growth stores. */
export function ttBid(g: { bid_type?: string; bid_price?: number; conversion_bid_price?: number; deep_bid_type?: string; roas_bid?: number }): {
  bidStrategy: string | null; bidAmount: number | null; roasFloor: number | null;
} {
  if (g.deep_bid_type === 'VO_MIN_ROAS' && (g.roas_bid ?? 0) > 0) return { bidStrategy: 'LOWEST_COST_WITH_MIN_ROAS', bidAmount: null, roasFloor: g.roas_bid ?? null };
  if ((g.conversion_bid_price ?? 0) > 0) return { bidStrategy: 'COST_CAP', bidAmount: g.conversion_bid_price ?? null, roasFloor: null };
  if (g.bid_type === 'BID_TYPE_CUSTOM' && (g.bid_price ?? 0) > 0) return { bidStrategy: 'LOWEST_COST_WITH_BID_CAP', bidAmount: g.bid_price ?? null, roasFloor: null };
  return { bidStrategy: g.bid_type ? 'LOWEST_COST_WITHOUT_CAP' : null, bidAmount: null, roasFloor: null };
}

/** TikTok optimisation goal → Growth's vocabulary. */
export function ttGoal(g: string | null | undefined): string | null {
  if (!g) return null;
  const map: Record<string, string> = { CONVERT: 'OFFSITE_CONVERSIONS', VALUE: 'VALUE', CLICK: 'LINK_CLICKS', TRAFFIC_LANDING_PAGE_VIEW: 'LANDING_PAGE_VIEWS', REACH: 'REACH' };
  return map[g] ?? g;
}

/** TikTok "YYYY-MM-DD HH:MM:SS" (UTC) → ISO. */
export function ttIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(`${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Split [since, until] (YYYY-MM-DD) into ≤30-day windows — TikTok's daily-report range limit. */
export function ttWindows(since: string, until: string, days = 30): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const end = new Date(`${until}T00:00:00Z`).getTime();
  let start = new Date(`${since}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return [[since, until]];
  while (start <= end) {
    const stop = Math.min(end, start + (days - 1) * 86_400_000);
    out.push([new Date(start).toISOString().slice(0, 10), new Date(stop).toISOString().slice(0, 10)]);
    start = stop + 86_400_000;
  }
  return out;
}

/**
 * TikTok Marketing API adapter. `token` = the advertiser access token obtained
 * through the TikTok for Business OAuth app (long-lived until revoked).
 * Available once TIKTOK_APP_ID + TIKTOK_APP_SECRET are configured; accounts are
 * added via TikTokOAuthService (Connect with TikTok).
 */
@Injectable()
export class TikTokAdsAdapter implements AdPlatformAdapter {
  readonly platform = 'tiktok' as const;
  readonly available: boolean;

  constructor(config: ConfigService) {
    this.available = !!config.get<string>('TIKTOK_APP_ID') && !!config.get<string>('TIKTOK_APP_SECRET');
  }

  private async call<T>(path: string, token: string): Promise<T> {
    const res = await httpJson<TtResp<T>>('GET', `${BASE}${path}`, { 'Access-Token': token });
    const code = res.body.code ?? (res.status >= 400 ? res.status : 0);
    if (code !== 0) {
      if (RATE_CODES.has(code)) throw new AdPlatformRateLimitError('TikTok is rate-limiting; retrying later.', 10 * 60_000);
      if (TOKEN_CODES.has(code)) throw new AdPlatformAuthError('TikTok rejected the access token. Reconnect the account.', 'token', code);
      throw new AdPlatformAuthError(res.body.message ?? `TikTok API error ${code}`, 'other', code);
    }
    return res.body.data as T;
  }

  private async paged<T>(path: string, token: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 50; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const data = await this.call<TtPage<T>>(`${path}${sep}page=${page}&page_size=1000`, token);
      out.push(...(data?.list ?? []));
      if (!data?.page_info?.total_page || page >= data.page_info.total_page) break;
    }
    return out;
  }

  async getAccountInfo(token: string, externalId: string): Promise<AdAccountInfo> {
    const q = `advertiser_ids=${encodeURIComponent(JSON.stringify([externalId]))}` +
      `&fields=${encodeURIComponent(JSON.stringify(['name', 'currency', 'timezone']))}`;
    const data = await this.call<{ list?: Array<{ name?: string; currency?: string; timezone?: string }> }>(
      `/advertiser/info/?${q}`,
      token,
    );
    const a = data?.list?.[0];
    return { externalId, name: a?.name ?? null, currency: a?.currency ?? null, timezone: a?.timezone ?? null };
  }

  async listEntities(token: string, externalId: string): Promise<AdEntityRow[]> {
    const adv = `advertiser_id=${encodeURIComponent(externalId)}`;
    const out: AdEntityRow[] = [];
    type C = { campaign_id: string; campaign_name?: string; operation_status?: string; objective_type?: string; budget?: number; budget_mode?: string; budget_optimize_on?: boolean; campaign_type?: string };
    for (const c of await this.paged<C>(`/campaign/get/?${adv}`, token)) {
      // The campaign owns the budget only with budget optimisation on (TikTok's CBO).
      const owns = !!c.budget_optimize_on && c.budget_mode !== 'BUDGET_MODE_INFINITE';
      out.push({ level: 'campaign', externalId: String(c.campaign_id), parentExternalId: null, campaignId: String(c.campaign_id),
        name: c.campaign_name ?? null, status: ttStatus(c.operation_status), configuredStatus: ttStatus(c.operation_status),
        objective: c.campaign_type && c.campaign_type !== 'REGULAR_CAMPAIGN' ? `${c.objective_type ?? ''} ${c.campaign_type}`.trim() : c.objective_type ?? null,
        dailyBudget: owns && c.budget_mode === 'BUDGET_MODE_DAY' ? c.budget ?? null : null,
        lifetimeBudget: owns && c.budget_mode === 'BUDGET_MODE_TOTAL' ? c.budget ?? null : null,
        creativeThumbUrl: null, destinationUrl: null });
    }
    type G = {
      adgroup_id: string; adgroup_name?: string; campaign_id?: string; operation_status?: string; budget?: number; budget_mode?: string;
      bid_type?: string; bid_price?: number; conversion_bid_price?: number; deep_bid_type?: string; roas_bid?: number;
      optimization_goal?: string; optimization_event?: string; schedule_start_time?: string; schedule_end_time?: string; schedule_type?: string;
    };
    for (const g of await this.paged<G>(`/adgroup/get/?${adv}`, token)) {
      const bid = ttBid(g);
      const hasBudget = g.budget_mode && g.budget_mode !== 'BUDGET_MODE_INFINITE' && (g.budget ?? 0) > 0;
      out.push({ level: 'adset', externalId: String(g.adgroup_id), parentExternalId: g.campaign_id ? String(g.campaign_id) : null,
        campaignId: g.campaign_id ? String(g.campaign_id) : null, name: g.adgroup_name ?? null, status: ttStatus(g.operation_status), configuredStatus: ttStatus(g.operation_status),
        objective: null,
        dailyBudget: hasBudget && g.budget_mode === 'BUDGET_MODE_DAY' ? g.budget ?? null : null,
        lifetimeBudget: hasBudget && g.budget_mode === 'BUDGET_MODE_TOTAL' ? g.budget ?? null : null,
        ...bid,
        optimizationGoal: ttGoal(g.optimization_goal), conversionEvent: g.optimization_event ?? null,
        startTime: ttIso(g.schedule_start_time), endTime: g.schedule_type === 'SCHEDULE_START_END' ? ttIso(g.schedule_end_time) : null,
        creativeThumbUrl: null, destinationUrl: null });
    }
    type A = { ad_id: string; ad_name?: string; adgroup_id?: string; campaign_id?: string; operation_status?: string; landing_page_url?: string; video_id?: string; image_ids?: string[] };
    const ads = await this.paged<A>(`/ad/get/?${adv}`, token);
    const covers = await this.videoCovers(token, externalId, ads.map((a) => a.video_id).filter((v): v is string => !!v));
    for (const a of ads) {
      out.push({ level: 'ad', externalId: String(a.ad_id), parentExternalId: a.adgroup_id ? String(a.adgroup_id) : null,
        campaignId: a.campaign_id ? String(a.campaign_id) : null, name: a.ad_name ?? null, status: ttStatus(a.operation_status), configuredStatus: ttStatus(a.operation_status),
        objective: null, dailyBudget: null, creativeThumbUrl: a.video_id ? covers.get(a.video_id) ?? null : null, destinationUrl: a.landing_page_url ?? null });
    }
    return out;
  }

  /** video_id → cover url (best-effort, 60 ids per call). */
  private async videoCovers(token: string, externalId: string, ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const uniq = [...new Set(ids)];
    for (let i = 0; i < uniq.length && i < 600; i += 60) {
      try {
        const part = uniq.slice(i, i + 60);
        const data = await this.call<{ list?: Array<{ video_id?: string; video_cover_url?: string; poster_url?: string }> }>(
          `/file/video/ad/info/?advertiser_id=${encodeURIComponent(externalId)}&video_ids=${encodeURIComponent(JSON.stringify(part))}`,
          token,
        );
        for (const v of data?.list ?? []) {
          const url = v.video_cover_url ?? v.poster_url;
          if (v.video_id && url) out.set(v.video_id, url);
        }
      } catch {
        break;
      }
    }
    return out;
  }

  async listStatuses(token: string, externalId: string): Promise<AdStatusRow[]> {
    const adv = `advertiser_id=${encodeURIComponent(externalId)}`;
    type S = { campaign_id?: string; adgroup_id?: string; ad_id?: string; operation_status?: string; schedule_end_time?: string };
    const out: AdStatusRow[] = [];
    const levels: Array<['campaign' | 'adset' | 'ad', string, keyof S]> = [
      ['campaign', '/campaign/get/', 'campaign_id'],
      ['adset', '/adgroup/get/', 'adgroup_id'],
      ['ad', '/ad/get/', 'ad_id'],
    ];
    for (const [level, path, idKey] of levels) {
      for (const r of await this.paged<S>(`${path}?${adv}`, token)) {
        const id = r[idKey];
        if (!id) continue;
        const st = ttStatus(r.operation_status);
        out.push({ level, externalId: String(id), status: st, configuredStatus: st, endTime: ttIso(r.schedule_end_time) });
      }
    }
    return out;
  }

  async fetchInsights(token: string, externalId: string, since: string, until: string): Promise<AdInsightRow[]> {
    const rows: AdInsightRow[] = [];
    for (const [a, b] of ttWindows(since, until)) rows.push(...(await this.fetchWindow(token, externalId, a, b)));
    return rows;
  }

  private async fetchWindow(token: string, externalId: string, since: string, until: string): Promise<AdInsightRow[]> {
    const metrics = ['campaign_id', 'adgroup_id', 'spend', 'impressions', 'reach', 'clicks', 'complete_payment',
      'complete_payment_roas', 'video_watched_2s', 'video_views_p100'];
    const q = [
      `advertiser_id=${encodeURIComponent(externalId)}`,
      'report_type=BASIC',
      'data_level=AUCTION_AD',
      `dimensions=${encodeURIComponent(JSON.stringify(['ad_id', 'stat_time_day']))}`,
      `metrics=${encodeURIComponent(JSON.stringify(metrics))}`,
      `start_date=${since}`,
      `end_date=${until}`,
    ].join('&');
    type R = { dimensions?: { ad_id?: string; stat_time_day?: string }; metrics?: Record<string, string> };
    const rows: AdInsightRow[] = [];
    for (const r of await this.paged<R>(`/report/integrated/get/?${q}`, token)) {
      const m = r.metrics ?? {};
      const adId = r.dimensions?.ad_id;
      const day = r.dimensions?.stat_time_day?.slice(0, 10);
      if (!adId || !day) continue;
      const spend = num(m.spend);
      rows.push({
        date: day, campaignId: String(m.campaign_id ?? ''), adsetId: m.adgroup_id ? String(m.adgroup_id) : null, adId: String(adId),
        spend, impressions: num(m.impressions), reach: num(m.reach), clicks: num(m.clicks), linkClicks: num(m.clicks),
        video3s: num(m.video_watched_2s), thruplay: num(m.video_views_p100), addToCart: 0, checkouts: 0,
        purchases: Math.round(num(m.complete_payment)), purchaseValue: num(m.complete_payment_roas) * spend, messagingStarted: 0,
      });
    }
    return rows;
  }
}
