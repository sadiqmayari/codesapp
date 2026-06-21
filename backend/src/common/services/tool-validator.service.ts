import { Injectable } from '@nestjs/common';

/**
 * Tool Validation Layer (enterprise hardening — increment 5, spec #3).
 *
 * WHY: the specialist agents act on whatever the tools return. A misconfigured
 * Shopify variant (price 0 / null), a placeholder tracking value ("N/A"), an
 * invalid shipping rate, or empty payment details flowing straight into the LLM
 * become confidently-wrong customer messages ("your order is $0", "tracking: N/A").
 * This layer sits BETWEEN the raw tool result and the model:
 *
 *      Tool → Validator → Normalized DTO → LLM
 *
 * so no raw, malformed tool output is ever serialized to the model. It is PURE +
 * deterministic (no I/O), conservative (only drops genuinely-invalid entries and
 * normalizes formats — valid data passes through unchanged), and the caller uses
 * it fail-open (on any unexpected error it falls back to the raw formatting), so
 * the layer can only ever make tool output SAFER, never break a good-path reply.
 */

const toNum = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const nonEmpty = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/** Placeholder tokens that must NEVER be surfaced as a real TRACKING value. */
const PLACEHOLDER = /^(n\/?a|na|none|null|nil|unknown|pending|tbd|-+|\.+|0)$/i;
/**
 * Placeholder tokens for a DELIVERY STATUS — much narrower than the tracking
 * filter. "pending"/"unfulfilled"/"processing" are REAL states for a freshly
 * placed order, so they must pass; only truly-empty markers are stripped.
 * (Treating "pending" as a placeholder here made the agent tell customers it
 * couldn't track a real, not-yet-dispatched order — see ERRORS.)
 */
const STATUS_PLACEHOLDER = /^(n\/?a|na|none|null|nil|unknown|-+|\.+)$/i;

export interface RawProduct {
  product?: unknown;
  variant?: unknown;
  price?: unknown;
  discountPercent?: unknown;
  originalPrice?: unknown;
  inStock?: unknown;
  url?: unknown;
}
export interface CleanProduct {
  product: string;
  variant?: string;
  price: number;
  discountPercent?: number;
  originalPrice?: number;
  inStock: boolean;
  url?: string;
}

export interface RawRate {
  title?: unknown;
  amount?: unknown;
  currency?: unknown;
}
export interface CleanRate {
  title: string;
  amount: number;
  currency: string;
}

@Injectable()
export class ToolValidatorService {
  /**
   * search_products: drop products with a missing/invalid price or no title, drop
   * malformed variants, normalize stock to a boolean, and keep a discount only
   * when it is internally consistent (0 < pct ≤ 100 AND originalPrice > price).
   */
  products(raw: RawProduct[]): { items: CleanProduct[]; dropped: number } {
    const items: CleanProduct[] = [];
    let dropped = 0;
    for (const r of Array.isArray(raw) ? raw : []) {
      const product = nonEmpty(r.product);
      const price = toNum(r.price);
      if (!product || price === null || price <= 0) {
        dropped++; // priceless / nameless product → never shown to the model
        continue;
      }
      const clean: CleanProduct = {
        product,
        variant: nonEmpty(r.variant),
        price,
        inStock: r.inStock === undefined ? true : !!r.inStock,
        url: nonEmpty(r.url),
      };
      const pct = toNum(r.discountPercent);
      const orig = toNum(r.originalPrice);
      if (pct !== null && pct > 0 && pct <= 100 && orig !== null && orig > price) {
        clean.discountPercent = pct;
        clean.originalPrice = orig;
      }
      items.push(clean);
    }
    return { items, dropped };
  }

  /**
   * get_order_status: strip placeholder/unknown tracking values so the model can
   * never present "tracking: N/A" as real, and report whether the delivery status
   * itself is usable (an empty/unknown status is "incomplete" → the caller answers
   * conservatively instead of inventing one).
   */
  orderStatus(input: { deliveryStatus?: unknown; tracking?: unknown }): {
    deliveryStatus: string | null;
    tracking: string[];
    complete: boolean;
  } {
    const ds = nonEmpty(input.deliveryStatus);
    const status = ds && !STATUS_PLACEHOLDER.test(ds) ? ds : null;
    const tracking = (Array.isArray(input.tracking) ? input.tracking : [])
      .map((t) => nonEmpty(t))
      .filter((t): t is string => !!t)
      // Keep an entry only if it carries a real token (a URL or an alphanumeric
      // tracking code ≥4 chars) and is not a bare placeholder.
      .filter((t) => {
        if (PLACEHOLDER.test(t)) return false;
        if (/https?:\/\//i.test(t)) return true;
        return /[a-z0-9]{4,}/i.test(t.replace(/\s+/g, ''));
      });
    return { deliveryStatus: status, tracking, complete: status !== null };
  }

  /**
   * shipping: drop rates with an invalid amount, normalize the currency to an
   * uppercase code, require a title. A free rate (amount 0) is valid.
   */
  shippingRates(raw: RawRate[]): CleanRate[] {
    const out: CleanRate[] = [];
    for (const r of Array.isArray(raw) ? raw : []) {
      const title = nonEmpty(r.title);
      const amount = toNum(r.amount);
      if (!title || amount === null || amount < 0) continue;
      const currency = (nonEmpty(r.currency) ?? '').toUpperCase().slice(0, 8);
      out.push({ title, amount, currency });
    }
    return out;
  }

  /**
   * payment: only surface bank/account details that actually look like account
   * data (contains digits and enough substance) — never an empty or junk string.
   */
  paymentDetails(text: unknown): string | null {
    const s = nonEmpty(text);
    if (!s) return null;
    const hasDigits = /\d{4,}/.test(s.replace(/\s+/g, ''));
    return hasDigits && s.length >= 8 ? s : null;
  }
}
