import { ttStatus, ttWindows } from './tiktok.adapter';

describe('tiktok adapter helpers', () => {
  it('maps operation_status to the Growth vocabulary', () => {
    expect(ttStatus('ENABLE')).toBe('ACTIVE');
    expect(ttStatus('DISABLE')).toBe('PAUSED');
    expect(ttStatus('DELETE')).toBe('DELETED');
    expect(ttStatus(null)).toBeNull();
  });

  it('splits a range into ≤30-day windows', () => {
    expect(ttWindows('2026-08-01', '2026-10-29')).toEqual([
      ['2026-08-01', '2026-08-30'],
      ['2026-08-31', '2026-09-29'],
      ['2026-09-30', '2026-10-29'],
    ]);
    expect(ttWindows('2026-11-25', '2026-11-26')).toEqual([['2026-11-25', '2026-11-26']]);
  });
});
