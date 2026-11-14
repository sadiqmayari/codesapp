import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as https from 'https';
import { randomBytes } from 'crypto';
import { AdPlatformAuthError, AdPlatformRateLimitError } from '../ad-platform.types';
import {
  AdAssets,
  AdPlatformWriter,
  AttributionWindow,
  CreateDraft,
  CreatedIds,
  EntityLevel,
  EntityPatch,
  toMinor,
} from '../ad-writer.types';

const TIMEOUT_MS = 120_000;
const THROTTLE = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80014]);
const TOKEN = new Set([190, 102, 463, 467]);
const PERMISSION = new Set([10, 200, 294]);

interface GraphError {
  message?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
}

const CTA: Record<string, string> = {
  'Shop now': 'SHOP_NOW',
  'Order now': 'ORDER_NOW',
  'Learn more': 'LEARN_MORE',
  'Buy now': 'BUY_NOW',
  'Get offer': 'GET_OFFER',
  'Send WhatsApp message': 'WHATSAPP_MESSAGE',
};

export function attributionSpec(w: AttributionWindow) {
  if (w === '1d_click') return [{ event_type: 'CLICK_THROUGH', window_days: 1 }];
  if (w === '7d_click') return [{ event_type: 'CLICK_THROUGH', window_days: 7 }];
  return [
    { event_type: 'CLICK_THROUGH', window_days: 7 },
    { event_type: 'VIEW_THROUGH', window_days: 1 },
  ];
}

/**
 * Map a normalised patch to Meta Graph fields for a level. Pure + exported for
 * unit tests. Campaigns use `stop_time`, ad sets `end_time`; ROAS floors are
 * sent ×10000 inside `bid_constraints`; money goes out in minor units.
 */
export function metaFields(level: EntityLevel, p: EntityPatch, currency: string | null): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (p.status) f.status = p.status;
  if (p.name != null) f.name = p.name.trim().slice(0, 400);
  if (level === 'ad') return f;
  if (p.dailyBudget != null) f.daily_budget = toMinor(p.dailyBudget, currency);
  if (p.lifetimeBudget != null) f.lifetime_budget = toMinor(p.lifetimeBudget, currency);
  if (p.bidStrategy) f.bid_strategy = p.bidStrategy;
  if (level === 'adset') {
    if (p.bidAmount != null) f.bid_amount = toMinor(p.bidAmount, currency);
    if (p.roasFloor != null) f.bid_constraints = { roas_average_floor: Math.round(p.roasFloor * 10_000) };
    if (p.optimizationGoal) f.optimization_goal = p.optimizationGoal;
    if (p.attributionWindow) f.attribution_spec = attributionSpec(p.attributionWindow);
    if (p.endTime !== undefined) f.end_time = p.endTime ?? 0;
  } else if (p.endTime !== undefined) {
    f.stop_time = p.endTime ?? 0;
  }
  return f;
}

/** Turn Meta's error into one sentence a store owner can act on. */
function friendly(err: GraphError): string {
  const msg = err.error_user_msg || err.message || 'Meta rejected the change.';
  const title = err.error_user_title ? `${err.error_user_title}: ` : '';
  if (/budget.*(too low|minimum|at least)/i.test(msg)) return `${title}${msg} (Meta's minimum budget for this goal).`;
  return `${title}${msg}`.slice(0, 900);
}

/** Meta Marketing API writes. Every object it creates is PAUSED. */
@Injectable()
export class MetaWriter implements AdPlatformWriter {
  readonly platform = 'meta' as const;
  private readonly logger = new Logger(MetaWriter.name);
  private readonly version: string;

  constructor(config: ConfigService) {
    this.version = config.get<string>('META_GRAPH_VERSION') ?? 'v19.0';
  }

  private act(id: string) {
    return id.startsWith('act_') ? id : `act_${id}`;
  }

  async checkWriteAccess(token: string) {
    const body = await this.call<{ data?: Array<{ permission: string; status: string }> }>('GET', '/me/permissions', token);
    const granted = (body.data ?? []).filter((p) => p.status === 'granted').map((p) => p.permission);
    // System User tokens don't always list permissions; an empty list is "unknown", not "missing".
    if (!granted.length) return { ok: true, granted, missing: [] };
    const need = ['ads_management'];
    const missing = need.filter((p) => !granted.includes(p));
    return { ok: missing.length === 0, granted, missing };
  }

