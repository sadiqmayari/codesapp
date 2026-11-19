/**
 * AI Agent v2 — conversation WORKING MEMORY (pure, unit-tested in memory.spec.ts).
 *
 * Replaces the v1 topic/episode machinery (ai_active_topic, ai_episode_*,
 * ai_pending_order, ai_linked_order_id…). The transcript is never cut; instead
 * the agent's tools write structured facts here (cart of RESOLVED variants,
 * customer details, payment choice, lead fields, booking draft) and CODE reads
 * them to gate irreversible actions:
 *  - an order is placed only when the summary the customer saw (summaryHash)
 *    still matches the cart/details AND the customer's latest turn confirms
 *  - "ok shukria" while an order is awaiting confirmation cannot close the chat
 * Stored as JSON on conversations.ai_memory.
 */

export interface CartLine {
  variantId: string;
  quantity: number;
  title: string;
  variantTitle: string;
  unitPrice: number;
  sku: string | null;
}

export type Stage =
  | 'idle'
  | 'collecting'
  | 'awaiting_confirm'
  | 'awaiting_payment'
  | 'done';

export interface CustomerDetails {
  name?: string;
  phone?: string;
  email?: string;
  address1?: string;
  city?: string;
  countryCode?: string;
}

export interface BookingDraft {
  service?: string;
  startIso?: string;
  partySize?: number;
  name?: string;
}

export interface AgentMemory {
  v: 2;
  stage: Stage;
  /** Short free-text of what the customer is trying to do (set by the model). */
  goal: string | null;
  cart: CartLine[];
  customer: CustomerDetails;
  payment: 'cod' | 'prepaid' | null;
  /** Signature of cart+customer+payment at the moment the summary was sent. */
  summaryHash: string | null;
  summaryAt: string | null;
  lastOrderName: string | null;
  lastOrderAt: string | null;
  lead: Record<string, string>;
  leadQualified: boolean;
  booking: BookingDraft;
  lastBookingId: number | null;
  /** Consecutive AI replies without any tool-recorded progress. */
  noProgress: number;
  /** When the off-hours away message was last sent (once per closed period). */
  awaySentAt: string | null;
  /** The customer was asked which store/brand (multi-brand number). */
  storeAsked: boolean;
  updatedAt: string | null;
}

export function emptyMemory(): AgentMemory {
  return {
    v: 2,
    stage: 'idle',
    goal: null,
    cart: [],
    customer: {},
    payment: null,
    summaryHash: null,
    summaryAt: null,
    lastOrderName: null,
    lastOrderAt: null,
    lead: {},
    leadQualified: false,
    booking: {},
    lastBookingId: null,
    noProgress: 0,
    awaySentAt: null,
    storeAsked: false,
    updatedAt: null,
  };
}

const STAGES: Stage[] = ['idle', 'collecting', 'awaiting_confirm', 'awaiting_payment', 'done'];

const s = (v: unknown, max = 300): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

/** Parse a stored JSON blob (any shape / null / v1 leftovers) safely. */
export function parseMemory(raw: unknown): AgentMemory {
  const base = emptyMemory();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const o = raw as Record<string, unknown>;
  if (o.v !== 2) return base;
  const cartRaw = Array.isArray(o.cart) ? o.cart : [];
  const cart: CartLine[] = cartRaw
    .map((x) => {
      const c = (x ?? {}) as Record<string, unknown>;
      const q = Math.floor(Number(c.quantity));
      const variantId = s(c.variantId, 255);
      if (!variantId || !(q > 0)) return null;
      return {
        variantId,
        quantity: Math.min(q, 999),
        title: s(c.title, 255) ?? '',
        variantTitle: s(c.variantTitle, 255) ?? '',
        unitPrice: Number(c.unitPrice) || 0,
        sku: s(c.sku, 120) ?? null,
      };
    })
    .filter((c): c is CartLine => !!c)
    .slice(0, 30);
  const cust = (o.customer ?? {}) as Record<string, unknown>;
  const lead = (o.lead ?? {}) as Record<string, unknown>;
  const booking = (o.booking ?? {}) as Record<string, unknown>;
  const leadOut: Record<string, string> = {};
  for (const [k, v] of Object.entries(lead)) {
    const val = s(v, 300);
    if (val) leadOut[k.slice(0, 40)] = val;
  }
  return {
    v: 2,
    stage: STAGES.includes(o.stage as Stage) ? (o.stage as Stage) : 'idle',
    goal: s(o.goal, 200) ?? null,
    cart,
    customer: {
      name: s(cust.name, 160),
      phone: s(cust.phone, 32),
      email: s(cust.email, 160),
      address1: s(cust.address1, 400),
      city: s(cust.city, 120),
      countryCode: s(cust.countryCode, 2),
    },
    payment: o.payment === 'cod' || o.payment === 'prepaid' ? o.payment : null,
    summaryHash: s(o.summaryHash, 255) ?? null,
    summaryAt: s(o.summaryAt, 40) ?? null,
    lastOrderName: s(o.lastOrderName, 64) ?? null,
    lastOrderAt: s(o.lastOrderAt, 40) ?? null,
    lead: leadOut,
    leadQualified: o.leadQualified === true,
    booking: {
      service: s(booking.service, 120),
      startIso: s(booking.startIso, 40),
      partySize: Number(booking.partySize) > 0 ? Math.floor(Number(booking.partySize)) : undefined,
      name: s(booking.name, 160),
    },
    lastBookingId: Number(o.lastBookingId) > 0 ? Number(o.lastBookingId) : null,
    noProgress: Math.max(0, Math.min(50, Math.floor(Number(o.noProgress) || 0))),
    awaySentAt: s(o.awaySentAt, 40) ?? null,
    storeAsked: o.storeAsked === true,
    updatedAt: s(o.updatedAt, 40) ?? null,
  };
}

