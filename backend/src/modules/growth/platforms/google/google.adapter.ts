import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdAccountInfo,
  AdEntityRow,
  AdInsightRow,
  AdPlatformAdapter,
  AdStatusRow,
} from '../ad-platform.types';
import {
  DEFAULT_API_VERSION,
  GoogleAdsClient,
  GoogleAdsConfig,
  digits,
  fromMicros,
  gStatus,
  gaqlDate,
  normaliseBidding,
} from './google-ads.client';

const num = (v: unknown) => Number(v ?? 0) || 0;

/** YouTube thumbnail for a video id. */
export const ytThumb = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

type AssetMap = Map<string, { youtubeId: string | null; imageUrl: string | null }>;

/** Pull the first YouTube id / image url an ad references, from any ad type. */
export function creativeOf(ad: Record<string, unknown> | undefined, assets: AssetMap): { youtubeId: string | null; thumb: string | null } {
  if (!ad) return { youtubeId: null, thumb: null };
  const refs: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || v == null) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k === 'asset' && typeof x === 'string') refs.push(x);
        else walk(x, depth + 1);
      }
    }
  };
  walk(ad, 0);
  let youtubeId: string | null = null;
  let image: string | null = null;
  for (const r of refs) {
    const a = assets.get(r);
    if (!a) continue;
    if (!youtubeId && a.youtubeId) youtubeId = a.youtubeId;
    if (!image && a.imageUrl) image = a.imageUrl;
  }
  const imageAd = (ad.imageAd as { imageUrl?: string } | undefined)?.imageUrl ?? null;
  return { youtubeId, thumb: youtubeId ? ytThumb(youtubeId) : image ?? imageAd };
}

/**
 * Residual campaign-grain rows: campaign cost/day minus the ad-grain sum.
 * Performance Max (and other ad-less campaigns) only report at campaign level;
 * they are stored as ad_id 'c:<campaignId>' (the legacy campaign-grain convention).
 */
export function campaignResiduals(adRows: AdInsightRow[], campRows: AdInsightRow[]): AdInsightRow[] {
  const sum = new Map<string, { spend: number; imp: number; clk: number; conv: number; val: number; v3: number; tp: number }>();
  for (const r of adRows) {
    const k = `${r.date}|${r.campaignId}`;
    const s = sum.get(k) ?? { spend: 0, imp: 0, clk: 0, conv: 0, val: 0, v3: 0, tp: 0 };
    s.spend += r.spend; s.imp += r.impressions; s.clk += r.clicks; s.conv += r.purchases; s.val += r.purchaseValue; s.v3 += r.video3s; s.tp += r.thruplay;
    sum.set(k, s);
  }
  const out: AdInsightRow[] = [];
  for (const c of campRows) {
    const s = sum.get(`${c.date}|${c.campaignId}`) ?? { spend: 0, imp: 0, clk: 0, conv: 0, val: 0, v3: 0, tp: 0 };
    const spend = c.spend - s.spend;
    // Below a rupee / 0.5% is rounding between the two reports, not a hidden campaign type.
    if (spend <= Math.max(1, c.spend * 0.005) && c.purchases - s.conv <= 0) continue;
    out.push({
      ...c,
      adId: `c:${c.campaignId}`,
      adsetId: null,
      spend: Math.max(0, spend),
      impressions: Math.max(0, c.impressions - s.imp),
      clicks: Math.max(0, c.clicks - s.clk),
      linkClicks: Math.max(0, c.clicks - s.clk),
      purchases: Math.max(0, c.purchases - s.conv),
      purchaseValue: Math.max(0, c.purchaseValue - s.val),
      video3s: Math.max(0, c.video3s - s.v3),
      thruplay: Math.max(0, c.thruplay - s.tp),
    });
  }
  return out;
}

type Metrics = {
  costMicros?: string; impressions?: string; clicks?: string; conversions?: number; conversionsValue?: number;
  videoTrueviewViews?: string; videoViews?: string; videoQuartileP25Rate?: number;
};

