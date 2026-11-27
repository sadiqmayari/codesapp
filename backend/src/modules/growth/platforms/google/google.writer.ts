import { Injectable, Logger } from '@nestjs/common';
import { AdPlatformAuthError } from '../ad-platform.types';
import {
  AdAssets,
  AdPlatformWriter,
  AnyCreateDraft,
  CreatedIds,
  EntityLevel,
  EntityPatch,
  GoogleCreateDraft,
} from '../ad-writer.types';
import { GoogleAdsAdapter } from './google.adapter';
import { GEO_COUNTRY, GoogleAdsClient, LANGUAGE, gaqlId, normaliseBidding, toMicros } from './google-ads.client';

/** Context the update mapper needs that isn't in the patch (looked up by the writer). */
export interface GoogleUpdateCtx {
  customerId: string;
  /** campaign_budget resource name of the campaign. */
  budgetResource?: string | null;
  budgetShared?: boolean;
  /** Current bidding family of the campaign. */
  valueFamily?: boolean;
  /** ad_group id of an ad (ad_group_ad resource = adGroupId~adId). */
  adGroupId?: string | null;
  /** 'date_time' (v2x start/end_date_time) or 'date' (older end_date). */
  dateField?: 'date_time' | 'date';
}

const NO_END = { date_time: '2037-12-30 23:59:59', date: '2037-12-30' };

/** ISO end → Google's end field value (end of that day, account clock). */
function endValue(iso: string | null | undefined, field: 'date_time' | 'date'): string {
  if (!iso) return NO_END[field];
  const d = iso.slice(0, 10);
  return field === 'date_time' ? `${d} 23:59:59` : d;
}

/** Google bidding object for a normalised strategy (+ family). */
export function biddingFor(
  strategy: string | undefined,
  family: 'conversions' | 'value',
  amount?: number | null,
  roas?: number | null,
): { field: string; value: Record<string, unknown>; mask: string[] } {
  if (strategy === 'LOWEST_COST_WITH_MIN_ROAS' || (family === 'value' && strategy !== 'COST_CAP')) {
    const v: Record<string, unknown> = {};
    if (roas != null && roas > 0) v.targetRoas = roas;
    return { field: 'maximizeConversionValue', value: v, mask: [v.targetRoas != null ? 'maximize_conversion_value.target_roas' : 'maximize_conversion_value'] };
  }
  const v: Record<string, unknown> = {};
  if (strategy === 'COST_CAP' && amount != null && amount > 0) v.targetCpaMicros = String(toMicros(amount));
  return { field: 'maximizeConversions', value: v, mask: [v.targetCpaMicros != null ? 'maximize_conversions.target_cpa_micros' : 'maximize_conversions'] };
}

/**
 * Normalised patch → Google Ads mutate operations. Pure + unit-tested
 * (the Google twin of metaFields). Throws a sentence for what Google can't do.
 */
