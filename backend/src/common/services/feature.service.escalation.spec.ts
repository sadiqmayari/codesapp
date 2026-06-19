import { FeatureService } from './feature.service';

/** Escalation-signals flag resolution (#increment 4): default OFF, override, fail-open. */
describe('FeatureService.escalationSignalsEnabled', () => {
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
      get: jest.fn(async (_k: string, fb: string) => opts.platformDefault ?? fb),
    } as any;
    return new FeatureService(prisma, platformSetting);
  }

  it('defaults OFF', async () => {
    expect(await make({}).escalationSignalsEnabled(1)).toBe(false);
  });
  it('ON via platform default', async () => {
    expect(await make({ platformDefault: 'true' }).escalationSignalsEnabled(1)).toBe(true);
  });
  it('per-tenant override ON wins', async () => {
    expect(
      await make({ overrides: { escalation_signals: 'on' } }).escalationSignalsEnabled(1),
    ).toBe(true);
  });
  it('per-tenant override OFF wins over platform default ON', async () => {
    expect(
      await make({
        overrides: { escalation_signals: 'off' },
        platformDefault: 'true',
      }).escalationSignalsEnabled(1),
    ).toBe(false);
  });
  it('fails OPEN (false) on error', async () => {
    expect(await make({ throwOnFindUnique: true }).escalationSignalsEnabled(1)).toBe(false);
  });
});
