import {
  FrustrationDetectorService,
  FRUSTRATION_DEFAULT_THRESHOLD,
} from './frustration-detector.service';

/**
 * Deterministic tests for the Frustration Detector (#increment 4 / spec #9).
 * Verifies each signal, the weighting that decides escalation at the default
 * threshold, repeat detection (incl. exact-duplicate earlier message), and that
 * calm messages never escalate.
 */
describe('FrustrationDetectorService', () => {
  const svc = new FrustrationDetectorService();
  const T = FRUSTRATION_DEFAULT_THRESHOLD;

  it('scores calm messages 0 / NONE', () => {
    const d = svc.evaluate({ latest: 'hi, what is the price of omega 3?' });
    expect(d.score).toBe(0);
    expect(d.reasonCode).toBe('NONE');
    expect(d.signals).toHaveLength(0);
  });

  it('escalates on an explicit "already told you" phrase alone', () => {
    const d = svc.evaluate({ latest: 'I already told you my address' });
    expect(d.signals).toContain('EXPLICIT_FRUSTRATION_PHRASE');
    expect(d.score).toBeGreaterThanOrEqual(T);
    expect(d.reasonCode).toBe('CUSTOMER_FRUSTRATION');
  });

  it('detects ALL CAPS shouting', () => {
    const d = svc.evaluate({ latest: 'WHERE IS MY ORDER' });
    expect(d.signals).toContain('ALL_CAPS');
  });

  it('does not flag short uppercase tokens as shouting', () => {
    expect(svc.evaluate({ latest: 'OK' }).signals).not.toContain('ALL_CAPS');
    expect(svc.evaluate({ latest: 'BP' }).signals).not.toContain('ALL_CAPS');
  });

  it('detects multiple exclamation marks', () => {
    expect(svc.evaluate({ latest: 'answer me!!' }).signals).toContain(
      'MULTIPLE_EXCLAMATION',
    );
    expect(svc.evaluate({ latest: 'hello!' }).signals).not.toContain(
      'MULTIPLE_EXCLAMATION',
    );
  });

  it('detects negative sentiment vocabulary (English + Roman-Urdu)', () => {
    expect(svc.evaluate({ latest: 'this service is terrible' }).signals).toContain(
      'NEGATIVE_SENTIMENT',
    );
    expect(svc.evaluate({ latest: 'ye to bilkul bekar hai' }).signals).toContain(
      'NEGATIVE_SENTIMENT',
    );
  });

  it('combines shouting + exclamation + negativity to escalate', () => {
    const d = svc.evaluate({ latest: 'THIS IS USELESS!!' });
    expect(d.score).toBeGreaterThanOrEqual(T);
    expect(d.reasonCode).toBe('CUSTOMER_FRUSTRATION');
  });

  it('detects a repeated question vs an earlier identical message', () => {
    const d = svc.evaluate({
      latest: 'where is my order number 1055',
      recent: ['where is my order number 1055', 'where is my order number 1055'],
    });
    expect(d.signals).toContain('REPEATED_QUESTION');
  });

  it('does not flag a repeat when prior messages differ', () => {
    const d = svc.evaluate({
      latest: 'do you have vitamin c',
      recent: ['what are your shipping charges', 'do you have vitamin c'],
    });
    expect(d.signals).not.toContain('REPEATED_QUESTION');
  });

  it('caps the score at 100', () => {
    const d = svc.evaluate({
      latest: 'YOU ARE NOT UNDERSTANDING, THIRD TIME, THIS IS USELESS!!!',
      recent: ['you are not understanding third time this is useless'],
    });
    expect(d.score).toBeLessThanOrEqual(100);
    expect(d.score).toBeGreaterThanOrEqual(T);
  });

  it('handles empty input', () => {
    expect(svc.evaluate({ latest: '' }).reasonCode).toBe('NONE');
  });
});
