/**
 * Inventory v2 — pure push planning + webhook interpretation.
 *
 * The pool (inventory_levels.available per item × location) is the truth.
 * Every store listing at a linked store location should show that number.
 * ListingPushState.last_seen is what we believe the store holds right now.
 */

export interface PlanInput {
  /** available per our location id */
  levels: Map<number, number>;
  /** this listing's store location links that sync */
  links: Array<{ linkId: number; locationId: number }>;
  /** current push state per link id */
  state: Map<number, { lastSeen: number | null }>;
  track: boolean;
  isBundle: boolean;
}

export interface PushTarget {
  linkId: number;
  locationId: number;
  target: number;
  /** compare value for the store's optimistic-concurrency check */
  expected: number | null;
}

/** Which (link → target) writes are needed to make the store match the pool. */
export function planPush(input: PlanInput): PushTarget[] {
  if (!input.track || input.isBundle) return [];
  const out: PushTarget[] = [];
  for (const l of input.links) {
    const target = Math.max(0, input.levels.get(l.locationId) ?? 0);
    const seen = input.state.get(l.linkId)?.lastSeen ?? null;
    if (seen === target) continue;
    out.push({ linkId: l.linkId, locationId: l.locationId, target, expected: seen });
  }
  return out;
}

export type WebhookVerdict =
  | { kind: 'echo' } // the store reports exactly what we last pushed/saw
  | { kind: 'first'; available: number } // never seen this link before → just record
  | { kind: 'change'; delta: number; available: number };

/**
 * Interpret an inventory-level webhook for one listing × store location.
 * delta is measured against last_seen, so our own push echo is a no-op and a
 * second store's sale is applied once to the pool.
 */
export function interpretWebhook(lastSeen: number | null, available: number): WebhookVerdict {
  if (lastSeen == null) return { kind: 'first', available };
  if (available === lastSeen) return { kind: 'echo' };
  return { kind: 'change', delta: available - lastSeen, available };
}

/** Reason for a store-side change: decreases are sales, increases cancels/restocks. */
export function reasonForStoreDelta(delta: number): 'sale' | 'cancel' {
  return delta < 0 ? 'sale' : 'cancel';
}
