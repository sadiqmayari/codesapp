import { normRef, planExternalBookings, ExternalBookingOrder } from './external-bookings.util';
import { tcsBulkRowsToBookings } from './adapters/tcs.adapter';

const order = (name: string, extra: Partial<ExternalBookingOrder> = {}): ExternalBookingOrder => ({
  gid: `gid://shopify/Order/${name}`,
  name,
  storeId: 1,
  totalPrice: 1260,
  outstanding: 1260,
  fulfillmentStatus: 'fulfilled',
  ...extra,
});
const bk = (cn: string, ref: string | null, cod = 1260, day = 20) => ({
  trackingNumber: cn,
  reference: ref,
  codAmount: cod,
  bookedAt: new Date(Date.UTC(2026, 10, day, 7)),
});

describe('external bookings', () => {
  it('normalises refs', () => {
    expect(normRef(' #brf-12 ')).toBe('BRF-12');
    expect(normRef('##1001')).toBe('1001');
  });

  it('creates a row for a fulfilled order matched by name, ignores other businesses', () => {
    const p = planExternalBookings(
      [bk('111', 'BRF-1'), bk('222', 'MM COLLECTION'), bk('333', '#326739', 5554)],
      [order('BRF-1')],
      [],
    );
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0]).toMatchObject({ kind: 'create', booking: { trackingNumber: '111' } });
  });

  it('numeric refs need a matching COD (shared account collisions)', () => {
    const p = planExternalBookings(
      [bk('111', '#1821', 999), bk('222', '#1822', 1260)],
      [order('#1821'), order('#1822')],
      [],
    );
    expect(p.actions.map((a) => a.booking.trackingNumber)).toEqual(['222']);
  });

  it('skips unfulfilled orders, ambiguous names, already linked CNs, and keeps the latest CN', () => {
    const p = planExternalBookings(
      [bk('1', 'A-1'), bk('2', 'B-1'), bk('3', 'C-1'), bk('4', 'D-1', 1260, 18), bk('5', 'D-1', 1260, 22)],
      [
        order('A-1', { fulfillmentStatus: null }),
        order('B-1'),
        order('B-1', { gid: 'other' }),
        order('C-1'),
        order('D-1'),
      ],
      [{ id: 9, gid: 'x', courierType: 'tcs', trackingNumber: '3', status: 'booked' }],
    );
    expect(p.alreadyLinked).toBe(1);
    expect(p.actions.map((a) => a.booking.trackingNumber)).toEqual(['5']);
  });

  it('fills an open row without tracking, never a manual or tracked one', () => {
    const p = planExternalBookings(
      [bk('1', 'A-1'), bk('2', 'B-1'), bk('3', 'C-1')],
      [order('A-1'), order('B-1'), order('C-1')],
      [
        { id: 1, gid: order('A-1').gid, courierType: 'trax', trackingNumber: null, status: 'booked' },
        { id: 2, gid: order('B-1').gid, courierType: 'manual', trackingNumber: null, status: 'delivered' },
        { id: 3, gid: order('C-1').gid, courierType: 'leopards', trackingNumber: 'L9', status: 'in_transit' },
      ],
    );
    expect(p.actions).toEqual([expect.objectContaining({ kind: 'fill', shipmentId: 1 })]);
  });

  it('parses TCS cnbulkinquiry rows', () => {
    const [b] = tcsBulkRowsToBookings([
      { cnno: '772845322925', bookingdate: '20/10/2026', cnstatus: 'OK', customerrefno: 'BRF-1765', codamount: 940 },
    ]);
    expect(b).toMatchObject({ trackingNumber: '772845322925', reference: 'BRF-1765', codAmount: 940, rawStatus: 'OK' });
    expect(b.bookedAt?.toISOString()).toBe('2026-10-20T07:00:00.000Z');
  });
});
