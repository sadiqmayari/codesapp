import { InventoryLedgerService } from '../inventory/core/inventory-ledger.service';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EventStoreService } from '../../common/services/event-store.service';
import { normalizePhone } from '../../common/utils/phone';
import { AiService } from '../ai/ai.service';
import { AiRagService } from '../ai/ai-rag.service';
import { ToolDef } from '../ai/providers/llm-provider.interface';
import { AgentProfileBundle } from '../ai/ai-profile.service';
import { InboxService } from '../inbox/inbox.service';
import { TicketsService } from '../tickets/tickets.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { ShopifyService } from '../integrations/shopify/shopify.service';
import { CommerceResolverService } from '../integrations/commerce/commerce-provider.resolver';
import { ProductHit } from '../integrations/commerce/commerce-provider.interface';
import { courierTrackingUrl } from '../couriers/couriers.constants';
import { AgentBookingsService } from './bookings.service';
import {
  AgentMemory,
  CartLine,
  cartSignature,
  cartTotal,
  hasOpenFlow,
  isAffirmation,
  missingOrderFields,
  quoteInTurn,
  summarySignature,
} from './memory';
import { HandoffCategory } from './handoff.service';

/** Everything one agent turn reads and writes (mutated by the executors). */
export interface TurnState {
  companyId: number;
  conversationId: number | null;
  contactId: number | null;
  contactName: string | null;
  contactPhone: string | null;
  storeId: number | null;
  stores: Array<{ id: number; label: string }>;
  bundle: AgentProfileBundle & { brandName: string };
  memory: AgentMemory;
  /** The customer's unanswered messages merged (the confirmation gate reads it). */
  latestTurnText: string;
  turnHasImage: boolean;
  dryRun: boolean;
  transactionsAllowed: boolean;
  autoOrder: boolean;
  open: boolean;
  tz: string;
  // ── outputs ──
  progress: boolean;
  /** Deterministic message the SYSTEM sends instead of the model's text. */
  systemReply: string | null;
  handoff: { reason: string; category: HandoffCategory; message?: string } | null;
  endConversation: boolean;
  seen: Map<string, ProductHit>;
  sources: Array<{ title: string; sourceType: string; score: number }>;
  tools: Array<{ name: string; ok: boolean; ms: number; summary: string }>;
  corpus: string;
  orderPlaced: string | null;
  bookingMade: number | null;
  leadSaved: boolean;
}

const AI_ORDER_LABEL = 'ai-order';
const REORDER_DUPLICATE_WINDOW_MS = 25 * 60 * 1000;

const str = (v: unknown, max = 500): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

function norm(s: string): string[] {
  return (s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Token-overlap relevance (used to RANK — never to drop — product hits). */
function relevance(q: string, h: ProductHit): number {
  const qt = norm(q);
  const tt = new Set(norm(`${h.productTitle} ${h.variantTitle} ${h.sku ?? ''}`));
  let s = 0;
  for (const w of qt) {
    if (tt.has(w)) s += 2;
    else if ([...tt].some((t) => t.startsWith(w) || w.startsWith(t))) s += 1;
  }
  return s;
}

const SIZE_ALIASES: Record<string, string[]> = {
  s: ['small'],
  m: ['medium', 'med'],
  l: ['large'],
  xl: ['extra large', 'xlarge'],
  xxl: ['2xl', 'double xl'],
  xs: ['extra small', 'xsmall'],
};

/** Expand a query's size words so "medium" matches a variant titled "M". */
function expandTokens(q: string): Set<string> {
  const out = new Set(norm(q));
  const joined = ` ${[...out].join(' ')} `;
  for (const [short, longs] of Object.entries(SIZE_ALIASES)) {
    if (longs.some((l) => joined.includes(` ${l} `))) out.add(short);
    if (out.has(short)) longs.forEach((l) => l.split(' ').forEach((w) => out.add(w)));
  }
  return out;
}

/**
 * Resolve ONE free-text item to a concrete variant: best PRODUCT first, then
 * the variant among that product's variants (title / SKU / size aliases).
 * Ambiguous → options (the agent asks; never guesses a pack/size).
 */
export function resolveVariant(
  query: string,
  hits: ProductHit[],
):
  | { status: 'ok'; hit: ProductHit }
  | { status: 'ambiguous'; productTitle: string; options: ProductHit[] }
  | { status: 'none' } {
  const avail = hits.filter((h) => h.available !== false);
  const pool = avail.length ? avail : hits;
  if (!pool.length) return { status: 'none' };
  const qTokens = expandTokens(query);
  if (!qTokens.size) return { status: 'ok', hit: pool[0] };
  let best = pool[0].productTitle;
  let bestScore = -1;
  for (const title of new Set(pool.map((h) => h.productTitle))) {
    const t = new Set(norm(title));
    let sc = 0;
    for (const w of qTokens) if (t.has(w)) sc++;
    if (sc > bestScore) {
      bestScore = sc;
      best = title;
    }
  }
  const cands = pool.filter((h) => h.productTitle === best);
  if (cands.length === 1) return { status: 'ok', hit: cands[0] };
  const scored = cands
    .map((h, idx) => {
      const vt = new Set([...norm(h.variantTitle), ...norm(h.sku ?? '')]);
      let s = 0;
      for (const w of qTokens) if (vt.has(w)) s += 2;
      return { h, s, idx };
    })
    .sort((a, b) => b.s - a.s || a.idx - b.idx);
  if (scored[0].s > 0 && (!scored[1] || scored[0].s > scored[1].s)) {
    return { status: 'ok', hit: scored[0].h };
  }
  return { status: 'ambiguous', productTitle: best, options: cands };
}

const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties: props,
  ...(required.length ? { required } : {}),
});

