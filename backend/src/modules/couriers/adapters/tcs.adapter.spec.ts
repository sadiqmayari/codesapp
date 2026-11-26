import {
  TcsAdapter,
  mapTcsStatus,
  parseTcsDate,
  splitTcsAddress,
  splitTcsName,
  maskSecrets,
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
    // Live TCS vocabulary (2026-11-26)
    expect(mapTcsStatus('Returned To Origin', 'RO')).toBe('failed'); // return leg, not yet handed back
    expect(mapTcsStatus('Returned To Sender', 'RS')).toBe('returned');
    expect(mapTcsStatus('Consignee not home', 'HN')).toBe('attempted');
    expect(mapTcsStatus('Processed at Origin', 'PO')).toBe('in_transit');
    expect(mapTcsStatus('Lost shipment', 'LS')).toBe('failed');
    expect(a.isAwaitingShipperAdvice('Need Further Consignee Information (NC)')).toBe(true);
  });

  it('keeps only the asked consignment when TCS also matches reference numbers', () => {
    const ev = TcsAdapter.events(
      {
        deliveryinfo: [
          { consignmentno: '111', status: 'Delivered', code: 'OK', datetime: 'Friday Nov 14, 2026 13:48' },
          { consignmentno: '222', status: 'Out For Delivery', code: 'OD', datetime: 'Friday Nov 14, 2026 09:00' },
        ],
        checkpoints: [{ consignmentno: '111', status: 'Arrived at TCS Facility', datetime: 'Thursday Nov 13, 2026 10:00' }],
      },
      '222',
    );
    expect(ev.map((e) => e.status)).toEqual(['Out For Delivery']);
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
    expect(splitTcsName('Ali Khan')).toEqual({ firstname: 'Ali', middlename: '-', lastname: 'Khan' });
    expect(splitTcsName('Mo Ali')).toEqual({ firstname: 'Mo Ali', middlename: '-' });
    expect(splitTcsName('Al')).toEqual({ firstname: 'Al Customer', middlename: '-' });
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
        bearerToken: 'b',
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
        items: [{ name: 'Shirt', qty: 2 }],
      },
    );
    expect(body.shipperinfo).toMatchObject({ tcsaccount: '04011K1', mobile: '03451234567', cityname: 'Karachi' });
    expect(body.consigneeinfo).toMatchObject({ firstname: 'Ali', middlename: '-', lastname: 'Khan', citycode: 'LHE', mobile: '03001234567' });
    expect(body.shipmentinfo).toMatchObject({ costcentercode: '9211', codamount: 2500, servicecode: 'O', referenceno: '#1001', weightinkg: 0.5, fragile: false });
    expect(body.shipmentinfo.skus).toEqual([{ description: 'Shirt', quantity: 2, weight: 0.5, uom: 'KG', unitprice: 1250 }]);
  });

  it('rejects COD above the TCS cap and missing pickup details', () => {
    const base = { bearerToken: 'b', username: 'u', password: 'p', accountNo: 'A1', costCenterCode: 'CC1' };
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
    const noCc = { ...base, costCenterCode: '', pickupAddress: 'Addr', pickupCity: 'Karachi', pickupPhone: '03001234567' };
    expect(() => a.buildBookingBody(noCc as any, { ...input, codAmount: 10 })).toThrow(/cost center not configured/);
  });

  it('masks every secret in messages', () => {
    const c = { bearerToken: 'eyJhbGciOi.abcdefghijkl.mnopqrstuvwx', ecomToken: 'ab%2Fcd%2Bef', password: 'fakepw+', clientSecret: 'shh-secret' };
    const out = maskSecrets(`bearer eyJhbGciOi.abcdefghijkl.mnopqrstuvwx ecom ab%2Fcd%2Bef pw fakepw+ pw2 fakepw%2B cs shh-secret`, c);
    expect(out).not.toMatch(/eyJ|ab%2F|fakepw|shh-secret/);
  });

  describe('tokens + retries (mocked fetch)', () => {
    const realFetch = global.fetch;
    afterEach(() => {
      global.fetch = realFetch;
    });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const creds = () =>
      ({ bearerToken: 'BEARER-x1', username: 'u1', password: 'p+1', accountNo: 'A', costCenterCode: 'C' }) as any;

    it('uses a stored, unexpired e-com token without fetching and sends it verbatim', async () => {
      const urls: string[] = [];
      global.fetch = jest.fn(async (u: any) => {
        urls.push(String(u));
        return json(200, { data: [] });
      }) as any;
      const c = { ...creds(), username: 'u-stored', ecomToken: 'tok%2Fab%2Bcd', ecomTokenExpiry: '2099-01-01T00:00:00Z' };
      await new TcsAdapter().listCostCenters(c);
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain('accesstoken=tok%2Fab%2Bcd');
      expect(urls[0]).not.toContain('%252F');
    });

    it('mints with query params (+ → %2B) and re-mints once on 401 Invalid access token', async () => {
      const calls: string[] = [];
      let mints = 0;
      let first = true;
      global.fetch = jest.fn(async (u: any) => {
        const url = String(u);
        calls.push(url);
        if (url.includes('/authentication/token')) {
          mints++;
          return json(200, { accesstoken: `tok${mints}`, expiry: '2099-01-01T00:00:00Z', message: 'success' });
        }
        if (first) {
          first = false;
          return json(401, { message: 'Invalid access token' });
        }
        return json(200, { data: [] });
      }) as any;
      const c = { ...creds(), username: 'u-retry' };
      await new TcsAdapter().listCostCenters(c);
      expect(mints).toBe(2);
      expect(calls[0]).toContain('password=p%2B1');
      expect(calls[calls.length - 1]).toContain('accesstoken=tok2');
    });

    it('does not retry a 401 about the bearer token', async () => {
      let n = 0;
      global.fetch = jest.fn(async () => {
        n++;
        return json(401, { code: 401, message: 'Invalid Bearer token. Mismatch configuration.', status: 'UnAuthorized' });
      }) as any;
      await expect(new TcsAdapter().statusList({ ...creds(), username: 'u-bad' })).rejects.toThrow(/bearer token is invalid/);
      expect(n).toBe(1);
    });
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
