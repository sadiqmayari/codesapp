import {
  ComplianceGuardService,
  COMPLIANCE_HIGH_RESPONSE,
  COMPLIANCE_MEDIUM_RESPONSE,
} from './compliance-guard.service';

/**
 * Exhaustive deterministic tests for the Compliance Guard (#increment 2).
 * The guard is the medical-safety brain, so every branch is covered: LOW/MEDIUM/
 * HIGH classification, precedence, case-insensitivity, phrase matching, Roman-Urdu
 * variants, matchedKeywords/reasonCode, and the critical product-category
 * false-positive controls (bare "kids" must NOT escalate for a store that sells
 * kids vitamins). Pure function → no LLM, no I/O.
 */
describe('ComplianceGuardService', () => {
  const guard = new ComplianceGuardService();

  describe('LOW — benign informational → PROCEED', () => {
    const lows = [
      'What are Omega 3 benefits?',
      'What vitamins does mango contain?',
      'What ingredients are in this product?',
      'Do you have kids vitamins?', // product category, NOT a medical question
      'Is there sugar in this product?', // "sugar" as ingredient, not diabetes
      'kitne ka hai ye product?',
      'salam, price batao',
    ];
    it.each(lows)('proceeds for: %s', (text) => {
      const d = guard.evaluate(text);
      expect(d.action).toBe('PROCEED');
      expect(d.riskLevel).toBe('LOW');
      expect(d.reasonCode).toBe('NONE');
      expect(d.matchedKeywords).toHaveLength(0);
      expect(d.response).toBeUndefined();
    });
  });

  describe('MEDIUM — chronic condition / medication → SAFE_RESPONSE (no handoff)', () => {
    const mediums = [
      'I have diabetes, can I use this?',
      'I have thyroid problems.',
      'I take blood pressure medicine.',
      'Will this help my PCOS?',
      'Can I take this while using metformin?',
      'mujhe sugar ki bimari hai',
      'I am on warfarin, is it safe?',
    ];
    it.each(mediums)('returns the safe response for: %s', (text) => {
      const d = guard.evaluate(text);
      expect(d.action).toBe('SAFE_RESPONSE');
      expect(d.riskLevel).toBe('MEDIUM');
      expect(d.response).toBe(COMPLIANCE_MEDIUM_RESPONSE);
      expect(d.matchedKeywords.length).toBeGreaterThan(0);
      expect(['CHRONIC_CONDITION', 'MEDICATION_MENTION']).toContain(d.reasonCode);
    });

    it('uses CHRONIC_CONDITION when a disease is present', () => {
      expect(guard.evaluate('I have diabetes').reasonCode).toBe('CHRONIC_CONDITION');
    });

    it('uses MEDICATION_MENTION when only a medication is present', () => {
      expect(guard.evaluate('can I take this with aspirin').reasonCode).toBe(
        'MEDICATION_MENTION',
      );
    });
  });

  describe('HIGH — sensitive population / crisis → HANDOFF', () => {
    const highs = [
      'I am pregnant, can I take this?',
      'Can I use this while breastfeeding?',
      'My mother is on chemotherapy for cancer',
      'I just had surgery last week',
      'is this safe for my child?',
      'he was admitted to the hospital',
      'main hamla hoon, ye le sakti hoon?',
      'I think this is an emergency',
    ];
    it.each(highs)('hands off for: %s', (text) => {
      const d = guard.evaluate(text);
      expect(d.action).toBe('HANDOFF');
      expect(d.riskLevel).toBe('HIGH');
      expect(d.response).toBe(COMPLIANCE_HIGH_RESPONSE);
      expect(d.reasonCode).toBe('HIGH_RISK_SITUATION');
      expect(d.matchedKeywords.length).toBeGreaterThan(0);
    });
  });

  describe('precedence — HIGH wins over MEDIUM', () => {
    it('escalates when both a disease and a high-risk term appear', () => {
      const d = guard.evaluate('I have diabetes and I am pregnant');
      expect(d.riskLevel).toBe('HIGH');
      expect(d.action).toBe('HANDOFF');
    });
  });

  describe('matching robustness', () => {
    it('is case-insensitive', () => {
      expect(guard.evaluate('I AM PREGNANT').riskLevel).toBe('HIGH');
      expect(guard.evaluate('DiAbEtEs').riskLevel).toBe('MEDIUM');
    });

    it('matches multi-word phrases with flexible whitespace/punctuation', () => {
      expect(guard.evaluate('my blood   pressure is high').riskLevel).toBe('MEDIUM');
      expect(guard.evaluate('blood-pressure issues').riskLevel).toBe('MEDIUM');
      expect(guard.evaluate('is it safe for my child?').riskLevel).toBe('HIGH');
    });

    it('does not substring-false-match inside larger words', () => {
      // "bp" must not match inside "backup"; no other medical term present.
      expect(guard.evaluate('please send me a backup invoice').riskLevel).toBe('LOW');
    });

    it('handles Roman-Urdu variants', () => {
      expect(guard.evaluate('mujhe sugar ki bimari hai').riskLevel).toBe('MEDIUM');
      expect(guard.evaluate('dil ka marz hai').riskLevel).toBe('MEDIUM');
      expect(guard.evaluate('main hamla hoon').riskLevel).toBe('HIGH');
      expect(guard.evaluate('mere bachay ko de sakte hain?').riskLevel).toBe('HIGH');
    });

    it('reports the matched canonical keyword(s)', () => {
      expect(guard.evaluate('I have diabetes').matchedKeywords).toContain('diabetes');
      expect(guard.evaluate('I am pregnant').matchedKeywords).toContain('pregnant');
    });
  });

  describe('edge cases', () => {
    it('treats empty / whitespace input as LOW/PROCEED', () => {
      expect(guard.evaluate('').action).toBe('PROCEED');
      expect(guard.evaluate('   ').action).toBe('PROCEED');
      // @ts-expect-error — defensive against a null slipping in
      expect(guard.evaluate(null).action).toBe('PROCEED');
    });
  });
});