/** All tool definitions (the runtime offers the subset the profile enables). */
export const TOOL_DEFS: Record<string, ToolDef> = {
  search_knowledge: {
    name: 'search_knowledge',
    description:
      "Search the business's knowledge (policies, FAQ, services, menu, listings, documents, website). Returns the most relevant passages.",
    inputSchema: obj({ query: { type: 'string', description: 'What to look up, in the customer\'s words' } }, ['query']),
  },
  search_products: {
    name: 'search_products',
    description:
      'Search the live product catalogue. Returns products with every variant (variant_id, option, price, discount, stock). Use for any product, price or stock question.',
    inputSchema: obj({ query: { type: 'string' } }, ['query']),
  },
  send_product_image: {
    name: 'send_product_image',
    description: 'Send the real product photo to the customer (system sends it). Pass a variant_id from search_products, or a product name.',
    inputSchema: obj({ variant_id: { type: 'string' }, query: { type: 'string' } }),
  },
  extract_order: {
    name: 'extract_order',
    description:
      'Read the whole chat (incl. photos) and pre-fill the order: items, name, phone, address, city, payment. Call it when the customer wants to buy. Returns what was filled and what is still missing.',
    inputSchema: obj({}),
  },
  set_cart: {
    name: 'set_cart',
    description:
      'Set the cart to exactly these items (replaces the previous cart). Use variant_id values returned by search_products / extract_order. quantity 0 removes an item.',
    inputSchema: obj(
      {
        items: {
          type: 'array',
          items: obj({ variant_id: { type: 'string' }, quantity: { type: 'number' } }, ['variant_id', 'quantity']),
        },
      },
      ['items'],
    ),
  },
  update_customer: {
    name: 'update_customer',
    description: 'Record delivery details the customer gave (only fields you learned).',
    inputSchema: obj({
      name: { type: 'string' },
      phone: { type: 'string' },
      email: { type: 'string' },
      address1: { type: 'string', description: 'Full street address' },
      city: { type: 'string' },
      country_code: { type: 'string', description: 'ISO-2' },
    }),
  },
  set_payment: {
    name: 'set_payment',
    description: 'Record the payment method the customer chose: "cod" (cash on delivery) or "prepaid".',
    inputSchema: obj({ method: { type: 'string', enum: ['cod', 'prepaid'] } }, ['method']),
  },
  get_shipping: {
    name: 'get_shipping',
    description: 'Get live delivery charges for the current cart to the customer\'s city.',
    inputSchema: obj({}),
  },
  review_order: {
    name: 'review_order',
    description:
      'Validate the order. If anything is missing it says what; otherwise the SYSTEM sends the customer the exact order summary to confirm.',
    inputSchema: obj({}),
  },
  place_order: {
    name: 'place_order',
    description:
      'Place the order the customer just confirmed. confirmation_quote = the customer\'s exact confirming words from their latest message (verified).',
    inputSchema: obj({ confirmation_quote: { type: 'string' } }, ['confirmation_quote']),
  },
  get_order_status: {
    name: 'get_order_status',
    description: 'Delivery status + tracking of an existing order by its number (only for this customer\'s own orders).',
    inputSchema: obj({ order_number: { type: 'string' } }, ['order_number']),
  },
  get_customer_history: {
    name: 'get_customer_history',
    description: "This customer's recent orders and saved address (by their WhatsApp number).",
    inputSchema: obj({}),
  },
  open_ticket: {
    name: 'open_ticket',
    description:
      'Register a complaint / return / refund / exchange / damaged / wrong / missing item ticket. Call once you have the order number and the issue.',
    inputSchema: obj(
      {
        issue: { type: 'string' },
        order_number: { type: 'string' },
        type: { type: 'string', enum: ['return', 'refund', 'exchange', 'damaged', 'wrong_item', 'missing', 'billing', 'other'] },
      },
      ['issue'],
    ),
  },
  get_payment_details: {
    name: 'get_payment_details',
    description: 'Bank / wallet details for advance payment.',
    inputSchema: obj({}),
  },
  get_slots: {
    name: 'get_slots',
    description: 'Free booking slots for a service. date = YYYY-MM-DD to start from (default today).',
    inputSchema: obj({ service: { type: 'string' }, date: { type: 'string' }, party_size: { type: 'number' } }, ['service']),
  },
  book_slot: {
    name: 'book_slot',
    description: 'Book a slot returned by get_slots (start = its exact startIso) after the customer confirmed it.',
    inputSchema: obj(
      {
        service: { type: 'string' },
        start: { type: 'string' },
        name: { type: 'string' },
        party_size: { type: 'number' },
        notes: { type: 'string' },
      },
      ['service', 'start', 'name'],
    ),
  },
  cancel_booking: {
    name: 'cancel_booking',
    description: "Cancel one of this customer's upcoming bookings (booking_id from my_bookings).",
    inputSchema: obj({ booking_id: { type: 'number' } }, ['booking_id']),
  },
  my_bookings: {
    name: 'my_bookings',
    description: "This customer's upcoming bookings.",
    inputSchema: obj({}),
  },
  save_lead: {
    name: 'save_lead',
    description:
      'Save what you learned about the customer\'s need (fields = key/value of the configured lead fields). qualified=true when the hot-lead rule is met.',
    inputSchema: obj(
      {
        fields: { type: 'object', additionalProperties: { type: 'string' } },
        qualified: { type: 'boolean' },
        summary: { type: 'string', description: 'One line on what they want' },
      },
      ['fields'],
    ),
  },
  choose_store: {
    name: 'choose_store',
    description: 'Set which brand/store this chat is about (after the customer said so).',
    inputSchema: obj({ store_id: { type: 'number' } }, ['store_id']),
  },
  handoff: {
    name: 'handoff',
    description: 'Connect the customer to a human (the system tells them). category: asked_human | upset | sensitive | other.',
    inputSchema: obj(
      { reason: { type: 'string' }, category: { type: 'string', enum: ['asked_human', 'upset', 'sensitive', 'other'] } },
      ['reason'],
    ),
  },
  end_conversation: {
    name: 'end_conversation',
    description: 'Mark the conversation resolved (customer is done, nothing pending).',
    inputSchema: obj({}),
  },
};

/**
 * Tool executors for the v2 agent. Every executor: reads/writes TurnState,
 * never throws (errors become a short tool result), respects `dryRun`
 * (playground / shadow: no message, order, booking, ticket or contact write
 * ever leaves the system), and records a trace entry.
 */
