import {
  cartSignature,
  emptyMemory,
  hasOpenFlow,
  isAffirmation,
  isStopWord,
  missingOrderFields,
  parseMemory,
  quoteInTurn,
  summarySignature,
} from './memory';
import { resolveProfile, isOpenAt, withStore } from '../ai/agent/profile';
import { buildSystem } from './prompt';
import { resolveVariant } from './skills';

describe('working memory', () => {
  it('parses junk / v1 leftovers to an empty memory', () => {
    expect(parseMemory(null).stage).toBe('idle');
    expect(parseMemory({ items: [1] }).cart).toEqual([]);
    expect(parseMemory('x').v).toBe(2);
  });

  it('round-trips a cart and drops invalid lines', () => {
    const m = parseMemory({
      v: 2,
      stage: 'awaiting_confirm',
      cart: [
        { variantId: 'a', quantity: 2, title: 'A', unitPrice: 100 },
        { variantId: '', quantity: 1 },
        { variantId: 'b', quantity: 0 },
      ],
    });
    expect(m.stage).toBe('awaiting_confirm');
    expect(m.cart).toHaveLength(1);
    expect(m.cart[0].quantity).toBe(2);
  });

  it('cart signature is order-independent and variant-exact', () => {
    expect(cartSignature([{ variantId: 'a', quantity: 1 }, { variantId: 'b', quantity: 2 }])).toBe(
      cartSignature([{ variantId: 'b', quantity: 2 }, { variantId: 'a', quantity: 1 }]),
    );
    expect(cartSignature([{ variantId: 'a', quantity: 1 }])).not.toBe(
      cartSignature([{ variantId: 'a', quantity: 2 }]),
    );
  });

  it('summary signature changes when address or payment changes', () => {
    const m = emptyMemory();
    m.cart = [{ variantId: 'a', quantity: 1, title: 'A', variantTitle: '', unitPrice: 1, sku: null }];
    m.customer = { name: 'S', phone: '0300', address1: 'H1', city: 'Lhr' };
    m.payment = 'cod';
    const s1 = summarySignature(m);
    m.customer.address1 = 'H2';
    expect(summarySignature(m)).not.toBe(s1);
  });

  it('lists missing order fields', () => {
    const m = emptyMemory();
    expect(missingOrderFields(m, true)).toEqual(['product', 'name', 'phone', 'full address', 'city', 'payment method']);
    m.cart = [{ variantId: 'a', quantity: 1, title: 'A', variantTitle: '', unitPrice: 1, sku: null }];
    m.customer = { name: 'S', phone: '03001234567', address1: 'H1', city: 'Lhr' };
    expect(missingOrderFields(m, false)).toEqual([]);
  });

  it('open flows block closing', () => {
    const m = emptyMemory();
    expect(hasOpenFlow(m)).toBe(false);
    m.stage = 'awaiting_confirm';
    expect(hasOpenFlow(m)).toBe(true);
  });
});

describe('affirmation detection (multilingual)', () => {
  it.each(['yes', 'haan', 'Ji', 'ok', 'theek hai', 'confirm', 'ہاں ٹھیک ہے', 'جی', '👍', 'order kar do', 'han ji'])(
    '"%s" is a yes',
    (t) => expect(isAffirmation(t)).toBe(true),
  );
  it.each(['no', 'nahi', 'cancel', 'wait', 'ok shukria', 'thanks', 'what is the price?', 'نہیں'])(
    '"%s" is NOT a deterministic yes',
    (t) => expect(isAffirmation(t)).toBe(false),
  );
  it('a long message is never a deterministic yes', () => {
    expect(isAffirmation('yes but please change the address to my office in gulberg before you send it')).toBe(false);
  });
  it('quote must appear in the turn', () => {
    expect(quoteInTurn('بالکل بھیج دیں', 'جی بالکل بھیج دیں شکریہ')).toBe(true);
    expect(quoteInTurn('yes', 'what is the price')).toBe(false);
  });
  it('stop words', () => {
    expect(isStopWord('STOP')).toBe(true);
    expect(isStopWord('stop sending me this')).toBe(false);
  });
});