export function insightOf(date: string, campaignId: string, adsetId: string | null, adId: string, m: Metrics | undefined): AdInsightRow {
  const imp = num(m?.impressions);
  return {
    date, campaignId, adsetId, adId,
    spend: num(m?.costMicros) / 1e6, impressions: imp, reach: 0,
    clicks: num(m?.clicks), linkClicks: num(m?.clicks),
    video3s: Math.round(num(m?.videoQuartileP25Rate) * imp),
    thruplay: num(m?.videoTrueviewViews ?? m?.videoViews),
    addToCart: 0, checkouts: 0,
    purchases: Math.round(num(m?.conversions)), purchaseValue: num(m?.conversionsValue), messagingStarted: 0,
  };
}

/**
 * Google Ads API adapter (REST + GAQL searchStream). The stored token is the
 * JSON {r: refresh token, l: login (manager) customer id, c: customer id} written
 * by "Connect with Google"; a bare refresh token (legacy) still works. Needs the
 * CodesApp developer token + OAuth client (GOOGLE_ADS_*), else "coming soon".
 */
@Injectable()
export class GoogleAdsAdapter implements AdPlatformAdapter {
  readonly platform = 'google' as const;
  readonly available: boolean;
  readonly cfg: GoogleAdsConfig;

  constructor(config: ConfigService) {
    this.cfg = {
      devToken: config.get<string>('GOOGLE_ADS_DEVELOPER_TOKEN') ?? '',
      clientId: config.get<string>('GOOGLE_ADS_CLIENT_ID') ?? '',
      clientSecret: config.get<string>('GOOGLE_ADS_CLIENT_SECRET') ?? '',
      version: config.get<string>('GOOGLE_ADS_API_VERSION') || DEFAULT_API_VERSION,
      defaultLoginCustomerId: digits(config.get<string>('GOOGLE_ADS_LOGIN_CUSTOMER_ID')),
    };
    this.available = !!(this.cfg.devToken && this.cfg.clientId && this.cfg.clientSecret);
  }

  client(token: string, customerId?: string | null) {
    return new GoogleAdsClient(this.cfg, token, customerId);
  }

  async getAccountInfo(token: string, externalId: string): Promise<AdAccountInfo> {
    type R = { customer?: { descriptiveName?: string; currencyCode?: string; timeZone?: string } };
    const rows = await this.client(token, externalId).gaql<R>(
      'SELECT customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1',
    );
    const c = rows[0]?.customer;
    return { externalId: digits(externalId) ?? externalId, name: c?.descriptiveName ?? null, currency: c?.currencyCode ?? null, timezone: c?.timeZone ?? null };
  }

  /** Asset resource name → YouTube id / image url (for ad thumbnails + video links). */
  private async assets(api: GoogleAdsClient): Promise<AssetMap> {
    const map: AssetMap = new Map();
    type A = { asset?: { resourceName?: string; type?: string; youtubeVideoAsset?: { youtubeVideoId?: string }; imageAsset?: { fullSize?: { url?: string } } } };
    try {
      const rows = await api.gaql<A>(
        "SELECT asset.resource_name, asset.type, asset.youtube_video_asset.youtube_video_id, asset.image_asset.full_size.url FROM asset WHERE asset.type IN ('YOUTUBE_VIDEO', 'IMAGE')",
      );
      for (const r of rows) {
        if (!r.asset?.resourceName) continue;
        map.set(r.asset.resourceName, { youtubeId: r.asset.youtubeVideoAsset?.youtubeVideoId ?? null, imageUrl: r.asset.imageAsset?.fullSize?.url ?? null });
      }
    } catch {
      /* thumbnails are best-effort */
    }
    return map;
  }

