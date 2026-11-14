import { isReturned, rtoSql } from './shipment-outcome';

/**
 * ONE definition of sales for every report (two headline numbers):
 *
 *   Gross sales = every order placed, item value BEFORE discounts
 *                 (no shipping, no tax; includes orders later cancelled/returned)
 *   Net sales   = Gross − discounts − cancelled before shipping − returned (RTO)
 *
 * Discounts / Cancelled / Returned are the breakdown ("how Gross becomes Net"),
 * never extra headline figures. Cancelled and Returned are valued at the
 * after-discount amount so the four parts always add up exactly.
 *
 * `subtotal_price` on the mirror is Shopify's subtotal = AFTER discounts,
 * BEFORE shipping/tax. Rows saved before the breakdown existed fall back to
 * total − shipping − tax (their discount reads 0 until the backfill fills it).
 *
 * All fragments take a `shopify_orders` alias and are ORDER-GRAIN: returns are
 * detected with EXISTS on shipments, so multi-parcel orders are never counted
 * twice (a plain LEFT JOIN shipments double-counts them).
 */

/** Items after discounts (no shipping / tax). */
export function afterDiscountSql(o = 'o'): string {
  return `COALESCE(${o}.subtotal_price, GREATEST(0, COALESCE(${o}.total_price,0) - COALESCE(${o}.total_shipping,0) - COALESCE(${o}.total_tax,0)))`;
}

export function discountsSql(o = 'o'): string {
  return `COALESCE(${o}.total_discounts,0)`;
}

/** Items before discounts. */
export function grossSql(o = 'o'): string {
  return `(${afterDiscountSql(o)} + ${discountsSql(o)})`;
}

/** The order came back physically (RTO). Receiving a return also cancels it in Shopify, so test this FIRST. */
export function returnedOrderSql(o = 'o'): string {
  return `EXISTS (SELECT 1 FROM shipments rts WHERE rts.company_id = ${o}.company_id AND rts.shopify_order_gid = ${o}.shopify_order_gid AND ${rtoSql('rts')})`;
}

/** Cancelled without having been returned. */
export function cancelledOrderSql(o = 'o'): string {
  return `(${o}.cancelled_at IS NOT NULL AND NOT ${returnedOrderSql(o)})`;
}

/** Counts toward Net (not cancelled, not returned). */
export function keptOrderSql(o = 'o'): string {
  return `(${o}.cancelled_at IS NULL AND NOT ${returnedOrderSql(o)})`;
}

/** Net value of ONE order (0 when cancelled or returned). */
export function netOrderSql(o = 'o'): string {
  return `(CASE WHEN ${keptOrderSql(o)} THEN ${afterDiscountSql(o)} ELSE 0 END)`;
}

/**
 * Aggregate SELECT list (use with FROM shopify_orders o WHERE …).
 * Columns: orders, kept_orders, cancelled_orders, returned_orders, gross,
 * discounts, cancelled, returned, net, shipping, tax.
 */
export function salesSelectSql(o = 'o'): string {
  const ret = returnedOrderSql(o);
  const can = `(${o}.cancelled_at IS NOT NULL AND NOT ${ret})`;
  const ad = afterDiscountSql(o);
  return `COUNT(*) orders,
    SUM(CASE WHEN ${o}.cancelled_at IS NULL AND NOT ${ret} THEN 1 ELSE 0 END) kept_orders,
    SUM(CASE WHEN ${can} THEN 1 ELSE 0 END) cancelled_orders,
    SUM(CASE WHEN ${ret} THEN 1 ELSE 0 END) returned_orders,
    COALESCE(SUM(${grossSql(o)}),0) gross,
    COALESCE(SUM(${discountsSql(o)}),0) discounts,
    COALESCE(SUM(CASE WHEN ${can} THEN ${ad} ELSE 0 END),0) cancelled,
    COALESCE(SUM(CASE WHEN ${ret} THEN ${ad} ELSE 0 END),0) returned,
    COALESCE(SUM(CASE WHEN ${o}.cancelled_at IS NULL AND NOT ${ret} THEN ${ad} ELSE 0 END),0) net,
    COALESCE(SUM(COALESCE(${o}.total_shipping,0)),0) shipping,
    COALESCE(SUM(COALESCE(${o}.total_tax,0)),0) tax,
    SUM(CASE WHEN ${o}.subtotal_price IS NULL THEN 1 ELSE 0 END) no_breakdown`;
}

export interface SalesTotals {
  orders: number;
  keptOrders: number;
  cancelledOrders: number;
  returnedOrders: number;
  gross: number;
  discounts: number;
  cancelled: number;
  returned: number;
  net: number;
  shipping: number;
  tax: number;
  /** Orders still without a discount breakdown (gross understated by their discount). */
  noBreakdown: number;
}

const num = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Map a row produced by {@link salesSelectSql} (Decimal/BigInt safe). */
export function salesFromRow(r: Record<string, unknown> | undefined | null): SalesTotals {
  return {
    orders: num(r?.orders),
    keptOrders: num(r?.kept_orders),
    cancelledOrders: num(r?.cancelled_orders),
    returnedOrders: num(r?.returned_orders),
    gross: r2(num(r?.gross)),
    discounts: r2(num(r?.discounts)),
    cancelled: r2(num(r?.cancelled)),
    returned: r2(num(r?.returned)),
    net: r2(num(r?.net)),
    shipping: r2(num(r?.shipping)),
    tax: r2(num(r?.tax)),
    noBreakdown: num(r?.no_breakdown),
  };
}

export const emptySales = (): SalesTotals => salesFromRow(null);

/** In-memory twin for one order (drawer, contact lists). */
export function orderSales(o: {
  subtotal_price?: unknown;
  total_price?: unknown;
  total_shipping?: unknown;
  total_tax?: unknown;
  total_discounts?: unknown;
  cancelled_at?: Date | string | null;
  shipment?: { status?: string | null; received_at?: Date | string | null } | null;
}): { gross: number; discounts: number; afterDiscount: number; net: number; state: 'kept' | 'cancelled' | 'returned' } {
  const after = o.subtotal_price != null ? num(o.subtotal_price) : Math.max(0, num(o.total_price) - num(o.total_shipping) - num(o.total_tax));
  const discounts = num(o.total_discounts);
  const state = isReturned(o.shipment) ? 'returned' : o.cancelled_at ? 'cancelled' : 'kept';
  return { gross: r2(after + discounts), discounts: r2(discounts), afterDiscount: r2(after), net: state === 'kept' ? r2(after) : 0, state };
}
