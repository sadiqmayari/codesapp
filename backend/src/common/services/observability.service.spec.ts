import { ObservabilityService } from './observability.service';

/**
 * Tests for the Observability + Audit service (#increment 6 / spec #12/#7):
 * event aggregation → metrics + rates, window clamping, caching, and the
 * per-conversation audit timeline. Prisma + cache are mocked.
 */
describe('ObservabilityService', () => {
  function make(opts: {
    grouped?: Array<{ type: string; _count: { type: number } }>;
    tickets?: number;
    conversations?: number;
    auditRows?: any[];
    cacheStore?: Map<string, unknown>;
  }) {
    const store = opts.cacheStore ?? new Map<string, unknown>();
    const cache = {
      get: jest.fn((k: string) => store.get(k)),
      set: jest.fn((k: string, v: unknown) => void store.set(k, v)),
    } as any;
    const prisma = {
      event: {
        groupBy: jest.fn(async () => opts.grouped ?? []),
        findMany: jest.fn(async () => opts.auditRows ?? []),
      },
      supportTicket: { count: jest.fn(async () => opts.tickets ?? 0) },
      $queryRaw: jest.fn(async () => [{ c: BigInt(opts.conversations ?? 0) }]),
    } as any;
    return { svc: new ObservabilityService(prisma, cache), prisma };
  }

  it('aggregates event counts and computes rates against active conversations', async () => {
    const { svc } = make({
      conversations: 10,
      tickets: 2,
      grouped: [
        { type: 'conversation.handoff', _count: { type: 4 } },
        { type: 'order.created', _count: { type: 5 } },
        { type: 'order.duplicate_prevented', _count: { type: 1 } },
        { type: 'frustration.detected', _count: { type: 2 } },
        { type: 'fraud.risk_flagged', _count: { type: 1 } },
        { type: 'compliance.guard_triggered', _count: { type: 3 } },
        { type: 'killswitch.specialist_disabled', _count: { type: 1 } },
        { type: 'tool.failed', _count: { type: 2 } },
      ],
    });

    const m = await svc.tenantMetrics(7, 30);

    expect(m.conversations).toBe(10);
    expect(m.handoffs).toBe(4);
    expect(m.handoffRate).toBe(0.4);
    expect(m.ordersCreated).toBe(5);
    expect(m.orderConversionRate).toBe(0.5);
    expect(m.duplicateOrdersPrevented).toBe(1);
    expect(m.ticketsCreated).toBe(2);
    expect(m.ticketCreationRate).toBe(0.2);
    expect(m.frustrationEscalations).toBe(2);
    expect(m.fraudEscalations).toBe(1);
    expect(m.medicalInterventions).toBe(3);
    expect(m.specialistDisabled).toBe(1);
    expect(m.toolFailures).toBe(2);
    expect(m.toolFailureRate).toBe(0.2);
    // Not-yet-instrumented metrics are honest nulls.
    expect(m.replyAcceptanceRate).toBeNull();
    expect(m.specialistAccuracy).toBeNull();
  });

  it('returns 0 rates when there are no active conversations', async () => {
    const { svc } = make({
      conversations: 0,
      grouped: [{ type: 'conversation.handoff', _count: { type: 3 } }],
    });
    const m = await svc.tenantMetrics(7, 30);
    expect(m.handoffs).toBe(3);
    expect(m.handoffRate).toBe(0);
  });

  it('clamps the window (<=0 → default 30, huge → max 180)', async () => {
    const { svc } = make({});
    expect((await svc.tenantMetrics(7, 0)).windowDays).toBe(30);
    expect((await svc.tenantMetrics(7, 9999)).windowDays).toBe(180);
    expect((await svc.tenantMetrics(7, 7)).windowDays).toBe(7);
  });

  it('caches the snapshot (second call does not re-query)', async () => {
    const { svc, prisma } = make({ conversations: 5 });
    await svc.tenantMetrics(7, 30);
    await svc.tenantMetrics(7, 30);
    expect(prisma.event.groupBy).toHaveBeenCalledTimes(1);
  });

  it('returns the conversation audit timeline ordered by seq', async () => {
    const { svc, prisma } = make({
      auditRows: [
        {
          seq: 1,
          type: 'compliance.guard_triggered',
          actor_type: 'SYSTEM',
          payload: { riskLevel: 'HIGH' },
          created_at: new Date('2026-06-19T10:00:00Z'),
        },
        {
          seq: 2,
          type: 'conversation.handoff',
          actor_type: 'AI',
          payload: { reason: 'compliance guard: HIGH_RISK_SITUATION' },
          created_at: new Date('2026-06-19T10:00:01Z'),
        },
      ],
    });

    const audit = await svc.conversationAudit(7, 100);

    expect(audit).toHaveLength(2);
    expect(audit[0].type).toBe('compliance.guard_triggered');
    expect(audit[1].actorType).toBe('AI');
    expect(audit[1].payload).toEqual({
      reason: 'compliance guard: HIGH_RISK_SITUATION',
    });
    // Tenant-scoped to the CONVERSATION aggregate.
    expect(prisma.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          company_id: 7,
          aggregate_type: 'CONVERSATION',
        }),
      }),
    );
  });
});
