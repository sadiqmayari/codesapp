import { digits, fromMicros, gStatus, gaqlDate, googleErrorOf, mapGoogleError, normaliseBidding, parseGoogleToken, serializeGoogleToken, toMicros } from './google-ads.client';
import { campaignResiduals, creativeOf, insightOf } from './google.adapter';
import { biddingFor, googleCreateOps, googleOps, validateGoogleDraft, withGoogleUtm } from './google.writer';
import { flattenHierarchy } from './google-oauth.service';
import { AdPlatformAuthError, AdPlatformRateLimitError } from '../ad-platform.types';
import { GoogleCreateDraft } from '../ad-writer.types';

describe('google token + units', () => {
  it('round-trips the stored token and accepts a bare refresh token', () => {
    const s = serializeGoogleToken({ r: 'rt', l: '123-456-7890', c: '111-222-3333' });
    expect(parseGoogleToken(s)).toEqual({ r: 'rt', l: '1234567890', c: '1112223333' });
    expect(parseGoogleToken('  1//legacy ')).toEqual({ r: '1//legacy', l: null, c: null });
  });
  it('micros + digits + dates', () => {
    expect(toMicros(1500.5)).toBe(1_500_500_000);
    expect(fromMicros('2500000')).toBe(2.5);
    expect(fromMicros(null)).toBeNull();
    expect(digits('act-12 3')).toBe('123');
    expect(gaqlDate('2026-11-27')).toBe('2026-11-27');
    expect(() => gaqlDate("2026-11-27' OR 1=1")).toThrow();
  });
  it('status vocabulary', () => {
    expect(gStatus('ENABLED')).toBe('ACTIVE');
    expect(gStatus('PAUSED')).toBe('PAUSED');
    expect(gStatus('REMOVED')).toBe('DELETED');
  });
});

describe('google errors', () => {
  const body = (code: Record<string, string>, http = 403) => ({ error: { code: http, message: 'x', details: [{ errors: [{ errorCode: code, message: 'detail msg' }] }] } });
  it('maps developer-token approval to a clear permission error', () => {
    const e = mapGoogleError(body({ authorizationError: 'DEVELOPER_TOKEN_NOT_APPROVED' }), 403);
    expect(e).toBeInstanceOf(AdPlatformAuthError);
    expect(e.message).toMatch(/Basic access/);
  });
  it('maps quota to rate limit and 401 to token', () => {
    expect(mapGoogleError(body({ quotaError: 'RESOURCE_EXHAUSTED' }, 429), 429)).toBeInstanceOf(AdPlatformRateLimitError);
    expect((mapGoogleError({ error: { code: 401, message: 'no' } }, 401) as AdPlatformAuthError).kind).toBe('token');
  });
  it('reads the first detail message (array body too)', () => {
    expect(googleErrorOf([body({ queryError: 'BAD' }, 400)], 400)).toEqual({ message: 'detail msg', code: 'BAD', http: 400 });
  });
});

describe('google bidding', () => {
  it('normalises Google strategies', () => {
    expect(normaliseBidding({ biddingStrategyType: 'MAXIMIZE_CONVERSIONS', maximizeConversions: { targetCpaMicros: '950000000' } }))
      .toMatchObject({ bidStrategy: 'COST_CAP', bidAmount: 950, optimizationGoal: 'OFFSITE_CONVERSIONS' });
    expect(normaliseBidding({ biddingStrategyType: 'MAXIMIZE_CONVERSION_VALUE', maximizeConversionValue: { targetRoas: 3.2 } }))
      .toMatchObject({ bidStrategy: 'LOWEST_COST_WITH_MIN_ROAS', roasFloor: 3.2, optimizationGoal: 'VALUE' });
    expect(normaliseBidding({ biddingStrategyType: 'MAXIMIZE_CONVERSIONS' }).bidStrategy).toBe('LOWEST_COST_WITHOUT_CAP');
    expect(normaliseBidding({ biddingStrategyType: 'MANUAL_CPC' }).bidStrategy).toBe('MANUAL_CPC');
  });
  it('builds the bidding object for a strategy', () => {
    expect(biddingFor('COST_CAP', 'conversions', 900)).toEqual({ field: 'maximizeConversions', value: { targetCpaMicros: '900000000' }, mask: ['maximize_conversions.target_cpa_micros'] });
    expect(biddingFor('LOWEST_COST_WITH_MIN_ROAS', 'conversions', null, 3)).toEqual({ field: 'maximizeConversionValue', value: { targetRoas: 3 }, mask: ['maximize_conversion_value.target_roas'] });
    expect(biddingFor('LOWEST_COST_WITHOUT_CAP', 'value').field).toBe('maximizeConversionValue');
  });
});

