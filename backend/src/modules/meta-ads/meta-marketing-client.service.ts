import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as https from 'https';

const REQUEST_TIMEOUT_MS = 20_000;
// Meta error codes we translate into a clear "fix your token/scope" message so
// the Settings UI can tell the tenant exactly what to do.
const TOKEN_ERROR_CODES = new Set([190, 102, 463, 467]); // expired/invalid session
const PERMISSION_ERROR_CODES = new Set([200, 10, 294, 3]); // missing ads_read / perms

export interface CampaignSpendRow {
  /** YYYY-MM-DD (the Meta insights `date_start` for a 1-day increment). */
  date: string;
  campaignId: string;
  campaignName: string;
  spend: number;
  impressions: number;
  clicks: number;
  // Meta-native pixel attribution for this campaign/day.
  metaPurchases: number;
  metaValue: number;
}

export interface AdDestination {
  campaignId: string;
  campaignName: string;
  /** The ad's destination website URL (may be null for CTWA / non-link ads). */
  url: string | null;
}

// Meta purchase action types, most-specific first.
const PURCHASE_ACTION_TYPES = [
  'omni_purchase',
  'purchase',
  'offsite_conversion.fb_pixel_purchase',
  'onsite_web_purchase',
];

/** Thrown when Meta rejects the ads call so Settings can surface a fix. */
export class MetaAdsAuthError extends Error {
  constructor(
    message: string,
    readonly kind: 'token' | 'permission' | 'other',
    readonly metaCode?: number,
  ) {
    super(message);
    this.name = 'MetaAdsAuthError';
  }
}

interface ActionEntry {
  action_type?: string;
  value?: string;
}
interface InsightsResponse {
  data?: Array<{
    campaign_id?: string;
    campaign_name?: string;
    spend?: string;
    impressions?: string;
    clicks?: string;
    date_start?: string;
    actions?: ActionEntry[];
    action_values?: ActionEntry[];
  }>;
  paging?: { next?: string };
  error?: { message?: string; code?: number; type?: string };
}

interface AdsResponse {
  data?: Array<{
    campaign_id?: string;
    campaign?: { id?: string; name?: string };
    creative?: {
      object_story_spec?: {
        link_data?: { link?: string };
        video_data?: { call_to_action?: { value?: { link?: string } } };
      };
      asset_feed_spec?: { link_urls?: Array<{ website_url?: string }> };
    };
  }>;
  paging?: { next?: string };
  error?: { message?: string; code?: number; type?: string };
}

/** Pick the best purchase action value from an actions/action_values array. */
function pickPurchase(entries?: ActionEntry[]): number {
  if (!entries?.length) return 0;
  for (const t of PURCHASE_ACTION_TYPES) {
    const hit = entries.find((e) => e.action_type === t);
    if (hit) return Number(hit.value ?? 0) || 0;
  }
  return 0;
}

/**
 * Thin wrapper around the Meta Marketing API (Ads Insights). Mirrors the
 * transport style of inbox/meta-client.service.ts (native https, graph.facebook.com,
 * Bearer token, META_GRAPH_VERSION). Read-only: it only pulls campaign spend.
 */
@Injectable()
export class MetaMarketingClientService {
  private readonly logger = new Logger(MetaMarketingClientService.name);
  private readonly graphVersion: string;
  private readonly graphHost = 'graph.facebook.com';

  constructor(private readonly config: ConfigService) {
    this.graphVersion = this.config.get<string>('META_GRAPH_VERSION') ?? 'v19.0';
  }