export function googleOps(level: EntityLevel, id: string, p: EntityPatch, ctx: GoogleUpdateCtx): unknown[] {
  const c = ctx.customerId;
  const ops: unknown[] = [];
  const field = ctx.dateField ?? 'date_time';
  if (level === 'campaign') {
    const update: Record<string, unknown> = { resourceName: `customers/${c}/campaigns/${id}` };
    const mask: string[] = [];
    if (p.status) { update.status = p.status === 'ACTIVE' ? 'ENABLED' : 'PAUSED'; mask.push('status'); }
    if (p.name != null) { update.name = p.name.trim().slice(0, 255); mask.push('name'); }
    if (p.endTime !== undefined) {
      const k = field === 'date_time' ? 'endDateTime' : 'endDate';
      update[k] = endValue(p.endTime, field);
      mask.push(field === 'date_time' ? 'end_date_time' : 'end_date');
    }
    if (p.bidStrategy || p.bidAmount != null || p.roasFloor != null) {
      if (p.bidStrategy === 'LOWEST_COST_WITH_BID_CAP') throw new Error('Google Ads has no bid cap strategy — use Target CPA or Target ROAS.');
      const strategy = p.bidStrategy ?? (p.roasFloor != null ? 'LOWEST_COST_WITH_MIN_ROAS' : p.bidAmount != null ? 'COST_CAP' : undefined);
      const b = biddingFor(strategy, ctx.valueFamily ? 'value' : 'conversions', p.bidAmount, p.roasFloor);
      update[b.field] = b.value;
      mask.push(...b.mask);
    }
    if (mask.length) ops.push({ campaignOperation: { update, updateMask: mask.join(',') } });
    if (p.lifetimeBudget != null) throw new Error('Google Ads campaigns use daily budgets.');
    if (p.dailyBudget != null) {
      if (!ctx.budgetResource) throw new Error('Could not find this campaign\'s budget on Google.');
      if (ctx.budgetShared) throw new Error('This campaign uses a shared budget — change it in Google Ads → Shared library.');
      ops.unshift({ campaignBudgetOperation: { update: { resourceName: ctx.budgetResource, amountMicros: String(toMicros(p.dailyBudget)) }, updateMask: 'amount_micros' } });
    }
  } else if (level === 'adset') {
    const update: Record<string, unknown> = { resourceName: `customers/${c}/adGroups/${id}` };
    const mask: string[] = [];
    if (p.status) { update.status = p.status === 'ACTIVE' ? 'ENABLED' : 'PAUSED'; mask.push('status'); }
    if (p.name != null) { update.name = p.name.trim().slice(0, 255); mask.push('name'); }
    if (p.bidAmount != null) { update.targetCpaMicros = String(toMicros(p.bidAmount)); mask.push('target_cpa_micros'); }
    if (p.roasFloor != null) { update.targetRoas = p.roasFloor; mask.push('target_roas'); }
    if (p.dailyBudget != null || p.lifetimeBudget != null) throw new Error('On Google Ads the budget is set on the campaign.');
    if (p.bidStrategy) throw new Error('On Google Ads the bid strategy is set on the campaign.');
    if (mask.length) ops.push({ adGroupOperation: { update, updateMask: mask.join(',') } });
  } else {
    if (p.name != null) throw new Error('Google Ads ads can\'t be renamed.');
    if (p.status) {
      if (!ctx.adGroupId) throw new Error('Could not find this ad\'s ad group on Google.');
      ops.push({
        adGroupAdOperation: {
          update: { resourceName: `customers/${c}/adGroupAds/${ctx.adGroupId}~${id}`, status: p.status === 'ACTIVE' ? 'ENABLED' : 'PAUSED' },
          updateMask: 'status',
        },
      });
    }
  }
  return ops;
}

/** Final URL + UTMs (Google auto-tagging adds gclid on top). */
export function withGoogleUtm(url: string): string {
  try {
    const u = new URL(url.trim());
    if (!u.searchParams.has('utm_source')) u.searchParams.set('utm_source', 'google');
    if (!u.searchParams.has('utm_medium')) u.searchParams.set('utm_medium', 'cpc');
    if (!u.searchParams.has('utm_campaign')) u.searchParams.set('utm_campaign', '{campaignid}');
    if (!u.searchParams.has('utm_content')) u.searchParams.set('utm_content', '{creative}');
    // Google rejects encoded ValueTrack braces in final URLs: keep them literal.
    return u.toString().replace(/%7B/gi, '{').replace(/%7D/gi, '}');
  } catch {
    return url.trim();
  }
}

