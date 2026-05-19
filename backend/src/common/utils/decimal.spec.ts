import { Prisma } from '@prisma/client';
import { numifyDecimals } from './decimal';

describe('numifyDecimals', () => {
  it('converts a bare Decimal to a number', () => {
    expect(numifyDecimals(new Prisma.Decimal('100.50'))).toBe(100.5);
  });

  it('converts Decimals nested in objects and arrays', () => {
    const input = {
      plan: 'pro',
      monthly_price: new Prisma.Decimal('2999.00'),
      setup_fee: new Prisma.Decimal('0'),
      items: [
        { amount: new Prisma.Decimal('10') },
        { amount: new Prisma.Decimal('20.25') },
      ],
      meta: { total: 2 },
    };
    expect(numifyDecimals(input)).toEqual({
      plan: 'pro',
      monthly_price: 2999,
      setup_fee: 0,
      items: [{ amount: 10 }, { amount: 20.25 }],
      meta: { total: 2 },
    });
  });

  it('passes through null, Dates and primitives untouched', () => {
    const d = new Date('2026-05-19T00:00:00.000Z');
    expect(numifyDecimals(null)).toBeNull();
    expect(numifyDecimals(undefined)).toBeUndefined();
    expect(numifyDecimals('x')).toBe('x');
    expect(numifyDecimals(42)).toBe(42);
    expect(numifyDecimals(d)).toBe(d);
  });
});
