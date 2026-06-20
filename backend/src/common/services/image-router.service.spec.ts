import { ImageRouterService } from './image-router.service';

/**
 * Deterministic tests for the multimodal Image Router (#increment 7 / spec #11):
 * context + caption driven classification, risk precedence, and that non-media
 * inputs are ignored.
 */
describe('ImageRouterService', () => {
  const svc = new ImageRouterService();

  it('classifies an awaiting-payment image as PAYMENT_SLIP (context)', () => {
    expect(
      svc.classify({ mediaType: 'image', awaitingPayment: true }),
    ).toBe('PAYMENT_SLIP');
  });

  it('classifies a payment caption as PAYMENT_SLIP (English + Roman-Urdu)', () => {
    expect(svc.classify({ mediaType: 'image', caption: 'here is my payment slip' })).toBe(
      'PAYMENT_SLIP',
    );
    expect(svc.classify({ mediaType: 'image', caption: 'easypaisa se paise bhej diye' })).toBe(
      'PAYMENT_SLIP',
    );
    expect(svc.classify({ mediaType: 'document', caption: 'transaction receipt' })).toBe(
      'PAYMENT_SLIP',
    );
  });

  it('classifies a prescription mention as PRESCRIPTION', () => {
    expect(svc.classify({ mediaType: 'image', caption: 'doctor prescription' })).toBe(
      'PRESCRIPTION',
    );
    expect(svc.classify({ mediaType: 'image', caption: 'yeh meri parchi hai' })).toBe(
      'PRESCRIPTION',
    );
  });

  it('classifies a damage description as DAMAGE_PHOTO', () => {
    expect(svc.classify({ mediaType: 'image', caption: 'the bottle arrived broken' })).toBe(
      'DAMAGE_PHOTO',
    );
    expect(svc.classify({ mediaType: 'image', recentText: 'product kharab nikla' })).toBe(
      'DAMAGE_PHOTO',
    );
  });

  it('defaults a bare image to PRODUCT_IMAGE', () => {
    expect(svc.classify({ mediaType: 'image' })).toBe('PRODUCT_IMAGE');
    expect(svc.classify({ mediaType: 'image', caption: 'do you have this one' })).toBe(
      'PRODUCT_IMAGE',
    );
  });

  it('classifies a document with no signal as OTHER', () => {
    expect(svc.classify({ mediaType: 'document', caption: 'my file' })).toBe('OTHER');
  });

  it('ignores non-media message types', () => {
    expect(svc.classify({ mediaType: 'text', caption: 'payment slip' })).toBe('OTHER');
    expect(svc.classify({ mediaType: null })).toBe('OTHER');
  });

  it('applies risk precedence (payment wins over damage)', () => {
    expect(
      svc.classify({ mediaType: 'image', caption: 'payment done but item is broken' }),
    ).toBe('PAYMENT_SLIP');
  });
});