/** Builder rules (unit-tested) — one clear sentence each instead of a Google error. */
export function validateGoogleDraft(d: GoogleCreateDraft): string[] {
  const e: string[] = [];
  const len = (arr: string[] | undefined, max: number) => (arr ?? []).map((s) => s.trim()).filter(Boolean).filter((s) => s.length <= max);
  if (!d.name?.trim()) e.push('Name the campaign.');
  if (!(d.budget > 0)) e.push('Enter a daily budget.');
  if (!/^https?:\/\//i.test(d.url ?? '')) e.push('Add the website URL (https://…).');
  if (!d.countries?.length) e.push('Pick at least one country.');
  if (d.bidStrategy === 'COST_CAP' && !(Number(d.bidAmount) > 0)) e.push('Enter the target CPA.');
  if (d.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS' && !(Number(d.roasFloor) > 0)) e.push('Enter the target ROAS.');
  if (d.endTime && d.startTime && new Date(d.endTime) <= new Date(d.startTime)) e.push('The end date must be after the start.');
  const heads = len(d.headlines, 30);
  const descs = len(d.descriptions, 90);
  if ((d.headlines ?? []).some((h) => h.trim().length > 30)) e.push('Headlines can be at most 30 characters.');
  if ((d.descriptions ?? []).some((h) => h.trim().length > 90)) e.push('Descriptions can be at most 90 characters.');
  if (d.type === 'search') {
    if (heads.length < 3 || heads.length > 15) e.push('Search ads need 3–15 headlines.');
    if (descs.length < 2 || descs.length > 4) e.push('Search ads need 2–4 descriptions.');
    if (!(d.keywords ?? []).some((k) => k.text?.trim())) e.push('Add at least one keyword.');
  }
  if (d.type === 'pmax') {
    if (heads.length < 3 || heads.length > 15) e.push('Performance Max needs 3–15 headlines.');
    if (!len(d.longHeadlines, 90).length) e.push('Add a long headline (up to 90 characters).');
    if (descs.length < 2 || descs.length > 5) e.push('Performance Max needs 2–5 descriptions.');
    if (!descs.some((s) => s.length <= 60)) e.push('One description must be 60 characters or fewer.');
    if (!d.businessName?.trim()) e.push('Add the business name.');
    if (!d.landscapeImages?.length) e.push('Add a landscape image (1.91:1).');
    if (!d.squareImages?.length) e.push('Add a square image.');
    if (!d.logoImages?.length) e.push('Add a square logo.');
  }
  if (d.type === 'video') {
    if (!d.youtubeVideoIds?.length) e.push('Pick or upload a YouTube video.');
    if (!heads.length) e.push('Add a headline.');
    if (!len(d.longHeadlines, 90).length) e.push('Add a long headline (up to 90 characters).');
    if (!descs.length) e.push('Add a description.');
    if (!d.businessName?.trim()) e.push('Add the business name.');
    if (!d.logoImages?.length) e.push('Add a square logo.');
  }
  return e;
}

/** Whole create payload (one atomic mutate). Pure + unit-tested. */
export function googleCreateOps(cid: string, d: GoogleCreateDraft): { ops: unknown[]; campaignTemp: string } {
  const R = (kind: string, n: number) => `customers/${cid}/${kind}/-${n}`;
  const budget = R('campaignBudgets', 1);
  const campaign = R('campaigns', 2);
  const ops: unknown[] = [];
  ops.push({
    campaignBudgetOperation: {
      create: { resourceName: budget, name: `${d.name.trim().slice(0, 200)} budget ${Date.now()}`, amountMicros: String(toMicros(d.budget)), deliveryMethod: 'STANDARD', explicitlyShared: false },
    },
  });
  const family = d.bidFamily ?? (d.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS' ? 'value' : 'conversions');
  const bid = biddingFor(d.bidStrategy, family, d.bidAmount, d.roasFloor);
  const channel = d.type === 'search' ? 'SEARCH' : d.type === 'pmax' ? 'PERFORMANCE_MAX' : 'DEMAND_GEN';
  ops.push({
    campaignOperation: {
      create: {
        resourceName: campaign,
        name: d.name.trim().slice(0, 255),
        status: 'PAUSED',
        advertisingChannelType: channel,
        campaignBudget: budget,
        [bid.field]: bid.value,
        containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
        ...(d.type === 'search'
          ? { networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false, targetPartnerSearchNetwork: false } }
          : {}),
      },
    },
  });
  for (const cc of d.countries) {
    const geo = /^\d+$/.test(cc) ? cc : GEO_COUNTRY[cc.toUpperCase()];
    if (geo) ops.push({ campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant: `geoTargetConstants/${geo}` } } } });
  }
  for (const x of d.excludeCities ?? []) {
    const key = x.key.startsWith('geoTargetConstants/') ? x.key : `geoTargetConstants/${x.key}`;
    ops.push({ campaignCriterionOperation: { create: { campaign, negative: true, location: { geoTargetConstant: key } } } });
  }
  for (const l of d.languages?.length ? d.languages : ['en']) {
    const lang = LANGUAGE[l] ?? (/^\d+$/.test(l) ? l : null);
    if (lang) ops.push({ campaignCriterionOperation: { create: { campaign, language: { languageConstant: `languageConstants/${lang}` } } } });
  }
  const url = withGoogleUtm(d.url);
  const heads = d.headlines.map((h) => h.trim()).filter(Boolean);
  const longs = (d.longHeadlines ?? []).map((h) => h.trim()).filter(Boolean);
  const descs = d.descriptions.map((h) => h.trim()).filter(Boolean);
  if (d.type === 'search') {
    const ag = R('adGroups', 3);
    ops.push({ adGroupOperation: { create: { resourceName: ag, campaign, name: `${d.name.trim().slice(0, 200)} — ad group`, status: 'ENABLED', type: 'SEARCH_STANDARD' } } });
    ops.push({
      adGroupAdOperation: {
        create: { adGroup: ag, status: 'ENABLED', ad: { finalUrls: [url], responsiveSearchAd: { headlines: heads.map((text) => ({ text })), descriptions: descs.map((text) => ({ text })) } } },
      },
    });
    for (const k of d.keywords ?? []) {
      if (!k.text?.trim()) continue;
      ops.push({ adGroupCriterionOperation: { create: { adGroup: ag, status: 'ENABLED', keyword: { text: k.text.trim().slice(0, 80), matchType: k.match ?? 'BROAD' } } } });
    }
  } else if (d.type === 'pmax') {
    const group = R('assetGroups', 4);
    let n = 10;
    const links: Array<{ asset: string; fieldType: string }> = [];
    const text = (t: string, fieldType: string) => {
      const res = R('assets', n++);
      ops.push({ assetOperation: { create: { resourceName: res, textAsset: { text: t } } } });
      links.push({ asset: res, fieldType });
    };
    heads.forEach((h) => text(h, 'HEADLINE'));
    longs.forEach((h) => text(h, 'LONG_HEADLINE'));
    descs.forEach((h) => text(h, 'DESCRIPTION'));
    text((d.businessName ?? '').trim().slice(0, 25), 'BUSINESS_NAME');
    for (const v of d.youtubeVideoIds ?? []) {
      const res = R('assets', n++);
      ops.push({ assetOperation: { create: { resourceName: res, youtubeVideoAsset: { youtubeVideoId: v } } } });
      links.push({ asset: res, fieldType: 'YOUTUBE_VIDEO' });
    }
    (d.landscapeImages ?? []).forEach((a) => links.push({ asset: a, fieldType: 'MARKETING_IMAGE' }));
    (d.squareImages ?? []).forEach((a) => links.push({ asset: a, fieldType: 'SQUARE_MARKETING_IMAGE' }));
    (d.logoImages ?? []).forEach((a) => links.push({ asset: a, fieldType: 'LOGO' }));
    ops.push({ assetGroupOperation: { create: { resourceName: group, campaign, name: `${d.name.trim().slice(0, 200)} — assets`, finalUrls: [url], status: 'ENABLED' } } });
    for (const l of links) ops.push({ assetGroupAssetOperation: { create: { assetGroup: group, asset: l.asset, fieldType: l.fieldType } } });
  } else {
    const ag = R('adGroups', 3);
    ops.push({ adGroupOperation: { create: { resourceName: ag, campaign, name: `${d.name.trim().slice(0, 200)} — ad group`, status: 'ENABLED' } } });
    const vids: Array<{ asset: string }> = [];
    let n = 10;
    for (const v of d.youtubeVideoIds ?? []) {
      const res = R('assets', n++);
      ops.push({ assetOperation: { create: { resourceName: res, youtubeVideoAsset: { youtubeVideoId: v } } } });
      vids.push({ asset: res });
    }
    ops.push({
      adGroupAdOperation: {
        create: {
          adGroup: ag,
          status: 'ENABLED',
          ad: {
            name: d.name.trim().slice(0, 255),
            finalUrls: [url],
            demandGenVideoResponsiveAd: {
              headlines: heads.map((t) => ({ text: t })),
              longHeadlines: longs.map((t) => ({ text: t })),
              descriptions: descs.map((t) => ({ text: t })),
              videos: vids,
              logoImages: (d.logoImages ?? []).map((asset) => ({ asset })),
              businessName: { text: (d.businessName ?? '').trim().slice(0, 25) },
            },
          },
        },
      },
    });
  }
  return { ops, campaignTemp: campaign };
}

