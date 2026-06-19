import { FeatureService } from './feature.service';

/**
 * Tests for the Compliance Guard feature-flag resolution (#increment 2):
 * default OFF, per-tenant override authority, and FAIL-OPEN on any error.
 */
describe('FeatureService.complianceGuardEnabled', () => {
  function make(opts: {
    overrides?: Record<string, unknown> | null;
    platformDefault?: string;
    throwOnFindUnique?: boolean;
  }) {
    const prisma = {
      company: {
        findUnique: jest.fn(async () => {
          if (opts.throwOnFindUnique) throw new Error('db down');
          return { feature_overrides: opts.overrides ?? null };
        }),
      },
    } as any;
    const platformSetting = {
      get: jest.fn(async (_k: string, fallback: string) =>
        opts.platformDefault ?? fallback,
      ),
    } as any;
    return new FeatureService(prisma, platformSetting);
  }

  it('defaults OFF when no override and no platform setting', async () => {
    const svc = make({});
    expect(await svc.complianceGuardEnabled(1)).toBe(false);
  });

  it('is ON when the platform default is enabled', async () => {
    const svc = make({ platformDefault: 'true' });
    expect(await svc.complianceGuardEnabled(1)).toBe(true);
  });

  it('per-tenant override ON wins over an absent platform default', async () => {
    const svc = make({ overrides: { compliance_guard: 'on' } });
    expect(await svc.complianceGuardEnabled(1)).toBe(true);
  });

  it('per-tenant override OFF wins over an enabled platform default', async () => {
    const svc = make({ overrides: { compliance_guard: 'off' }, platformDefault: 'true' });
    expect(await svc.complianceGuardEnabled(1)).toBe(false);
  });

  it('fails OPEN (returns false) when resolution throws', async () => {
    const svc = make({ throwOnFindUnique: true });
    expect(await svc.complianceGuardEnabled(1)).toBe(false);
  });
});
