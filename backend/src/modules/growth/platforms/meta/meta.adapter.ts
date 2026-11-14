import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as https from 'https';
import {
  AdAccountInfo,
  AdEntityRow,
  AdInsightRow,
  AdPlatformAdapter,
  AdPlatformAuthError,
  AdPlatformRateLimitError,
} from '../ad-platform.types';
import { fromMinor } from '../ad-writer.types';

const REQUEST_TIMEOUT_MS = 90_000;
// Meta's ad-level insights endpoint is slow on big windows; a timeout or a
// transient 5xx/code 1/2 is retried with backoff before the sync gives up.
const RETRY_DELAYS_MS = [3_000, 10_000, 30_000];
const TRANSIENT_CODES = new Set([1, 2]);
class TransientMetaError extends Error {}
const MAX_PAGES = 80;
// Meta error codes → actionable categories.
const TOKEN_CODES = new Set([190, 102, 463, 467]);
const PERMISSION_CODES = new Set([200, 10, 294]);
const THROTTLE_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80014]);

// Action types, most specific first (pick ONE per metric — never sum, Meta
// reports the same purchase under several aliases).
const PURCHASE = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_web_purchase'];
const ADD_TO_CART = ['omni_add_to_cart', 'add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart'];
const CHECKOUT = ['omni_initiated_checkout', 'initiate_checkout', 'offsite_conversion.fb_pixel_initiate_checkout'];
const MESSAGING = ['onsite_conversion.messaging_conversation_started_7d'];
const VIDEO_3S = ['video_view'];

interface ActionEntry {
  action_type?: string;
  value?: string;
}
interface MetaError {
  message?: string;
  code?: number;
  error_subcode?: number;
}
interface Paged<T> {
  data?: T[];
  paging?: { next?: string };
  error?: MetaError;
}

function pick(entries: ActionEntry[] | undefined, types: string[]): number {
  if (!entries?.length) return 0;
  for (const t of types) {
    const hit = entries.find((e) => e.action_type === t);
    if (hit) return Number(hit.value ?? 0) || 0;
  }
  return 0;
}

const num = (v: unknown) => Number(v ?? 0) || 0;

/**
 * Meta Marketing API adapter (Ads Insights + campaign/adset/ad hierarchy).
 * Native https, graph.facebook.com, Bearer token, META_GRAPH_VERSION. Read-only.
 */
@Injectable()
export class MetaAdapter implements AdPlatformAdapter {
  readonly platform = 'meta' as const;
  readonly available = true;
  private readonly logger = new Logger(MetaAdapter.name);
  private readonly version: string;

  constructor(config: ConfigService) {
    this.version = config.get<string>('META_GRAPH_VERSION') ?? 'v19.0';
  }

  private act(id: string) {
    return id.startsWith('act_') ? id : `act_${id}`;
  }

  async getAccountInfo(token: string, externalId: string): Promise<AdAccountInfo> {
    const body = await this.get<{
      id?: string;
      name?: string;
      currency?: string;
      timezone_name?: string;
      error?: MetaError;
    }>(`/${this.act(externalId)}?fields=name,currency,timezone_name,account_status`, token);
    if (body.error) this.throwMeta(body.error);
    return {
      externalId: externalId.replace(/^act_/, ''),
      name: body.name ?? null,
      currency: body.currency ?? null,
      timezone: body.timezone_name ?? null,
    };
  }

