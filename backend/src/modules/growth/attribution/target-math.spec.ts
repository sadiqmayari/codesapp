import { pace, phi } from './target-math';

describe('target pacing', () => {
  it('normal CDF is sane', () => {
    expect(phi(0)).toBeCloseTo(0.5, 3);
    expect(phi(1.2816)).toBeCloseTo(0.9, 2);
    expect(phi(-1.2816)).toBeCloseTo(0.1, 2);
  });
  it('needed per day = remaining ÷ days left', () => {
    const p = pace({ target: 30_000_000, soFar: 13_800_000, daysLeft: 16, p10: 27e6, p50: 28.7e6, p90: 30.4e6, recentPerDay: 930_000 });
    expect(p.needPerDay).toBeCloseTo(1_012_500, 0);
    expect(p.gap).toBeCloseTo(1_300_000, 0);
    expect(p.chance).toBeGreaterThan(10);
    expect(p.chance).toBeLessThan(40);
    expect(p.status).toBe('off_track');
  });
  it('median on target ≈ 50% chance; already hit = 100%', () => {
    expect(pace({ target: 10, soFar: 5, daysLeft: 5, p10: 8, p50: 10, p90: 12, recentPerDay: 1 }).chance).toBe(50);
    expect(pace({ target: 10, soFar: 11, daysLeft: 5, p10: 11, p50: 13, p90: 15, recentPerDay: 1 }).chance).toBe(100);
  });
});
