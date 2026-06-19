import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  OrderIdempotencyService,
  OrderFingerprintInput,
} from './order-idempotency.service';

/**
 * Critical-path tests for Order Idempotency Protection (#2).
 *
 * These guard the most expensive failure in the platform — a duplicate Shopify
 * order — so they exercise every branch of reserve(): proceed, duplicate-return,
 * concurrent conflict, stale reclaim (legit reorder), the insert-race loser, and
 * the fail-open path. Prisma + the event store are mocked so the logic is tested
 * deterministically without a database.
 */

type Row = {
  id: number;
  company_id: number;
  conversation_id: number | null;
  hash: string;
  status: string;
  order_gid: string | null;
  order_name: string | null;
  admin_url: string | null;
  expires_at: Date;
};

function makePrisma() {
  const pendingOrderHash = {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  return { pendingOrderHash } as any;
}

function makeEvents() {
  return { append: jest.fn().mockResolvedValue(undefined) } as any;
}

const baseInput: OrderFingerprintInput = {
  phone: '0317-1263292',
  address1: '12 Main Road',
  city: 'Lahore',
  countryCode: 'PK',
  lineItems: [
    { variantId: 'gid://shopify/ProductVariant/1', quantity: 2 },
    { variantId: 'gid://shopify/ProductVariant/2', quantity: 1 },
  ],
  prepaid: false,
};

describe('OrderIdempotencyService.computeHash', () => {
  it('is deterministic for identical input', () => {
    expect(OrderIdempotencyService.computeHash(baseInput)).toBe(
      OrderIdempotencyService.computeHash({ ...baseInput }),
    );
  });

  it('is independent of cart line ordering', () => {
    const reordered: OrderFingerprintInput = {
      ...baseInput,
      lineItems: [...baseInput.lineItems].reverse(),
    };
    expect(OrderIdempotencyService.computeHash(reordered)).toBe(
      OrderIdempotencyService.computeHash(baseInput),
    );
  });

  it('treats different phone formats for the same number as identical', () => {
    const e164: OrderFingerprintInput = { ...baseInput, phone: '+923171263292' };
    expect(OrderIdempotencyService.computeHash(e164)).toBe(
      OrderIdempotencyService.computeHash(baseInput),
    );
  });

  it('differs when the cart, payment, or address differs', () => {
    const h = OrderIdempotencyService.computeHash(baseInput);
    expect(OrderIdempotencyService.computeHash({ ...baseInput, prepaid: true })).not.toBe(h);
    expect(
      OrderIdempotencyService.computeHash({
        ...baseInput,
        lineItems: [{ variantId: 'gid://shopify/ProductVariant/1', quantity: 5 }],
      }),
    ).not.toBe(h);
    expect(OrderIdempotencyService.computeHash({ ...baseInput, city: 'Karachi' })).not.toBe(h);
  });

  it('returns null when too sparse to identify a customer (no phone, no address)', () => {
    expect(
      OrderIdempotencyService.computeHash({
        phone: null,
        address1: null,
        city: null,
        lineItems: [{ title: 'X', quantity: 1 }],
      }),
    ).toBeNull();
  });

  it('returns null when there is no cart', () => {
    expect(
      OrderIdempotencyService.computeHash({ ...baseInput, lineItems: [] }),
    ).toBeNull();
  });
});

describe('OrderIdempotencyService.reserve', () => {
  const HASH = 'a'.repeat(64);
  let prisma: any;
  let events: any;
  let svc: OrderIdempotencyService;

  beforeEach(() => {
    prisma = makePrisma();
    events = makeEvents();
    svc = new OrderIdempotencyService(prisma, events);
  });

  it('proceeds and reserves an in_flight row when no fingerprint exists', async () => {
    prisma.pendingOrderHash.findUnique.mockResolvedValue(null);
    prisma.pendingOrderHash.create.mockResolvedValue({ id: 42 } as Row);

    const res = await svc.reserve(7, 100, HASH);

    expect(res).toEqual({ kind: 'proceed', reservationId: 42, hash: HASH });
    expect(prisma.pendingOrderHash.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        company_id: 7,
        conversation_id: 100,
        hash: HASH,
        status: 'in_flight',
      }),
    });
  });

  it('returns the existing order (no create) for a fresh completed duplicate', async () => {
    prisma.pendingOrderHash.findUnique.mockResolvedValue({
      id: 9,
      status: 'created',
      order_gid: 'gid://shopify/Order/55',
      order_name: '#1055',
      admin_url: 'https://shop/admin/orders/55',
      expires_at: new Date(Date.now() + 60_000),
    } as Row);

    const res = await svc.reserve(7, 100, HASH);

    expect(res.kind).toBe('duplicate');
    if (res.kind === 'duplicate') {
      expect(res.order.orderName).toBe('#1055');
      expect(res.order.orderId).toBe('gid://shopify/Order/55');
    }
    expect(prisma.pendingOrderHash.create).not.toHaveBeenCalled();
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'order.duplicate_prevented' }),
    );
  });

  it('throws ConflictException when a fresh create is already in flight', async () => {
    prisma.pendingOrderHash.findUnique.mockResolvedValue({
      id: 9,
      status: 'in_flight',
      order_gid: null,
      expires_at: new Date(Date.now() + 60_000),
    } as Row);

    await expect(svc.reserve(7, 100, HASH)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.pendingOrderHash.create).not.toHaveBeenCalled();
  });

  it('reclaims a stale row (expired) and proceeds — a legitimate later reorder', async () => {
    prisma.pendingOrderHash.findUnique.mockResolvedValue({
      id: 9,
      status: 'created',
      order_gid: 'gid://shopify/Order/55',
      order_name: '#1055',
      expires_at: new Date(Date.now() - 1000), // past window
    } as Row);
    prisma.pendingOrderHash.delete.mockResolvedValue({} as Row);
    prisma.pendingOrderHash.create.mockResolvedValue({ id: 43 } as Row);

    const res = await svc.reserve(7, 100, HASH);

    expect(prisma.pendingOrderHash.delete).toHaveBeenCalledWith({ where: { id: 9 } });
    expect(res.kind).toBe('proceed');
  });

  it('resolves to the winner on a lost insert race (P2002)', async () => {
    prisma.pendingOrderHash.findUnique
      .mockResolvedValueOnce(null) // initial check: nothing yet
      .mockResolvedValueOnce({
        id: 9,
        status: 'created',
        order_gid: 'gid://shopify/Order/55',
        order_name: '#1055',
        expires_at: new Date(Date.now() + 60_000),
      } as Row); // re-read after the unique violation
    prisma.pendingOrderHash.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );

    const res = await svc.reserve(7, 100, HASH);
    expect(res.kind).toBe('duplicate');
  });

  it('fails OPEN (proceeds, reservationId<0) on an unexpected DB error', async () => {
    prisma.pendingOrderHash.findUnique.mockRejectedValue(new Error('db down'));

    const res = await svc.reserve(7, 100, HASH);
    expect(res).toEqual({ kind: 'proceed', reservationId: -1, hash: HASH });
  });
});

