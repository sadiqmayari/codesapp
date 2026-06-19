import { ToolValidatorService } from './tool-validator.service';

/**
 * Deterministic tests for the Tool Validation Layer (#increment 5 / spec #3):
 * products (drop priceless/malformed, normalize stock + discount), order status
 * (strip unknown tracking, flag incomplete), shipping rates (drop invalid,
 * normalize currency), payment details (only real account data).
 */
describe('ToolValidatorService', () => {
  const v = new ToolValidatorService();

  describe('products', () => {
    it('drops products with a missing or zero/invalid price', () => {
      const { items, dropped } = v.products([
        { product: 'Good', price: '1500' },
        { product: 'NoPrice', price: null },
        { product: 'Zero', price: 0 },
        { product: 'Junk', price: 'abc' },
        { price: 99 }, // no title
      ]);
      expect(items.map((i) => i.product)).toEqual(['Good']);
      expect(items[0].price).toBe(1500);
      expect(dropped).toBe(4);
    });

    it('defaults inStock to true when absent, respects it when present', () => {
      const { items } = v.products([
        { product: 'A', price: 10 },
        { product: 'B', price: 10, inStock: false },
      ]);
      expect(items[0].inStock).toBe(true);
      expect(items[1].inStock).toBe(false);
    });

    it('keeps a discount only when internally consistent', () => {
      const { items } = v.products([
        { product: 'Real', price: 90, discountPercent: 10, originalPrice: 100 },
        { product: 'BadPct', price: 90, discountPercent: 0, originalPrice: 100 },
        { product: 'BadOrig', price: 90, discountPercent: 10, originalPrice: 80 },
      ]);
      expect(items[0].discountPercent).toBe(10);
      expect(items[0].originalPrice).toBe(100);
      expect(items[1].discountPercent).toBeUndefined();
      expect(items[2].discountPercent).toBeUndefined();
    });

    it('handles non-array input safely', () => {
      expect(v.products(undefined as any).items).toEqual([]);
    });
  });

  describe('orderStatus', () => {
    it('keeps a real status and a real tracking entry', () => {
      const r = v.orderStatus({
        deliveryStatus: 'Shipped',
        tracking: ['TCS AB123456789 https://track/abc'],
      });
      expect(r.complete).toBe(true);
      expect(r.deliveryStatus).toBe('Shipped');
      expect(r.tracking).toHaveLength(1);
    });

    it('strips placeholder tracking values', () => {
      const r = v.orderStatus({
        deliveryStatus: 'Shipped',
        tracking: ['N/A', 'pending', '-', ''],
      });
      expect(r.tracking).toHaveLength(0);
    });

    it('flags an unusable status as incomplete', () => {
      expect(v.orderStatus({ deliveryStatus: 'unknown', tracking: [] }).complete).toBe(false);
      expect(v.orderStatus({ deliveryStatus: '', tracking: [] }).complete).toBe(false);
      expect(v.orderStatus({ tracking: [] }).deliveryStatus).toBeNull();
    });
  });

  describe('shippingRates', () => {
    it('drops invalid rates and normalizes currency to uppercase', () => {
      const out = v.shippingRates([
        { title: 'Standard', amount: '250', currency: 'pkr' },
        { title: 'Free', amount: 0, currency: 'PKR' },
        { title: 'Bad', amount: 'NaN', currency: 'PKR' },
        { title: '', amount: 100, currency: 'PKR' },
        { title: 'Neg', amount: -5, currency: 'PKR' },
      ]);
      expect(out).toEqual([
        { title: 'Standard', amount: 250, currency: 'PKR' },
        { title: 'Free', amount: 0, currency: 'PKR' },
      ]);
    });
  });

  describe('paymentDetails', () => {
    it('returns details that look like real account data', () => {
      expect(v.paymentDetails('Meezan Bank, Acc 01234567890')).toContain('Meezan');
    });
    it('rejects empty or junk strings', () => {
      expect(v.paymentDetails('')).toBeNull();
      expect(v.paymentDetails('   ')).toBeNull();
      expect(v.paymentDetails('ask team')).toBeNull(); // no account digits
      expect(v.paymentDetails(null)).toBeNull();
    });
  });
});