describe('googleOps', () => {
  const ctx = { customerId: '111', budgetResource: 'customers/111/campaignBudgets/9', valueFamily: false, dateField: 'date_time' as const };
  it('campaign status + budget + end date', () => {
    const ops = googleOps('campaign', '55', { status: 'PAUSED', dailyBudget: 2000, endTime: '2026-12-31T10:00:00Z' }, ctx);
    expect(ops[0]).toEqual({ campaignBudgetOperation: { update: { resourceName: 'customers/111/campaignBudgets/9', amountMicros: '2000000000' }, updateMask: 'amount_micros' } });
    expect(ops[1]).toEqual({
      campaignOperation: { update: { resourceName: 'customers/111/campaigns/55', status: 'PAUSED', endDateTime: '2026-12-31 23:59:59' }, updateMask: 'status,end_date_time' },
    });
  });
  it('clearing the end date uses Google\'s no-end sentinel; older field name', () => {
    const ops = googleOps('campaign', '55', { endTime: null }, { ...ctx, dateField: 'date' });
    expect(ops[0]).toMatchObject({ campaignOperation: { update: { endDate: '2037-12-30' }, updateMask: 'end_date' } });
  });
  it('refuses what Google cannot do', () => {
    expect(() => googleOps('campaign', '1', { dailyBudget: 5 }, { ...ctx, budgetShared: true })).toThrow(/shared budget/);
    expect(() => googleOps('campaign', '1', { bidStrategy: 'LOWEST_COST_WITH_BID_CAP' }, ctx)).toThrow(/bid cap/);
    expect(() => googleOps('adset', '1', { dailyBudget: 5 }, ctx)).toThrow(/campaign/);
    expect(() => googleOps('ad', '1', { name: 'x' }, ctx)).toThrow(/renamed/);
  });
  it('ad status uses the adGroupAd resource', () => {
    expect(googleOps('ad', '77', { status: 'ACTIVE' }, { ...ctx, adGroupId: '66' })).toEqual([
      { adGroupAdOperation: { update: { resourceName: 'customers/111/adGroupAds/66~77', status: 'ENABLED' }, updateMask: 'status' } },
    ]);
  });
});

