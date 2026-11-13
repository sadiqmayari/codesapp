import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdAccountInfo,
  AdEntityRow,
  AdInsightRow,
  AdPlatformAdapter,
  AdPlatformAuthError,
  AdPlatformRateLimitError,
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

/**
 * TikTok Marketing API adapter. `token` = the advertiser access token obtained
 * through the TikTok for Business OAuth app (long-lived until revoked).
 * Available once TIKTOK_APP_ID is configured (app approved by TikTok).
 */
@Injectable()
export class TikTokAdsAdapter implements AdPlatformAdapter {
  readonly platform = 'tiktok' as const;
  readonly available: boolean;

  constructor(config: ConfigService) {
    this.available = !!config.get<string>('TIKTOK_APP_ID');
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
    type C = { campaign_id: string; campaign_name?: string; operation_status?: string; objective_type?: string; budget?: number };
    for (const c of await this.paged<C>(`/campaign/get/?${adv}`, token)) {
      out.push({ level: 'campaign', externalId: String(c.campaign_id), parentExternalId: null, campaignId: String(c.campaign_id),
        name: c.campaign_name ?? null, status: c.operation_status ?? null, objective: c.objective_type ?? null,
        dailyBudget: c.budget ?? null, creativeThumbUrl: null, destinationUrl: null });
    }
    type G = { adgroup_id: string; adgroup_name?: string; campaign_id?: string; operation_status?: string; budget?: number };
    for (const g of await this.paged<G>(`/adgroup/get/?${adv}`, token)) {
      out.push({ level: 'adset', externalId: String(g.adgroup_id), parentExternalId: g.campaign_id ? String(g.campaign_id) : null,
        campaignId: g.campaign_id ? String(g.campaign_id) : null, name: g.adgroup_name ?? null, status: g.operation_status ?? null,
        objective: null, dailyBudget: g.budget ?? null, creativeThumbUrl: null, destinationUrl: null });
    }
    type A = { ad_id: string; ad_name?: string; adgroup_id?: string; campaign_id?: string; operation_status?: string; landing_page_url?: string };
    for (const a of await this.paged<A>(`/ad/get/?${adv}`, token)) {
      out.push({ level: 'ad', externalId: String(a.ad_id), parentExternalId: a.adgroup_id ? String(a.adgroup_id) : null,
        campaignId: a.campaign_id ? String(a.campaign_id) : null, name: a.ad_name ?? null, status: a.operation_status ?? null,
        objective: null, dailyBudget: null, creativeThumbUrl: null, destinationUrl: a.landing_page_url ?? null });
    }
    return out;
  }

  async fetchInsights(token: string, externalId: string, since: string, until: string): Promise<AdInsightRow[]> {
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
