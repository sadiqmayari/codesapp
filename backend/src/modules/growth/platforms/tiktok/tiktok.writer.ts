import { Injectable, Logger } from '@nestjs/common';
import * as https from 'https';
import { createHash, randomBytes } from 'crypto';
import { AdPlatformAuthError, AdPlatformRateLimitError } from '../ad-platform.types';
import {
  AdAssets,
  AdPlatformWriter,
  AnyCreateDraft,
  CreatedIds,
  EntityLevel,
  EntityPatch,
  TikTokCreateDraft,
} from '../ad-writer.types';
import { httpJson } from '../http';

const BASE = 'https://business-api.tiktok.com/open_api/v1.3';
const TOKEN_CODES = new Set([40001, 40104, 40105, 40102]);
const RATE_CODES = new Set([40100, 50002]);
const PK_LOCATION = '1168579';

interface TtResp<T> {
  code?: number;
  message?: string;
  data?: T;
}

/** TikTok bidding fields for a normalised strategy (pure, unit-tested). */
export function tiktokBid(strategy: string | undefined, amount?: number | null, roas?: number | null): Record<string, unknown> {
  if (strategy === 'LOWEST_COST_WITH_MIN_ROAS') {
    return { bid_type: 'BID_TYPE_NO_BID', deep_bid_type: 'VO_MIN_ROAS', ...(roas != null && roas > 0 ? { roas_bid: roas } : {}) };
  }
  if (strategy === 'COST_CAP') return { bid_type: 'BID_TYPE_CUSTOM', ...(amount != null && amount > 0 ? { conversion_bid_price: amount } : {}) };
  if (strategy === 'LOWEST_COST_WITH_BID_CAP') return { bid_type: 'BID_TYPE_CUSTOM', ...(amount != null && amount > 0 ? { bid_price: amount } : {}) };
  return { bid_type: 'BID_TYPE_NO_BID' };
}