describe('google create', () => {
  const base: GoogleCreateDraft = {
    platform: 'google', type: 'search', name: 'Brand', budget: 4000, bidStrategy: 'LOWEST_COST_WITHOUT_CAP', bidFamily: 'conversions',
    countries: ['PK'], excludeCities: [{ key: 'geoTargetConstants/1011', name: 'X' }], languages: ['en', 'ur'],
    url: 'https://shop.example/collections/lawn', headlines: ['A', 'B', 'C'], descriptions: ['d1', 'd2'], keywords: [{ text: 'lawn suits', match: 'PHRASE' }],
  };
  it('validates per type', () => {
    expect(validateGoogleDraft(base)).toEqual([]);
    expect(validateGoogleDraft({ ...base, keywords: [] })).toContain('Add at least one keyword.');
    const pmax = validateGoogleDraft({ ...base, type: 'pmax' });
    expect(pmax).toEqual(expect.arrayContaining(['Add a long headline (up to 90 characters).', 'Add the business name.', 'Add a square logo.']));
    expect(validateGoogleDraft({ ...base, headlines: ['x'.repeat(31), 'b', 'c'] })).toContain('Headlines can be at most 30 characters.');
  });
  it('search ops: paused campaign, EU declaration, geo + language, RSA + keyword', () => {
    const { ops } = googleCreateOps('111', base);
    const camp = (ops[1] as { campaignOperation: { create: Record<string, unknown> } }).campaignOperation.create;
    expect(camp).toMatchObject({ status: 'PAUSED', advertisingChannelType: 'SEARCH', containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING', maximizeConversions: {} });
    const json = JSON.stringify(ops);
    expect(json).toContain('geoTargetConstants/2586');
    expect(json).toContain('"negative":true');
    expect(json).toContain('languageConstants/1041');
    expect(json).toContain('"matchType":"PHRASE"');
    expect(json).toContain('utm_source=google');
  });
  it('pmax ops link every asset to the asset group', () => {
    const { ops } = googleCreateOps('111', { ...base, type: 'pmax', longHeadlines: ['Long one'], businessName: 'Sois', landscapeImages: ['customers/111/assets/1'], squareImages: ['customers/111/assets/2'], logoImages: ['customers/111/assets/3'], youtubeVideoIds: ['abc'] });
    const links = ops.filter((o) => (o as Record<string, unknown>).assetGroupAssetOperation).map((o) => (o as { assetGroupAssetOperation: { create: { fieldType: string } } }).assetGroupAssetOperation.create.fieldType);
    expect(links).toEqual(expect.arrayContaining(['HEADLINE', 'LONG_HEADLINE', 'DESCRIPTION', 'BUSINESS_NAME', 'MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE', 'LOGO', 'YOUTUBE_VIDEO']));
  });
  it('keeps ValueTrack braces literal in UTMs', () => {
    expect(withGoogleUtm('https://a.com/x?y=1')).toBe('https://a.com/x?y=1&utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_content={creative}');
  });
});

describe('google insights', () => {
  it('maps metrics incl. video views', () => {
    const r = insightOf('2026-11-01', 'c1', 'g1', 'a1', { costMicros: '1500000', impressions: '1000', clicks: '20', conversions: 2.6, conversionsValue: 9000, videoTrueviewViews: '310', videoQuartileP25Rate: 0.4 });
    expect(r).toMatchObject({ spend: 1.5, impressions: 1000, clicks: 20, purchases: 3, purchaseValue: 9000, thruplay: 310, video3s: 400 });
  });
  it('adds campaign-grain residuals for PMax (no ad rows) and skips rounding noise', () => {
    const ad = insightOf('2026-11-01', 'search', 'g', 'a', { costMicros: '100000000' });
    const campSearch = insightOf('2026-11-01', 'search', null, '', { costMicros: '100200000' });
    const campPmax = insightOf('2026-11-01', 'pmax', null, '', { costMicros: '500000000', conversions: 4 });
    const res = campaignResiduals([ad], [campSearch, campPmax]);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ adId: 'c:pmax', spend: 500, purchases: 4, adsetId: null });
  });
  it('finds the YouTube id behind any ad type', () => {
    const assets = new Map([['customers/1/assets/9', { youtubeId: 'vid123', imageUrl: null }]]);
    expect(creativeOf({ videoResponsiveAd: { videos: [{ asset: 'customers/1/assets/9' }] } }, assets)).toEqual({ youtubeId: 'vid123', thumb: 'https://i.ytimg.com/vi/vid123/hqdefault.jpg' });
    expect(creativeOf({ type: 'RESPONSIVE_SEARCH_AD' }, assets)).toEqual({ youtubeId: null, thumb: null });
  });
});

describe('google account picker', () => {
  it('lists manager clients under the manager and prefers direct access', () => {
    const rows = flattenHierarchy([
      { rootId: '900', rows: [
        { id: '900', name: 'MCC', currency: 'PKR', timezone: 'Asia/Karachi', manager: true, level: 0, test: false },
        { id: '111', name: 'Sois', currency: 'PKR', timezone: 'Asia/Karachi', manager: false, level: 1, test: false },
        { id: '222', name: 'Bin Ali', currency: 'PKR', timezone: 'Asia/Karachi', manager: false, level: 1, test: false },
      ] },
      { rootId: '222', rows: [{ id: '222', name: 'Bin Ali', currency: 'PKR', timezone: 'Asia/Karachi', manager: false, level: 0, test: false }] },
    ]);
    expect(rows.find((r) => r.customerId === '900')?.isManager).toBe(true);
    expect(rows.find((r) => r.customerId === '111')).toMatchObject({ loginCustomerId: '900', managerName: 'MCC' });
    expect(rows.find((r) => r.customerId === '222')).toMatchObject({ loginCustomerId: null });
  });
});
