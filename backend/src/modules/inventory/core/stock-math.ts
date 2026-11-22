/**
 * Inventory v2 — pure stock math. The ONE place stock status, bundle
 * buildable count, on-hand and days-of-cover are computed (it replaced four
 * copies of the bundle formula). No I/O; unit-tested in inventory-core.spec.ts.
 */

export type StockStatus = 'in' | 'low' | 'out';

/** Every reason a stock movement can carry. Keep in sync with the frontend labels. */
export const MOVEMENT_REASONS = [
  'sale', // a store sold it (webhook delta < 0)
  'cancel', // a store put it back (order cancelled before shipping)
  'external', // changed inside the store admin (not by an order we know of)
  'return', // RTO parcel physically received + sellable
  'return_damaged', // RTO parcel received but written off
  'po_receive',
  'count',
  'adjust_damaged',
  'adjust_lost',
  'adjust_found',
  'adjust_recount',
  'adjust_gift',
  'adjust_other',
  'transfer_out',
  'transfer_in',
  'replacement_out',
  'set', // inline "Available = N" edit
  'import', // CSV import
  'bootstrap', // v2 backfill seed
] as const;
export type MovementReason = (typeof MOVEMENT_REASONS)[number];

/** Adjustment reasons a person may pick in the Adjust form. */
export const ADJUST_REASONS: MovementReason[] = [
  'adjust_damaged',
  'adjust_lost',
  'adjust_found',
  'adjust_recount',
  'adjust_gift',
  'adjust_other',
];

export function isMovementReason(v: unknown): v is MovementReason {
  return typeof v === 'string' && (MOVEMENT_REASONS as readonly string[]).includes(v);
}

export function statusOf(available: number, reorderLevel: number): StockStatus {
  if (available <= 0) return 'out';
  if (available <= Math.max(0, reorderLevel)) return 'low';
  return 'in';
}

export function onHand(level: { available: number; committed: number }): number {
  return level.available + Math.max(0, level.committed);
}

/**
 * How many bundles the components can make: min over components of
 * floor(available / per-bundle quantity). A component that is missing or out
 * of stock limits the bundle to 0. No components → 0.
 */
export function buildable(components: Array<{ quantity: number; available: number }>): number {
  if (!components.length) return 0;
  let min = Infinity;
  for (const c of components) {
    const per = Math.max(1, Math.floor(c.quantity) || 1);
    const can = Math.floor(Math.max(0, c.available) / per);
    if (can < min) min = can;
  }
  return Number.isFinite(min) ? min : 0;
}

/** Index of the component(s) that limit the bundle (ties → all of them). */
export function limitingComponents(
  components: Array<{ quantity: number; available: number }>,
): number[] {
  const b = buildable(components);
  const out: number[] = [];
  components.forEach((c, i) => {
    const per = Math.max(1, Math.floor(c.quantity) || 1);
    if (Math.floor(Math.max(0, c.available) / per) === b) out.push(i);
  });
  return out;
}

/** Days the available stock lasts at the given daily sales velocity (null = no sales). */
export function daysCover(available: number, unitsPerDay: number): number | null {
  if (!(unitsPerDay > 0)) return null;
  return Math.max(0, available) / unitsPerDay;
}

/**
 * Suggested reorder quantity: enough for lead time + target cover, minus what
 * is available and already incoming. Never negative; rounded up.
 */
export function suggestReorder(opts: {
  available: number;
  incoming: number;
  unitsPerDay: number;
  leadTimeDays: number;
  coverDays: number;
  reorderQty?: number | null;
}): number {
  const need =
    Math.max(0, opts.unitsPerDay) * (Math.max(0, opts.leadTimeDays) + Math.max(0, opts.coverDays)) -
    Math.max(0, opts.available) -
    Math.max(0, opts.incoming);
  if (need <= 0) return 0;
  const base = Math.ceil(need);
  const pack = opts.reorderQty && opts.reorderQty > 0 ? opts.reorderQty : 0;
  return pack ? Math.ceil(base / pack) * pack : base;
}

/**
 * Converts an absolute "set to N" (inline edit, count) into a delta against
 * the value the person saw. Throws when the level moved since they looked —
 * the caller turns that into a 409 so a sale is never silently overwritten.
 */
export function deltaForSet(opts: {
  current: number;
  seen: number | null | undefined;
  target: number;
}): number {
  if (opts.seen != null && opts.seen !== opts.current) {
    throw new StaleStockError(opts.current);
  }
  return opts.target - opts.current;
}

export class StaleStockError extends Error {
  constructor(public readonly current: number) {
    super(`Stock changed to ${current} since you opened it — check and try again.`);
  }
}
