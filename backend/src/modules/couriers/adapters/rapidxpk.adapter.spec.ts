import * as crypto from 'crypto';
import {
  RapidxpkAdapter,
  keyMode,
  rapidxpkExternalBase,
  synthesizeRapidxpkHistory,
  toRapidxpkPhone,
  verifyRapidxpkSignature,
} from './rapidxpk.adapter';
import { UnmappedCourierStatusError } from './courier-adapter.interface';
import { buildRapidxpkLabelsPdf, RapidxpkLabelData } from '../rapidxpk-slip.util';
import { buildRapidxpkLoadsheetPdf, toRapidxpkLoadsheets } from '../rapidxpk-loadsheet.util';

describe('RapidxpkAdapter', () => {
  const a = new RapidxpkAdapter();

  it('maps every documented status', () => {
    expect(a.mapStatus('received')).toBe('booked');
    expect(a.mapStatus('packed')).toBe('ready_for_pickup');
    expect(a.mapStatus('dispatched')).toBe('out_for_delivery');
    expect(a.mapStatus('delivered')).toBe('delivered');
    expect(a.mapStatus('failed_attempt')).toBe('attempted');
    expect(a.mapStatus('rto')).toBe('failed'); // return in motion, NOT returned
    expect(a.mapStatus('returned')).toBe('returned');
    expect(a.mapStatus('cancelled')).toBe('cancelled');
    expect(a.mapStatus('order.delivered')).toBe('delivered');
    expect(a.mapStatus('Failed Attempt')).toBe('attempted');
  });

  it('throws on an unknown status', () => {
    expect(() => a.mapStatus('teleported')).toThrow(UnmappedCourierStatusError);
  });

  it('normalises Pakistani mobiles to 03XXXXXXXXX', () => {
    expect(toRapidxpkPhone('03001234567')).toBe('03001234567');
    expect(toRapidxpkPhone('+92 300 1234567')).toBe('03001234567');
    expect(toRapidxpkPhone('923001234567')).toBe('03001234567');
    expect(toRapidxpkPhone('00923001234567')).toBe('03001234567');
    expect(toRapidxpkPhone('3001234567')).toBe('03001234567');
  });

  it('builds external ids from the order number', () => {
    expect(rapidxpkExternalBase('#51842')).toBe('51842');
    expect(rapidxpkExternalBase('YG-1001')).toBe('YG-1001');
    expect(rapidxpkExternalBase('#1001-R1')).toBe('1001-R1');
  });

  it('detects key mode', () => {
    expect(keyMode('rxp_test_abc')).toBe('test');
    expect(keyMode('rxp_live_abc')).toBe('live');
    expect(keyMode('nope')).toBeNull();
  });

  describe('verifyRapidxpkSignature', () => {
    const secret = 'whsec_test';
    const body = '{"event":"order.delivered","order_id":"RXK-1"}';
    const now = 1_800_000_000_000;
    const ts = String(Math.floor(now / 1000));
    const sig =
      'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

    it('accepts a valid signature', () => {
      expect(verifyRapidxpkSignature(secret, ts, sig, Buffer.from(body), now)).toBe(true);
    });
    it('rejects a tampered body', () => {
      expect(verifyRapidxpkSignature(secret, ts, sig, body.replace('1', '2'), now)).toBe(false);
    });
    it('rejects a wrong secret', () => {
      expect(verifyRapidxpkSignature('other', ts, sig, body, now)).toBe(false);
    });
    it('rejects a stale timestamp (> 5 min)', () => {
      expect(verifyRapidxpkSignature(secret, ts, sig, body, now + 301_000)).toBe(false);
    });
    it('rejects missing headers', () => {
      expect(verifyRapidxpkSignature(secret, undefined, sig, body, now)).toBe(false);
      expect(verifyRapidxpkSignature(secret, ts, undefined, body, now)).toBe(false);
    });
  });

  it('synthesises a timeline from milestone timestamps', () => {
    const h = synthesizeRapidxpkHistory({
      order_id: 'RXK-1',
      status: 'failed_attempt',
      reason: 'Customer not home',
      attempts: 1,
      created_at: '2026-10-22T07:15:02Z',
      packed_at: '2026-10-22T08:02:11Z',
      dispatched_at: '2026-10-22T10:40:05Z',
      updated_at: '2026-10-22T13:21:47Z',
    });
    expect(h.map((c) => c.status)).toEqual([
      'Received by RapidXpk',
      'Packed — ready for rider',
      'Out for delivery',
      'Delivery attempt failed',
    ]);
    expect(h[3].detail).toBe('Customer not home · attempt 1');
  });
});

describe('RapidXpk label + loadsheet', () => {
  const base: RapidxpkLabelData = {
    orderId: 'RXK-1234567',
    trackingUrl: 'https://rapidxpk.com/track.html?tn=RXK-1234567',
    externalId: 'YG-1001',
    service: 'STANDARD 24 HR',
    date: '2026-11-15',
    brand: 'Yummy Gummy',
    name: 'Ali Khan',
    phone: '03001234567',
    address: 'House 12, Street 4, DHA Phase 5',
    landmark: 'Near Masjid',
    city: 'Lahore',
    codAmount: 2500,
    payment: 'COD',
    pieces: 1,
    items: [{ name: 'Gummies 60ct', qty: 2 }],
    notes: 'Call before delivery',
  };
  const prepaid: RapidxpkLabelData = {
    ...base,
    orderId: 'RXK-1234568',
    externalId: 'YG-1002',
    name: 'Sara',
    phone: '03211234567',
    codAmount: 0,
    payment: 'PREPAID',
  };

  it('computes RapidXpk loadsheet totals (COD only)', () => {
    const [sheet] = toRapidxpkLoadsheets([base, prepaid], '2026-11-15');
    expect(sheet).toEqual({
      loadsheet_date: '2026-11-15',
      brand: 'Yummy Gummy',
      total_parcels: 2,
      total_cod: 2500,
      orders: [
        { order_id: 'RXK-1234567', external_id: 'YG-1001', name: 'Ali Khan', phone: '03001234567', city: 'Lahore', pieces: 1, cod_amount: 2500, payment: 'COD' },
        { order_id: 'RXK-1234568', external_id: 'YG-1002', name: 'Sara', phone: '03211234567', city: 'Lahore', pieces: 1, cod_amount: 0, payment: 'PREPAID' },
      ],
    });
  });

  it('splits a multi-brand batch into one sheet per brand', () => {
    const sheets = toRapidxpkLoadsheets([base, { ...prepaid, brand: 'Other Store' }], '2026-11-15');
    expect(sheets.map((s) => s.brand)).toEqual(['Yummy Gummy', 'Other Store']);
  });

  it('renders label and loadsheet PDFs', async () => {
    const labels = await buildRapidxpkLabelsPdf([base, prepaid]);
    expect(labels.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const sheet = await buildRapidxpkLoadsheetPdf(toRapidxpkLoadsheets([base, prepaid], '2026-11-15'));
    expect(sheet.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
