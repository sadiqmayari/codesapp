import { FraudSignalCollectorService } from './fraud-signal-collector.service';

/**
 * Tests for the local fraud-history collector (#increment 12): distinct delivery
 * phone counting (deduped by last-10), order-creation modifications count,
 * caching, and fail-safe behavior.
 */
describe('FraudSignalCollectorService', () => {
  function make(opts: {
    messages?: Array<{ content: string | null; transcription?: string | null }>;
    orderCreatedCount?: number;
    store?: Map<string, unknown>;
    throwOnFind?: boolean;
  }) {
    const store = opts.store ?? new Map<string, unknown>();
    const cache = {
      get: jest.fn((k: string) => store.get(k)),
      set: jest.fn((k: string, v: unknown) => void store.set(k, v)),
    } as any;
    const prisma = {
      message: {
        findMany: jest.fn(async () => {
          if (opts.throwOnFind) throw new Error('db down');
          return opts.messages ?? [];
        }),
      },
      event: { count: jest.fn(async () => opts.orderCreatedCount ?? 0) },
    } as any;
    return { svc: new FraudSignalCollectorService(prisma, cache), prisma };
  }

  it('counts distinct delivery phone numbers (deduped by last 10 digits)', async () => {
    const { svc } = make({
      messages: [
        { content: 'my number is 03171234567' },
        { content: 'actually use +92 317 1234567' }, // same number, different format
        { content: 'or send to 03009998888' }, // a different number
      ],
    });
    const h = await svc.collect(7, 100);
    expect(h.phoneChanges).toBe(2);
  });

  it('reports order-creation modifications from the event count', async () => {
    const { svc } = make({ messages: [], orderCreatedCount: 4 });
    const h = await svc.collect(7, 100);
    expect(h.modifications).toBe(4);
  });

  it('leaves deferred counters at 0', async () => {
    const { svc } = make({ messages: [{ content: 'hi' }] });
    const h = await svc.collect(7, 100);
    expect(h.addressChanges).toBe(0);
    expect(h.failedOrders).toBe(0);
  });

  it('caches the result (second call does not re-query)', async () => {
    const { svc, prisma } = make({ messages: [], orderCreatedCount: 1 });
    await svc.collect(7, 100);
    await svc.collect(7, 100);
    expect(prisma.message.findMany).toHaveBeenCalledTimes(1);
  });

  it('fails safe to empty counters on a query error', async () => {
    const { svc } = make({ throwOnFind: true });
    const h = await svc.collect(7, 100);
    expect(h).toEqual({
      phoneChanges: 0,
      addressChanges: 0,
      failedOrders: 0,
      modifications: 0,
    });
  });
});
