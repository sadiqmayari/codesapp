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
}

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

interface InsightsResponse {
  data?: Array<{
    campaign_id?: string;
    campaign_name?: string;
    spend?: string;
    impressions?: string;
    clicks?: string;
    date_start?: string;
  }>;
  paging?: { next?: string };
  error?: { message?: string; code?: number; type?: string };
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
      `&fields=campaign_id,campaign_name,spend,impressions,clicks` +
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
        });
      }
      pathOrUrl = body.paging?.next ?? null;
    }
    return rows;
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

  private getJson(
    urlString: string,
    token: string,
  ): Promise<InsightsResponse> {
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
              resolve(raw ? (JSON.parse(raw) as InsightsResponse) : {});
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
