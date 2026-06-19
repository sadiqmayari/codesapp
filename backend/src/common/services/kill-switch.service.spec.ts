import { KillSwitchService } from './kill-switch.service';

/**
 * Unit tests for the Global Kill Switches (#increment 3): default-ON, global vs
 * per-tenant override precedence, fail-closed-vs-open semantics, caching, the
 * intent→specialist mapping, and cache invalidation.
 */
describe('KillSwitchService', () => {
  function make(opts: {
    overrides?: Record<string, unknown> | null;
    global?: Record<string, string>;
    throwGlobal?: boolean;
    cacheStore?: Map<string, unknown>;
  }) {
    const store = opts.cacheStore ?? new Map<string, unknown>();
    const cache = {
      get: jest.fn((k: string) => store.get(k)),
      set: jest.fn((k: string, v: unknown) => void store.set(k, v)),
      del: jest.fn((k: string) => void store.delete(k)),
    } as any;
    const prisma = {
      company: {
        findUnique: jest.fn(async () => ({
          feature_overrides: opts.overrides ?? null,
        })),
      },
    } as any;
    const platformSetting = {
      get: jest.fn(async (key: string, fallback: string) => {
        if (opts.throwGlobal) throw new Error('settings down');
        return opts.global?.[key] ?? fallback;
      }),
    } as any;
    return {
      svc: new KillSwitchService(prisma, cache, platformSetting),
      prisma,
      cache,
    };
  }

  it('defaults every switch to ON when nothing is configured (preserve behavior)', async () => {
    const { svc } = make({});
    const snap = await svc.resolveAll(1);
    expect(Object.values(snap).every((v) => v === true)).toBe(true);
  });

  it('a global platform kill disables that one switch', async () => {
    const { svc } = make({ global: { 'kill.sales_specialist': 'off' } });
    const snap = await svc.resolveAll(1);
    expect(snap.sales_specialist).toBe(false);
    expect(snap.order_specialist).toBe(true);
    expect(snap.auto_reply).toBe(true);
  });

  it('a per-tenant override OFF wins over a global default', async () => {
    const { svc } = make({ overrides: { 'kill.auto_order': 'off' } });
    expect((await svc.resolveAll(1)).auto_order).toBe(false);
  });

  it('a per-tenant override ON wins over a global OFF', async () => {
    const { svc } = make({
      overrides: { 'kill.auto_reply': 'on' },
      global: { 'kill.auto_reply': 'off' },
    });
    expect((await svc.resolveAll(1)).auto_reply).toBe(true);
  });

  it('FAILS CLOSED for auto_order and OPEN for the rest on a resolution error', async () => {
    const { svc } = make({ throwGlobal: true });
    const snap = await svc.resolveAll(1);
    expect(snap.auto_order).toBe(false); // money fails closed
    expect(snap.auto_reply).toBe(true); // reversible fails open
    expect(snap.sales_specialist).toBe(true);
  });

  it('caches the snapshot (second call does not re-read the DB)', async () => {
    const { svc, prisma } = make({});
    await svc.resolveAll(1);
    await svc.resolveAll(1);
    expect(prisma.company.findUnique).toHaveBeenCalledTimes(1);
  });

  it('invalidate() drops the cache so a toggle takes effect', async () => {
    const store = new Map<string, unknown>();
    const { svc, prisma } = make({ cacheStore: store });
    await svc.resolveAll(1);
    svc.invalidate(1);
    await svc.resolveAll(1);
    expect(prisma.company.findUnique).toHaveBeenCalledTimes(2);
  });

  it('isEnabled reads a single switch from the snapshot', async () => {
    const { svc } = make({ global: { 'kill.logistics_specialist': 'off' } });
    expect(await svc.isEnabled(1, 'logistics_specialist')).toBe(false);
    expect(await svc.isEnabled(1, 'general_specialist')).toBe(true);
  });

  describe('specialistEnabled (intent → switch mapping)', () => {
    const snap = {
      auto_reply: true,
      auto_order: true,
      sales_specialist: false,
      order_specialist: true,
      logistics_specialist: true,
      resolution_specialist: true,
      general_specialist: true,
    };
    it('maps each intent to its switch', () => {
      expect(KillSwitchService.specialistEnabled(snap, 'sales')).toBe(false);
      expect(KillSwitchService.specialistEnabled(snap, 'order')).toBe(true);
      expect(KillSwitchService.specialistEnabled(snap, 'logistics')).toBe(true);
    });
    it('allows an unknown intent (no switch governs it)', () => {
      expect(KillSwitchService.specialistEnabled(snap, 'closing')).toBe(true);
    });
  });
});
