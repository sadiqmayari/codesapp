import { tiktokBid, tiktokOps, ttTime, validateTikTokDraft, withTikTokUtm } from './tiktok.writer';
import { ttBid, ttGoal, ttIso } from './tiktok.adapter';
import { TikTokCreateDraft } from '../ad-writer.types';

describe('tiktok bidding', () => {
  it('maps normalised strategies to TikTok fields and back', () => {
    expect(tiktokBid('COST_CAP', 700)).toEqual({ bid_type: 'BID_TYPE_CUSTOM', conversion_bid_price: 700 });
    expect(tiktokBid('LOWEST_COST_WITH_MIN_ROAS', null, 2.5)).toEqual({ bid_type: 'BID_TYPE_NO_BID', deep_bid_type: 'VO_MIN_ROAS', roas_bid: 2.5 });
    expect(tiktokBid('LOWEST_COST_WITHOUT_CAP')).toEqual({ bid_type: 'BID_TYPE_NO_BID' });
    expect(ttBid({ bid_type: 'BID_TYPE_CUSTOM', conversion_bid_price: 700 })).toMatchObject({ bidStrategy: 'COST_CAP', bidAmount: 700 });
    expect(ttBid({ bid_type: 'BID_TYPE_NO_BID', deep_bid_type: 'VO_MIN_ROAS', roas_bid: 2.5 })).toMatchObject({ bidStrategy: 'LOWEST_COST_WITH_MIN_ROAS', roasFloor: 2.5 });
    expect(ttBid({ bid_type: 'BID_TYPE_CUSTOM', bid_price: 20 })).toMatchObject({ bidStrategy: 'LOWEST_COST_WITH_BID_CAP', bidAmount: 20 });
    expect(ttGoal('CONVERT')).toBe('OFFSITE_CONVERSIONS');
  });
  it('times are UTC "YYYY-MM-DD HH:MM:SS"', () => {
    expect(ttTime('2026-12-01T05:30:00.000Z')).toBe('2026-12-01 05:30:00');
    expect(ttIso('2026-12-01 05:30:00')).toBe('2026-12-01T05:30:00.000Z');
  });
});

describe('tiktokOps', () => {
  it('status per level', () => {
    expect(tiktokOps('adset', 'g1', 'adv', { status: 'PAUSED' })).toEqual([
      { path: '/adgroup/status/update/', body: { advertiser_id: 'adv', adgroup_ids: ['g1'], operation_status: 'DISABLE' } },
    ]);
    expect(tiktokOps('campaign', 'c1', 'adv', { status: 'ACTIVE' })[0].body).toMatchObject({ campaign_ids: ['c1'], operation_status: 'ENABLE' });
  });
  it('ad group budget, bid and schedule', () => {
    const calls = tiktokOps('adset', 'g1', 'adv', { dailyBudget: 9500, bidStrategy: 'COST_CAP', bidAmount: 700, endTime: '2026-12-31T00:00:00Z' });
    expect(calls[0]).toEqual({ path: '/adgroup/budget/update/', body: { advertiser_id: 'adv', budget: [{ adgroup_id: 'g1', budget: 9500 }] } });
    expect(calls[1].body).toMatchObject({ adgroup_id: 'g1', bid_type: 'BID_TYPE_CUSTOM', conversion_bid_price: 700, schedule_end_time: '2026-12-31 00:00:00' });
  });
  it('campaign budget (CBO) and refusals', () => {
    expect(tiktokOps('campaign', 'c1', 'adv', { dailyBudget: 20000, name: 'New' })).toEqual([
      { path: '/campaign/update/', body: { advertiser_id: 'adv', campaign_id: 'c1', campaign_name: 'New', budget: 20000 } },
    ]);
    expect(() => tiktokOps('campaign', 'c1', 'adv', { bidAmount: 5 })).toThrow(/ad group/);
    expect(() => tiktokOps('ad', 'a1', 'adv', { name: 'x' })).toThrow(/renamed/);
    expect(() => tiktokOps('adset', 'g1', 'adv', { endTime: null })).toThrow(/end time/);
  });
});

describe('tiktok create', () => {
  const d: TikTokCreateDraft = {
    platform: 'tiktok', objective: 'WEB_CONVERSIONS', name: 'Dhamaka', cbo: false, budgetType: 'daily', budget: 5000,
    bidStrategy: 'LOWEST_COST_WITHOUT_CAP', pixelId: 'px', locationIds: ['1168579'], ageGroups: [], gender: 'GENDER_UNLIMITED',
    identityId: 'id1', identityType: 'CUSTOMIZED_USER', videoId: 'v1', adText: 'Sale', cta: 'SHOP_NOW', url: 'https://shop.example',
  };
  it('validates', () => {
    expect(validateTikTokDraft(d)).toEqual([]);
    expect(validateTikTokDraft({ ...d, pixelId: null })).toContain('Choose the TikTok pixel.');
    expect(validateTikTokDraft({ ...d, identityId: null, displayName: '' })).toContain('Pick an identity or enter a display name.');
    expect(validateTikTokDraft({ ...d, adText: 'x'.repeat(101) })).toContain('TikTok ad text can be at most 100 characters.');
  });
  it('adds UTMs with TikTok macros', () => {
    expect(withTikTokUtm('https://shop.example/p')).toContain('utm_campaign=__CAMPAIGN_ID__');
  });
});