/** Google Ads writes through googleAds:mutate. Everything it creates is PAUSED. */
@Injectable()
export class GoogleAdsWriter implements AdPlatformWriter {
  readonly platform = 'google' as const;
  private readonly logger = new Logger(GoogleAdsWriter.name);
  private dateField: 'date_time' | 'date' = 'date_time';

  constructor(private readonly adapter: GoogleAdsAdapter) {}

  private api(token: string, externalId?: string) {
    return this.adapter.client(token, externalId);
  }

  async checkWriteAccess(token: string, externalId?: string) {
    const api = this.api(token, externalId);
    type R = { customer?: { manager?: boolean; testAccount?: boolean } };
    const rows = await api.gaql<R>('SELECT customer.manager, customer.test_account FROM customer LIMIT 1');
    if (rows[0]?.customer?.manager) return { ok: false, granted: [], missing: ['a client account (manager accounts can\'t run ads)'] };
    // Access level of the signed-in user on this account (best-effort; READ_ONLY / EMAIL_ONLY can't edit).
    try {
      type U = { customerUserAccess?: { accessRole?: string; emailAddress?: string } };
      const users = await api.gaql<U>('SELECT customer_user_access.access_role, customer_user_access.email_address FROM customer_user_access');
      const roles = new Set(users.map((u) => u.customerUserAccess?.accessRole).filter(Boolean));
      if (roles.size && ![...roles].some((r) => r === 'ADMIN' || r === 'STANDARD')) {
        return { ok: false, granted: [...roles] as string[], missing: ['Standard or Admin access'] };
      }
    } catch {
      /* the user-access report needs admin; unknown ≠ missing */
    }
    return { ok: true, granted: ['adwords'], missing: [] };
  }

