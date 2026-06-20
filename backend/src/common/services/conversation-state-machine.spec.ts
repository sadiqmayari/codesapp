import {
  ConversationStateMachine,
  CONVERSATION_STATES,
} from './conversation-state-machine';

/**
 * Tests for the pure Conversation State Machine (#increment 9 / spec #1):
 * the documented forward funnel, global pivots, fresh-journey-from-terminal,
 * self-transitions, illegal transitions, and the signal→state mapping.
 */
describe('ConversationStateMachine', () => {
  const m = new ConversationStateMachine();

  describe('forward commerce funnel (legal)', () => {
    it.each([
      ['BROWSING', 'CART_BUILDING'],
      ['CART_BUILDING', 'COLLECTING_DETAILS'],
      ['CART_BUILDING', 'AWAITING_CONFIRMATION'],
      ['CART_BUILDING', 'PAYMENT_PENDING'], // prepaid: cart → bank details/await slip
      ['COLLECTING_DETAILS', 'AWAITING_CONFIRMATION'],
      ['COLLECTING_DETAILS', 'PAYMENT_PENDING'],
      ['AWAITING_CONFIRMATION', 'PAYMENT_PENDING'],
      ['AWAITING_CONFIRMATION', 'ORDER_CREATED'],
      ['PAYMENT_PENDING', 'ORDER_CREATED'],
    ] as const)('%s → %s is allowed', (from, to) => {
      expect(m.canTransition(from, to)).toBe(true);
    });
  });

  describe('global pivots allowed from anywhere', () => {
    it.each(['BROWSING', 'ORDER_STATUS', 'TICKET_OPEN', 'HUMAN_HANDOFF', 'CLOSED'] as const)(
      'any → %s',
      (to) => {
        expect(m.canTransition('PAYMENT_PENDING', to)).toBe(true);
        expect(m.canTransition('COLLECTING_DETAILS', to)).toBe(true);
      },
    );
  });

  it('allows a fresh journey from a terminal state', () => {
    expect(m.canTransition('ORDER_CREATED', 'CART_BUILDING')).toBe(true);
    expect(m.canTransition('CLOSED', 'BROWSING')).toBe(true);
    expect(m.canTransition('HUMAN_HANDOFF', 'CART_BUILDING')).toBe(true);
  });

  it('treats a self-transition as valid (idempotent)', () => {
    expect(m.canTransition('BROWSING', 'BROWSING')).toBe(true);
  });

  describe('illegal transitions are rejected', () => {
    it.each([
      ['BROWSING', 'ORDER_CREATED'],
      ['BROWSING', 'PAYMENT_PENDING'],
      ['CART_BUILDING', 'ORDER_CREATED'],
      ['ORDER_STATUS', 'COLLECTING_DETAILS'],
    ] as const)('%s → %s is illegal', (from, to) => {
      expect(m.canTransition(from, to)).toBe(false);
      const v = m.validate(from, to);
      expect(v.ok).toBe(false);
      expect(v.reason).toContain(from);
    });
  });

  describe('fromSignal mapping', () => {
    it.each([
      ['sales', 'BROWSING'],
      ['general', 'BROWSING'],
      ['order', 'CART_BUILDING'],
      ['awaiting_confirmation', 'AWAITING_CONFIRMATION'],
      ['payment_pending', 'PAYMENT_PENDING'],
      ['order_created', 'ORDER_CREATED'],
      ['logistics', 'ORDER_STATUS'],
      ['resolution', 'TICKET_OPEN'],
      ['ticket_open', 'TICKET_OPEN'],
      ['closing', 'CLOSED'],
      ['escalate', 'HUMAN_HANDOFF'],
      ['handoff', 'HUMAN_HANDOFF'],
    ] as const)('signal %s → %s', (sig, state) => {
      expect(m.fromSignal(sig)).toBe(state);
    });
  });

  describe('isState', () => {
    it('recognizes valid states and rejects junk', () => {
      for (const s of CONVERSATION_STATES) expect(m.isState(s)).toBe(true);
      expect(m.isState('NONSENSE')).toBe(false);
      expect(m.isState(null)).toBe(false);
      expect(m.isState(42)).toBe(false);
    });
  });
});
