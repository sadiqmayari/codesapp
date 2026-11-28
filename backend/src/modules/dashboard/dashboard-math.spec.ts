import { buildBrief, median, tenantUtcOffset, type BriefSignals } from './dashboard-math';

const base: BriefSignals = {
  hotspot: null,
  storeRtoRate: null,
  unconfirmedOld: 0,
  target: null,
  roas: null,
  unreadOldestMin: null,
  unread: 0,
  deliveryRate: null,
  deliveryRatePrev: null,
};

describe('dashboard-math', () => {
  it('tenantUtcOffset', () => {
    expect(tenantUtcOffset('Asia/Karachi')).toBe('+05:00');
    expect(tenantUtcOffset(null)).toBe('+00:00');
    expect(tenantUtcOffset('Not/AZone')).toBe('+00:00');
  });

  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([1, 2, 3, 10])).toBe(3); // (2+3)/2 rounded
  });

  it('empty signals → empty brief', () => {
    expect(buildBrief(base)).toEqual([]);
  });

  it('caps at three items, most urgent first', () => {
    const b = buildBrief({
      ...base,
      unread: 9,
      unreadOldestMin: 300,
      hotspot: { city: 'Karachi', rtoRate: 22, parcels: 400, bestCourier: { courier: 'postex', deliveryRate: 81 } },
      storeRtoRate: 14,
      unconfirmedOld: 18,
      target: { target: 100, net: 10, projected: 60, onTrack: false, neededPerDay: 5 },
      roas: 1.1,
    });
    expect(b).toHaveLength(3);
    expect(b[0].href).toBe('/inbox?status=unread');
    expect(b.some((x) => x.text.includes('Karachi'))).toBe(true);
    expect(b[1].why).toContain('PostEx');
  });

  it('ignores a fresh unread queue and a tiny delivery dip', () => {
    const b = buildBrief({ ...base, unread: 3, unreadOldestMin: 10, deliveryRate: 78, deliveryRatePrev: 79 });
    expect(b).toEqual([]);
  });

  it('on-track target is a low-priority good note', () => {
    const b = buildBrief({ ...base, target: { target: 100, net: 80, projected: 120, onTrack: true, neededPerDay: 1 } });
    expect(b[0].tone).toBe('good');
  });
});