/** ISO → TikTok schedule time (UTC, "YYYY-MM-DD HH:MM:SS"). */
export function ttTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Bad date ${iso}`);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export type TikTokCall = { path: string; body: Record<string, unknown> };

/**
 * Normalised patch → TikTok API calls for one object (pure + unit-tested; the
 * TikTok twin of metaFields). Money goes out in major units.
 */
export function tiktokOps(level: EntityLevel, id: string, advertiserId: string, p: EntityPatch): TikTokCall[] {
  const calls: TikTokCall[] = [];
  const adv = { advertiser_id: advertiserId };
  if (p.status) {
    const status = p.status === 'ACTIVE' ? 'ENABLE' : 'DISABLE';
    if (level === 'campaign') calls.push({ path: '/campaign/status/update/', body: { ...adv, campaign_ids: [id], operation_status: status } });
    else if (level === 'adset') calls.push({ path: '/adgroup/status/update/', body: { ...adv, adgroup_ids: [id], operation_status: status } });
    else calls.push({ path: '/ad/status/update/', body: { ...adv, ad_ids: [id], operation_status: status } });
  }
  if (level === 'campaign') {
    const body: Record<string, unknown> = { ...adv, campaign_id: id };
    if (p.name != null) body.campaign_name = p.name.trim().slice(0, 512);
    if (p.dailyBudget != null) body.budget = p.dailyBudget;
    if (p.lifetimeBudget != null) body.budget = p.lifetimeBudget;
    if (Object.keys(body).length > 2) calls.push({ path: '/campaign/update/', body });
    if (p.bidStrategy || p.bidAmount != null || p.roasFloor != null || p.endTime !== undefined) {
      throw new Error('On TikTok the bid and schedule are set on the ad group.');
    }
  } else if (level === 'adset') {
    if (p.dailyBudget != null || p.lifetimeBudget != null) {
      calls.push({ path: '/adgroup/budget/update/', body: { ...adv, budget: [{ adgroup_id: id, budget: p.dailyBudget ?? p.lifetimeBudget }] } });
    }
    const body: Record<string, unknown> = { ...adv, adgroup_id: id };
    if (p.name != null) body.adgroup_name = p.name.trim().slice(0, 512);
    if (p.bidStrategy || p.bidAmount != null || p.roasFloor != null) {
      const strategy = p.bidStrategy ?? (p.roasFloor != null ? 'LOWEST_COST_WITH_MIN_ROAS' : 'COST_CAP');
      Object.assign(body, tiktokBid(strategy, p.bidAmount, p.roasFloor));
    }
    if (p.endTime !== undefined) {
      if (!p.endTime) throw new Error('TikTok ad groups with a schedule need an end time — pick a later date instead of clearing it.');
      body.schedule_end_time = ttTime(p.endTime);
    }
    if (Object.keys(body).length > 2) calls.push({ path: '/adgroup/update/', body });
  } else if (p.name != null) {
    throw new Error('TikTok ads can\'t be renamed from CodesApp.');
  }
  return calls;
}

/** Landing URL + UTMs with TikTok macros (ttclid is added by TikTok). */
export function withTikTokUtm(url: string): string {
  try {
    const u = new URL(url.trim());
    if (!u.searchParams.has('utm_source')) u.searchParams.set('utm_source', 'tiktok');
    if (!u.searchParams.has('utm_medium')) u.searchParams.set('utm_medium', 'paid');
    if (!u.searchParams.has('utm_campaign')) u.searchParams.set('utm_campaign', '__CAMPAIGN_ID__');
    if (!u.searchParams.has('utm_term')) u.searchParams.set('utm_term', '__AID__');
    if (!u.searchParams.has('utm_content')) u.searchParams.set('utm_content', '__CID__');
    return u.toString();
  } catch {
    return url.trim();
  }
}

export function validateTikTokDraft(d: TikTokCreateDraft): string[] {
  const e: string[] = [];
  if (!d.name?.trim()) e.push('Name the campaign.');
  if (!(d.budget > 0)) e.push('Enter a budget.');
  if (d.budgetType === 'lifetime' && !d.endTime) e.push('A lifetime budget needs an end date.');
  if (d.endTime && d.startTime && new Date(d.endTime) <= new Date(d.startTime)) e.push('The end date must be after the start.');
  if (!/^https?:\/\//i.test(d.url ?? '')) e.push('Add the landing page URL (https://…).');
  if (!d.videoId) e.push('Add a video.');
  if (!d.adText?.trim()) e.push('Write the ad text.');
  if ((d.adText ?? '').length > 100) e.push('TikTok ad text can be at most 100 characters.');
  if (!d.locationIds?.length) e.push('Pick at least one location.');
  if (!d.identityId && !d.displayName?.trim()) e.push('Pick an identity or enter a display name.');
  if (d.objective === 'WEB_CONVERSIONS' && !d.pixelId) e.push('Choose the TikTok pixel.');
  if (d.bidStrategy === 'COST_CAP' && !(Number(d.bidAmount) > 0)) e.push('Enter the cost cap.');
  if (d.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS' && !(Number(d.roasFloor) > 0)) e.push('Enter the minimum ROAS.');
  return e;
}

/** TikTok Marketing API writes. Everything it creates is DISABLED (paused). */
@Injectable()
export class TikTokWriter implements AdPlatformWriter {
  readonly platform = 'tiktok' as const;
  private readonly logger = new Logger(TikTokWriter.name);
  private readonly regionCache = new Map<string, { at: number; rows: Array<{ id: string; name: string; level: string; parent: string | null }> }>();

  private check<T>(res: { status: number; body: TtResp<T> }): T {
    const code = res.body.code ?? (res.status >= 400 ? res.status : 0);
    if (code !== 0) {
      if (RATE_CODES.has(code)) throw new AdPlatformRateLimitError('TikTok is rate-limiting; try again in a few minutes.', 10 * 60_000);
      if (TOKEN_CODES.has(code)) throw new AdPlatformAuthError('TikTok rejected the access token. Reconnect the account.', 'token', code);
      throw new AdPlatformAuthError(res.body.message ?? `TikTok API error ${code}`, 'other', code);
    }
    return res.body.data as T;
  }

  private async get<T>(token: string, path: string): Promise<T> {
    return this.check(await httpJson<TtResp<T>>('GET', `${BASE}${path}`, { 'Access-Token': token }));
  }

  private async post<T>(token: string, path: string, body: Record<string, unknown>): Promise<T> {
    return this.check(await httpJson<TtResp<T>>('POST', `${BASE}${path}`, { 'Access-Token': token }, body));
  }

  private adv(externalId?: string): string {
    if (!externalId) throw new AdPlatformAuthError('Missing TikTok advertiser id.', 'other');
    return externalId;
  }

  async checkWriteAccess(token: string, externalId?: string) {
    const adv = this.adv(externalId);
    const q = `advertiser_ids=${encodeURIComponent(JSON.stringify([adv]))}&fields=${encodeURIComponent(JSON.stringify(['role', 'status']))}`;
    const data = await this.get<{ list?: Array<{ role?: string; status?: string }> }>(token, `/advertiser/info/?${q}`);
    const a = data?.list?.[0];
    const status = a?.status ?? '';
    if (/DISABLE|PUNISH|LIMIT/i.test(status)) return { ok: false, granted: [], missing: [`an active advertiser (TikTok says ${status})`] };
    return { ok: true, granted: ['ads management'], missing: [] };
  }

  validatePatch(level: EntityLevel, p: EntityPatch, e: { objective: string | null; destination_type: string | null; name: string | null }): string | null {
    if (p.optimizationGoal || p.conversionEvent || p.attributionWindow) return 'Change the optimisation goal in TikTok Ads Manager — TikTok locks it after creation.';
    if (level === 'campaign' && (p.bidStrategy || p.bidAmount != null || p.roasFloor != null)) return 'On TikTok the bid is set on the ad group.';
    if (level !== 'adset' && p.endTime !== undefined) return 'On TikTok the schedule is set on the ad group.';
    if (level === 'ad' && p.name != null) return 'TikTok ads can\'t be renamed from CodesApp.';
    if (/SMART|UPGRADED/i.test(e.objective ?? '') && (p.dailyBudget != null || p.bidStrategy)) return 'Smart+ campaigns are managed in TikTok Ads Manager.';
    return null;
  }

  async update(token: string, level: EntityLevel, id: string, patch: EntityPatch, _currency: string | null, externalId?: string) {
    let calls: TikTokCall[];
    try {
      calls = tiktokOps(level, id, this.adv(externalId), patch);
    } catch (e) {
      throw new AdPlatformAuthError((e as Error).message, 'other');
    }
    for (const c of calls) await this.post(token, c.path, c.body);
  }

  /** TikTok has no copy API: rebuild an ad group (or a campaign with its ad groups) with the same ads, DISABLED. */
  async copy(token: string, level: EntityLevel, id: string, externalId?: string): Promise<string> {
    const adv = this.adv(externalId);
    if (level === 'ad') throw new AdPlatformAuthError('Duplicate the ad group instead — single TikTok ads can\'t be copied.', 'other');
    const filter = (k: string, ids: string[]) => `filtering=${encodeURIComponent(JSON.stringify({ [k]: ids }))}`;
    const list = <T>(path: string) => this.get<{ list?: T[] }>(token, path).then((d) => d?.list ?? []);
    let campaignId: string;
    if (level === 'campaign') {
      const [c] = await list<Record<string, unknown>>(`/campaign/get/?advertiser_id=${adv}&${filter('campaign_ids', [id])}`);
      if (!c) throw new AdPlatformAuthError('Campaign not found on TikTok.', 'other');
      if (/SMART|UPGRADED/i.test(String(c.campaign_type ?? c.objective_type ?? ''))) throw new AdPlatformAuthError('Smart+ campaigns can\'t be copied from CodesApp.', 'other');
      const made = await this.post<{ campaign_id?: string }>(token, '/campaign/create/', {
        advertiser_id: adv,
        campaign_name: `${String(c.campaign_name ?? 'Campaign')} — copy`.slice(0, 512),
        objective_type: c.objective_type,
        budget_mode: c.budget_mode,
        ...(c.budget_mode !== 'BUDGET_MODE_INFINITE' ? { budget: c.budget } : {}),
        ...(c.budget_optimize_on ? { budget_optimize_on: true } : {}),
        operation_status: 'DISABLE',
      });
      if (!made.campaign_id) throw new AdPlatformAuthError('TikTok did not return the new campaign id.', 'other');
      campaignId = String(made.campaign_id);
    }
    const groupFilter = level === 'campaign' ? filter('campaign_ids', [id]) : filter('adgroup_ids', [id]);
    const groups = await list<Record<string, unknown>>(`/adgroup/get/?advertiser_id=${adv}&${groupFilter}`);
    if (!groups.length) throw new AdPlatformAuthError('Ad group not found on TikTok.', 'other');
    let firstGroup: string | null = null;
    const skip = new Set(['adgroup_id', 'create_time', 'modify_time', 'secondary_status', 'is_new_structure', 'is_smart_performance_campaign', 'statistic_type', 'actions', 'adgroup_app_profile_page_state', 'operation_status', 'campaign_name']);
    for (const g of groups) {
      const body: Record<string, unknown> = { advertiser_id: adv };
      for (const [k, v] of Object.entries(g)) if (!skip.has(k) && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) body[k] = v;
      if (level === 'campaign') body.campaign_id = campaignId!;
      body.adgroup_name = `${String(g.adgroup_name ?? 'Ad group')}${level === 'adset' ? ' — copy' : ''}`.slice(0, 512);
      body.operation_status = 'DISABLE';
      // A schedule that already ended can't be reused: run from now, keep the length.
      if (body.schedule_type === 'SCHEDULE_START_END' && typeof g.schedule_end_time === 'string' && new Date(`${g.schedule_end_time}Z`).getTime() < Date.now() + 3_600_000) {
        body.schedule_type = 'SCHEDULE_FROM_NOW';
        delete body.schedule_end_time;
        body.schedule_start_time = ttTime(new Date(Date.now() + 10 * 60_000).toISOString());
      }
      const made = await this.post<{ adgroup_id?: string }>(token, '/adgroup/create/', body);
      const gid = made.adgroup_id ? String(made.adgroup_id) : null;
      if (!gid) throw new AdPlatformAuthError('TikTok did not return the new ad group id.', 'other');
      firstGroup ??= gid;
      const ads = await list<Record<string, unknown>>(`/ad/get/?advertiser_id=${adv}&${filter('adgroup_ids', [String(g.adgroup_id)])}`);
      const creatives = ads
        .filter((a) => a.operation_status !== 'DELETE')
        .map((a) => {
          const keep = ['ad_name', 'identity_type', 'identity_id', 'identity_authorized_bc_id', 'ad_format', 'video_id', 'image_ids', 'ad_text', 'call_to_action', 'landing_page_url', 'display_name', 'avatar_icon_web_uri', 'tiktok_item_id', 'deeplink'];
          const c: Record<string, unknown> = {};
          for (const k of keep) if (a[k] != null && a[k] !== '') c[k] = a[k];
          return c;
        })
        .slice(0, 20);
      if (creatives.length) await this.post(token, '/ad/create/', { advertiser_id: adv, adgroup_id: gid, creatives });
    }
    return level === 'campaign' ? campaignId! : firstGroup!;
  }

  async listAssets(token: string, externalId: string): Promise<AdAssets> {
    const adv = this.adv(externalId);
    const safe = async <T>(p: Promise<T>, fb: T) => p.catch((e) => {
      this.logger.warn(`tiktok assets: ${(e as Error).message}`);
      return fb;
    });
    const [px, ids, vids] = await Promise.all([
      safe(this.get<{ pixels?: Array<{ pixel_id?: string | number; pixel_name?: string }> }>(token, `/pixel/list/?advertiser_id=${adv}&page_size=20`), {}),
      safe(this.get<{ identity_list?: Array<{ identity_id?: string; identity_type?: string; display_name?: string; profile_image?: string }> }>(token, `/identity/get/?advertiser_id=${adv}&page_size=50`), {}),
      safe(this.get<{ list?: Array<{ video_id?: string; file_name?: string; video_cover_url?: string; poster_url?: string; duration?: number }> }>(token, `/file/video/ad/search/?advertiser_id=${adv}&page_size=30`), {}),
    ]);
    return {
      pages: [],
      instagram: [],
      pixels: ((px as { pixels?: Array<{ pixel_id?: string | number; pixel_name?: string }> }).pixels ?? []).map((p) => ({ id: String(p.pixel_id), name: p.pixel_name ?? String(p.pixel_id) })),
      identities: ((ids as { identity_list?: Array<{ identity_id?: string; identity_type?: string; display_name?: string; profile_image?: string }> }).identity_list ?? [])
        .filter((i) => i.identity_id)
        .map((i) => ({ id: String(i.identity_id), type: i.identity_type ?? 'CUSTOMIZED_USER', name: i.display_name ?? null, avatar: i.profile_image ?? null })),
      videos: ((vids as { list?: Array<{ video_id?: string; file_name?: string; video_cover_url?: string; poster_url?: string; duration?: number }> }).list ?? [])
        .filter((v) => v.video_id)
        .map((v) => ({ id: String(v.video_id), name: v.file_name ?? null, cover: v.video_cover_url ?? v.poster_url ?? null, durationS: v.duration != null ? Math.round(v.duration) : null })),
    };
  }

  private multipart(token: string, path: string, fields: Record<string, string>, file: { name: string; field: string; bytes: Buffer; type: string }) {
    const boundary = `----codesapp${randomBytes(8).toString('hex')}`;
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name.replace(/"/g, '')}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);
    return new Promise<unknown>((resolve, reject) => {
      const u = new URL(`${BASE}${path}`);
      const req = https.request(
        { method: 'POST', hostname: u.hostname, path: u.pathname, timeout: 600_000, headers: { 'Access-Token': token, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => {
            try {
              resolve(this.check({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('TikTok upload timed out'));
      });
      req.write(body);
      req.end();
    });
  }

  async uploadImage(token: string, externalId: string, bytes: Buffer, filename: string): Promise<string> {
    const md5 = createHash('md5').update(bytes).digest('hex');
    const data = (await this.multipart(token, '/file/image/ad/upload/', { advertiser_id: this.adv(externalId), upload_type: 'UPLOAD_BY_FILE', image_signature: md5 }, { name: filename, field: 'image_file', bytes, type: 'image/jpeg' })) as { image_id?: string };
    if (!data?.image_id) throw new AdPlatformAuthError('TikTok did not return the image id.', 'other');
    return data.image_id;
  }

  async uploadVideo(token: string, externalId: string, bytes: Buffer, filename: string): Promise<string> {
    const md5 = createHash('md5').update(bytes).digest('hex');
    const data = (await this.multipart(token, '/file/video/ad/upload/', { advertiser_id: this.adv(externalId), upload_type: 'UPLOAD_BY_FILE', video_signature: md5, file_name: `${filename.slice(0, 80)}-${Date.now()}` }, { name: filename, field: 'video_file', bytes, type: 'video/mp4' })) as Array<{ video_id?: string }> | { video_id?: string };
    const id = Array.isArray(data) ? data[0]?.video_id : data?.video_id;
    if (!id) throw new AdPlatformAuthError('TikTok did not return the video id.', 'other');
    return id;
  }

  /** Location search over TikTok's region list (cached 6 h per advertiser). */
  async searchCities(token: string, query: string, _country: string, externalId?: string) {
    const adv = externalId ?? '';
    let hit = this.regionCache.get(adv);
    if (!hit || Date.now() - hit.at > 6 * 3_600_000) {
      const q = `advertiser_id=${adv}&placements=${encodeURIComponent(JSON.stringify(['PLACEMENT_TIKTOK']))}&objective_type=WEB_CONVERSIONS&level_range=TO_CITY`;
      const data = await this.get<{ region_info?: Array<{ location_id?: string | number; name?: string; region_level?: string; parent_id?: string | number }> }>(token, `/tool/region/?${q}`).catch(() => ({ region_info: [] }));
      hit = {
        at: Date.now(),
        rows: (data.region_info ?? []).map((r) => ({ id: String(r.location_id), name: r.name ?? '', level: r.region_level ?? '', parent: r.parent_id != null ? String(r.parent_id) : null })),
      };
      this.regionCache.set(adv, hit);
    }
    const needle = query.toLowerCase();
    return hit.rows.filter((r) => r.name.toLowerCase().includes(needle)).slice(0, 15).map((r) => ({ key: r.id, name: r.name, region: r.level.replace(/_/g, ' ').toLowerCase() }));
  }

  validateDraft(d: AnyCreateDraft): string[] {
    if ((d as TikTokCreateDraft).platform !== 'tiktok') return ['This builder draft is not for TikTok.'];
    return validateTikTokDraft(d as TikTokCreateDraft);
  }

  async createAll(token: string, externalId: string, draft: AnyCreateDraft, _currency: string | null, onStep: (ids: CreatedIds) => void) {
    const d = draft as TikTokCreateDraft;
    const adv = this.adv(externalId);
    const ids: CreatedIds = {};
    const budgetMode = d.budgetType === 'lifetime' ? 'BUDGET_MODE_TOTAL' : 'BUDGET_MODE_DAY';
    const camp = await this.post<{ campaign_id?: string }>(token, '/campaign/create/', {
      advertiser_id: adv,
      campaign_name: d.name.trim().slice(0, 512),
      objective_type: d.objective,
      ...(d.cbo ? { budget_optimize_on: true, budget_mode: budgetMode, budget: d.budget } : { budget_mode: 'BUDGET_MODE_INFINITE' }),
      operation_status: 'DISABLE',
    });
    if (!camp.campaign_id) throw new AdPlatformAuthError('TikTok did not return the campaign id.', 'other');
    ids.campaignId = String(camp.campaign_id);
    onStep({ ...ids });
    let identityId = d.identityId ?? null;
    let identityType = d.identityType ?? 'CUSTOMIZED_USER';
    if (!identityId) {
      const made = await this.post<{ identity_id?: string }>(token, '/identity/create/', { advertiser_id: adv, display_name: (d.displayName ?? d.name).trim().slice(0, 40) });
      identityId = made.identity_id ? String(made.identity_id) : null;
      identityType = 'CUSTOMIZED_USER';
      if (!identityId) throw new AdPlatformAuthError('TikTok did not create the identity.', 'other');
    }
    const optimization =
      d.objective === 'WEB_CONVERSIONS'
        ? { optimization_goal: d.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS' ? 'VALUE' : 'CONVERT', pixel_id: d.pixelId, optimization_event: d.conversionEvent || 'SHOPPING', billing_event: 'OCPM' }
        : d.objective === 'TRAFFIC'
          ? { optimization_goal: 'CLICK', billing_event: 'CPC' }
          : { optimization_goal: 'ENGAGED_VIEW', billing_event: 'CPV' };
    const start = d.startTime && new Date(d.startTime).getTime() > Date.now() + 5 * 60_000 ? d.startTime : new Date(Date.now() + 10 * 60_000).toISOString();
    const group = await this.post<{ adgroup_id?: string }>(token, '/adgroup/create/', {
      advertiser_id: adv,
      campaign_id: ids.campaignId,
      adgroup_name: `${d.name.trim().slice(0, 480)} — ad group`,
      promotion_type: 'WEBSITE',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      location_ids: d.locationIds.length ? d.locationIds : [PK_LOCATION],
      ...(d.excludeLocationIds?.length ? { excluded_location_ids: d.excludeLocationIds } : {}),
      ...(d.ageGroups?.length ? { age_groups: d.ageGroups } : {}),
      gender: d.gender ?? 'GENDER_UNLIMITED',
      ...(d.cbo ? {} : { budget_mode: budgetMode, budget: d.budget }),
      schedule_type: d.endTime ? 'SCHEDULE_START_END' : 'SCHEDULE_FROM_NOW',
      schedule_start_time: ttTime(start),
      ...(d.endTime ? { schedule_end_time: ttTime(d.endTime) } : {}),
      pacing: 'PACING_MODE_SMOOTH',
      ...optimization,
      ...tiktokBid(d.bidStrategy, d.bidAmount, d.roasFloor),
      operation_status: 'DISABLE',
    });
    if (!group.adgroup_id) throw new AdPlatformAuthError('TikTok did not return the ad group id.', 'other');
    ids.adsetId = String(group.adgroup_id);
    onStep({ ...ids });
    // SINGLE_VIDEO needs a cover image: TikTok's own poster of the uploaded video.
    const info = await this.get<{ list?: Array<{ video_cover_url?: string; poster_url?: string }> }>(token, `/file/video/ad/info/?advertiser_id=${adv}&video_ids=${encodeURIComponent(JSON.stringify([d.videoId]))}`);
    const cover = info?.list?.[0]?.video_cover_url ?? info?.list?.[0]?.poster_url;
    let imageIds: string[] = [];
    if (cover) {
      const img = await this.post<{ image_id?: string }>(token, '/file/image/ad/upload/', { advertiser_id: adv, upload_type: 'UPLOAD_BY_URL', image_url: cover }).catch(() => ({ image_id: undefined }));
      if (img.image_id) imageIds = [img.image_id];
    }
    const ad = await this.post<{ ad_ids?: string[] }>(token, '/ad/create/', {
      advertiser_id: adv,
      adgroup_id: ids.adsetId,
      creatives: [
        {
          ad_name: d.name.trim().slice(0, 512),
          identity_type: identityType,
          identity_id: identityId,
          ad_format: 'SINGLE_VIDEO',
          video_id: d.videoId,
          ...(imageIds.length ? { image_ids: imageIds } : {}),
          ad_text: d.adText.trim().slice(0, 100),
          call_to_action: d.cta || 'SHOP_NOW',
          landing_page_url: withTikTokUtm(d.url),
        },
      ],
    });
    ids.adId = ad.ad_ids?.[0] ? String(ad.ad_ids[0]) : '';
    ids.creativeId = d.videoId;
    onStep({ ...ids });
    return { campaignId: ids.campaignId, adsetId: ids.adsetId, creativeId: ids.creativeId ?? '', adId: ids.adId ?? '' };
  }
}