  /**
   * Daily per-campaign spend for [since, until] (inclusive, YYYY-MM-DD).
   * `time_increment=1` returns one row per campaign per day. Follows cursor
   * paging. Throws MetaAdsAuthError on a token/permission rejection.
   */
  async getCampaignSpend(
    token: string,
    adAccountId: string,
    since: string,
    until: string,
  ): Promise<CampaignSpendRow[]> {
    const acct = adAccountId.startsWith('act_')
      ? adAccountId
      : `act_${adAccountId}`;
    const timeRange = encodeURIComponent(
      JSON.stringify({ since, until }),
    );
    const first =
      `/${this.graphVersion}/${acct}/insights` +
      `?level=campaign` +
      `&fields=campaign_id,campaign_name,spend,impressions,clicks,actions,action_values` +
      `&time_range=${timeRange}` +
      `&time_increment=1&limit=500`;

    const rows: CampaignSpendRow[] = [];
    let pathOrUrl: string | null = `https://${this.graphHost}${first}`;
    let hops = 0;
    while (pathOrUrl && hops < 50) {
      hops++;
      const body: InsightsResponse = await this.getJson(pathOrUrl, token);
      if (body.error) this.throwMetaError(body.error);
      for (const d of body.data ?? []) {
        if (!d.campaign_id || !d.date_start) continue;
        rows.push({
          date: d.date_start,
          campaignId: d.campaign_id,
          campaignName: d.campaign_name ?? d.campaign_id,
          spend: Number(d.spend ?? 0) || 0,
          impressions: Number(d.impressions ?? 0) || 0,
          clicks: Number(d.clicks ?? 0) || 0,
          metaPurchases: Math.round(pickPurchase(d.actions)),
          metaValue: pickPurchase(d.action_values),
        });
      }
      pathOrUrl = body.paging?.next ?? null;
    }
    return rows;
  }

  /**
   * One destination URL per campaign (the most recent ad's link). Used to map a
   * campaign to the product it advertises. Best-effort — returns [] on error so
   * the sync never fails because of this. Covered by `ads_read`.
   */
  async getAdDestinations(
    token: string,
    adAccountId: string,
  ): Promise<AdDestination[]> {
    const acct = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
    const fields =
      'campaign_id,campaign{id,name},' +
      'creative{object_story_spec{link_data{link},video_data{call_to_action{value{link}}}},asset_feed_spec{link_urls{website_url}}}';
    const first =
      `/${this.graphVersion}/${acct}/ads` +
      `?fields=${encodeURIComponent(fields)}` +
      `&effective_status=["ACTIVE","PAUSED"]&limit=200`;

    const byCampaign = new Map<string, AdDestination>();
    let pathOrUrl: string | null = `https://${this.graphHost}${first}`;
    let hops = 0;
    try {
      while (pathOrUrl && hops < 30) {
        hops++;
        const body: AdsResponse = await this.getJson<AdsResponse>(pathOrUrl, token);
        if (body.error) break; // best-effort — don't throw
        for (const ad of body.data ?? []) {
          const campaignId = ad.campaign_id ?? ad.campaign?.id;
          if (!campaignId) continue;
          const url =
            ad.creative?.object_story_spec?.link_data?.link ??
            ad.creative?.object_story_spec?.video_data?.call_to_action?.value?.link ??
            ad.creative?.asset_feed_spec?.link_urls?.[0]?.website_url ??
            null;
          // Keep the first ad per campaign that has a usable link.
          const existing = byCampaign.get(campaignId);
          if (!existing || (!existing.url && url)) {
            byCampaign.set(campaignId, {
              campaignId,
              campaignName: ad.campaign?.name ?? '',
              url,
            });
          }
        }
        pathOrUrl = body.paging?.next ?? null;
      }
    } catch (e) {
      this.logger.warn(
        `getAdDestinations failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return Array.from(byCampaign.values());
  }

  private throwMetaError(err: {
    message?: string;
    code?: number;
  }): never {
    const code = err.code;
    const msg = err.message ?? 'Meta Ads API error';
    if (code && TOKEN_ERROR_CODES.has(code)) {
      throw new MetaAdsAuthError(
        'Meta rejected the access token. Reissue your System User token and try again.',
        'token',
        code,
      );
    }
    if (code && PERMISSION_ERROR_CODES.has(code)) {
      throw new MetaAdsAuthError(
        'The token is missing the ads_read permission (or the System User is not assigned to this ad account). Reissue the token with ads_read and assign it to the ad account.',
        'permission',
        code,
      );
    }
    throw new MetaAdsAuthError(msg, 'other', code);
  }

  private getJson<T = InsightsResponse>(
    urlString: string,
    token: string,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlString);
      const req = https.request(
        {
          method: 'GET',
          hostname: url.hostname,
          path: url.pathname + url.search,
          headers: { Authorization: `Bearer ${token}` },
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            try {
              resolve(raw ? (JSON.parse(raw) as T) : ({} as T));
            } catch {
              reject(
                new MetaAdsAuthError(
                  `Unexpected Meta response (${res.statusCode})`,
                  'other',
                ),
              );
            }
          });
        },
      );
      req.on('error', (e) => reject(e));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Meta Ads API request timed out'));
      });
      req.end();
    });
  }
}