  validatePatch(level: EntityLevel, p: EntityPatch, e: { objective: string | null; destination_type: string | null; name: string | null }): string | null {
    const what = e.name ?? 'This item';
    if (p.lifetimeBudget != null) return `“${what}”: Google Ads campaigns use daily budgets.`;
    if (p.bidStrategy === 'LOWEST_COST_WITH_BID_CAP') return 'Google Ads has no bid cap strategy — use Target CPA or Target ROAS.';
    if (p.optimizationGoal || p.conversionEvent || p.attributionWindow) return 'Conversion goals and attribution are set in Google Ads → Goals.';
    if (p.dailyBudget != null && e.destination_type === 'SHARED_BUDGET') return `“${what}” uses a shared budget — change it in Google Ads → Shared library.`;
    if (level === 'ad' && p.name != null) return 'Google Ads ads can\'t be renamed.';
    if (level !== 'campaign' && p.endTime !== undefined) return 'On Google Ads the end date is set on the campaign.';
    return null;
  }

  private async ctx(api: GoogleAdsClient, level: EntityLevel, id: string, p: EntityPatch): Promise<GoogleUpdateCtx> {
    const ctx: GoogleUpdateCtx = { customerId: api.customerId!, dateField: this.dateField };
    if (level === 'campaign' && (p.dailyBudget != null || p.bidStrategy || p.bidAmount != null || p.roasFloor != null)) {
      type R = { campaign?: { campaignBudget?: string; biddingStrategyType?: string }; campaignBudget?: { explicitlyShared?: boolean } };
      const [r] = await api.gaql<R>(
        `SELECT campaign.campaign_budget, campaign.bidding_strategy_type, campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${gaqlId(id)}`,
      );
      ctx.budgetResource = r?.campaign?.campaignBudget ?? null;
      ctx.budgetShared = !!r?.campaignBudget?.explicitlyShared;
      const t = r?.campaign?.biddingStrategyType ?? '';
      ctx.valueFamily = t === 'MAXIMIZE_CONVERSION_VALUE' || t === 'TARGET_ROAS';
    }
    if (level === 'ad') {
      type A = { adGroup?: { id?: string } };
      const [r] = await api.gaql<A>(`SELECT ad_group.id FROM ad_group_ad WHERE ad_group_ad.ad.id = ${gaqlId(id)} LIMIT 1`);
      ctx.adGroupId = r?.adGroup?.id ?? null;
    }
    return ctx;
  }

  async update(token: string, level: EntityLevel, id: string, patch: EntityPatch, _currency: string | null, externalId?: string) {
    const api = this.api(token, externalId);
    const ctx = await this.ctx(api, level, id, patch);
    let ops: unknown[];
    try {
      ops = googleOps(level, id, patch, ctx);
    } catch (e) {
      throw new AdPlatformAuthError((e as Error).message, 'other');
    }
    if (!ops.length) return;
    try {
      await api.mutate(ops);
    } catch (e) {
      // Older API versions name the end date field end_date: retry once with it.
      if (patch.endTime !== undefined && level === 'campaign' && this.dateField === 'date_time' && /end_date_time|Unrecognized field/i.test((e as Error).message)) {
        this.dateField = 'date';
        await api.mutate(googleOps(level, id, patch, { ...ctx, dateField: 'date' }));
        return;
      }
      throw e;
    }
  }

