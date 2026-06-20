import { HandoffSlaService } from './handoff-sla.service';

/**
 * Tests for Handoff SLA Management (#increment 8 / spec #10): the deterministic
 * reason→priority/SLA mapping, flag-gated recording (+ supersede), and the sweep's
 * resolve-vs-breach decision with owner alerting.
 */
describe('HandoffSlaService', () => {
  function make(opts: {
    enabled?: boolean;
    due?: any[];
    convo?: { status: string; assigned_user_id: number | null } | null;
    owner?: { email: string } | null;
  }) {
    const prisma = {
      handoff: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        create: jest.fn(async () => ({ id: 1 })),
        findMany: jest.fn(async () => opts.due ?? []),
        update: jest.fn(async () => ({})),
      },
      conversation: {
        findFirst: jest.fn(async () => opts.convo ?? null),
      },
      user: { findFirst: jest.fn(async () => opts.owner ?? null) },
    } as any;
    const events = { append: jest.fn(async () => undefined) } as any;
    const mail = { send: jest.fn(async () => undefined) } as any;
    const featureService = {
      handoffSlaEnabled: jest.fn(async () => opts.enabled ?? true),
    } as any;
    return {
      svc: new HandoffSlaService(prisma, events, mail, featureService),
      prisma,
      events,
      mail,
    };
  }

  describe('classify', () => {
    const { svc } = make({});
    it.each([
      ['FRAUD_REVIEW (60): PAYMENT_REDIRECTION', 'fraud', 'urgent', 15],
      ['compliance guard: HIGH_RISK_SITUATION', 'medical_legal', 'urgent', 15],
      ['image routing: PRESCRIPTION', 'medical_legal', 'urgent', 15],
      ['triage → handoff (escalate, wants human)', 'angry', 'urgent', 15],
      ['CUSTOMER_FRUSTRATION (60): ALL_CAPS', 'frustration', 'high', 30],
      ['customer wants a refund', 'refund', 'high', 60],
      ['damaged item received', 'damaged', 'high', 120],
      ['image routing: PAYMENT_SLIP', 'payment', 'normal', 60],
      ['specialist sales disabled (kill switch)', 'general', 'normal', 240],
    ])('maps "%s" → %s/%s/%dm', (reason, category, priority, minutes) => {
      const c = svc.classify(reason);
      expect(c.category).toBe(category);
      expect(c.priority).toBe(priority);
      expect(c.minutes).toBe(minutes);
    });
  });

  describe('record', () => {
    it('no-ops when the flag is disabled', async () => {
      const { svc, prisma } = make({ enabled: false });
      await svc.record(7, 100, 'compliance guard: HIGH_RISK_SITUATION');
      expect(prisma.handoff.create).not.toHaveBeenCalled();
    });

    it('supersedes prior open handoffs and inserts with the computed SLA', async () => {
      const { svc, prisma, events } = make({ enabled: true });
      await svc.record(7, 100, 'customer wants a refund');
      expect(prisma.handoff.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ conversation_id: 100, resolved_at: null }),
        }),
      );
      expect(prisma.handoff.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            reason_category: 'refund',
            priority: 'high',
          }),
        }),
      );
      expect(events.append).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'handoff.sla_set' }),
      );
    });
  });

  describe('sweepOverdue', () => {
    const dueRow = {
      id: 5,
      company_id: 7,
      conversation_id: 100,
      reason: 'angry customer',
      reason_category: 'angry',
      priority: 'urgent',
      sla_due_at: new Date(Date.now() - 1000),
    };

    it('resolves a handoff that a human picked up (assigned) — no alert', async () => {
      const { svc, prisma, mail, events } = make({
        due: [dueRow],
        convo: { status: 'pending', assigned_user_id: 9 },
      });
      const r = await svc.sweepOverdue();
      expect(r).toEqual({ checked: 1, resolved: 1, breached: 0 });
      expect(prisma.handoff.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ resolved_at: expect.any(Date) }) }),
      );
      expect(mail.send).not.toHaveBeenCalled();
      expect(events.append).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'handoff.sla_breached' }),
      );
    });

    it('resolves a handoff moved off pending — no alert', async () => {
      const { svc, mail } = make({
        due: [dueRow],
        convo: { status: 'resolved', assigned_user_id: null },
      });
      const r = await svc.sweepOverdue();
      expect(r.resolved).toBe(1);
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('breaches + alerts an unattended handoff (still pending, unassigned)', async () => {
      const { svc, prisma, mail, events } = make({
        due: [dueRow],
        convo: { status: 'pending', assigned_user_id: null },
        owner: { email: 'owner@store.pk' },
      });
      const r = await svc.sweepOverdue();
      expect(r).toEqual({ checked: 1, resolved: 0, breached: 1 });
      expect(prisma.handoff.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ escalated_at: expect.any(Date) }) }),
      );
      expect(events.append).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'handoff.sla_breached' }),
      );
      expect(mail.send).toHaveBeenCalledWith(
        'owner@store.pk',
        expect.stringContaining('SLA breached'),
        expect.any(String),
      );
    });

    it('does not throw when the sweep query fails', async () => {
      const { svc, prisma } = make({});
      prisma.handoff.findMany.mockRejectedValueOnce(new Error('db down'));
      await expect(svc.sweepOverdue()).resolves.toEqual({
        checked: 0,
        resolved: 0,
        breached: 0,
      });
    });
  });
});