  async update(token: string, level: EntityLevel, id: string, patch: EntityPatch, currency: string | null) {
    const fields = metaFields(level, patch, currency);
    if (patch.conversionEvent && level === 'adset') {
      // promoted_object must be sent whole: keep the pixel, swap the event.
      const cur = await this.call<{ promoted_object?: Record<string, unknown> }>('GET', `/${id}?fields=promoted_object`, token);
      fields.promoted_object = { ...(cur.promoted_object ?? {}), custom_event_type: patch.conversionEvent };
    }
    if (!Object.keys(fields).length) return;
    await this.call('POST', `/${id}`, token, fields);
  }

  async copy(token: string, level: EntityLevel, id: string): Promise<string> {
    const body = await this.call<{ copied_campaign_id?: string; copied_adset_id?: string; copied_ad_id?: string; ad_object_ids?: Array<{ copied_id?: string }> }>(
      'POST',
      `/${id}/copies`,
      token,
      level === 'ad' ? { status_option: 'PAUSED' } : { deep_copy: true, status_option: 'PAUSED' },
    );
    const newId = body.copied_campaign_id ?? body.copied_adset_id ?? body.copied_ad_id ?? body.ad_object_ids?.[0]?.copied_id;
    if (!newId) throw new AdPlatformAuthError('Meta did not return the new copy id.', 'other');
    return newId;
  }

  async listAssets(token: string, externalId: string): Promise<AdAssets> {
    const acct = this.act(externalId);
    const safe = async <T>(p: Promise<T>, fb: T) => p.catch((e) => {
      this.logger.warn(`assets: ${(e as Error).message}`);
      return fb;
    });
    type IgRow = { id: string; username: string };
    type PageRow = { id: string; name: string; instagram_business_account?: IgRow };
    type List<T> = { data?: T[] };
    // Business Instagram accounts hang off the PAGE (instagram_business_account);
    // the ad account edges only list IG accounts attached to the ad account itself.
    const [pages, ig, connected, pixels] = await Promise.all([
      safe(this.call<List<PageRow>>('GET', `/${acct}/promote_pages?fields=id,name,instagram_business_account{id,username}&limit=100`, token), {} as List<PageRow>),
      safe(this.call<List<IgRow>>('GET', `/${acct}/instagram_accounts?fields=id,username&limit=100`, token), {} as List<IgRow>),
      safe(this.call<List<IgRow>>('GET', `/${acct}/connected_instagram_accounts?fields=id,username&limit=100`, token), {} as List<IgRow>),
      safe(this.call<List<{ id: string; name: string }>>('GET', `/${acct}/adspixels?fields=id,name&limit=100`, token), {} as List<{ id: string; name: string }>),
    ]);
    const igById = new Map<string, { id: string; username: string; pageId: string | null }>();
    for (const p of pages.data ?? []) {
      const a = p.instagram_business_account;
      if (a?.id) igById.set(a.id, { id: a.id, username: a.username ?? a.id, pageId: p.id });
    }
    for (const a of [...(ig.data ?? []), ...(connected.data ?? [])]) {
      if (a?.id && !igById.has(a.id)) igById.set(a.id, { id: a.id, username: a.username ?? a.id, pageId: null });
    }
    // Pages with a linked Instagram account first — those are the ones ads usually run from.
    const pageList = (pages.data ?? [])
      .map((p) => ({ id: p.id, name: p.name, instagramId: p.instagram_business_account?.id ?? null }))
      .sort((a, b) => Number(!!b.instagramId) - Number(!!a.instagramId));
    return {
      pages: pageList,
      instagram: [...igById.values()],
      pixels: pixels.data ?? [],
    };
  }

  async uploadImage(token: string, externalId: string, bytes: Buffer, filename: string): Promise<string> {
    const body = await this.call<{ images?: Record<string, { hash?: string }> }>('POST', `/${this.act(externalId)}/adimages`, token, {
      bytes: bytes.toString('base64'),
      name: filename.slice(0, 100),
    });
    const hash = Object.values(body.images ?? {})[0]?.hash;
    if (!hash) throw new AdPlatformAuthError('Meta did not accept the image.', 'other');
    return hash;
  }

  async uploadVideo(token: string, externalId: string, bytes: Buffer, filename: string): Promise<string> {
    const body = await this.multipart<{ id?: string }>(`/${this.act(externalId)}/advideos`, token, { name: filename.slice(0, 100) }, {
      field: 'source',
      filename,
      bytes,
    });
    if (!body.id) throw new AdPlatformAuthError('Meta did not accept the video.', 'other');
    return body.id;
  }

