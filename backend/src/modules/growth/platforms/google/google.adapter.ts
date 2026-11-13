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

const API = 'https://googleads.googleapis.com/v17';
const num = (v: unknown) => Number(v ?? 0) || 0;

/**
 * Google Ads API adapter (REST + GAQL searchStream). `token` = the OAuth REFRESH
 * token; an access token is minted per sync with GOOGLE_ADS_CLIENT_ID/SECRET.
 * Every call also needs the approved GOOGLE_ADS_DEVELOPER_TOKEN, so the adapter
 * stays unavailable until Google approves CodesApp's developer token.
 */
@Injectable()
export class GoogleAdsAdapter implements AdPlatformAdapter {
  readonly platform = 'google' as const;
  readonly available: boolean;
  private readonly devToken: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly loginCustomerId: string;

  constructor(config: ConfigService) {
    this.devToken = config.get<string>('GOOGLE_ADS_DEVELOPER_TOKEN') ?? '';
    this.clientId = config.get<string>('GOOGLE_ADS_CLIENT_ID') ?? '';
    this.clientSecret = config.get<string>('GOOGLE_ADS_CLIENT_SECRET') ?? '';
    this.loginCustomerId = (config.get<string>('GOOGLE_ADS_LOGIN_CUSTOMER_ID') ?? '').replace(/\D/g, '');
    this.available = !!(this.devToken && this.clientId && this.clientSecret);
  }

  private async access(refresh: string): Promise<string> {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    }).toString();
    const res = await httpJson<{ access_token?: string }>(
      'POST',
      'https://oauth2.googleapis.com/token',
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      form,
    );
    if (!res.body.access_token) throw new AdPlatformAuthError('Google rejected the refresh token. Reconnect the account.', 'token');
    return res.body.access_token;
  }

  private async gaql<T>(customerId: string, access: string, query: string): Promise<T[]> {
    const cid = customerId.replace(/\D/g, '');
    const res = await httpJson<Array<{ results?: T[] }> | { error?: { code?: number; message?: string; status?: string } }>(
      'POST',
      `${API}/customers/${cid}/googleAds:searchStream`,
      {
        Authorization: `Bearer ${access}`,
        'developer-token': this.devToken,
        ...(this.loginCustomerId ? { 'login-customer-id': this.loginCustomerId } : {}),
      },
      { query },
    );
    if (!Array.isArray(res.body)) {
      const err = res.body.error;
      if (res.status === 429 || err?.status === 'RESOURCE_EXHAUSTED') {
        throw new AdPlatformRateLimitError('Google Ads quota reached; retrying later.', 30 * 60_000);
      }
      if (res.status === 401) throw new AdPlatformAuthError('Google token expired. Reconnect the account.', 'token');
      if (res.status === 403) throw new AdPlatformAuthError(err?.message ?? 'No access to this Google Ads account.', 'permission');
      throw new AdPlatformAuthError(err?.message ?? `Google Ads API error ${res.status}`, 'other');
    }
    return res.body.flatMap((b) => b.results ?? []);
  }

  async getAccountInfo(token: string, externalId: string): Promise<AdAccountInfo> {
    const access = await this.access(token);
    type R = { customer?: { descriptiveName?: string; currencyCode?: string; timeZone?: string } };
    const rows = await this.gaql<R>(externalId, access,
      'SELECT customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1');
    const c = rows[0]?.customer;
    return { externalId: externalId.replace(/\D/g, ''), name: c?.descriptiveName ?? null,
      currency: c?.currencyCode ?? null, timezone: c?.timeZone ?? null };
  }

  async listEntities(token: string, externalId: string): Promise<AdEntityRow[]> {
    const access = await this.access(token);
    const out: AdEntityRow[] = [];
    type C = { campaign?: { id?: string; name?: string; status?: string; advertisingChannelType?: string }; campaignBudget?: { amountMicros?: string } };
    for (const r of await this.gaql<C>(externalId, access,
      "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED'")) {
      if (!r.campaign?.id) continue;
      out.push({ level: 'campaign', externalId: r.campaign.id, parentExternalId: null, campaignId: r.campaign.id,
        name: r.campaign.name ?? null, status: r.campaign.status ?? null, objective: r.campaign.advertisingChannelType ?? null,
        dailyBudget: r.campaignBudget?.amountMicros ? num(r.campaignBudget.amountMicros) / 1e6 : null,
        creativeThumbUrl: null, destinationUrl: null });
    }
    type G = { adGroup?: { id?: string; name?: string; status?: string }; campaign?: { id?: string } };
    for (const r of await this.gaql<G>(externalId, access,
      "SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id FROM ad_group WHERE ad_group.status != 'REMOVED'")) {
      if (!r.adGroup?.id) continue;
      out.push({ level: 'adset', externalId: r.adGroup.id, parentExternalId: r.campaign?.id ?? null, campaignId: r.campaign?.id ?? null,
        name: r.adGroup.name ?? null, status: r.adGroup.status ?? null, objective: null, dailyBudget: null,
        creativeThumbUrl: null, destinationUrl: null });
    }
    type A = { adGroupAd?: { status?: string; ad?: { id?: string; name?: string; finalUrls?: string[] } }; adGroup?: { id?: string }; campaign?: { id?: string } };
    for (const r of await this.gaql<A>(externalId, access,
      "SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.final_urls, ad_group_ad.status, ad_group.id, campaign.id FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED'")) {
      const ad = r.adGroupAd?.ad;
      if (!ad?.id) continue;
      out.push({ level: 'ad', externalId: ad.id, parentExternalId: r.adGroup?.id ?? null, campaignId: r.campaign?.id ?? null,
        name: ad.name ?? null, status: r.adGroupAd?.status ?? null, objective: null, dailyBudget: null,
        creativeThumbUrl: null, destinationUrl: ad.finalUrls?.[0] ?? null });
    }
    return out;
  }

  async fetchInsights(token: string, externalId: string, since: string, until: string): Promise<AdInsightRow[]> {
    const access = await this.access(token);
    type R = {
      segments?: { date?: string };
      campaign?: { id?: string };
      adGroup?: { id?: string };
      adGroupAd?: { ad?: { id?: string } };
      metrics?: { costMicros?: string; impressions?: string; clicks?: string; conversions?: number; conversionsValue?: number; videoViews?: string };
    };
    const rows = await this.gaql<R>(externalId, access,
      'SELECT segments.date, campaign.id, ad_group.id, ad_group_ad.ad.id, metrics.cost_micros, metrics.impressions, ' +
      'metrics.clicks, metrics.conversions, metrics.conversions_value, metrics.video_views ' +
      `FROM ad_group_ad WHERE segments.date BETWEEN '${since}' AND '${until}'`);
    return rows
      .filter((r) => r.segments?.date && r.adGroupAd?.ad?.id)
      .map((r) => ({
        date: r.segments!.date!, campaignId: r.campaign?.id ?? '', adsetId: r.adGroup?.id ?? null, adId: r.adGroupAd!.ad!.id!,
        spend: num(r.metrics?.costMicros) / 1e6, impressions: num(r.metrics?.impressions), reach: 0,
        clicks: num(r.metrics?.clicks), linkClicks: num(r.metrics?.clicks), video3s: num(r.metrics?.videoViews), thruplay: 0,
        addToCart: 0, checkouts: 0, purchases: Math.round(num(r.metrics?.conversions)),
        purchaseValue: num(r.metrics?.conversionsValue), messagingStarted: 0,
      }));
  }
}
