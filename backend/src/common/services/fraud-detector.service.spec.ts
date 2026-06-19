import {
  FraudDetectorService,
  FRAUD_DEFAULT_THRESHOLD,
} from './fraud-detector.service';

/**
 * Deterministic tests for the Fraud Detector (#increment 4 / spec #6): the
 * payment-redirection text signal, each history-counter signal, threshold-driven
 * requiresHumanReview, score capping, and that benign input is not flagged.
 */
describe('FraudDetectorService', () => {
  const svc = new FraudDetectorService();
  const T = FRAUD_DEFAULT_THRESHOLD;

  it('does not flag a benign order message', () => {
    const r = svc.evaluate({ text: 'please deliver to 12 Main Road, COD' });
    expect(r.riskScore).toBe(0);
    expect(r.riskFactors).toHaveLength(0);
    expect(r.requiresHumanReview).toBe(false);
  });

  it('flags a payment-redirection attempt on its own', () => {
    const r = svc.evaluate({
      text: 'please send the money to my personal account instead',
    });
    expect(r.riskFactors).toContain('PAYMENT_REDIRECTION');
    expect(r.requiresHumanReview).toBe(true);
  });

  it('flags Roman-Urdu payment redirection', () => {
    const r = svc.evaluate({ text: 'is account par bhej dein paise' });
    expect(r.riskFactors).toContain('PAYMENT_REDIRECTION');
  });

  it('accumulates history signals', () => {
    const r = svc.evaluate({
      text: 'normal message',
      history: { phoneChanges: 3, addressChanges: 2 },
    });
    expect(r.riskFactors).toEqual(
      expect.arrayContaining(['REPEATED_PHONE_CHANGE', 'REPEATED_ADDRESS_CHANGE']),
    );
  });

  it('flags multiple failed orders + excessive modifications', () => {
    const r = svc.evaluate({
      text: 'change it again',
      history: { failedOrders: 2, modifications: 5 },
    });
    expect(r.riskFactors).toEqual(
      expect.arrayContaining(['MULTIPLE_FAILED_ORDERS', 'EXCESSIVE_MODIFICATIONS']),
    );
    expect(r.requiresHumanReview).toBe(true);
  });

  it('does not trip history signals below their minimums', () => {
    const r = svc.evaluate({
      text: 'hello',
      history: { phoneChanges: 1, addressChanges: 1, failedOrders: 1, modifications: 3 },
    });
    expect(r.riskScore).toBe(0);
    expect(r.requiresHumanReview).toBe(false);
  });

  it('respects a custom threshold', () => {
    const r = svc.evaluate({ text: 'hi', history: { phoneChanges: 2 } }, 10);
    expect(r.riskScore).toBe(25);
    expect(r.requiresHumanReview).toBe(true); // 25 >= 10
    const r2 = svc.evaluate({ text: 'hi', history: { phoneChanges: 2 } }, 90);
    expect(r2.requiresHumanReview).toBe(false); // 25 < 90
  });

  it('caps the score at 100', () => {
    const r = svc.evaluate(
      { text: 'send the money to another account' },
      T,
    );
    const r2 = svc.evaluate(
      {
        text: 'send the money to another account',
        history: { phoneChanges: 5, addressChanges: 5, failedOrders: 5, modifications: 9 },
      },
      T,
    );
    expect(r.riskScore).toBeLessThanOrEqual(100);
    expect(r2.riskScore).toBe(100);
  });
});
