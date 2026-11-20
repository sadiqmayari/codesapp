import { MnpAdapter } from './mnp.adapter';
import { UnmappedCourierStatusError } from './courier-adapter.interface';
import { normalizeEvent } from '../shipment-tracking.service';

describe('M&P webhook push (Nov-2026 snake_case payload)', () => {
  // Real push captured from production logs.
  const push = {
    comments: 'CAN-Consignee not Available',
    tracking_number: '565714810000631',
    timestamp: '2026-11-20 17:00:02.153000',
    status: 'Attempt:1',
  };

  it('reads tracking_number / status / comments', () => {
    expect(normalizeEvent('mnp', push)).toEqual({
      trackingNumber: '565714810000631',
      rawStatus: 'Attempt:1',
      reason: 'CAN-Consignee not Available',
    });
  });

  it('still reads the older PascalCase payload', () => {
    expect(
      normalizeEvent('mnp', { TrackingNumber: '565714810000041', Status: 'Delivered', Comments: '' }),
    ).toEqual({ trackingNumber: '565714810000041', rawStatus: 'Delivered', reason: undefined });
  });

  it('rejects a payload without a tracking number or status', () => {
    expect(normalizeEvent('mnp', { status: 'Delivered' })).toBeNull();
    expect(normalizeEvent('mnp', { tracking_number: '1' })).toBeNull();
  });
});

describe('MnpAdapter.mapStatus — every status M&P pushed on 2026-11-20', () => {
  const a = new MnpAdapter();
  const cases: Array<[string, string]> = [
    ['Arrived at Origin', 'in_transit'],
    ['Delivered', 'delivered'],
    ['Attempt:1', 'attempted'],
    ['Attempt:2', 'attempted'],
    ['Attempt:3', 'attempted'],
    ['Hold in Operations', 'in_transit'],
    ['Out For Delivery', 'out_for_delivery'],
    ['Return – Out For Delivery', 'failed'],
    ['Return – Reached at Origin', 'failed'],
    ['Return – Attempt', 'failed'],
    ['Failed Delivered', 'failed'],
  ];
  it.each(cases)('%s → %s', (raw, expected) => {
    expect(a.mapStatus(raw)).toBe(expected);
  });

  it('still throws on a truly unknown status', () => {
    expect(() => a.mapStatus('teleported')).toThrow(UnmappedCourierStatusError);
  });
});