  async listEntities(token: string, externalId: string): Promise<AdEntityRow[]> {
    const api = this.client(token, externalId);
    const out: AdEntityRow[] = [];
    type Bid = Parameters<typeof normaliseBidding>[0];
    type C = {
      campaign?: Bid & { id?: string; name?: string; status?: string; primaryStatus?: string; advertisingChannelType?: string;
        startDate?: string; endDate?: string; startDateTime?: string; endDateTime?: string };
      campaignBudget?: { amountMicros?: string; explicitlyShared?: boolean };
    };
    const base = 'campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, ' +
      'campaign.target_cpa.target_cpa_micros, campaign.target_roas.target_roas, campaign.maximize_conversions.target_cpa_micros, ' +
      'campaign.maximize_conversion_value.target_roas, campaign_budget.amount_micros, campaign_budget.explicitly_shared';
    const where = " FROM campaign WHERE campaign.status != 'REMOVED'";
    const camps = await api.gaqlFirst<C>([
      `SELECT ${base}, campaign.start_date_time, campaign.end_date_time${where}`,
      `SELECT ${base}, campaign.start_date, campaign.end_date${where}`,
      `SELECT ${base}${where}`,
    ]);
    for (const r of camps) {
      const c = r.campaign;
      if (!c?.id) continue;
      const bid = normaliseBidding(c);
      const end = c.endDateTime ?? c.endDate ?? null;
      out.push({
        level: 'campaign', externalId: c.id, parentExternalId: null, campaignId: c.id,
        name: c.name ?? null, status: gStatus(c.status), configuredStatus: gStatus(c.status), objective: c.advertisingChannelType ?? null,
        // Google budgets always live on the campaign (CBO-like); a shared budget can't be edited per campaign.
        dailyBudget: fromMicros(r.campaignBudget?.amountMicros),
        bidStrategy: bid.bidStrategy, bidAmount: bid.bidAmount, roasFloor: bid.roasFloor, optimizationGoal: bid.optimizationGoal,
        destinationType: r.campaignBudget?.explicitlyShared ? 'SHARED_BUDGET' : null,
        startTime: c.startDateTime ?? c.startDate ?? null,
        // Google's "no end date" sentinel is 2037-12-30.
        endTime: end && !end.startsWith('2037-12-30') ? end : null,
        creativeThumbUrl: null, destinationUrl: null,
      });
    }
    type G = { adGroup?: { id?: string; name?: string; status?: string; cpcBidMicros?: string; targetCpaMicros?: string; targetRoas?: number }; campaign?: { id?: string } };
    for (const r of await api.gaql<G>(
      "SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.cpc_bid_micros, ad_group.target_cpa_micros, ad_group.target_roas, campaign.id FROM ad_group WHERE ad_group.status != 'REMOVED'",
    )) {
      const g = r.adGroup;
      if (!g?.id) continue;
      out.push({
        level: 'adset', externalId: g.id, parentExternalId: r.campaign?.id ?? null, campaignId: r.campaign?.id ?? null,
        name: g.name ?? null, status: gStatus(g.status), configuredStatus: gStatus(g.status), objective: null, dailyBudget: null,
        bidAmount: fromMicros(g.targetCpaMicros), roasFloor: g.targetRoas ?? null,
        creativeThumbUrl: null, destinationUrl: null,
      });
    }
    const assets = await this.assets(api);
    type A = { adGroupAd?: { status?: string; ad?: Record<string, unknown> & { id?: string; name?: string; finalUrls?: string[]; type?: string } }; adGroup?: { id?: string }; campaign?: { id?: string } };
    const ads = await api.gaqlFirst<A>([
      "SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.status, ad_group.id, campaign.id, " +
        'ad_group_ad.ad.video_ad.video.asset, ad_group_ad.ad.video_responsive_ad.videos, ad_group_ad.ad.demand_gen_video_responsive_ad.videos, ' +
        'ad_group_ad.ad.responsive_display_ad.marketing_images, ad_group_ad.ad.image_ad.image_url ' +
        "FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED'",
      "SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.status, ad_group.id, campaign.id " +
        "FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED'",
    ]);
    for (const r of ads) {
      const ad = r.adGroupAd?.ad;
      if (!ad?.id) continue;
      const cr = creativeOf(ad, assets);
      out.push({
        level: 'ad', externalId: ad.id, parentExternalId: r.adGroup?.id ?? null, campaignId: r.campaign?.id ?? null,
        name: ad.name ?? (ad.type ? String(ad.type).toLowerCase().replace(/_/g, ' ') : null),
        status: gStatus(r.adGroupAd?.status), configuredStatus: gStatus(r.adGroupAd?.status), objective: null, dailyBudget: null,
        creativeThumbUrl: cr.thumb, destinationUrl: ad.finalUrls?.[0] ?? null, youtubeVideoId: cr.youtubeId,
      });
    }
    return out;
  }

