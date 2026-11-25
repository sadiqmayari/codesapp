/**
 * The ONE rule for "how many units of this line does the order hold NOW".
 *
 * After a Shopify order edit (or a refund/return), a line's `quantity` stays at
 * the ORIGINALLY ordered amount — a removed line still reports quantity 2 with
 * currentQuantity 0, a reduced line keeps its original quantity. Every writer of
 * the local order mirror (webhook, import/reconcile, post-edit refresh, booking)
 * must use the CURRENT quantity and drop removed lines, or an edited order
 * silently reverts to its pre-edit items and the courier slip ships the old cart.
 *
 * Shapes accepted: GraphQL (`currentQuantity`), REST (`current_quantity`), and
 * already-mirrored rows (`quantity` only).
 */
export interface QtyLine {
  quantity?: unknown;
  currentQuantity?: unknown;
  current_quantity?: unknown;
}

/** Units the order holds now (0 = removed). Missing everything → 1 (legacy rows). */
export function effectiveQty(line: QtyLine | null | undefined): number {
  if (!line) return 0;
  const cur = line.currentQuantity ?? line.current_quantity;
  if (cur != null && cur !== '') {
    const n = Number(cur);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }
  if (line.quantity == null || line.quantity === '') return 1;
  const q = Number(line.quantity);
  return Number.isFinite(q) ? Math.max(0, q) : 0;
}

/** Keep only lines still on the order (effective qty > 0). */
export function liveLines<T extends QtyLine>(lines: T[] | null | undefined): T[] {
  if (!Array.isArray(lines)) return [];
  return lines.filter((l) => effectiveQty(l) > 0);
}

/**
 * Pick the order money value to mirror: a cancelled (VOIDED) order's CURRENT
 * total drops to 0, so it keeps the ORIGINAL; an open order uses the CURRENT
 * (post-edit/refund) value, falling back to the original when absent.
 */
export function currentOrOriginal<T>(
  cancelled: boolean,
  current: T | null | undefined,
  original: T | null | undefined,
): T | null {
  if (cancelled) return original ?? current ?? null;
  return current ?? original ?? null;
}
