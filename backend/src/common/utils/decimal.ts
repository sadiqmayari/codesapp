import { Prisma } from '@prisma/client';

/**
 * Recursively convert Prisma `Decimal` (decimal.js) instances to plain
 * `number`s.
 *
 * WHY: the global `ClassSerializerInterceptor` runs `instanceToPlain()` on
 * every response. class-transformer decomposes a `Decimal` instance into its
 * decimal.js internals (`{ s, e, d }`) instead of a value, so price/amount
 * fields (`subscriptions.monthly_price`, `setup_fee`, `invoices.amount`)
 * reached the frontend as objects and rendered as $0. We cannot drop the
 * interceptor (it is what strips `password_hash` via `@Exclude`), so any
 * service that returns a Decimal must normalize it at the boundary first.
 *
 * Dates and other class instances are passed through untouched.
 */
export function numifyDecimals<T>(value: T): T {
  if (value === null || value === undefined) return value;

  if (value instanceof Prisma.Decimal) {
    return Number(value) as unknown as T;
  }

  if (value instanceof Date) return value;

  if (Array.isArray(value)) {
    return value.map((v) => numifyDecimals(v)) as unknown as T;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = numifyDecimals(v);
    }
    return out as T;
  }

  return value;
}
