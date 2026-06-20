import {
  ResponseConfidenceService,
  CONFIDENCE_HANDOFF_BELOW,
} from './response-confidence.service';

/**
 * Tests for the deterministic Specialist Confidence Framework (#increment 10 /
 * spec #8): grounded vs ungrounded scoring, tool failure, hedging, and the
 * send/handoff decision thresholds.
 */
describe('ResponseConfidenceService', () => {
  const svc = new ResponseConfidenceService();

  describe('score', () => {
    it('rewards a grounded sales reply (tool used, no failures)', () => {
      const r = svc.score({
        reply: 'The Kids Duo is 3346 after 7% discount.',
        toolsUsed: ['search_products'],
        toolFailures: 0,
        intent: 'sales',
      });
      expect(r.confidence).toBeGreaterThanOrEqual(70);
      expect(r.reasonCode).toBe('OK');
    });

    it('penalizes a tool failure', () => {
      const r = svc.score({
        reply: 'Here is the price.',
        toolsUsed: ['search_products'],
        toolFailures: 1,
        intent: 'sales',
      });
      expect(r.reasonCode).toBe('TOOL_FAILURE');
      expect(r.confidence).toBeLessThan(70);
    });

    it('penalizes hedging language', () => {
      const r = svc.score({
        reply: "I'm not sure, let me check and get back to you.",
        toolsUsed: ['search_knowledge'],
        toolFailures: 0,
        intent: 'general',
      });
      expect(r.reasonCode).toBe('HEDGING');
      expect(r.confidence).toBeLessThan(70);
    });

    it('flags an ungrounded price (number quoted without search_products)', () => {
      const r = svc.score({
        reply: 'It costs 3500 rupees.',
        toolsUsed: [],
        toolFailures: 0,
        intent: 'sales',
      });
      expect(r.reasonCode).toBe('UNGROUNDED_PRICE');
      expect(r.confidence).toBeLessThan(70);
    });

    it('flags a logistics reply that never looked the order up', () => {
      const r = svc.score({
        reply: 'Your order is on the way.',
        toolsUsed: [],
        toolFailures: 0,
        intent: 'logistics',
      });
      expect(r.reasonCode).toBe('NO_STATUS_TOOL');
    });

    it('returns 0 for an empty reply', () => {
      expect(svc.score({ reply: '', toolsUsed: [], toolFailures: 0, intent: 'sales' })).toEqual({
        confidence: 0,
        reasonCode: 'EMPTY_REPLY',
      });
    });

    it('clamps to 0–100', () => {
      const r = svc.score({
        reply: "I'm not sure, 3500, let me check",
        toolsUsed: [],
        toolFailures: 2,
        intent: 'sales',
      });
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(100);
    });
  });

  describe('decide', () => {
    it('hands off below the hard floor (<50)', () => {
      expect(
        svc.decide({ confidence: CONFIDENCE_HANDOFF_BELOW - 1, intent: 'sales', replyIsQuestion: false }),
      ).toBe('handoff');
    });

    it('hands off an uncertain commerce recommendation (<70, not a question)', () => {
      expect(svc.decide({ confidence: 60, intent: 'order', replyIsQuestion: false })).toBe('handoff');
    });

    it('sends an uncertain reply that is already a clarifying question', () => {
      expect(svc.decide({ confidence: 60, intent: 'order', replyIsQuestion: true })).toBe('send');
    });

    it('sends an uncertain NON-commerce reply (general/greeting)', () => {
      expect(svc.decide({ confidence: 60, intent: 'general', replyIsQuestion: false })).toBe('send');
    });

    it('sends a confident reply', () => {
      expect(svc.decide({ confidence: 85, intent: 'sales', replyIsQuestion: false })).toBe('send');
    });
  });
});