  async listStatuses(token: string, externalId: string): Promise<AdStatusRow[]> {
    const api = this.client(token, externalId);
    const out: AdStatusRow[] = [];
    type C = { campaign?: { id?: string; status?: string; endDate?: string; endDateTime?: string } };
    const where = " FROM campaign WHERE campaign.status != 'REMOVED'";
    for (const r of await api.gaqlFirst<C>([
      `SELECT campaign.id, campaign.status, campaign.end_date_time${where}`,
      `SELECT campaign.id, campaign.status, campaign.end_date${where}`,
      `SELECT campaign.id, campaign.status${where}`,
    ])) {
      if (!r.campaign?.id) continue;
      const end = r.campaign.endDateTime ?? r.campaign.endDate ?? null;
      const st = gStatus(r.campaign.status);
      out.push({ level: 'campaign', externalId: r.campaign.id, status: st, configuredStatus: st, endTime: end && !end.startsWith('2037-12-30') ? end : null });
    }
    type G = { adGroup?: { id?: string; status?: string } };
    for (const r of await api.gaql<G>("SELECT ad_group.id, ad_group.status FROM ad_group WHERE ad_group.status != 'REMOVED'")) {
      if (!r.adGroup?.id) continue;
      const st = gStatus(r.adGroup.status);
      out.push({ level: 'adset', externalId: r.adGroup.id, status: st, configuredStatus: st, endTime: null });
    }
    type A = { adGroupAd?: { status?: string; ad?: { id?: string } } };
    for (const r of await api.gaql<A>("SELECT ad_group_ad.ad.id, ad_group_ad.status FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED'")) {
      if (!r.adGroupAd?.ad?.id) continue;
      const st = gStatus(r.adGroupAd.status);
      out.push({ level: 'ad', externalId: r.adGroupAd.ad.id, status: st, configuredStatus: st, endTime: null });
    }
    return out;
  }

  async fetchInsights(token: string, externalId: string, since: string, until: string): Promise<AdInsightRow[]> {
    const api = this.client(token, externalId);
    const range = `segments.date BETWEEN '${gaqlDate(since)}' AND '${gaqlDate(until)}'`;
    const m = 'metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value';
    const videoNew = ', metrics.video_trueview_views, metrics.video_quartile_p25_rate';
    const videoOld = ', metrics.video_views, metrics.video_quartile_p25_rate';
    type R = { segments?: { date?: string }; campaign?: { id?: string }; adGroup?: { id?: string }; adGroupAd?: { ad?: { id?: string } }; metrics?: Metrics };
    const adQ = (v: string) => `SELECT segments.date, campaign.id, ad_group.id, ad_group_ad.ad.id, ${m}${v} FROM ad_group_ad WHERE ${range}`;
    const campQ = (v: string) => `SELECT segments.date, campaign.id, ${m}${v} FROM campaign WHERE ${range}`;
    const [ads, camps] = await Promise.all([
      api.gaqlFirst<R>([adQ(videoNew), adQ(videoOld), adQ('')]),
      api.gaqlFirst<R>([campQ(videoNew), campQ(videoOld), campQ('')]),
    ]);
    const adRows = ads
      .filter((r) => r.segments?.date && r.adGroupAd?.ad?.id)
      .map((r) => insightOf(r.segments!.date!, r.campaign?.id ?? '', r.adGroup?.id ?? null, r.adGroupAd!.ad!.id!, r.metrics));
    const campRows = camps
      .filter((r) => r.segments?.date && r.campaign?.id)
      .map((r) => insightOf(r.segments!.date!, r.campaign!.id!, null, '', r.metrics));
    return [...adRows, ...campaignResiduals(adRows, campRows)];
  }
}
