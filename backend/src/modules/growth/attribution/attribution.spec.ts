import { classify, credit, MODELS, Touch } from './attribution';
import { fitResponse, forecastSeries } from './forecast-math';

const t = (iso: string, channel: Touch['channel'], campaignId: string | null = null): Touch => ({
  occurredAt: new Date(iso),
  channel,
  platform: channel === 'meta_ads' || channel === 'whatsapp_ctwa' ? 'meta' : null,
  clickIdType: null,
  campaignId,
  adsetId: null,
  adId: null,
});

describe('classify', () => {
  it('detects paid Meta from utm_source + campaign', () => {
    expect(classify({ occurredAt: new Date(), source: 'shopify_journey', utmSource: 'facebook', utmCampaign: 'Sale' }).channel).toBe('meta_ads');
  });
  it('detects Google from gclid even without UTMs', () => {
    expect(classify({ occurredAt: new Date(), source: 'landing_site', landingPage: '/p/x?gclid=abc' }).channel).toBe('google_ads');
  });
  it('treats a bare fbclid as organic social', () => {
    expect(classify({ occurredAt: new Date(), source: 'landing_site', landingPage: '/?fbclid=1' }).channel).toBe('organic_social');
  });
  it('CTWA is WhatsApp ads on Meta', () => {
    expect(classify({ occurredAt: new Date(), source: 'ctwa', adRef: '123' })).toMatchObject({ channel: 'whatsapp_ctwa', platform: 'meta' });
  });
  it('falls back to direct', () => {
    expect(classify({ occurredAt: new Date(), source: 'shopify_journey' }).channel).toBe('direct');
  });
});

describe('credit', () => {
  const order = new Date('2026-11-10T12:00:00Z');
  const touches = [
    t('2026-11-01T10:00:00Z', 'meta_ads', 'A'),
    t('2026-11-05T10:00:00Z', 'organic_social'),
    t('2026-11-10T11:00:00Z', 'direct'),
  ];

  it('every model sums to exactly 1', () => {
    for (const m of MODELS) {
      const sum = credit(touches, order, m, 28).reduce((a, c) => a + c.credit, 0);
      expect(Math.round(sum * 10_000)).toBe(10_000);
    }
  });
  it('first click credits the first touch, last click the last', () => {
    expect(credit(touches, order, 'first', 28)).toEqual([expect.objectContaining({ channel: 'meta_ads', campaignId: 'A', credit: 1 })]);
    expect(credit(touches, order, 'last', 28)).toEqual([expect.objectContaining({ channel: 'direct', credit: 1 })]);
  });
  it('last non-direct skips direct visits', () => {
    expect(credit(touches, order, 'lnd', 28)[0].channel).toBe('organic_social');
  });
  it('position-based gives 40/20/40', () => {
    const c = credit(touches, order, 'position', 28);
    expect(c.find((x) => x.channel === 'meta_ads')?.credit).toBeCloseTo(0.4, 4);
    expect(c.find((x) => x.channel === 'organic_social')?.credit).toBeCloseTo(0.2, 4);
  });
  it('window drops old touches; no touches → unknown', () => {
    expect(credit(touches, order, 'first', 1)[0].channel).toBe('direct');
    expect(credit([], order, 'last', 28)).toEqual([expect.objectContaining({ channel: 'unknown', credit: 1 })]);
  });
  it('time decay favours recent touches', () => {
    const c = credit(touches, order, 'decay', 28);
    expect(c.find((x) => x.channel === 'direct')!.credit).toBeGreaterThan(c.find((x) => x.channel === 'meta_ads')!.credit);
  });
});

describe('forecast + response curve', () => {
  it('projects a flat series near its level', () => {
    const hist = Array.from({ length: 60 }, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), value: 1000 }));
    const fc = forecastSeries(hist, ['2026-11-01', '2026-11-02']);
    expect(fc[0].mid).toBeGreaterThan(950);
    expect(fc[0].mid).toBeLessThan(1050);
  });
  it('fits diminishing returns with b in [0.25, 1]', () => {
    const pts: Array<[number, number]> = Array.from({ length: 30 }, (_, i) => {
      const s = 1000 + i * 200;
      return [s, 5 * Math.pow(s, 0.7)];
    });
    const f = fitResponse(pts);
    expect(f.b).toBeCloseTo(0.7, 2);
  });
});
