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

/** Units originally ordered on a line (ignores current quantity). */
export function orderedQty(line: QtyLine | null | undefined): number {
  if (!line) return 0;
  if (line.quantity == null || line.quantity === '') return 1;
  const q = Number(line.quantity);
  return Number.isFinite(q) ? Math.max(0, q) : 0;
}

/**
 * The lines to mirror, each with the quantity to store.
 *
 * Normally = the lines still on the order at their CURRENT quantity (removed
 * lines dropped). But when EVERY line is at current 0 the order was cancelled /
 * fully refunded (an RTO receipt cancels with restock) — Shopify never lets an
 * edit remove the last line — so keep the ORIGINAL lines and quantities, like the
 * money rule in `currentOrOriginal`. Otherwise a returned order mirrors with no
 * items and the returns sheet / restock picklist print blank.
 */
export function mirrorLines<T extends QtyLine>(
  lines: T[] | null | undefined,
): Array<{ line: T; qty: number }> {
  if (!Array.isArray(lines)) return [];
  const live = lines
    .map((line) => ({ line, qty: effectiveQty(line) }))
    .filter((x) => x.qty > 0);
  if (live.length || !lines.length) return live;
  return lines
    .map((line) => ({ line, qty: orderedQty(line) }))
    .filter((x) => x.qty > 0);
}

/** Lines to keep (see `mirrorLines`): current lines, or the ordered lines of a
 *  cancelled / fully-refunded order. */
export function liveLines<T extends QtyLine>(lines: T[] | null | undefined): T[] {
  return mirrorLines(lines).map((x) => x.line);
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