describe('agent profile', () => {
  it('defaults by pack + country', () => {
    const p = resolveProfile(null, { countryCode: 'PK' });
    expect(p.industry).toBe('ecommerce');
    expect(p.currencySymbol).toBe('Rs');
    expect(p.languages).toContain('Roman Urdu');
    expect(p.skills.orders.enabled).toBe(true);
    expect(p.skills.bookings.enabled).toBe(false);
  });

  it('clinic pack enables bookings, not orders', () => {
    const p = resolveProfile({ industry: 'clinic', country_code: 'AE' });
    expect(p.skills.bookings.enabled).toBe(true);
    expect(p.skills.orders.enabled).toBe(false);
    expect(p.currencyCode).toBe('AED');
    expect(p.skills.bookings.services.length).toBeGreaterThan(0);
  });

  it('india tenant may reply in Hindi (no global Hindi ban)', () => {
    const p = resolveProfile({ country_code: 'IN' });
    expect(p.languages).toContain('Hindi');
    expect(p.voiceLanguage).toBe('hi');
  });

  it('clamps garbage JSON', () => {
    const p = resolveProfile({
      handoff: { noProgressTurns: 999, resumeAfterMin: -5, keywords: 'x' },
      hours: { days: { mon: { open: '25:99', on: true } }, holidays: ['nope', '2026-12-25'] },
      skills: { bookings: { services: [{ name: '' }, { name: 'Cut', durationMin: 1, capacity: 0 }] } },
    });
    expect(p.handoff.noProgressTurns).toBe(20);
    expect(p.handoff.resumeAfterMin).toBe(0);
    expect(p.handoff.keywords).toEqual([]);
    expect(p.hours.days.mon.open).toBe('10:00');
    expect(p.hours.holidays).toEqual(['2026-12-25']);
    expect(p.skills.bookings.services).toEqual([{ name: 'Cut', durationMin: 5, capacity: 1 }]);
  });

  it('store override layers currency + tone', () => {
    const p = withStore(resolveProfile(null), { currencySymbol: '$', currencyCode: 'usd', tone: 'Playful' });
    expect(p.currencySymbol).toBe('$');
    expect(p.currencyCode).toBe('USD');
    expect(p.tone).toBe('Playful');
  });

  it('business hours in the tenant zone', () => {
    const p = resolveProfile({
      hours: {
        enabled: true,
        days: { mon: { on: true, open: '10:00', close: '19:00' } },
      },
    });
    // 2026-11-16 is a Monday. 06:00 UTC = 11:00 Karachi → open; 16:00 UTC = 21:00 → closed.
    expect(isOpenAt(p.hours, new Date('2026-11-16T06:00:00Z'), 'Asia/Karachi')).toBe(true);
    expect(isOpenAt(p.hours, new Date('2026-11-16T16:00:00Z'), 'Asia/Karachi')).toBe(false);
    // Sunday off by default.
    expect(isOpenAt(p.hours, new Date('2026-11-15T06:00:00Z'), 'Asia/Karachi')).toBe(false);
  });
});

describe('system prompt', () => {
  it('is industry + locale aware and caches the stable block', () => {
    const p = resolveProfile({ industry: 'clinic', country_code: 'AE' });
    const blocks = buildSystem({
      profile: p,
      brandName: 'CareFirst',
      tools: ['search_knowledge', 'get_slots', 'book_slot', 'handoff'],
      stores: [],
      storeLabel: null,
      autoOrder: false,
      open: true,
      transactionsAllowed: true,
      nowLocal: 'Monday',
      memory: emptyMemory(),
      knownCustomer: null,
    });
    expect(blocks[0].cache).toBe(true);
    expect(blocks[1].cache).toBeFalsy();
    expect(blocks[0].text).toContain('CareFirst');
    expect(blocks[0].text).toContain('AED');
    expect(blocks[0].text).toContain('NOT a doctor');
    expect(blocks[0].text).toContain('Languages you may reply in: English, Arabic.');
    expect(blocks[0].text).not.toContain('Urdu vocabulary');
    expect(blocks[0].text).not.toContain('place_order');
  });
});

describe('variant resolution', () => {
  const hit = (variantTitle: string, id: string) => ({
    variantId: id,
    productTitle: 'Lawn Kurta',
    variantTitle,
    description: null,
    price: '3450',
    compareAtPrice: null,
    discountPercent: null,
    sku: null,
    image: null,
    productUrl: null,
    available: true,
  });
  it('maps "medium" to the M variant', () => {
    const r = resolveVariant('black kurta medium', [hit('Black / S', '1'), hit('Black / M', '2'), hit('Black / L', '3')]);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.hit.variantId).toBe('2');
  });
  it('asks when the variant is unclear', () => {
    const r = resolveVariant('kurta', [hit('S', '1'), hit('M', '2')]);
    expect(r.status).toBe('ambiguous');
  });
});

import { AiMeteringService } from '../ai/ai-metering.service';

describe('AI spend cap (tenant can only lower the ceiling)', () => {
  const svc = new AiMeteringService(
    {} as never,
    { get: async (_k: string, d: string) => (_k === 'ai_default_monthly_cap_cents' ? '2000' : d) } as never,
  );
  it('0 / null means "use the ceiling", never unlimited', async () => {
    expect(await svc.effectiveCapCents({ ai_monthly_cap_cents: 0 })).toBe(2000);
    expect(await svc.effectiveCapCents({ ai_monthly_cap_cents: null })).toBe(2000);
  });
  it('tenant cap above the ceiling is clamped', async () => {
    expect(await svc.effectiveCapCents({ ai_monthly_cap_cents: 99999 })).toBe(2000);
    expect(await svc.effectiveCapCents({ ai_monthly_cap_cents: 500 })).toBe(500);
  });
  it('super-admin cap overrides the platform default', async () => {
    expect(await svc.effectiveCapCents({ ai_monthly_cap_cents: null, ai_admin_cap_cents: 5000 })).toBe(5000);
    expect(await svc.effectiveCapCents({ ai_monthly_cap_cents: 9000, ai_admin_cap_cents: 0 })).toBe(9000);
  });
});
