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
import { httpJson, zoneOffset } from '../http';

const BASE = 'https://adsapi.snapchat.com/v1';
const num = (v: unknown) => Number(v ?? 0) || 0;

/**
 * Snapchat Marketing API adapter. `token` = the OAuth REFRESH token; Snap access
 * tokens live ~30 min, so each call mints one with SNAP_CLIENT_ID/SECRET.
 * Spend is reported in micro-currency.
 */
@Injectable()
export class SnapAdsAdapter implements AdPlatformAdapter {
  readonly platform = 'snap' as const;
  readonly available: boolean;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private tz = new Map<string, string>();

  constructor(config: ConfigService) {
    this.clientId = config.get<string>('SNAP_CLIENT_ID') ?? '';
    this.clientSecret = config.get<string>('SNAP_CLIENT_SECRET') ?? '';
    this.available = !!(this.clientId && this.clientSecret);
  }

  private async access(refresh: string): Promise<string> {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    }).toString();
    const res = await httpJson<{ access_token?: string; error?: string }>(
      'POST',
      'https://accounts.snapchat.com/login/oauth2/access_token',
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      form,
    );
    if (!res.body.access_token) {
      throw new AdPlatformAuthError('Snapchat rejected the refresh token. Reconnect the account.', 'token');
    }
    return res.body.access_token;
  }

  private async get<T>(url: string, access: string): Promise<T> {
    const res = await httpJson<T & { request_status?: string; debug_message?: string }>('GET', url, {
      Authorization: `Bearer ${access}`,
    });
    if (res.status === 429) throw new AdPlatformRateLimitError('Snapchat is rate-limiting; retrying later.', 10 * 60_000);
    if (res.status === 401) throw new AdPlatformAuthError('Snapchat token expired or revoked. Reconnect the account.', 'token');
    if (res.status === 403) throw new AdPlatformAuthError('This Snapchat user cannot read the ad account.', 'permission');
    if (res.status >= 400) throw new AdPlatformAuthError(res.body.debug_message ?? `Snapchat API error ${res.status}`, 'other');
    return res.body;
  }

  private async list<T>(url: string, key: string, inner: string, access: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = url;
    for (let i = 0; next && i < 40; i++) {
      const body: Record<string, unknown> & { paging?: { next_link?: string } } = await this.get(next, access);
      for (const w of (body[key] as Array<Record<string, T>>) ?? []) if (w[inner]) out.push(w[inner]);
      next = body.paging?.next_link ?? null;
    }
    return out;
  }

  async getAccountInfo(token: string, externalId: string): Promise<AdAccountInfo> {
    const access = await this.access(token);
    type Acc = { name?: string; currency?: string; timezone?: string };
    const rows = await this.list<Acc>(`${BASE}/adaccounts/${externalId}`, 'adaccounts', 'adaccount', access);
    const a = rows[0];
    if (a?.timezone) this.tz.set(externalId, a.timezone);
    return { externalId, name: a?.name ?? null, currency: a?.currency ?? null, timezone: a?.timezone ?? null };
  }

  async listEntities(token: string, externalId: string): Promise<AdEntityRow[]> {
    const access = await this.access(token);
    const out: AdEntityRow[] = [];
    type C = { id: string; name?: string; status?: string; objective?: string; daily_budget_micro?: number };
    for (const c of await this.list<C>(`${BASE}/adaccounts/${externalId}/campaigns`, 'campaigns', 'campaign', access)) {
      out.push({ level: 'campaign', externalId: c.id, parentExternalId: null, campaignId: c.id, name: c.name ?? null,
        status: c.status ?? null, objective: c.objective ?? null,
        dailyBudget: c.daily_budget_micro ? c.daily_budget_micro / 1e6 : null, creativeThumbUrl: null, destinationUrl: null });
    }
    type S = { id: string; name?: string; campaign_id?: string; status?: string; daily_budget_micro?: number };
    for (const s of await this.list<S>(`${BASE}/adaccounts/${externalId}/adsquads`, 'adsquads', 'adsquad', access)) {
      out.push({ level: 'adset', externalId: s.id, parentExternalId: s.campaign_id ?? null, campaignId: s.campaign_id ?? null,
        name: s.name ?? null, status: s.status ?? null, objective: null,
        dailyBudget: s.daily_budget_micro ? s.daily_budget_micro / 1e6 : null, creativeThumbUrl: null, destinationUrl: null });
    }
    type A = { id: string; name?: string; ad_squad_id?: string; status?: string };
    const squadCampaign = new Map(out.filter((e) => e.level === 'adset').map((e) => [e.externalId, e.campaignId]));
    for (const a of await this.list<A>(`${BASE}/adaccounts/${externalId}/ads`, 'ads', 'ad', access)) {
      out.push({ level: 'ad', externalId: a.id, parentExternalId: a.ad_squad_id ?? null,
        campaignId: (a.ad_squad_id && squadCampaign.get(a.ad_squad_id)) || null, name: a.name ?? null,
        status: a.status ?? null, objective: null, dailyBudget: null, creativeThumbUrl: null, destinationUrl: null });
    }
    return out;
  }

  async fetchInsights(token: string, externalId: string, since: string, until: string): Promise<AdInsightRow[]> {
    const access = await this.access(token);
    const off = zoneOffset(this.tz.get(externalId) ?? null);
    const endDay = new Date(`${until}T00:00:00Z`);
    endDay.setUTCDate(endDay.getUTCDate() + 1);
    const start = encodeURIComponent(`${since}T00:00:00${off}`);
    const end = encodeURIComponent(`${endDay.toISOString().slice(0, 10)}T00:00:00${off}`);
    const fields = 'spend,impressions,swipes,video_views,conversion_purchases,conversion_purchases_value,conversion_add_cart';
    type Stat = { start_time?: string; stats?: Record<string, number> };
    type Body = { total_stats?: Array<{ total_stat?: { breakdown_stats?: { ad?: Array<{ id: string; timeseries?: Stat[] }> } } }> };
    const body = await this.get<Body>(
      `${BASE}/adaccounts/${externalId}/stats?granularity=DAY&breakdown=ad&fields=${fields}&start_time=${start}&end_time=${end}`,
      access,
    );
    const rows: AdInsightRow[] = [];
    for (const ad of body.total_stats?.[0]?.total_stat?.breakdown_stats?.ad ?? []) {
      for (const t of ad.timeseries ?? []) {
        const s = t.stats ?? {};
        const date = t.start_time?.slice(0, 10);
        if (!date) continue;
        rows.push({
          date, campaignId: '', adsetId: null, adId: ad.id, spend: num(s.spend) / 1e6, impressions: num(s.impressions),
          reach: 0, clicks: num(s.swipes), linkClicks: num(s.swipes), video3s: num(s.video_views), thruplay: 0,
          addToCart: num(s.conversion_add_cart), checkouts: 0, purchases: num(s.conversion_purchases),
          purchaseValue: num(s.conversion_purchases_value) / 1e6, messagingStarted: 0,
        });
      }
    }
    return rows;
  }
}