  async listEntities(token: string, externalId: string, currency: string | null = null): Promise<AdEntityRow[]> {
    const acct = this.act(externalId);
    const out: AdEntityRow[] = [];
    const money = (v?: string) => fromMinor(v, currency);

    type Camp = {
      id: string; name?: string; status?: string; effective_status?: string; objective?: string;
      daily_budget?: string; lifetime_budget?: string; bid_strategy?: string; start_time?: string; stop_time?: string;
    };
    for (const c of await this.pages<Camp>(
      `/${acct}/campaigns?fields=id,name,status,effective_status,objective,daily_budget,lifetime_budget,bid_strategy,start_time,stop_time&limit=500`,
      token,
    )) {
      out.push({
        level: 'campaign',
        externalId: c.id,
        parentExternalId: null,
        campaignId: c.id,
        name: c.name ?? null,
        status: c.effective_status ?? null,
        configuredStatus: c.status ?? null,
        objective: c.objective ?? null,
        dailyBudget: money(c.daily_budget),
        lifetimeBudget: money(c.lifetime_budget),
        bidStrategy: c.bid_strategy ?? null,
        startTime: c.start_time ?? null,
        endTime: c.stop_time ?? null,
        creativeThumbUrl: null,
        destinationUrl: null,
      });
    }

    type AdSet = {
      id: string; name?: string; campaign_id?: string; status?: string; effective_status?: string;
      daily_budget?: string; lifetime_budget?: string; bid_strategy?: string; bid_amount?: string;
      bid_constraints?: { roas_average_floor?: number }; optimization_goal?: string;
      promoted_object?: { custom_event_type?: string }; destination_type?: string;
      attribution_spec?: Array<{ event_type?: string; window_days?: number }>; start_time?: string; end_time?: string;
    };
    const setFields =
      'id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,bid_strategy,bid_amount,' +
      'bid_constraints,optimization_goal,promoted_object,destination_type,attribution_spec,start_time,end_time';
    for (const a of await this.pages<AdSet>(`/${acct}/adsets?fields=${setFields}&limit=500`, token)) {
      out.push({
        level: 'adset',
        externalId: a.id,
        parentExternalId: a.campaign_id ?? null,
        campaignId: a.campaign_id ?? null,
        name: a.name ?? null,
        status: a.effective_status ?? null,
        configuredStatus: a.status ?? null,
        objective: null,
        dailyBudget: money(a.daily_budget),
        lifetimeBudget: money(a.lifetime_budget),
        bidStrategy: a.bid_strategy ?? null,
        bidAmount: money(a.bid_amount),
        roasFloor: a.bid_constraints?.roas_average_floor != null ? a.bid_constraints.roas_average_floor / 10000 : null,
        optimizationGoal: a.optimization_goal ?? null,
        conversionEvent: a.promoted_object?.custom_event_type ?? null,
        destinationType: a.destination_type ?? null,
        attributionSpec: a.attribution_spec ?? null,
        startTime: a.start_time ?? null,
        endTime: a.end_time ?? null,
        creativeThumbUrl: null,
        destinationUrl: null,
      });
    }

    type Ad = {
      id: string;
      name?: string;
      adset_id?: string;
      campaign_id?: string;
      status?: string;
      effective_status?: string;
      creative?: {
        thumbnail_url?: string;
        image_url?: string;
        object_story_spec?: {
          link_data?: { link?: string; picture?: string };
          video_data?: { image_url?: string; call_to_action?: { value?: { link?: string } } };
        };
        asset_feed_spec?: { link_urls?: Array<{ website_url?: string }> };
      };
    };
    const adFields =
      'id,name,adset_id,campaign_id,status,effective_status,' +
      'creative{thumbnail_url,image_url,object_story_spec{link_data{link,picture},video_data{image_url,call_to_action{value{link}}}},asset_feed_spec{link_urls{website_url}}}';
    for (const ad of await this.pages<Ad>(
      `/${acct}/ads?fields=${encodeURIComponent(adFields)}&thumbnail_width=320&thumbnail_height=320&limit=200`,
      token,
    )) {
      const cr = ad.creative;
      const oss = cr?.object_story_spec;
      out.push({
        level: 'ad',
        externalId: ad.id,
        parentExternalId: ad.adset_id ?? null,
        campaignId: ad.campaign_id ?? null,
        name: ad.name ?? null,
        status: ad.effective_status ?? null,
        configuredStatus: ad.status ?? null,
        objective: null,
        dailyBudget: null,
        creativeThumbUrl:
          cr?.thumbnail_url ?? cr?.image_url ?? oss?.video_data?.image_url ?? oss?.link_data?.picture ?? null,
        destinationUrl:
          oss?.link_data?.link ??
          oss?.video_data?.call_to_action?.value?.link ??
          cr?.asset_feed_spec?.link_urls?.[0]?.website_url ??
          null,
      });
    }
    return out;
  }

