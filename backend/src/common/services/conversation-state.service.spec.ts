import { ConversationStateService } from './conversation-state.service';
import { ConversationStateMachine } from './conversation-state-machine';

/**
 * Tests for ConversationStateService (#increment 9 / spec #1): flag gating,
 * initial state recording, legal advance + event, illegal-transition rejection
 * (state unchanged) + event, and current() read.
 */
describe('ConversationStateService', () => {
  function make(opts: { enabled?: boolean; existing?: any | null }) {
    const prisma = {
      conversationState: {
        findUnique: jest.fn(async () => opts.existing ?? null),
        upsert: jest.fn(async () => ({})),
      },
    } as any;
    const events = { append: jest.fn(async () => undefined) } as any;
    const featureService = {
      conversationStateMachineEnabled: jest.fn(async () => opts.enabled ?? true),
    } as any;
    const svc = new ConversationStateService(
      prisma,
      events,
      new ConversationStateMachine(),
      featureService,
    );
    return { svc, prisma, events };
  }

  it('no-ops when the flag is disabled', async () => {
    const { svc, prisma, events } = make({ enabled: false });
    await svc.apply(7, 100, 'CART_BUILDING');
    expect(prisma.conversationState.upsert).not.toHaveBeenCalled();
    expect(events.append).not.toHaveBeenCalled();
  });

  it('records the initial state when none exists', async () => {
    const { svc, prisma, events } = make({ existing: null });
    await svc.apply(7, 100, 'BROWSING', { lockedIntent: 'sales' });
    expect(prisma.conversationState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          conversation_id: 100,
          current_state: 'BROWSING',
          locked_intent: 'sales',
        }),
      }),
    );
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'state.transition',
        payload: { from: null, to: 'BROWSING' },
      }),
    );
  });

  it('advances on a legal transition and logs state.transition', async () => {
    const { svc, prisma, events } = make({
      existing: { current_state: 'BROWSING' },
    });
    await svc.apply(7, 100, 'CART_BUILDING');
    expect(prisma.conversationState.upsert).toHaveBeenCalled();
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'state.transition',
        payload: { from: 'BROWSING', to: 'CART_BUILDING' },
      }),
    );
  });

  it('REJECTS an illegal transition (state unchanged) and logs invalid_transition', async () => {
    const { svc, prisma, events } = make({
      existing: { current_state: 'BROWSING' },
    });
    await svc.apply(7, 100, 'ORDER_CREATED'); // illegal from BROWSING
    expect(prisma.conversationState.upsert).not.toHaveBeenCalled();
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'state.invalid_transition',
        payload: { from: 'BROWSING', to: 'ORDER_CREATED' },
      }),
    );
  });

  it('does not log a transition event for an idempotent self-transition', async () => {
    const { svc, prisma, events } = make({
      existing: { current_state: 'CART_BUILDING' },
    });
    await svc.apply(7, 100, 'CART_BUILDING');
    expect(prisma.conversationState.upsert).toHaveBeenCalled(); // still upserts meta
    expect(events.append).not.toHaveBeenCalled();
  });

  it('current() returns the persisted state (tenant-scoped)', async () => {
    const { svc } = make({
      existing: { current_state: 'ORDER_STATUS', company_id: 7 },
    });
    expect(await svc.current(7, 100)).toBe('ORDER_STATUS');
  });

  it('current() returns null for a mismatched tenant', async () => {
    const { svc } = make({
      existing: { current_state: 'ORDER_STATUS', company_id: 999 },
    });
    expect(await svc.current(7, 100)).toBeNull();
  });
});