  /** Google has no copy API: rebuild a Search campaign / ad group, PAUSED. */
  async copy(token: string, level: EntityLevel, id: string, externalId?: string): Promise<string> {
    const api = this.api(token, externalId);
    const cid = api.customerId!;
    if (level === 'ad') throw new AdPlatformAuthError('Copy the ad group instead — single Google ads can\'t be duplicated.', 'other');
    const R = (kind: string, n: number) => `customers/${cid}/${kind}/-${n}`;
    type C = {
      campaign?: Parameters<typeof normaliseBidding>[0] & { id?: string; name?: string; advertisingChannelType?: string;
        networkSettings?: Record<string, boolean>; manualCpc?: Record<string, unknown> };
      campaignBudget?: { amountMicros?: string };
    };
    const campaignId = level === 'campaign' ? id : (await api.gaql<{ campaign?: { id?: string } }>(`SELECT campaign.id FROM ad_group WHERE ad_group.id = ${gaqlId(id)}`))[0]?.campaign?.id;
    if (!campaignId) throw new AdPlatformAuthError('Could not find the campaign on Google.', 'other');
    const [camp] = await api.gaql<C>(
      'SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.target_cpa.target_cpa_micros, ' +
        'campaign.target_roas.target_roas, campaign.maximize_conversions.target_cpa_micros, campaign.maximize_conversion_value.target_roas, ' +
        'campaign.network_settings.target_google_search, campaign.network_settings.target_search_network, campaign.network_settings.target_content_network, ' +
        `campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${gaqlId(campaignId)}`,
    );
    const channel = camp?.campaign?.advertisingChannelType;
    if (channel !== 'SEARCH' && channel !== 'DISPLAY') {
      throw new AdPlatformAuthError('Google has no copy for this campaign type — only Search and Display campaigns can be duplicated from CodesApp.', 'other');
    }
    const groupsWhere = level === 'adset' ? `ad_group.id = ${gaqlId(id)}` : `campaign.id = ${gaqlId(campaignId)} AND ad_group.status != 'REMOVED'`;
    type G = { adGroup?: { id?: string; name?: string; type?: string; cpcBidMicros?: string } };
    const groups = await api.gaql<G>(`SELECT ad_group.id, ad_group.name, ad_group.type, ad_group.cpc_bid_micros FROM ad_group WHERE ${groupsWhere}`);
    type K = { adGroup?: { id?: string }; adGroupCriterion?: { negative?: boolean; keyword?: { text?: string; matchType?: string } } };
    const kws = await api.gaql<K>(
      `SELECT ad_group.id, ad_group_criterion.negative, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion ` +
        `WHERE campaign.id = ${gaqlId(campaignId)} AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'`,
    );
    type A = { adGroup?: { id?: string }; adGroupAd?: { ad?: { finalUrls?: string[]; responsiveSearchAd?: { headlines?: Array<{ text?: string; pinnedField?: string }>; descriptions?: Array<{ text?: string; pinnedField?: string }>; path1?: string; path2?: string } } } };
    const ads = await api.gaql<A>(
      'SELECT ad_group.id, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ' +
        'ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2 FROM ad_group_ad ' +
        `WHERE campaign.id = ${gaqlId(campaignId)} AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD' AND ad_group_ad.status != 'REMOVED'`,
    );
    const ops: unknown[] = [];
    let target = `customers/${cid}/campaigns/${campaignId}`;
    if (level === 'campaign') {
      type CC = { campaignCriterion?: { negative?: boolean; location?: { geoTargetConstant?: string }; language?: { languageConstant?: string }; keyword?: { text?: string; matchType?: string } } };
      const crit = await api.gaql<CC>(
        'SELECT campaign_criterion.negative, campaign_criterion.location.geo_target_constant, campaign_criterion.language.language_constant, ' +
          `campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign.id = ${gaqlId(campaignId)}`,
      );
      const bid = normaliseBidding(camp.campaign ?? {});
      const b = bid.bidStrategy === 'LOWEST_COST_WITHOUT_CAP' || bid.bidStrategy === 'COST_CAP' || bid.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS'
        ? biddingFor(bid.bidStrategy, bid.optimizationGoal === 'VALUE' ? 'value' : 'conversions', bid.bidAmount, bid.roasFloor)
        : { field: 'manualCpc', value: {}, mask: [] };
      ops.push({ campaignBudgetOperation: { create: { resourceName: R('campaignBudgets', 1), name: `${camp.campaign?.name ?? 'Campaign'} copy budget ${Date.now()}`, amountMicros: camp.campaignBudget?.amountMicros ?? '1000000', deliveryMethod: 'STANDARD', explicitlyShared: false } } });
      target = R('campaigns', 2);
      ops.push({
        campaignOperation: {
          create: {
            resourceName: target, name: `${camp.campaign?.name ?? 'Campaign'} — copy`.slice(0, 255), status: 'PAUSED', advertisingChannelType: channel,
            campaignBudget: R('campaignBudgets', 1), [b.field]: b.value, containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
            ...(camp.campaign?.networkSettings ? { networkSettings: camp.campaign.networkSettings } : {}),
          },
        },
      });
      for (const c of crit) {
        const cc = c.campaignCriterion;
        if (!cc) continue;
        const body: Record<string, unknown> = { campaign: target, ...(cc.negative ? { negative: true } : {}) };
        if (cc.location?.geoTargetConstant) body.location = { geoTargetConstant: cc.location.geoTargetConstant };
        else if (cc.language?.languageConstant) body.language = { languageConstant: cc.language.languageConstant };
        else if (cc.keyword?.text && cc.negative) body.keyword = { text: cc.keyword.text, matchType: cc.keyword.matchType };
        else continue;
        ops.push({ campaignCriterionOperation: { create: body } });
      }
    }
    let n = 3;
    let firstGroup: string | null = null;
    for (const g of groups) {
      const gid = g.adGroup?.id;
      if (!gid) continue;
      const res = R('adGroups', n++);
      firstGroup ??= res;
      ops.push({
        adGroupOperation: {
          create: {
            resourceName: res, campaign: target, name: `${g.adGroup?.name ?? 'Ad group'}${level === 'adset' ? ' — copy' : ''}`.slice(0, 255),
            status: level === 'adset' ? 'PAUSED' : 'ENABLED', ...(g.adGroup?.type ? { type: g.adGroup.type } : {}),
            ...(g.adGroup?.cpcBidMicros ? { cpcBidMicros: g.adGroup.cpcBidMicros } : {}),
          },
        },
      });
      for (const k of kws.filter((x) => x.adGroup?.id === gid)) {
        const kw = k.adGroupCriterion?.keyword;
        if (!kw?.text) continue;
        ops.push({ adGroupCriterionOperation: { create: { adGroup: res, status: 'ENABLED', ...(k.adGroupCriterion?.negative ? { negative: true } : {}), keyword: { text: kw.text, matchType: kw.matchType ?? 'BROAD' } } } });
      }
      for (const a of ads.filter((x) => x.adGroup?.id === gid)) {
        const rsa = a.adGroupAd?.ad?.responsiveSearchAd;
        if (!rsa) continue;
        const clean = (xs?: Array<{ text?: string; pinnedField?: string }>) =>
          (xs ?? []).filter((x) => x.text).map((x) => ({ text: x.text, ...(x.pinnedField && x.pinnedField !== 'UNSPECIFIED' ? { pinnedField: x.pinnedField } : {}) }));
        ops.push({
          adGroupAdOperation: {
            create: {
              adGroup: res, status: 'ENABLED',
              ad: { finalUrls: a.adGroupAd?.ad?.finalUrls ?? [], responsiveSearchAd: { headlines: clean(rsa.headlines), descriptions: clean(rsa.descriptions), ...(rsa.path1 ? { path1: rsa.path1 } : {}), ...(rsa.path2 ? { path2: rsa.path2 } : {}) } },
            },
          },
        });
      }
    }
    const results = await api.mutate(ops);
    // Map the temp resource we care about to the real id.
    const wanted = level === 'campaign' ? '/campaigns/' : '/adGroups/';
    const real = results.find((r) => r?.includes(wanted) && !r.endsWith('/-1'));
    const newId = real?.split('/').pop();
    if (!newId) throw new AdPlatformAuthError('Google did not return the new copy id.', 'other');
    void firstGroup;
    return newId;
  }

