/**
 * Inventory v2 — pure cost math. The ONE COGS resolver (it replaced three
 * copies of `cost_price ?? shopify_unit_cost`), weighted-average costing and
 * landed-cost spreading. Unit-tested in inventory-core.spec.ts.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

const toNum = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Unit cost used for COGS + stock value, in precedence order:
 * the master item's average cost → the listing's manual cost → Shopify's
 * cost-per-item. null when none is known.
 */
export function unitCostOf(src: {
  avgCost?: unknown;
  costPrice?: unknown;
  shopifyUnitCost?: unknown;
}): number | null {
  return toNum(src.avgCost) ?? toNum(src.costPrice) ?? toNum(src.shopifyUnitCost);
}

/** SQL twin of unitCostOf for raw analytics queries (aliases: i = item, v = listing). */
export function unitCostSql(item = 'i', listing = 'v'): string {
  return `COALESCE(${item}.avg_cost, ${listing}.cost_price, ${listing}.shopify_unit_cost)`;
}

/**
 * New weighted-average unit cost after receiving `inQty` units at `inCost`.
 * Negative or zero existing stock does not dilute the new cost.
 */
export function weightedAverage(opts: {
  oldQty: number;
  oldCost: number | null;
  inQty: number;
  inCost: number;
}): number {
  const oldQty = Math.max(0, opts.oldQty);
  if (opts.inQty <= 0) return round2(opts.oldCost ?? opts.inCost);
  if (opts.oldCost == null || oldQty === 0) return round2(opts.inCost);
  return round2((oldQty * opts.oldCost + opts.inQty * opts.inCost) / (oldQty + opts.inQty));
}

/**
 * Spread freight (and other landed costs) across receipt lines by line value,
 * returning each line's landed UNIT cost. The spread always sums back to the
 * freight (residual on the largest line) so totals reconcile to the rupee.
 */
export function spreadLanded(
  lines: Array<{ qty: number; unitCost: number }>,
  freight: number,
): number[] {
  const values = lines.map((l) => Math.max(0, l.qty) * Math.max(0, l.unitCost));
  const total = values.reduce((a, b) => a + b, 0);
  const f = Math.max(0, freight);
  if (!lines.length) return [];
  if (f === 0 || total === 0) return lines.map((l) => round2(l.unitCost));
  const shares = values.map((v) => round2((v / total) * f));
  const residual = round2(f - shares.reduce((a, b) => a + b, 0));
  let maxIdx = 0;
  values.forEach((v, i) => {
    if (v > values[maxIdx]) maxIdx = i;
  });
  shares[maxIdx] = round2(shares[maxIdx] + residual);
  return lines.map((l, i) => (l.qty > 0 ? round2(l.unitCost + shares[i] / l.qty) : round2(l.unitCost)));
}

/** Bundle unit cost = Σ component cost × quantity (null when any component cost is unknown). */
export function bundleCost(components: Array<{ quantity: number; unitCost: number | null }>): number | null {
  if (!components.length) return null;
  let sum = 0;
  for (const c of components) {
    if (c.unitCost == null) return null;
    sum += c.unitCost * Math.max(1, c.quantity);
  }
  return round2(sum);
}