  async fetchInsights(
    token: string,
    externalId: string,
    since: string,
    until: string,
  ): Promise<AdInsightRow[]> {
    type Ins = {
      date_start?: string;
      campaign_id?: string;
      adset_id?: string;
      ad_id?: string;
      spend?: string;
      impressions?: string;
      reach?: string;
      clicks?: string;
      inline_link_clicks?: string;
      actions?: ActionEntry[];
      action_values?: ActionEntry[];
      video_thruplay_watched_actions?: ActionEntry[];
    };
    const fields =
      'campaign_id,adset_id,ad_id,spend,impressions,reach,clicks,inline_link_clicks,actions,action_values,video_thruplay_watched_actions';
    const path =
      `/${this.act(externalId)}/insights?level=ad&time_increment=1&limit=200` +
      `&fields=${fields}&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`;
    const rows: AdInsightRow[] = [];
    for (const d of await this.pages<Ins>(path, token)) {
      if (!d.date_start || !d.ad_id || !d.campaign_id) continue;
      rows.push({
        date: d.date_start,
        campaignId: d.campaign_id,
        adsetId: d.adset_id ?? null,
        adId: d.ad_id,
        spend: num(d.spend),
        impressions: num(d.impressions),
        reach: num(d.reach),
        clicks: num(d.clicks),
        linkClicks: num(d.inline_link_clicks),
        video3s: pick(d.actions, VIDEO_3S),
        thruplay: pick(d.video_thruplay_watched_actions, ['video_view']),
        addToCart: Math.round(pick(d.actions, ADD_TO_CART)),
        checkouts: Math.round(pick(d.actions, CHECKOUT)),
        purchases: Math.round(pick(d.actions, PURCHASE)),
        purchaseValue: pick(d.action_values, PURCHASE),
        messagingStarted: Math.round(pick(d.actions, MESSAGING)),
      });
    }
    return rows;
  }

  // ── transport ──────────────────────────────────────────────────────────────
  private async pages<T>(path: string, token: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = `https://graph.facebook.com/${this.version}${path}`;
    for (let hops = 0; url && hops < MAX_PAGES; hops++) {
      const body: Paged<T> = await this.withRetry(() => this.getUrl<Paged<T>>(url as string, token));
      if (body.error) this.throwMeta(body.error);
      out.push(...(body.data ?? []));
      url = body.paging?.next ?? null;
    }
    return out;
  }

  /** Retry timeouts / network drops / transient Meta errors; never auth or throttle errors. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const body = await fn();
        const code = (body as { error?: MetaError })?.error?.code;
        if (code != null && TRANSIENT_CODES.has(code)) throw new TransientMetaError(`Meta transient error ${code}`);
        if (code != null && THROTTLE_CODES.has(code)) {
          const err = (body as { error?: MetaError }).error ?? {};
          this.throwMeta(err);
        }
        return body;
      } catch (e) {
        const transient =
          e instanceof TransientMetaError ||
          (e instanceof Error && /timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(e.message));
        if (!transient || attempt >= RETRY_DELAYS_MS.length) {
          if (transient) throw new Error('Meta did not respond in time after several retries; the next sync will try again.');
          throw e;
        }
        this.logger.warn(`Meta request retry ${attempt + 1}: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  private get<T>(path: string, token: string) {
    return this.getUrl<T>(`https://graph.facebook.com/${this.version}${path}`, token);
  }

  private throwMeta(err: MetaError): never {
    const code = err.code ?? 0;
    if (THROTTLE_CODES.has(code)) {
      throw new AdPlatformRateLimitError(
        'Meta API usage limit reached for this ad account — sync resumes automatically.',
        30 * 60_000,
      );
    }
    if (TOKEN_CODES.has(code)) {
      throw new AdPlatformAuthError(
        'Meta rejected the access token. Reissue your System User token and save it again.',
        'token',
        code,
      );
    }
    if (PERMISSION_CODES.has(code)) {
      throw new AdPlatformAuthError(
        'The token is missing ads_read, or the System User is not assigned to this ad account.',
        'permission',
        code,
      );
    }
    throw new AdPlatformAuthError(err.message ?? 'Meta Ads API error', 'other', code);
  }

  private getUrl<T>(urlString: string, token: string): Promise<T> {
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
              resolve((raw ? JSON.parse(raw) : {}) as T);
            } catch {
              this.logger.warn(`Unparseable Meta response (${res.statusCode})`);
              reject(new AdPlatformAuthError(`Unexpected Meta response (${res.statusCode})`, 'other'));
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Meta Ads API request timed out'));
      });
      req.end();
    });
  }
}