  async listAssets(token: string, externalId: string): Promise<AdAssets> {
    const api = this.api(token, externalId);
    type C = { conversionAction?: { id?: string; name?: string; category?: string; primaryForGoal?: boolean } };
    let conversionActions: AdAssets['conversionActions'] = [];
    try {
      const rows = await api.gaqlFirst<C>([
        "SELECT conversion_action.id, conversion_action.name, conversion_action.category, conversion_action.primary_for_goal FROM conversion_action WHERE conversion_action.status = 'ENABLED'",
        "SELECT conversion_action.id, conversion_action.name, conversion_action.category FROM conversion_action WHERE conversion_action.status = 'ENABLED'",
      ]);
      conversionActions = rows
        .filter((r) => r.conversionAction?.id)
        .map((r) => ({ id: r.conversionAction!.id!, name: r.conversionAction!.name ?? '', category: r.conversionAction!.category ?? null, primary: r.conversionAction!.primaryForGoal !== false }))
        .sort((a, b) => Number(b.category === 'PURCHASE') - Number(a.category === 'PURCHASE'));
    } catch (e) {
      this.logger.warn(`google conversion actions: ${(e as Error).message}`);
    }
    return { pages: [], instagram: [], pixels: [], conversionActions };
  }

  async uploadImage(token: string, externalId: string, bytes: Buffer, filename: string): Promise<string> {
    const api = this.api(token, externalId);
    const [res] = await api.mutate([
      { assetOperation: { create: { name: `${filename.slice(0, 80)} ${Date.now()}`, type: 'IMAGE', imageAsset: { data: bytes.toString('base64') } } } },
    ]);
    if (!res) throw new AdPlatformAuthError('Google did not return the image asset.', 'other');
    return res;
  }

