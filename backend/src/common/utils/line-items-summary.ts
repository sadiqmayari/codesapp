/**
 * Single source of truth for the human-readable "line items" summary string —
 * the one stored on `shopify_orders.line_items_summary`, shown in the orders
 * UI, AND sent to couriers as the parcel's `itemsDescription`.
 *
 * It includes the variant (e.g. "2x Hair Serum - 120ml") because the courier's
 * airway bill / picker needs to know WHICH variant to pack. Shopify's synthetic
 * "Default Title" variant (products with no real options) is skipped so a plain
 * product stays clean as "2x Hair Serum".
 *
 * Separators are kept ASCII (" - ", "...") so the string is safe to hand to
 * courier APIs that reject non-ASCII in the description field.
 */
export interface SummaryLineItem {
  title?: string | null;
  quantity?: number | null;
  variantTitle?: string | null;
}

export function formatLineItemsSummary(
  items: SummaryLineItem[] | null | undefined,
  maxLen?: number,
): string {
  if (!Array.isArray(items)) return '';
  const parts = items.map((li) => {
    const qty = Number(li?.quantity) || 1;
    const title = (li?.title ?? 'item').toString().trim() || 'item';
    const variant = (li?.variantTitle ?? '').toString().trim();
    const label =
      variant && variant.toLowerCase() !== 'default title'
        ? `${title} - ${variant}`
        : title;
    return `${qty}x ${label}`;
  });
  let out = parts.join(', ');
  // Optional cap (couriers vary; the stored summary is left uncapped for the UI).
  if (maxLen && out.length > maxLen) {
    out = out.slice(0, Math.max(0, maxLen - 3)).trimEnd() + '...';
  }
  return out;
}