describe('OrderIdempotencyService.finalize / release', () => {
  let prisma: any;
  let svc: OrderIdempotencyService;

  beforeEach(() => {
    prisma = makePrisma();
    prisma.pendingOrderHash.update.mockResolvedValue({});
    svc = new OrderIdempotencyService(prisma, makeEvents());
  });

  it('finalize marks the row created with the order refs', async () => {
    await svc.finalize(42, {
      orderId: 'gid://shopify/Order/55',
      orderName: '#1055',
      adminUrl: 'https://shop/admin/orders/55',
    });
    expect(prisma.pendingOrderHash.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: expect.objectContaining({ status: 'created', order_gid: 'gid://shopify/Order/55' }),
    });
  });

  it('release marks the row failed with a short TTL (no double-create on retry)', async () => {
    await svc.release(42);
    const arg = prisma.pendingOrderHash.update.mock.calls[0][0];
    expect(arg.data.status).toBe('failed');
    expect(arg.data.expires_at.getTime()).toBeLessThan(Date.now() + 5 * 60_000);
  });

  it('finalize and release no-op for a fail-open reservation (id<0)', async () => {
    await svc.finalize(-1, { orderId: 'x', orderName: 'y', adminUrl: 'z' });
    await svc.release(-1);
    expect(prisma.pendingOrderHash.update).not.toHaveBeenCalled();
  });
});
