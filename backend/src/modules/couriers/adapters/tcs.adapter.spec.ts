import {
  TcsAdapter,
  mapTcsStatus,
  parseTcsDate,
  splitTcsAddress,
  splitTcsName,
  tcsErrorText,
  tcsInvoiceToParsed,
  toTcsMobile,
} from './tcs.adapter';
import { UnmappedCourierStatusError } from './courier-adapter.interface';

describe('TcsAdapter', () => {
  const a = new TcsAdapter();

  it('maps codes and tracking texts', () => {
    expect(mapTcsStatus('Delivered', 'OK')).toBe('delivered');
    expect(mapTcsStatus('Shipment Delivered')).toBe('delivered');
    expect(mapTcsStatus('Awaiting Receiver Collection', 'SC')).toBe('attempted');
    expect(mapTcsStatus('Out For Delivery')).toBe('out_for_delivery');
    expect(mapTcsStatus('Arrived at TCS Facility')).toBe('in_transit');
    expect(mapTcsStatus('Delay due to Flight Cancelled')).toBe('in_transit');
    expect(mapTcsStatus('Return To Origin')).toBe('failed');
    expect(mapTcsStatus('Returned to Shipper')).toBe('returned');
    expect(mapTcsStatus('Booked')).toBe('booked');
    expect(mapTcsStatus('RO')).toBe('failed');
    expect(a.mapStatus('Delivered (OK)')).toBe('delivered');
    expect(a.mapStatus('Awaiting Receiver Collection (SC)')).toBe('attempted');
  });

  it('throws on an unknown status', () => {
    expect(() => mapTcsStatus('teleported')).toThrow(UnmappedCourierStatusError);
  });

  it('normalises mobiles to 03XXXXXXXXX', () => {
    expect(toTcsMobile('+92 300 1234567')).toBe('03001234567');
    expect(toTcsMobile('923001234567')).toBe('03001234567');
    expect(toTcsMobile('00923001234567')).toBe('03001234567');
    expect(toTcsMobile('3001234567')).toBe('03001234567');
    expect(toTcsMobile('03001234567')).toBe('03001234567');
  });

  it('splits names and addresses within TCS limits', () => {
    expect(splitTcsName('Ali Khan')).toEqual({ firstname: 'Ali', lastname: 'Khan' });
    expect(splitTcsName('Mo Ali')).toEqual({ firstname: 'Mo Ali' });
    expect(splitTcsName('Al')).toEqual({ firstname: 'Al Customer' });
    const long = 'House 12, Street 4, '.repeat(12);
    const parts = splitTcsAddress(long);
    expect(parts.length).toBeLessThanOrEqual(3);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(120);
  });

  it('parses TCS dates as PKT', () => {
    expect(parseTcsDate('Thursday Oct 17, 2024 12:58')?.toISOString()).toBe('2024-10-17T07:58:00.000Z');
    expect(parseTcsDate('')).toBeUndefined();
  });

  it('orders tracking events and picks the latest', () => {
    const ev = TcsAdapter.events({
      deliveryinfo: [{ status: 'Delivered', code: 'OK', datetime: 'Thursday Oct 17, 2024 12:58', recievedby: 'IMROOZ', station: 'BAGH' }],
      checkpoints: [
        { status: 'Shipment Delivered', datetime: 'Thursday Oct 17, 2024 12:58' },
        { status: 'Out For Delivery', datetime: 'Thursday Oct 17, 2024 09:35' },
        { status: 'Arrived at TCS Facility', datetime: 'Monday Oct 14, 2024 23:19' },
      ],
    });
    expect(ev.map((e) => e.status)).toEqual(['Arrived at TCS Facility', 'Out For Delivery', 'Delivered']);
    expect(ev[ev.length - 1].code).toBe('OK');
  });

  it('builds a booking body the Swagger schema accepts', () => {
    const body: any = a.buildBookingBody(
      {
        clientId: 'c',
        clientSecret: 's',
        username: 'u',
        password: 'p',
        accountNo: '04011K1',
        costCenterCode: '9211',
        pickupAddress: 'KHI Airport',
        pickupCity: 'Karachi',
        pickupPhone: '+923451234567',
      },
      {
        companyId: 1,
        shopifyOrderName: '#1001',
        destination: { name: 'Ali Khan', phone: '923001234567', city: 'Lahore', cityCode: 'LHE', address1: 'House 1, Gulberg' },
        codAmount: 2500.4,
        itemsDescription: '2 x Shirt',
        pieces: 1,
      },
    );
    expect(body.shipperinfo).toMatchObject({ tcsaccount: '04011K1', mobile: '03451234567', cityname: 'Karachi' });
    expect(body.consigneeinfo).toMatchObject({ firstname: 'Ali', lastname: 'Khan', citycode: 'LHE', mobile: '03001234567' });
    expect(body.shipmentinfo).toMatchObject({ codamount: 2500, servicecode: 'O', referenceno: '#1001', weightinkg: 0.5, fragile: false });
  });

  it('rejects COD above the TCS cap and missing pickup details', () => {
    const base = { clientId: 'c', clientSecret: 's', username: 'u', password: 'p', accountNo: 'A1' };
    const input: any = {
      companyId: 1,
      shopifyOrderName: '#1',
      destination: { name: 'Ali', phone: '03001234567', city: 'Lahore', cityCode: 'LHE', address1: 'House 1' },
      codAmount: 300000,
      itemsDescription: 'x',
      pieces: 1,
    };
    expect(() => a.buildBookingBody(base as any, input)).toThrow(/pickup details not configured/);
    expect(() =>
      a.buildBookingBody({ ...base, pickupAddress: 'Addr', pickupCity: 'Karachi', pickupPhone: '03001234567' } as any, input),
    ).toThrow(/Invalid COD/);
  });

  it('flattens TCS error replies', () => {
    expect(tcsErrorText({ error: [{ mobile: 'Mobile is invalid' }], message: 'Validation failed' })).toBe(
      'Validation failed; Mobile is invalid',
    );
  });

  it('turns a payment invoice into a statement', () => {
    const p = tcsInvoiceToParsed('543777', [
      { cnsg_no: '779412314605', cust_ref: 'Internet 570372', status: 'Return To Origin', codamount: 2057, courier_charges: 116, gst: 18.56, invoiceno: 'LHEGEW888257', dstn: 'HSL' },
      { cnsg_no: '779412315161', cust_ref: 'Internet 571197', status: 'Delivered', codamount: 0, courier_charges: 83, gst: 13.28, invoiceno: 'LHEGEW888257' },
      { cnsg_no: '779412315162', cust_ref: 'Internet 571299', status: 'Delivered', codamount: 2559, courier_charges: 83, gst: 13.28, invoiceno: 'LHEGEW888257' },
    ]);
    expect(p.invoiceNumber).toBe('LHEGEW888257');
    expect(p.lines[0]).toMatchObject({ paid: false, codAmount: 0, clientOrderId: '570372' });
    expect(p.lines[1]).toMatchObject({ paid: false, needsPrepaidCheck: true });
    expect(p.lines[2]).toMatchObject({ paid: true, codAmount: 2559, netTotal: 2559 - 83 - 13.28 });
    expect(p.totals).toMatchObject({ rows: 3, paidRows: 1, codCollected: 2559 });
    expect(p.totals.netPayable).toBeCloseTo(2559 - 282 - (18.56 + 13.28 + 13.28), 2);
  });
});
