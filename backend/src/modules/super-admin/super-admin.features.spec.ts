import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SuperAdminService } from './super-admin.service';

/**
 * Tests for the super-admin feature-override API (#increment 11): listing flags
 * with override/default/effective resolution, setting + clearing an override, the
 * allow-list guard, and kill-switch cache invalidation.
 */
describe('SuperAdminService — hardening feature flags', () => {
  function make(opts: {
    overrides?: Record<string, unknown> | null;
    companyExists?: boolean;
  }) {
    const prisma = {
      company: {
        findUnique: jest.fn(async () =>
          opts.companyExists === false
            ? null
            : { id: 7, feature_overrides: opts.overrides ?? null },
        ),
        update: jest.fn(async () => ({})),
      },
    } as any;
    const platformSetting = {
      // Default path: return the provided fallback (guards 'false', kills 'on').
      get: jest.fn(async (_k: string, fallback: string) => fallback),
    } as any;
    const killSwitches = { invalidate: jest.fn() } as any;
    const noop = {} as any;
    const svc = new SuperAdminService(
      prisma, noop, noop, platformSetting, noop, noop, noop, noop, killSwitches,
    );
    return { svc, prisma, killSwitches };
  }

  it('lists flags with override + platform default + effective state', async () => {
    const { svc } = make({
      overrides: { compliance_guard: 'on', 'kill.auto_order': 'off' },
    });
    const { features } = await svc.getClientFeatures(7);

    const compliance = features.find((f) => f.key === 'compliance_guard')!;
    expect(compliance.override).toBe('on');
    expect(compliance.effectiveEnabled).toBe(true);
    expect(compliance.semantics).toBe('enable');

    const killOrder = features.find((f) => f.key === 'kill.auto_order')!;
    expect(killOrder.override).toBe('off');
    expect(killOrder.effectiveEnabled).toBe(false);
    expect(killOrder.semantics).toBe('kill');

    // A guard with no override inherits the (OFF) platform default.
    const tool = features.find((f) => f.key === 'tool_validation')!;
    expect(tool.override).toBeNull();
    expect(tool.effectiveEnabled).toBe(false);

    // A kill switch with no override inherits the (ON) platform default.
    const killReply = features.find((f) => f.key === 'kill.auto_reply')!;
    expect(killReply.override).toBeNull();
    expect(killReply.effectiveEnabled).toBe(true);
  });

  it('sets a per-tenant override', async () => {
    const { svc, prisma } = make({ overrides: {} });
    await svc.setClientFeature(7, 'response_confidence', 'on');
    expect(prisma.company.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 7 },
        data: { feature_overrides: { response_confidence: 'on' } },
      }),
    );
  });

  it('clears an override when value is null', async () => {
    const { svc, prisma } = make({
      overrides: { response_confidence: 'on', compliance_guard: 'off' },
    });
    await svc.setClientFeature(7, 'response_confidence', null);
    expect(prisma.company.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { feature_overrides: { compliance_guard: 'off' } },
      }),
    );
  });

  it('invalidates the kill-switch cache when a kill flag changes', async () => {
    const { svc, killSwitches } = make({ overrides: {} });
    await svc.setClientFeature(7, 'kill.auto_reply', 'off');
    expect(killSwitches.invalidate).toHaveBeenCalledWith(7);
  });

  it('does not touch the kill cache for a non-kill flag', async () => {
    const { svc, killSwitches } = make({ overrides: {} });
    await svc.setClientFeature(7, 'compliance_guard', 'on');
    expect(killSwitches.invalidate).not.toHaveBeenCalled();
  });

  it('rejects an unknown flag key', async () => {
    const { svc } = make({ overrides: {} });
    await expect(svc.setClientFeature(7, 'not_a_flag', 'on')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('throws NotFound for a missing client', async () => {
    const { svc } = make({ companyExists: false });
    await expect(svc.getClientFeatures(7)).rejects.toBeInstanceOf(NotFoundException);
  });
});