  async searchCities(token: string, query: string, country: string) {
    const q = new URLSearchParams({
      type: 'adgeolocation',
      location_types: JSON.stringify(['city']),
      q: query,
      country_code: country,
      limit: '10',
    });
    const body = await this.call<{ data?: Array<{ key: string; name: string; region?: string }> }>('GET', `/search?${q.toString()}`, token);
    return (body.data ?? []).map((c) => ({ key: String(c.key), name: c.name, region: c.region ?? '' }));
  }

  /** A video's thumbnail is required in the creative; Meta builds it after processing. */
  private async videoThumb(token: string, videoId: string): Promise<string | null> {
    for (let i = 0; i < 12; i++) {
      const v = await this.call<{ picture?: string; status?: { video_status?: string } }>('GET', `/${videoId}?fields=picture,status`, token).catch(() => null);
      if (v?.picture && v.status?.video_status !== 'processing') return v.picture;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    return null;
  }

  async createAll(token: string, externalId: string, d: CreateDraft, currency: string | null, onStep: (ids: CreatedIds) => void) {
    const acct = this.act(externalId);
    const ids: CreatedIds = {};
    const budget = d.budgetType === 'lifetime' ? { lifetime_budget: toMinor(d.budget, currency) } : { daily_budget: toMinor(d.budget, currency) };
    const bidExtra: Record<string, unknown> = {};
    if ((d.bidStrategy === 'COST_CAP' || d.bidStrategy === 'LOWEST_COST_WITH_BID_CAP') && d.bidAmount) bidExtra.bid_amount = toMinor(d.bidAmount, currency);
    if (d.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS' && d.roasFloor) bidExtra.bid_constraints = { roas_average_floor: Math.round(d.roasFloor * 10_000) };

    // 1) Campaign (PAUSED)
    const camp = await this.call<{ id: string }>('POST', `/${acct}/campaigns`, token, {
      name: d.name.slice(0, 400),
      objective: d.objective,
      status: 'PAUSED',
      special_ad_categories: [],
      buying_type: 'AUCTION',
      ...(d.cbo ? { ...budget, bid_strategy: d.bidStrategy } : {}),
    });
    ids.campaignId = camp.id;
    onStep({ ...ids });

    // 2) Ad set (PAUSED)
    const targeting: Record<string, unknown> = {
      geo_locations: { countries: d.countries.length ? d.countries : ['PK'] },
      age_min: Math.max(18, d.ageMin),
      age_max: Math.min(65, d.ageMax),
      targeting_automation: { advantage_audience: d.advantageAudience ? 1 : 0 },
    };
    if (d.excludeCities.length) targeting.excluded_geo_locations = { cities: d.excludeCities.map((c) => ({ key: c.key })) };
    if (d.genders.length === 1) targeting.genders = d.genders;
    if (!d.advantagePlacements) {
      targeting.publisher_platforms = ['facebook', 'instagram'];
      targeting.facebook_positions = ['feed', 'story', 'facebook_reels'];
      targeting.instagram_positions = ['stream', 'story', 'reels'];
    }
    const wa = d.conversionLocation === 'whatsapp';
    const promoted = wa
      ? { page_id: d.pageId, whatsapp_phone_number: (d.whatsappNumber ?? '').replace(/\D/g, '') }
      : d.pixelId
        ? { pixel_id: d.pixelId, custom_event_type: d.conversionEvent ?? 'PURCHASE' }
        : undefined;
    const set = await this.call<{ id: string }>('POST', `/${acct}/adsets`, token, {
      name: `${d.name.slice(0, 340)} · ${wa ? 'WhatsApp' : 'Website'}`,
      campaign_id: camp.id,
      status: 'PAUSED',
      billing_event: 'IMPRESSIONS',
      optimization_goal: d.optimizationGoal,
      destination_type: wa ? 'WHATSAPP' : 'WEBSITE',
      ...(promoted ? { promoted_object: promoted } : {}),
      attribution_spec: attributionSpec(d.attributionWindow),
      targeting,
      ...(d.cbo ? bidExtra : { ...budget, bid_strategy: d.bidStrategy, ...bidExtra }),
      ...(d.startTime ? { start_time: d.startTime } : {}),
      ...(d.endTime ? { end_time: d.endTime } : {}),
    });
    ids.adsetId = set.id;
    onStep({ ...ids });

    // 3) Creative — UTMs so every order from this ad is attributed in Growth.
    const ctaType = wa ? 'WHATSAPP_MESSAGE' : CTA[d.cta] ?? 'SHOP_NOW';
    const link = wa ? 'https://api.whatsapp.com/send' : /^https?:\/\//i.test(d.url ?? '') ? d.url! : `https://${d.url}`;
    const cta = wa ? { type: ctaType, value: { app_destination: 'WHATSAPP' } } : { type: ctaType, value: { link } };
    let story: Record<string, unknown>;
    if (d.videoId) {
      const thumb = await this.videoThumb(token, d.videoId);
      story = {
        page_id: d.pageId,
        video_data: {
          video_id: d.videoId,
          message: d.primaryText,
          title: d.headline,
          call_to_action: cta,
          ...(thumb ? { image_url: thumb } : d.imageHash ? { image_hash: d.imageHash } : {}),
        },
      };
    } else {
      story = {
        page_id: d.pageId,
        link_data: { link, message: d.primaryText, name: d.headline, image_hash: d.imageHash, call_to_action: cta },
      };
    }
    if (d.instagramId) story.instagram_user_id = d.instagramId;
    const creative = await this.call<{ id: string }>('POST', `/${acct}/adcreatives`, token, {
      name: `${d.name.slice(0, 380)} · creative`,
      object_story_spec: story,
      url_tags: 'utm_source=meta&utm_medium=paid&utm_campaign={{campaign.name}}&utm_term={{adset.name}}&utm_content={{ad.name}}&utm_id={{campaign.id}}',
    });
    ids.creativeId = creative.id;
    onStep({ ...ids });

    // 4) Ad (PAUSED)
    const ad = await this.call<{ id: string }>('POST', `/${acct}/ads`, token, {
      name: d.headline.slice(0, 400) || d.name.slice(0, 400),
      adset_id: set.id,
      creative: { creative_id: creative.id },
      status: 'PAUSED',
    });
    ids.adId = ad.id;
    onStep({ ...ids });
    return ids as Required<CreatedIds>;
  }

  // ── transport ──────────────────────────────────────────────────────────────
  private raise(err: GraphError): never {
    const code = err.code ?? 0;
    if (THROTTLE.has(code)) throw new AdPlatformRateLimitError('Meta API limit reached for this ad account; try again in a few minutes.', 15 * 60_000);
    if (TOKEN.has(code)) throw new AdPlatformAuthError('Meta rejected the access token. Reissue the System User token and save it in Connections.', 'token', code);
    if (PERMISSION.has(code)) {
      throw new AdPlatformAuthError(
        'Missing permission: the token needs ads_management, and the System User must be assigned to this ad account, Page and Instagram account with "create ads".',
        'permission',
        code,
      );
    }
    throw new AdPlatformAuthError(friendly(err), 'other', code);
  }

  private call<T>(method: 'GET' | 'POST', path: string, token: string, fields?: Record<string, unknown>): Promise<T> {
    const form =
      fields &&
      new URLSearchParams(
        Object.entries(fields)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
      ).toString();
    return this.send<T>(method, path, token, form ? Buffer.from(form) : undefined, form ? 'application/x-www-form-urlencoded' : undefined);
  }

  private multipart<T>(path: string, token: string, fields: Record<string, string>, file: { field: string; filename: string; bytes: Buffer }) {
    const boundary = `----codesapp${randomBytes(8).toString('hex')}`;
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename.replace(/"/g, '')}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      file.bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    );
    return this.send<T>('POST', path, token, Buffer.concat(parts), `multipart/form-data; boundary=${boundary}`);
  }

  private send<T>(method: 'GET' | 'POST', path: string, token: string, body?: Buffer, type?: string): Promise<T> {
    const url = new URL(`https://graph.facebook.com/${this.version}${path}`);
    return new Promise<T>((resolve, reject) => {
      const req = https.request(
        {
          method,
          hostname: url.hostname,
          path: url.pathname + url.search,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { 'Content-Type': type ?? 'application/x-www-form-urlencoded', 'Content-Length': String(body.length) } : {}),
          },
          timeout: TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let json: { error?: GraphError } & Record<string, unknown>;
            try {
              json = raw ? JSON.parse(raw) : {};
            } catch {
              reject(new AdPlatformAuthError(`Unexpected Meta response (${res.statusCode})`, 'other'));
              return;
            }
            if (json.error) {
              try {
                this.raise(json.error);
              } catch (e) {
                reject(e);
              }
              return;
            }
            resolve(json as T);
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Meta did not respond in time; the change may still apply — refresh before retrying.'));
      });
      if (body) req.write(body);
      req.end();
    });
  }
}