/** Stable signature of a cart (resolved variant + qty) — order-independent. */
export function cartSignature(cart: Array<{ variantId: string; quantity: number }>): string {
  return cart
    .map((i) => `${i.variantId}x${i.quantity}`)
    .sort()
    .join(';');
}

/** Signature of everything the customer confirms (cart + delivery + payment). */
export function summarySignature(m: AgentMemory): string {
  const c = m.customer;
  return [
    cartSignature(m.cart),
    (c.name ?? '').toLowerCase(),
    (c.phone ?? '').replace(/\D/g, ''),
    (c.address1 ?? '').toLowerCase(),
    (c.city ?? '').toLowerCase(),
    m.payment ?? '',
  ].join('|');
}

/** Required order fields still missing from memory. */
export function missingOrderFields(m: AgentMemory, needPayment: boolean): string[] {
  const miss: string[] = [];
  if (!m.cart.length) miss.push('product');
  if (!m.customer.name) miss.push('name');
  if (!m.customer.phone || (m.customer.phone.match(/\d/g)?.length ?? 0) < 7) miss.push('phone');
  if (!m.customer.address1) miss.push('full address');
  if (!m.customer.city) miss.push('city');
  if (needPayment && !m.payment) miss.push('payment method');
  return miss;
}

export function cartTotal(cart: CartLine[]): number {
  return cart.reduce((t, l) => t + l.unitPrice * l.quantity, 0);
}

/** Stages during which the chat must not be closed / resolved by the AI. */
export function hasOpenFlow(m: AgentMemory): boolean {
  return m.stage === 'collecting' || m.stage === 'awaiting_confirm' || m.stage === 'awaiting_payment';
}

const YES_WORDS = [
  // English
  'yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'okk', 'okey', 'sure', 'confirm', 'confirmed', 'done',
  'correct', 'right', 'go ahead', 'place it', 'place order', 'book it', 'proceed',
  // Roman Urdu / Hindi
  'haan', 'han', 'hn', 'ha', 'ji', 'jee', 'g', 'theek', 'thik', 'theek hai', 'sahi', 'sahi hai',
  'pakka', 'bilkul', 'kar do', 'kardo', 'kr do', 'krdo', 'order kar do', 'confirm kar do', 'chalo',
  // Arabic (romanised)
  'naam', 'aiwa', 'tamam', 'tamaam',
];
const YES_SCRIPT = /(ہاں|جی|ٹھیک|بالکل|کر دیں|کردیں|کر دو|درست|हाँ|हां|जी|ठीक|नعم|نعم|أيوه|ايوه|تمام|حسنا|موافق)/;
const YES_EMOJI = /(👍|✅|✔|☑|👌|🙏)/u;
const NO_WORDS = /\b(no|nope|nahi|nahin|nai|na|cancel|mat|ruk|ruko|wait|stop|don'?t|not now|later|baad mein)\b|(نہیں|مت|رکو|लेकिन|नहीं|لا)/i;

/**
 * Deterministic "is this an affirmation?" for a SHORT customer turn (≤ 60
 * chars). Multilingual (English / Roman Urdu / Urdu & Hindi script / Arabic)
 * and emoji. A negation anywhere wins. Longer turns are left to the model's
 * confirmation_quote (verified against the turn by the place-order gate).
 */
export function isAffirmation(text: string): boolean {
  const t = (text || '').trim().toLowerCase();
  if (!t || t.length > 60) return false;
  if (NO_WORDS.test(t)) return false;
  // "ok thanks" / "ok shukria" is ambiguous (thanks vs yes) — never a
  // deterministic yes; the model decides and must quote the customer.
  if (/(shukri|thank|thx|jazak|شکری|धन्यवाद|شكر)/i.test(t)) return false;
  if (YES_EMOJI.test(t) || YES_SCRIPT.test(t)) return true;
  const norm = t.replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!norm) return false;
  return YES_WORDS.some((w) => norm === w || norm.startsWith(`${w} `) || norm.endsWith(` ${w}`) || norm.includes(` ${w} `));
}

/** WhatsApp opt-out words (the webhook records the opt-out; the AI stays quiet). */
export function isStopWord(text: string): boolean {
  return /^\s*(stop|unsubscribe|stop all|opt out|optout)\s*$/i.test(text || '');
}

/**
 * Verify a model-supplied confirmation quote really appears in the customer's
 * latest turn (case/space-insensitive) — the language-agnostic half of the
 * place-order gate (the model can't invent a "yes" the customer never wrote).
 */
export function quoteInTurn(quote: string | undefined, turn: string): boolean {
  const n = (x: string) => x.toLowerCase().replace(/\s+/g, ' ').trim();
  const q = n(quote ?? '');
  if (q.length < 1) return false;
  return n(turn).includes(q);
}
