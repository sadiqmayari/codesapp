import { currentOrOriginal, effectiveQty, liveLines } from './order-lines';

describe('order lines — effective quantity', () => {
  it('uses currentQuantity (GraphQL) over the original quantity', () => {
    expect(effectiveQty({ quantity: 2, currentQuantity: 1 })).toBe(1);
    expect(effectiveQty({ quantity: 2, currentQuantity: 0 })).toBe(0);
  });
  it('uses current_quantity (REST webhook) over quantity', () => {
    expect(effectiveQty({ quantity: 3, current_quantity: 0 })).toBe(0);
    expect(effectiveQty({ quantity: 3, current_quantity: '2' })).toBe(2);
  });
  it('falls back to quantity, then 1 for legacy rows', () => {
    expect(effectiveQty({ quantity: 4 })).toBe(4);
    expect(effectiveQty({})).toBe(1);
    expect(effectiveQty(null)).toBe(0);
  });
  it('liveLines drops removed lines (edited order)', () => {
    const lines = [
      { title: 'A', quantity: 2, current_quantity: 0 },
      { title: 'B', quantity: 1, current_quantity: 1 },
      { title: 'C', quantity: 1 },
    ];
    expect(liveLines(lines).map((l) => l.title)).toEqual(['B', 'C']);
  });
  it('currentOrOriginal keeps the original for cancelled orders only', () => {
    expect(currentOrOriginal(false, '3999', '4998')).toBe('3999');
    expect(currentOrOriginal(true, '0', '4998')).toBe('4998');
    expect(currentOrOriginal(false, null, '4998')).toBe('4998');
  });
});
