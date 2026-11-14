import { attributionSpec, metaFields } from './meta.writer';
import { fromMinor, toMinor } from '../ad-writer.types';

describe('money units', () => {
  it('PKR/USD go out ×100, zero-decimal ×1', () => {
    expect(toMinor(1500, 'PKR')).toBe(150000);
    expect(toMinor(12.345, 'USD')).toBe(1235);
    expect(toMinor(900, 'JPY')).toBe(900);
    expect(toMinor(10, null)).toBe(1000);
  });
  it('fromMinor round-trips and tolerates junk', () => {
    expect(fromMinor('150000', 'PKR')).toBe(1500);
    expect(fromMinor(900, 'jpy')).toBe(900);
    expect(fromMinor(null, 'PKR')).toBeNull();
    expect(fromMinor('', 'PKR')).toBeNull();
    expect(fromMinor('abc', 'PKR')).toBeNull();
  });
});

describe('metaFields', () => {
  it('campaign budget + strategy, end → stop_time', () => {
    expect(metaFields('campaign', { dailyBudget: 2000, bidStrategy: 'COST_CAP', endTime: '2026-12-01T00:00:00Z' }, 'PKR')).toEqual({
      daily_budget: 200000,
      bid_strategy: 'COST_CAP',
      stop_time: '2026-12-01T00:00:00Z',
    });
  });
  it('campaign never receives ad-set-only fields', () => {
    const f = metaFields('campaign', { bidAmount: 500, roasFloor: 2, optimizationGoal: 'VALUE', attributionWindow: '7d_click' }, 'PKR');
    expect(f).toEqual({});
  });
  it('ad set ROAS floor ×10000 + value goal + attribution', () => {
    expect(
      metaFields('adset', { bidStrategy: 'LOWEST_COST_WITH_MIN_ROAS', roasFloor: 3.2, optimizationGoal: 'VALUE', attributionWindow: '1d_click' }, 'PKR'),
    ).toEqual({
      bid_strategy: 'LOWEST_COST_WITH_MIN_ROAS',
      bid_constraints: { roas_average_floor: 32000 },
      optimization_goal: 'VALUE',
      attribution_spec: [{ event_type: 'CLICK_THROUGH', window_days: 1 }],
    });
  });
  it('ad set cost cap amount in minor units; cleared end = 0', () => {
    expect(metaFields('adset', { bidAmount: 850, endTime: null }, 'PKR')).toEqual({ bid_amount: 85000, end_time: 0 });
  });
  it('ads only take status + name', () => {
    expect(metaFields('ad', { status: 'PAUSED', name: '  New name ', dailyBudget: 10 }, 'PKR')).toEqual({ status: 'PAUSED', name: 'New name' });
  });
  it('default attribution is 7-day click + 1-day view', () => {
    expect(attributionSpec('7d_click_1d_view')).toHaveLength(2);
  });
});
