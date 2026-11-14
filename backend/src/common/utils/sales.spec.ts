import { orderSales, salesFromRow } from './sales';

describe('sales definition (Gross / Net)', () => {
  it('real order #3001086: subtotal is after discount; shipping not in sales', () => {
    const s = orderSales({ subtotal_price: '3398.30', total_discounts: '599.70', total_shipping: '199', total_tax: '0', total_price: '3597.30' });
    expect(s.gross).toBe(3998);
    expect(s.afterDiscount).toBe(3398.3);
    expect(s.net).toBe(3398.3);
    expect(s.state).toBe('kept');
  });
  it('returned beats cancelled (a received return also cancels the order)', () => {
    const s = orderSales({ subtotal_price: 1000, total_discounts: 0, cancelled_at: new Date(), shipment: { status: 'cancelled', received_at: new Date() } });
    expect(s.state).toBe('returned');
    expect(s.net).toBe(0);
    expect(orderSales({ subtotal_price: 1000, cancelled_at: new Date(), shipment: null }).state).toBe('cancelled');
  });
  it('legacy rows without a breakdown fall back to total − shipping − tax', () => {
    expect(orderSales({ subtotal_price: null, total_price: 2199, total_shipping: 199, total_tax: 0 }).afterDiscount).toBe(2000);
  });
  it('aggregate row: gross − discounts − cancelled − returned = net', () => {
    const t = salesFromRow({ orders: 239n, gross: '786746', discounts: '10720', cancelled: '19041', returned: '0', net: '756985', shipping: '7761' });
    expect(t.gross - t.discounts - t.cancelled - t.returned).toBeCloseTo(t.net, 0);
    expect(t.orders).toBe(239);
  });
});
