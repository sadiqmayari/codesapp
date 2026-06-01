import { LimitWarningService } from './limit-warning.service';

describe('LimitWarningService', () => {
  function makeService(usageContacts: number, limit = 100) {
    const store = new Map<string, unknown>();
    const cache = {
      get: (k: string) => store.get(k),
      set: (k: string, v: unknown) => store.set(k, v),
      del: (k: string) => store.delete(k),
      subscriptionKey: (id: number) => `subscription:${id}`,
    };
    const prisma = {
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          subscription: { contact_limit: limit, template_limit: limit },
        }),
      },
      // Current usage is now a LIVE stored count (contact.count / template.count),
      // not the per-month usage_metering counter.
      contact: {
        count: jest.fn().mockResolvedValue(usageContacts),
      },
      template: {
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const dispatcher = { dispatch };
    const svc = new LimitWarningService(
      prisma as never,
      cache as never,
      dispatcher as never,
    );
    return { svc, dispatch };
  }

  it('fires subscription.limit.warning once at 80%', async () => {
    const { svc, dispatch } = makeService(85);
    await svc.check(1, 'contacts');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      1,
      'subscription.limit.warning',
      expect.objectContaining({ dimension: 'contacts', current: 85, limit: 100 }),
    );
  });

  it('is suppressed on a second call within the same period', async () => {
    const { svc, dispatch } = makeService(90);
    await svc.check(1, 'contacts');
    await svc.check(1, 'contacts');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not fire below 80%', async () => {
    const { svc, dispatch } = makeService(50);
    await svc.check(1, 'contacts');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not fire at/above 100% (PlanGuard owns the hard block)', async () => {
    const { svc, dispatch } = makeService(100);
    await svc.check(1, 'contacts');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