  async uploadVideo(): Promise<string> {
    // Google video ads play YouTube videos: AdCreateService uploads to the connected channel.
    throw new AdPlatformAuthError('Connect a YouTube channel to upload videos for Google ads.', 'other');
  }

  async searchCities(token: string, query: string, country: string) {
    const api = this.api(token);
    type S = { geoTargetConstantSuggestions?: Array<{ geoTargetConstant?: { resourceName?: string; name?: string; canonicalName?: string; targetType?: string } }> };
    const body = await api.postRoot<S>('/geoTargetConstants:suggest', { locale: 'en', countryCode: country, locationNames: { names: [query] } });
    return (body.geoTargetConstantSuggestions ?? [])
      .map((s) => s.geoTargetConstant)
      .filter((g): g is NonNullable<typeof g> => !!g?.resourceName)
      .map((g) => ({ key: g.resourceName!, name: g.name ?? '', region: g.canonicalName ?? g.targetType ?? '' }))
      .slice(0, 15);
  }

  validateDraft(d: AnyCreateDraft): string[] {
    if ((d as GoogleCreateDraft).platform !== 'google') return ['This builder draft is not for Google Ads.'];
    return validateGoogleDraft(d as GoogleCreateDraft);
  }

  async createAll(token: string, externalId: string, draft: AnyCreateDraft, currency: string | null, onStep: (ids: CreatedIds) => void) {
    const d = draft as GoogleCreateDraft;
    const api = this.api(token, externalId);
    const { ops } = googleCreateOps(api.customerId!, d);
    const results = await api.mutate(ops); // atomic on Google's side: nothing half-created
    const campaignRes = results.find((r) => r?.includes('/campaigns/'));
    const campaignId = campaignRes?.split('/').pop();
    if (!campaignId) throw new AdPlatformAuthError('Google did not return the new campaign id.', 'other');
    const adsetRes = results.find((r) => r?.includes('/adGroups/') || r?.includes('/assetGroups/'));
    const adRes = results.find((r) => r?.includes('/adGroupAds/'));
    const ids = {
      campaignId,
      adsetId: adsetRes?.split('/').pop() ?? '',
      creativeId: '',
      adId: adRes?.split('/').pop()?.split('~').pop() ?? '',
    };
    onStep(ids);
    if (d.endTime) {
      await this.update(token, 'campaign', campaignId, { endTime: d.endTime }, currency, externalId).catch((e) =>
        this.logger.warn(`google end date on ${campaignId}: ${(e as Error).message}`),
      );
    }
    return ids;
  }
}