@Injectable()
export class AgentSkills {
  private readonly logger = new Logger(AgentSkills.name);
  /** Per-conversation in-process order mutex (single worker container). */
  private readonly orderChains = new Map<number, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly rag: AiRagService,
    private readonly commerce: CommerceResolverService,
    private readonly inbox: InboxService,
    private readonly tickets: TicketsService,
    private readonly bookings: AgentBookingsService,
    private readonly webhooks: WebhookDispatcherService,
    private readonly events: EventStoreService,
    private readonly stock: InventoryLedgerService,
  ) {}

  /** Which tools to offer this turn, from the profile + store setup. */
  toolsFor(st: TurnState, hasStore: boolean): ToolDef[] {
    const sk = st.bundle.profile.skills;
    const names: string[] = [];
    if (sk.knowledge.enabled) names.push('search_knowledge');
    if (hasStore && (sk.orders.enabled || sk.knowledge.enabled)) names.push('search_products', 'send_product_image');
    if (hasStore && sk.orders.enabled) {
      names.push('extract_order', 'set_cart', 'update_customer', 'set_payment', 'get_shipping', 'review_order', 'place_order');
    }
    if (hasStore && sk.order_status.enabled) names.push('get_order_status', 'get_customer_history', 'open_ticket');
    if (sk.payments.enabled) names.push('get_payment_details');
    if (sk.bookings.enabled && sk.bookings.services.length) {
      names.push('get_slots', 'book_slot', 'cancel_booking', 'my_bookings');
    }
    if (sk.leads.enabled) names.push('save_lead');
    if (st.stores.length > 1 && !st.storeId) names.push('choose_store');
    if (sk.handoff.enabled) names.push('handoff');
    names.push('end_conversation');
    return names.map((n) => TOOL_DEFS[n]).filter(Boolean);
  }

  async execute(st: TurnState, name: string, input: Record<string, unknown>): Promise<string> {
    const started = Date.now();
    let out: string;
    let ok = true;
    try {
      out = await this.dispatch(st, name, input);
    } catch (e) {
      ok = false;
      out = 'That tool is temporarily unavailable. Do not guess — tell the customer you will check, or hand off.';
      this.logger.warn(
        `tool ${name} failed (company ${st.companyId}, convo ${st.conversationId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      if (st.conversationId && !st.dryRun) {
        await this.events.append({
          companyId: st.companyId,
          aggregateType: 'CONVERSATION',
          aggregateId: st.conversationId,
          type: 'tool.failed',
          actorType: 'SYSTEM',
          payload: { tool: name, error: e instanceof Error ? e.message.slice(0, 300) : 'error' },
        });
      }
    }
    const clipped = (out || '').slice(0, 6000);
    st.corpus += `${clipped}\n`;
    st.tools.push({ name, ok, ms: Date.now() - started, summary: clipped.slice(0, 160) });
    return clipped;
  }

  private async provider(st: TurnState) {
    return this.commerce.forStore(st.companyId, st.storeId ?? undefined);
  }

  private money(st: TurnState, n: number | string): string {
    const v = typeof n === 'string' ? parseFloat(n) : n;
    return `${st.bundle.profile.currencySymbol} ${Math.round(v || 0).toLocaleString('en-US')}`;
  }

  private async dispatch(st: TurnState, name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'search_knowledge':
        return this.searchKnowledge(st, str(input.query, 300));
      case 'search_products':
        return this.searchProducts(st, str(input.query, 200));
      case 'send_product_image':
        return this.sendImage(st, str(input.variant_id, 255), str(input.query, 200));
      case 'extract_order':
        return this.extractOrder(st);
      case 'set_cart':
        return this.setCart(st, input.items);
      case 'update_customer':
        return this.updateCustomer(st, input);
      case 'set_payment':
        return this.setPayment(st, str(input.method, 20));
      case 'get_shipping':
        return this.shipping(st);
      case 'review_order':
        return this.reviewOrder(st);
      case 'place_order':
        return this.placeOrder(st, str(input.confirmation_quote, 200));
      case 'get_order_status':
        return this.orderStatus(st, str(input.order_number, 40));
      case 'get_customer_history':
        return this.customerHistory(st);
      case 'open_ticket':
        return this.openTicket(st, input);
      case 'get_payment_details':
        return st.bundle.paymentDetails
          ? `Payment details to share exactly:\n<customer_data>\n${st.bundle.paymentDetails}\n</customer_data>`
          : 'No payment details are configured. Tell the customer the team will share them, and hand off.';
      case 'get_slots':
        return this.getSlots(st, input);
      case 'book_slot':
        return this.bookSlot(st, input);
      case 'cancel_booking':
        return this.cancelBooking(st, Number(input.booking_id));
      case 'my_bookings':
        return this.myBookings(st);
      case 'save_lead':
        return this.saveLead(st, input);
      case 'choose_store':
        return this.chooseStore(st, Number(input.store_id));
      case 'handoff': {
        const cat = str(input.category, 20);
        st.handoff = {
          reason: str(input.reason, 250) || 'agent requested a human',
          category: cat === 'asked_human' || cat === 'upset' || cat === 'sensitive' ? cat : 'model',
        };
        return 'Handoff scheduled — the system will message the customer. Do not write a reply.';
      }
      case 'end_conversation':
        if (hasOpenFlow(st.memory)) {
          return 'Not allowed: an order/booking is still in progress. Ask whether they want to continue instead.';
        }
        st.endConversation = true;
        return 'OK — reply with a brief, warm closing line.';
      default:
        return 'Unknown tool.';
    }
  }

  // ── Knowledge ─────────────────────────────────────────────────────────

  private async searchKnowledge(st: TurnState, q: string): Promise<string> {
    if (!q) return 'Empty query.';
    const hits = await this.rag.retrieveHits(st.companyId, q, { storeId: st.storeId, topK: 6 });
    if (!hits.length) {
      if (st.conversationId && !st.dryRun) {
        await this.events.append({
          companyId: st.companyId,
          aggregateType: 'CONVERSATION',
          aggregateId: st.conversationId,
          type: 'ai.knowledge_miss',
          actorType: 'AI',
          payload: { query: q.slice(0, 200) },
        });
      }
      return 'Nothing relevant in the knowledge. Do not guess — say you will check with the team (or hand off if it matters).';
    }
    for (const h of hits) st.sources.push({ title: h.title, sourceType: h.sourceType, score: h.score });
    st.progress = true;
    let out = '';
    for (const h of hits) {
      const block = `## ${h.title} [${h.sourceType}]\n${h.content}\n\n`;
      if (out.length + block.length > 9000) break;
      out += block;
    }
    return `<knowledge>\n${out.trim()}\n</knowledge>`;
  }

  // ── Products ──────────────────────────────────────────────────────────

  private remember(st: TurnState, hits: ProductHit[]): void {
    for (const h of hits) if (h.variantId) st.seen.set(h.variantId, h);
  }

  private async searchRaw(st: TurnState, q: string): Promise<ProductHit[]> {
    const p = await this.provider(st);
    let hits = await p.searchProducts(st.companyId, q, false, st.storeId ?? undefined).catch(() => [] as ProductHit[]);
    // Semantic augment: catalogue chunks whose meaning matches (synonyms,
    // other languages, spelling) — KEPT, never filtered out by word overlap.
    try {
      const sem = await this.rag.retrieveHits(st.companyId, q, {
        storeId: st.storeId,
        types: ['product'],
        topK: 4,
      });
      const have = new Set(hits.map((h) => h.productTitle.toLowerCase()));
      for (const s of sem) {
        const title = s.title.replace(/\s*\(\d+\/\d+\)$/, '');
        if (have.has(title.toLowerCase())) continue;
        const extra = await p
          .searchProducts(st.companyId, title, false, st.storeId ?? undefined)
          .catch(() => [] as ProductHit[]);
        hits = hits.concat(extra.filter((e) => e.productTitle.toLowerCase() === title.toLowerCase()).slice(0, 20));
        have.add(title.toLowerCase());
      }
    } catch {
      /* best-effort */
    }
    const dedup = new Map<string, ProductHit>();
    for (const h of hits) if (h.variantId && !dedup.has(h.variantId)) dedup.set(h.variantId, h);
    // Inventory v2: the shared stock pool decides what is in stock (Shopify's
    // availableForSale stays true when "continue selling" is on, and a sale in
    // another store isn't reflected there yet).
    try {
      const stock = await this.stock.stockFor(st.companyId, [...dedup.keys()], st.storeId);
      for (const [gid, s] of stock) {
        const h = dedup.get(gid);
        if (h) dedup.set(gid, { ...h, available: s.sellable });
      }
    } catch {
      /* inventory unavailable — keep the store's own flag */
    }
    return [...dedup.values()];
  }

  private async searchProducts(st: TurnState, q: string): Promise<string> {
    if (!q) return 'Empty query.';
    const hits = await this.searchRaw(st, q);
    if (!hits.length) {
      return 'No matching products found. Ask the customer to describe it differently (name, type, colour) — do not list unrelated items.';
    }
    this.remember(st, hits);
    st.progress = true;
    // Group by product, rank products by relevance (semantic order breaks ties).
    const byProduct = new Map<string, ProductHit[]>();
    for (const h of hits) {
      const list = byProduct.get(h.productTitle) ?? [];
      list.push(h);
      byProduct.set(h.productTitle, list);
    }
    const ranked = [...byProduct.entries()]
      .map(([title, vs], i) => ({ title, vs, score: Math.max(...vs.map((v) => relevance(q, v))), i }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, 6);
    const out = ranked.map((p) => ({
      product: p.title,
      url: p.vs[0].productUrl ?? undefined,
      description: p.vs[0].description ? p.vs[0].description.slice(0, 240) : undefined,
      variants: p.vs.slice(0, 25).map((v) => ({
        variant_id: v.variantId,
        option: v.variantTitle || undefined,
        price: this.money(st, v.price),
        original_price: v.compareAtPrice ? this.money(st, v.compareAtPrice) : undefined,
        discount_percent: v.discountPercent ?? undefined,
        in_stock: v.available,
      })),
    }));
    return JSON.stringify(out);
  }

  private async sendImage(st: TurnState, variantId: string, query: string): Promise<string> {
    let hit = variantId ? st.seen.get(variantId) : undefined;
    if (!hit && query) {
      const hits = await this.searchRaw(st, query);
      this.remember(st, hits);
      const r = resolveVariant(query, hits);
      hit = r.status === 'ok' ? r.hit : r.status === 'ambiguous' ? r.options[0] : hits[0];
    }
    if (!hit?.image) return 'No product photo is available. Tell the customer the team will share it — never paste a link.';
    if (st.dryRun || !st.conversationId) return `(dry run) Would send the photo of "${hit.productTitle}".`;
    const resp = await fetch(hit.image);
    if (!resp.ok) throw new Error(`image fetch ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const mimetype = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0];
    await this.inbox.sendMedia({
      companyId: st.companyId,
      conversationId: st.conversationId,
      file: { buffer: buf, mimetype, size: buf.length },
    });
    st.progress = true;
    return `Sent the photo of "${hit.productTitle}". Write one short line referring to it — no link.`;
  }

  // ── Orders ────────────────────────────────────────────────────────────

  private touchOrder(st: TurnState): void {
    if (st.memory.stage === 'idle' || st.memory.stage === 'done') st.memory.stage = 'collecting';
    st.progress = true;
  }

  private async extractOrder(st: TurnState): Promise<string> {
    if (!st.conversationId) {
      return 'Not available here — use search_products, set_cart and update_customer.';
    }
    const draft = await this.ai.draftOrder(st.companyId, null, st.conversationId);
    const m = st.memory;
    const c = draft.customer;
    m.customer = {
      ...m.customer,
      name: m.customer.name || c.name || undefined,
      phone: m.customer.phone || c.phone || undefined,
      email: m.customer.email || c.email || undefined,
      address1: m.customer.address1 || c.address1 || undefined,
      city: m.customer.city || c.city || undefined,
      countryCode: m.customer.countryCode || c.countryCode || undefined,
    };
    if (!m.payment && draft.paymentMethod) m.payment = draft.paymentMethod;

    const resolved: string[] = [];
    const ambiguous: Array<{ query: string; product: string; options: Array<{ variant_id: string; option: string; price: string }> }> = [];
    const notFound: string[] = [];
    if (draft.items.length) {
      const cart: CartLine[] = [...m.cart];
      for (const it of draft.items) {
        const hits = await this.searchRaw(st, it.productQuery);
        this.remember(st, hits);
        const r = resolveVariant(it.productQuery, hits);
        if (r.status === 'ok') {
          const i = cart.findIndex((l) => l.variantId === r.hit.variantId);
          const line: CartLine = {
            variantId: r.hit.variantId,
            quantity: it.quantity,
            title: r.hit.productTitle,
            variantTitle: r.hit.variantTitle,
            unitPrice: parseFloat(r.hit.price) || 0,
            sku: r.hit.sku,
          };
          if (i >= 0) cart[i] = line;
          else cart.push(line);
          resolved.push(`${it.quantity} x ${r.hit.productTitle}${r.hit.variantTitle ? ` (${r.hit.variantTitle})` : ''}`);
        } else if (r.status === 'ambiguous') {
          ambiguous.push({
            query: it.productQuery,
            product: r.productTitle,
            options: r.options.slice(0, 12).map((o) => ({
              variant_id: o.variantId,
              option: o.variantTitle,
              price: this.money(st, o.price),
            })),
          });
        } else {
          notFound.push(it.productQuery);
        }
      }
      m.cart = cart;
    }
    // Saved address from the customer's last order (offer, don't assume).
    let saved: string | null = null;
    if (!m.customer.address1 && st.contactPhone) {
      const last = await this.lastOrderFor(st).catch(() => null);
      if (last?.address1) saved = [last.address1, last.city].filter(Boolean).join(', ');
    }
    this.touchOrder(st);
    return JSON.stringify({
      cart: resolved,
      need_variant_choice: ambiguous,
      not_found: notFound,
      customer: m.customer,
      payment: m.payment,
      saved_address_on_file: saved ?? undefined,
      still_missing: missingOrderFields(m, true),
    });
  }

  private setCart(st: TurnState, raw: unknown): string {
    const items = Array.isArray(raw) ? raw : [];
    const cart: CartLine[] = [];
    const unknown: string[] = [];
    for (const x of items) {
      const o = (x ?? {}) as Record<string, unknown>;
      const vid = str(o.variant_id, 255);
      const q = Math.floor(Number(o.quantity));
      if (!vid || !(q > 0)) continue;
      const hit = st.seen.get(vid);
      const existing = st.memory.cart.find((l) => l.variantId === vid);
      if (!hit && !existing) {
        unknown.push(vid);
        continue;
      }
      cart.push(
        hit
          ? {
              variantId: vid,
              quantity: Math.min(q, 999),
              title: hit.productTitle,
              variantTitle: hit.variantTitle,
              unitPrice: parseFloat(hit.price) || 0,
              sku: hit.sku,
            }
          : { ...existing!, quantity: Math.min(q, 999) },
      );
    }
    if (unknown.length) {
      return `Unknown variant_id(s): ${unknown.join(', ')}. Call search_products first and use its variant_id values.`;
    }
    // Never put an out-of-stock item in the cart.
    const oos = cart.filter((l) => st.seen.get(l.variantId)?.available === false);
    if (oos.length) {
      return `Out of stock: ${oos.map((l) => `${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ''}`).join(', ')}. Do not add it. Tell the customer it is out of stock and offer an in-stock option from search_products (or ask if they want to be told when it is back).`;
    }
    st.memory.cart = cart;
    this.touchOrder(st);
    return JSON.stringify({
      cart: cart.map((l) => `${l.quantity} x ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ''} = ${this.money(st, l.unitPrice * l.quantity)}`),
      total: this.money(st, cartTotal(cart)),
      still_missing: missingOrderFields(st.memory, true),
    });
  }

  private updateCustomer(st: TurnState, i: Record<string, unknown>): string {
    const c = st.memory.customer;
    const set = (k: keyof typeof c, v: string) => {
      if (v) c[k] = v;
    };
    set('name', str(i.name, 160));
    set('phone', str(i.phone, 32));
    const email = str(i.email, 160);
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) c.email = email;
    set('address1', str(i.address1, 400));
    set('city', str(i.city, 120));
    const cc = str(i.country_code, 2).toUpperCase();
    if (/^[A-Z]{2}$/.test(cc)) c.countryCode = cc;
    this.touchOrder(st);
    return JSON.stringify({ customer: c, still_missing: missingOrderFields(st.memory, true) });
  }

  private setPayment(st: TurnState, method: string): string {
    const o = st.bundle.profile.skills.orders;
    if (method === 'cod' && !o.allowCod) return 'Cash on delivery is not offered — offer prepaid.';
    if (method === 'prepaid' && !o.allowPrepaid) return 'Prepaid is not offered — offer cash on delivery.';
    if (method !== 'cod' && method !== 'prepaid') return 'method must be "cod" or "prepaid".';
    st.memory.payment = method;
    this.touchOrder(st);
    return JSON.stringify({ payment: method, still_missing: missingOrderFields(st.memory, true) });
  }

  private country(st: TurnState): string {
    return (st.memory.customer.countryCode || st.bundle.profile.countryCode || 'PK').toUpperCase().slice(0, 2);
  }

  private async shipping(st: TurnState): Promise<string> {
    const m = st.memory;
    if (!m.cart.length) return 'The cart is empty — add items first.';
    const p = await this.provider(st);
    const rates = await p.getShippingRates(
      st.companyId,
      {
        lineItems: m.cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
        address1: m.customer.address1,
        city: m.customer.city,
        countryCode: this.country(st),
      },
      st.storeId ?? undefined,
    );
    if (!rates.length) return 'No shipping rates are configured for that destination — check search_knowledge for the delivery policy.';
    return JSON.stringify(rates.map((r) => ({ option: r.title, amount: this.money(st, r.amount) })));
  }

  private async reviewOrder(st: TurnState): Promise<string> {
    const m = st.memory;
    const o = st.bundle.profile.skills.orders;
    const needPayment = o.allowCod && o.allowPrepaid;
    if (!needPayment && !m.payment) m.payment = o.allowCod ? 'cod' : 'prepaid';
    const miss = missingOrderFields(m, true);
    if (miss.length) return `Not ready — still missing: ${miss.join(', ')}. Ask the customer for these.`;
    const lines = m.cart.map((l) => ({
      quantity: l.quantity,
      title: l.variantTitle ? `${l.title} (${l.variantTitle})` : l.title,
      unitPrice: l.unitPrice,
      lineTotal: l.unitPrice * l.quantity,
    }));
    const total = cartTotal(m.cart);
    let summary: string | null = null;
    if (st.conversationId && !st.dryRun) {
      try {
        summary = (
          await this.ai.composeOrderConfirmation(st.companyId, st.conversationId, {
            items: lines,
            total,
            name: m.customer.name!,
            phone: m.customer.phone!,
            address1: m.customer.address1!,
            city: m.customer.city!,
            payment: m.payment!,
          })
        ).text;
      } catch {
        summary = null;
      }
    }
    if (!summary || !summary.trim()) {
      summary =
        `📋 Please confirm your order:\n\n` +
        lines.map((l) => `• ${l.quantity} × ${l.title} — ${this.money(st, l.lineTotal)}`).join('\n') +
        `\n\nTotal: ${this.money(st, total)}\n\nName: ${m.customer.name}\nPhone: ${m.customer.phone}\n` +
        `Address: ${m.customer.address1}, ${m.customer.city}\n` +
        `Payment: ${m.payment === 'prepaid' ? 'Prepaid' : 'Cash on Delivery'}\n\nReply YES to confirm.`;
    }
    m.summaryHash = summarySignature(m);
    m.summaryAt = new Date().toISOString();
    m.stage = 'awaiting_confirm';
    st.systemReply = summary.trim();
    st.progress = true;
    return 'Summary prepared — the SYSTEM will send it to the customer now. Do not write anything else.';
  }

  private async withOrderLock<T>(conversationId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.orderChains.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((res) => (release = res));
    const tail = prev.then(() => done);
    this.orderChains.set(conversationId, tail);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.orderChains.get(conversationId) === tail) this.orderChains.delete(conversationId);
    }
  }

  private async placeOrder(st: TurnState, quote: string): Promise<string> {
    const m = st.memory;
    if (m.stage !== 'awaiting_confirm' || !m.summaryHash) {
      return 'No confirmed summary yet — call review_order first.';
    }
    if (m.summaryHash !== summarySignature(m)) {
      return 'The order changed after the summary — call review_order again so the customer confirms the new version.';
    }
    const confirmed =
      isAffirmation(st.latestTurnText) ||
      (quoteInTurn(quote, st.latestTurnText) && !/\b(no|nahi|cancel|wait|mat)\b/i.test(quote));
    if (!confirmed) {
      return 'The customer has not clearly confirmed in their latest message. Ask them to confirm (or tell you what to change).';
    }
    const total = cartTotal(m.cart);
    const ho = st.bundle.profile.handoff;
    const detail =
      m.cart.map((l) => `${l.quantity} x ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ''}`).join(', ') +
      ` | ${m.customer.name}, ${m.customer.phone}, ${m.customer.address1}, ${m.customer.city} | ${m.payment} | total ${this.money(st, total)}`;

    if (!st.transactionsAllowed || !st.autoOrder || (ho.orderValueAbove && total > ho.orderValueAbove)) {
      m.stage = 'done';
      st.handoff = {
        reason: `Confirmed order for the team to place: ${detail}`.slice(0, 250),
        category: !st.autoOrder || !st.transactionsAllowed ? 'manual_order' : 'order_value',
        message: st.open
          ? 'Thank you! Your order details are confirmed — our team will place it and send you the order number shortly.'
          : 'Thank you! Your order details are confirmed — our team will place it as soon as we open.',
      };
      st.progress = true;
      return 'Handed to the team to place (the system tells the customer). Do not write a reply.';
    }

    if (m.payment === 'prepaid') {
      m.stage = 'awaiting_payment';
      st.progress = true;
      if (st.conversationId && !st.dryRun) {
        await this.prisma.conversation
          .update({ where: { id: st.conversationId }, data: { ai_awaiting_payment_at: new Date() } })
          .catch(() => undefined);
      }
      return st.bundle.paymentDetails
        ? `PREPAID: do NOT say the order is placed. Share these payment details exactly and ask the customer to pay and send the payment slip here:\n<customer_data>\n${st.bundle.paymentDetails}\n</customer_data>`
        : 'PREPAID but no payment details are configured: tell the customer the team will share the account details, then call handoff.';
    }

    // COD → create the real order.
    if (st.dryRun || !st.conversationId) {
      m.stage = 'done';
      m.lastOrderName = '#SIM-1001';
      st.orderPlaced = '#SIM-1001';
      st.progress = true;
      return 'ORDER PLACED (simulation): #SIM-1001, cash on delivery. Confirm it to the customer with the order number.';
    }
    const conversationId = st.conversationId;
    const r = await this.withOrderLock(conversationId, () => this.createCodOrder(st, conversationId));
    if (r.status === 'failed') {
      st.handoff = {
        reason: `Order creation failed (${r.error ?? 'error'}): ${detail}`.slice(0, 250),
        category: 'error',
        message: 'Thank you! Your order is confirmed — our team is finalising it and will send your order number shortly.',
      };
      return 'Order creation failed — handed to the team. Do not write a reply.';
    }
    m.stage = 'done';
    m.lastOrderName = r.orderName ?? m.lastOrderName;
    m.lastOrderAt = new Date().toISOString();
    st.orderPlaced = r.orderName ?? 'placed';
    st.progress = true;
    return `ORDER PLACED: ${r.orderName ?? '(number pending)'} — cash on delivery. Confirm it warmly in one or two lines with the order number. Do not repeat prices.`;
  }

  private async createCodOrder(
    st: TurnState,
    conversationId: number,
  ): Promise<{ status: 'created' | 'duplicate' | 'failed'; orderName?: string; error?: string }> {
    const m = st.memory;
    const lineItems = m.cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity }));
    const signature = cartSignature(lineItems);
    const recent = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        company_id: st.companyId,
        ai_last_order_signature: signature,
        ai_order_created_at: { gt: new Date(Date.now() - REORDER_DUPLICATE_WINDOW_MS) },
      },
      select: { id: true },
    });
    if (recent) return { status: 'duplicate', orderName: m.lastOrderName ?? undefined };

    const p = await this.provider(st);
    const country = this.country(st);
    let shippingLine: { title: string; price: number } | undefined;
    try {
      const rates = await p.getShippingRates(
        st.companyId,
        { lineItems, address1: m.customer.address1, city: m.customer.city, countryCode: country },
        st.storeId ?? undefined,
      );
      if (rates[0]) shippingLine = { title: rates[0].title, price: parseFloat(rates[0].amount) || 0 };
    } catch {
      /* order without a shipping line */
    }
    try {
      const order = await p.createOrder(st.companyId, {
        lineItems,
        customerName: m.customer.name,
        phone: normalizePhone(m.customer.phone ?? '', country),
        email: m.customer.email,
        address1: m.customer.address1,
        city: m.customer.city,
        countryCode: country,
        tags: ['CodesApp', 'AI auto-order'],
        prepaid: false,
        shippingLine,
        conversationId,
        storeId: st.storeId ?? undefined,
      });
      await this.prisma.conversation
        .updateMany({
          where: { id: conversationId, company_id: st.companyId },
          data: {
            ai_order_created_at: new Date(),
            ai_last_order_signature: signature,
            ...(st.storeId ? { last_shopify_store_id: st.storeId } : {}),
          },
        })
        .catch(() => undefined);
      await this.prisma.conversationLabel
        .upsert({
          where: { conversation_id_label: { conversation_id: conversationId, label: AI_ORDER_LABEL } },
          create: { company_id: st.companyId, conversation_id: conversationId, label: AI_ORDER_LABEL },
          update: {},
        })
        .catch(() => undefined);
      await this.events.append({
        companyId: st.companyId,
        aggregateType: 'CONVERSATION',
        aggregateId: conversationId,
        type: 'order.created',
        actorType: 'AI',
        payload: { orderName: order.orderName, signature, storeId: st.storeId },
      });
      return { status: 'created', orderName: order.orderName };
    } catch (e) {
      return { status: 'failed', error: e instanceof Error ? e.message.slice(0, 120) : String(e) };
    }
  }

  // ── Existing orders ───────────────────────────────────────────────────

  private tail(p?: string | null): string {
    const d = (p || '').replace(/\D/g, '');
    return d.length >= 10 ? d.slice(-10) : d;
  }

  private async lastOrderFor(st: TurnState) {
    const t = this.tail(st.contactPhone);
    if (!t) return null;
    const rows = await this.prisma.$queryRaw<
      Array<{ address1: string | null; city: string | null; customer_name: string | null }>
    >`SELECT address1, city, customer_name FROM shopify_orders
       WHERE company_id = ${st.companyId}
         AND RIGHT(REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', ''), 10) = ${t}
       ORDER BY shopify_created_at DESC LIMIT 1`;
    return rows[0] ?? null;
  }

  private async orderStatus(st: TurnState, raw: string): Promise<string> {
    const digits = raw.replace(/[^0-9A-Za-z-]/g, '').replace(/^#/, '');
    if (!digits) return 'Ask the customer for their order number.';
    const order = await this.prisma.shopifyOrder.findFirst({
      where: {
        company_id: st.companyId,
        OR: [{ order_number: digits }, { order_name: `#${digits}` }, { order_name: digits }],
      },
      orderBy: { shopify_created_at: 'desc' },
      select: {
        order_name: true,
        phone: true,
        shopify_order_gid: true,
        fulfillment_status: true,
        cancelled_at: true,
        shopify_created_at: true,
      },
    });
    if (!order) {
      // Not mirrored yet — ask the primary store directly.
      const p = await this.provider(st);
      const s2 = await p.getOrderStatus(st.companyId, digits);
      if (!s2.found) return 'No order found with that number. Ask the customer to double-check it.';
      const own = [s2.customerPhone, s2.shippingPhone].some((x) => this.tail(x) && this.tail(x) === this.tail(st.contactPhone));
      if (!own) return 'That order is not linked to this WhatsApp number — ask them to check the number or message from the phone used on the order.';
      st.progress = true;
      return JSON.stringify({
        order: s2.name,
        status: ShopifyService.humanizeFulfillmentStatus(s2.fulfillmentStatus),
        tracking: (s2.tracking ?? []).map((t) => [t.company, t.number, t.url].filter(Boolean).join(' ')),
      });
    }
    if (!this.tail(st.contactPhone) || this.tail(order.phone) !== this.tail(st.contactPhone)) {
      return 'That order is not linked to this WhatsApp number — ask them to check the number or message from the phone used on the order.';
    }
    const ship = await this.prisma.shipment.findFirst({
      where: { company_id: st.companyId, shopify_order_gid: order.shopify_order_gid },
      select: { status: true, courier_type: true, courier_tracking_number: true, delivered_at: true },
    });
    st.progress = true;
    const status = order.cancelled_at
      ? 'cancelled'
      : ship
        ? ship.status.replace(/_/g, ' ')
        : ShopifyService.humanizeFulfillmentStatus(order.fulfillment_status);
    return JSON.stringify({
      order: order.order_name,
      placed: order.shopify_created_at?.toISOString().slice(0, 10),
      status,
      courier: ship?.courier_type ?? undefined,
      tracking_number: ship?.courier_tracking_number ?? undefined,
      tracking_url:
        ship?.courier_tracking_number && ship.courier_type
          ? courierTrackingUrl(ship.courier_type, ship.courier_tracking_number)
          : undefined,
      delivered_on: ship?.delivered_at?.toISOString().slice(0, 10),
    });
  }

  private async customerHistory(st: TurnState): Promise<string> {
    const t = this.tail(st.contactPhone);
    if (!t) return 'No phone number on file for this customer.';
    const rows = await this.prisma.$queryRaw<
      Array<{ order_name: string | null; created: Date | null; total: unknown; fulfillment_status: string | null; cancelled_at: Date | null; address1: string | null; city: string | null }>
    >`SELECT order_name, shopify_created_at AS created, total_price AS total, fulfillment_status,
             cancelled_at, address1, city
        FROM shopify_orders
       WHERE company_id = ${st.companyId}
         AND RIGHT(REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', ''), 10) = ${t}
       ORDER BY shopify_created_at DESC LIMIT 5`;
    if (!rows.length) return 'No previous orders found for this number.';
    st.progress = true;
    return JSON.stringify({
      saved_address: [rows[0].address1, rows[0].city].filter(Boolean).join(', ') || undefined,
      recent_orders: rows.map((r) => ({
        order: r.order_name,
        date: r.created?.toISOString().slice(0, 10),
        total: this.money(st, Number(r.total ?? 0)),
        status: r.cancelled_at ? 'cancelled' : ShopifyService.humanizeFulfillmentStatus(r.fulfillment_status),
      })),
    });
  }

  private async openTicket(st: TurnState, i: Record<string, unknown>): Promise<string> {
    if (!st.contactId || !st.conversationId) return 'Cannot register a ticket here.';
    const issue = str(i.issue, 1000) || st.latestTurnText || 'Customer complaint';
    const orderNumber = str(i.order_number, 40);
    const type = str(i.type, 20) || 'other';
    if (st.dryRun) return JSON.stringify({ ticketNumber: 'SIM-T-1', note: 'simulation' });
    const { ticket } = await this.tickets.createOrReuseForConversation(st.companyId, {
      conversationId: st.conversationId,
      contactId: st.contactId,
      type,
      createdBy: 'ai',
      description: issue,
      linkedOrderName: orderNumber || undefined,
      silentAck: true,
    });
    st.progress = true;
    return JSON.stringify({
      ticketNumber: ticket.ticket_number,
      note: 'Registered. Give the customer this ticket number; never promise a refund/replacement.',
    });
  }

  // ── Bookings ──────────────────────────────────────────────────────────

  private svc(st: TurnState, name: string) {
    return this.bookings.findService(st.bundle.profile.skills.bookings.services, name);
  }

  private async getSlots(st: TurnState, i: Record<string, unknown>): Promise<string> {
    const svc = this.svc(st, str(i.service, 120));
    const all = st.bundle.profile.skills.bookings.services.map((s) => s.name);
    if (!svc) return `Which service? Options: ${all.join(', ')}.`;
    const b = st.bundle.profile.skills.bookings;
    const slots = await this.bookings.slots({
      companyId: st.companyId,
      service: svc,
      hours: st.bundle.profile.hours,
      tz: st.tz,
      fromYmd: str(i.date, 10) || undefined,
      days: 3,
      leadTimeMin: b.leadTimeMin,
      maxDaysAhead: b.maxDaysAhead,
      partySize: Number(i.party_size) || 1,
    });
    if (!slots.length) return 'No free slots in that range — offer another date or hand off.';
    st.memory.booking = { ...st.memory.booking, service: svc.name };
    st.progress = true;
    return JSON.stringify({ service: svc.name, minutes: svc.durationMin, slots: slots.map((s) => ({ start: s.startIso, label: s.label })) });
  }

  private async bookSlot(st: TurnState, i: Record<string, unknown>): Promise<string> {
    const svc = this.svc(st, str(i.service, 120));
    if (!svc) return 'Unknown service — call get_slots first.';
    if (!st.transactionsAllowed) {
      st.handoff = {
        reason: `Booking request (after hours): ${svc.name} at ${str(i.start, 40)} for ${str(i.name, 80)}`,
        category: 'manual_order',
        message: 'Thanks! I have noted your booking request — our team will confirm it as soon as we open.',
      };
      return 'Booking handed to the team (after hours). Do not write a reply.';
    }
    if (st.dryRun) {
      st.bookingMade = -1;
      return JSON.stringify({ booking_id: 'SIM', service: svc.name, start: str(i.start, 40), note: 'simulation' });
    }
    const booking = await this.bookings.book({
      companyId: st.companyId,
      service: svc,
      startIso: str(i.start, 40),
      tz: st.tz,
      conversationId: st.conversationId,
      contactId: st.contactId,
      name: str(i.name, 160) || st.contactName,
      phone: st.contactPhone,
      partySize: Number(i.party_size) || 1,
      notes: str(i.notes, 1000) || null,
    });
    st.memory.lastBookingId = booking.id;
    st.memory.booking = {};
    st.bookingMade = booking.id;
    st.progress = true;
    void this.webhooks.dispatch(st.companyId, 'booking.created', {
      bookingId: booking.id,
      conversationId: st.conversationId,
      contactId: st.contactId,
      service: booking.service,
      startsAt: booking.starts_at,
    });
    const when = new Intl.DateTimeFormat('en-GB', {
      timeZone: st.tz,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(booking.starts_at);
    return JSON.stringify({ booked: true, booking_id: booking.id, service: booking.service, when });
  }

  private async cancelBooking(st: TurnState, id: number): Promise<string> {
    if (!id) return 'Which booking? Call my_bookings.';
    const own = await this.prisma.aiBooking.findFirst({
      where: {
        id,
        company_id: st.companyId,
        OR: [{ contact_id: st.contactId ?? -1 }, { conversation_id: st.conversationId ?? -1 }],
      },
      select: { id: true },
    });
    if (!own) return 'That booking is not linked to this customer.';
    if (st.dryRun) return 'Cancelled (simulation).';
    await this.bookings.cancel(st.companyId, id);
    st.progress = true;
    return 'Booking cancelled.';
  }

  private async myBookings(st: TurnState): Promise<string> {
    const rows = await this.bookings.upcomingFor(st.companyId, {
      contactId: st.contactId,
      conversationId: st.conversationId,
    });
    if (!rows.length) return 'No upcoming bookings.';
    return JSON.stringify(
      rows.map((b) => ({
        booking_id: b.id,
        service: b.service,
        when: new Intl.DateTimeFormat('en-GB', {
          timeZone: st.tz,
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }).format(b.starts_at),
      })),
    );
  }

  // ── Leads ─────────────────────────────────────────────────────────────

  private async saveLead(st: TurnState, i: Record<string, unknown>): Promise<string> {
    const lf = st.bundle.profile.skills.leads;
    const fields = (i.fields && typeof i.fields === 'object' ? i.fields : {}) as Record<string, unknown>;
    const known = new Set(lf.fields.map((f) => f.key));
    for (const [k, v] of Object.entries(fields)) {
      const key = k.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40);
      const val = str(v, 300);
      if (key && val && (known.has(key) || Object.keys(st.memory.lead).length < 20)) {
        st.memory.lead[key] = val;
      }
    }
    const wasQualified = st.memory.leadQualified;
    if (i.qualified === true) st.memory.leadQualified = true;
    const missing = lf.fields.filter((f) => f.required && !st.memory.lead[f.key]).map((f) => f.label);
    st.progress = true;
    st.leadSaved = true;
    if (!st.dryRun && st.contactId) {
      const contact = await this.prisma.contact.findFirst({
        where: { id: st.contactId, company_id: st.companyId },
        select: { custom_fields: true, tags: true },
      });
      if (contact) {
        const cf = { ...((contact.custom_fields as Record<string, unknown>) ?? {}) };
        for (const [k, v] of Object.entries(st.memory.lead)) cf[`lead_${k}`] = v;
        const summary = str(i.summary, 300);
        if (summary) cf.lead_summary = summary;
        const tags = Array.isArray(contact.tags) ? [...(contact.tags as string[])] : [];
        const addTag = (t: string) => {
          if (t && !tags.some((x) => String(x).toLowerCase() === t.toLowerCase())) tags.push(t);
        };
        addTag(lf.tag);
        if (st.memory.leadQualified) addTag('🔥 hot lead');
        await this.prisma.contact.update({
          where: { id: st.contactId },
          data: {
            custom_fields: cf as Prisma.InputJsonValue,
            tags: tags as Prisma.InputJsonValue,
          },
        });
      }
      if (st.memory.leadQualified && !wasQualified && st.conversationId) {
        await this.events.append({
          companyId: st.companyId,
          aggregateType: 'CONVERSATION',
          aggregateId: st.conversationId,
          type: 'lead.qualified',
          actorType: 'AI',
          payload: { lead: st.memory.lead },
        });
      }
      if (st.memory.leadQualified && !wasQualified) {
        void this.webhooks.dispatch(st.companyId, 'lead.qualified', {
          contactId: st.contactId,
          conversationId: st.conversationId,
          lead: st.memory.lead,
          summary: str(i.summary, 300) || null,
        });
      }
    }
    return JSON.stringify({ saved: st.memory.lead, qualified: st.memory.leadQualified, still_missing: missing });
  }

  private async chooseStore(st: TurnState, storeId: number): Promise<string> {
    const s = st.stores.find((x) => x.id === storeId);
    if (!s) return `Unknown store. Options: ${st.stores.map((x) => `${x.label} (id ${x.id})`).join(', ')}.`;
    st.storeId = s.id;
    st.memory.storeAsked = false;
    st.progress = true;
    if (st.conversationId && !st.dryRun) {
      await this.prisma.conversation
        .update({ where: { id: st.conversationId }, data: { ai_store_id: s.id } })
        .catch(() => undefined);
    }
    return `This chat is now about ${s.label}. Continue with their request.`;
  }
}
