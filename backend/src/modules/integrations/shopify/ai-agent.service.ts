import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { JobQueueService } from '../../../common/services/job-queue.service';
import { AiService, AgentIntent, DraftOrderResult } from '../../ai/ai.service';
import { AiRagService } from '../../ai/ai-rag.service';
import { AI_AGENT_MAX_STEPS } from '../../ai/ai.constants';
import {
  SystemBlock,
  ToolDef,
} from '../../ai/providers/llm-provider.interface';
import { InboxService } from '../../inbox/inbox.service';
import { InboxGateway } from '../../inbox/inbox.gateway';
import { SendMessageType } from '../../inbox/dto/send-message.dto';
import { normalizePhone } from '../../../common/utils/phone';
import { ShopifyService } from './shopify.service';

/** Label applied when the agent hands a chat to a human (mirrors BotsModule). */
const AI_HANDOFF_LABEL = 'needs-human';
/** Label applied to a conversation where the agent created an order. */
const AI_ORDER_LABEL = 'ai-order';
/** Sentinel the agent returns instead of a reply when it should hand off. */
const HANDOFF_TOKEN = '[[HANDOFF]]';

interface AgentJob {
  companyId: number;
  conversationId: number;
  messageId: number;
}

/** Per-message routing facts the orchestrator computes once (DB-derived). */
interface RouteCtx {
  /** This chat is eligible for fully-automated order creation. */
  autoOrderEligible: boolean;
  defaultCountryCode: string;
  /** Set when the AI is waiting for a prepaid payment slip (Rule 4). */
  awaitingPaymentAt: Date | null;
  /** WhatsApp type of the latest inbound message (slip = image/document). */
  latestInboundType: string | null;
  /** Set when the AI already closed this chat (further thanks → stay silent). */
  aiClosedAt: Date | null;
  /**
   * Mutated to true by create_order when a real order was placed (or already
   * exists) THIS turn. The post-run guard uses it to catch the model claiming
   * "order placed" without actually creating one.
   */
  orderConfirmed: boolean;
}

/** Window (ms) within which the SAME cart signature is treated as a mechanical
 *  duplicate (double "yes" / retry / two queued jobs) and NOT re-created. A
 *  different cart, or the same cart after this window with a fresh confirmation,
 *  is a legitimate reorder and DOES create a new order. */
const REORDER_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

/** A pending order-confirmation older than this is stale (re-summarise). */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

type AgentContext = Awaited<ReturnType<AiService['buildAgentContext']>>;

/**
 * MAIN orchestrator + specialist sub-agents (the unified conversational brain).
 *
 * For tenants where the agent is enabled (platform_settings
 * `ai_agent_company_ids`), every inbound auto-reply is handled here:
 *   1. The MAIN agent (`AiService.classifyIntent`) triages the message — one
 *      cheap, fast-tier, tool-less call — into a single specialist route.
 *   2. The matching SPECIALIST (sales / order / logistics / resolution /
 *      general) runs a bounded tool-calling loop with its OWN small prompt and
 *      its OWN restricted tool set, so each agent has one job and little room to
 *      hallucinate. Prices/stock/status/orders come ONLY from live Shopify
 *      tools — never computed or invented.
 *
 * Lives in ShopifyModule (which already has Shopify + Inbox + AI) and is reached
 * via the `ai-agent` job queue — no module import cycle. Bounded for shared
 * hosting: per message = 1 router call + 1 specialist loop (≤AI_AGENT_MAX_STEPS
 * tool calls), concurrency 2, never holding a DB connection across a model call.
 */
@Injectable()
export class AiAgentService implements OnModuleInit {
  private readonly logger = new Logger(AiAgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobQueue: JobQueueService,
    private readonly ai: AiService,
    private readonly rag: AiRagService,
    private readonly shopify: ShopifyService,
    private readonly inbox: InboxService,
    private readonly gateway: InboxGateway,
  ) {}

  onModuleInit(): void {
    this.jobQueue.registerWorker(
      'ai-agent',
      (p) => this.process(p as AgentJob),
      2,
    );
  }

  async enqueue(job: AgentJob): Promise<void> {
    try {
      await this.jobQueue.enqueue('ai-agent', job);
    } catch (e) {
      this.logger.warn(
        `ai-agent enqueue failed (convo ${job.conversationId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  // ── Orchestration ─────────────────────────────────────────────────────

  private async process(job: AgentJob): Promise<void> {
    let ctx: AgentContext;
    try {
      ctx = await this.ai.buildAgentContext(job.companyId, job.conversationId);
    } catch (e) {
      this.logger.warn(
        `ai-agent context load failed (convo ${job.conversationId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return;
    }

    // Nothing readable to answer (sticker / untranscribable voice note) → skip
    // silently, never mark needs-human.
    if (!ctx.hasCustomerText) return;

    const route = await this.loadRouteCtx(job, ctx);

    // ── Prepaid slip detection (Rule 4) ─────────────────────────────────
    // If we're waiting for a payment slip and the customer just sent an image /
    // document, treat it as the slip: acknowledge, then hand off to a human to
    // verify the payment and place the prepaid order. The AI never creates a
    // prepaid order itself.
    if (
      route.awaitingPaymentAt &&
      (route.latestInboundType === 'image' ||
        route.latestInboundType === 'document')
    ) {
      try {
        await this.inbox.sendMessage(job.companyId, job.conversationId, {
          type: SendMessageType.text,
          content:
            'Shukria! Aap ki payment verify kar ke order confirm kar diya ' +
            'jayega. Hamari team thori dair mein aap se raabta karegi.',
        });
      } catch {
        /* best-effort */
      }
      await this.clearAwaitingPayment(job.conversationId);
      await this.handoff(
        job.companyId,
        job.conversationId,
        'prepaid payment slip received → human verification',
      );
      return;
    }

    // ── MAIN agent: triage ──────────────────────────────────────────────
    let triage;
    try {
      triage = await this.ai.classifyIntent(job.companyId, ctx.transcript);
    } catch (e) {
      if (e instanceof ForbiddenException) return; // AI off / over cap → consume
      throw e; // genuine error → queue retry
    }

    // Immediate human handoff: explicit human request or an escalation topic
    // (anger/abuse/legal/medical/fraud) — no auto-reply.
    if (triage.intent === 'escalate' || triage.wantsHuman) {
      await this.handoff(
        job.companyId,
        job.conversationId,
        `triage → handoff (${triage.intent}${triage.wantsHuman ? ', wants human' : ''})`,
      );
      return;
    }

    // ── Closing / end-of-chat ───────────────────────────────────────────
    // The customer is signing off ("ok thanks", "kuch nahi chahiye"). Send ONE
    // short closing + resolve the chat; if we already closed it, stay SILENT so
    // repeated thanks don't loop.
    if (triage.intent === 'closing') {
      await this.handleClosing(job, ctx, route);
      return;
    }
    // A real request after a close → reopen the AI for this chat.
    if (route.aiClosedAt) await this.clearClosed(job.conversationId);

    // Route to the specialist. (No "order already exists → logistics" reroute:
    // that blocked genuine reorders. Duplicate safety lives in create_order's
    // signature + time-window guard instead.)
    const intent: AgentIntent = triage.intent;

    // Deterministic order backstop: for an order-eligible buy chat, the SYSTEM
    // (not the model) runs confirm-before-create from the structured draft, so an
    // order is reliably summarised + placed even if the model never calls the
    // create tool. Returns 'handled' when it already replied (summary / created /
    // prepaid), or 'collect' to let the order specialist ask for missing details
    // conversationally.
    if (intent === 'order' && route.autoOrderEligible) {
      const res = await this.runDeterministicOrder(job, ctx, route);
      if (res === 'handled') return;
    }

    // ── SPECIALIST: focused prompt + restricted tools ───────────────────
    const specialist = this.buildSpecialist(intent, ctx, route);
    this.logger.log(
      `ai-agent convo ${job.conversationId}: ${triage.intent} → ${specialist.name}`,
    );

    let text: string;
    try {
      const res = await this.ai.runAgent(
        job.companyId,
        'autoreply',
        ctx.tier,
        {
          system: specialist.system,
          userText: this.buildUserText(ctx),
          tools: specialist.tools,
          maxSteps: specialist.maxSteps,
          maxTokens: 700,
          temperature: 0.3,
        },
        (name, input) => this.executeTool(job, ctx, route, name, input),
      );
      text = res.text;
    } catch (e) {
      if (e instanceof ForbiddenException) return; // AI off / over cap → consume
      throw e; // genuine error → queue retry
    }

    if (!text || text.includes(HANDOFF_TOKEN)) {
      await this.handoff(
        job.companyId,
        job.conversationId,
        text ? `${specialist.name} requested handoff` : 'agent produced no reply',
      );
      return;
    }

    // No-fake-order guard: the model claimed the order is placed/confirmed but
    // create_order did NOT actually succeed this turn (it wasn't called, or
    // auto-order is off, or it was a prepaid that must go to a human). Never send
    // a false "placed" — hand off so a human completes it, with an honest note.
    if (!route.orderConfirmed && this.claimsOrderPlaced(text)) {
      this.logger.warn(
        `ai-agent convo ${job.conversationId}: blocked false "order placed" claim (no order created) → handoff`,
      );
      try {
        await this.inbox.sendMessage(job.companyId, job.conversationId, {
          type: SendMessageType.text,
          content:
            'Aap ke order ki tafseelat mil gayi hain. Hamari team thori dair ' +
            'mein aap ka order confirm kar degi. Shukria!',
        });
      } catch {
        /* best-effort */
      }
      await this.handoff(
        job.companyId,
        job.conversationId,
        'model claimed order placed without a real order',
      );
      return;
    }

    // Anti-repeat safety net: if this reply is essentially the same as the AI's
    // own last message, stay silent instead of looping (covers any residual
    // repeat, not just closings).
    if (await this.isLoopingReply(job, text)) {
      this.logger.log(
        `ai-agent convo ${job.conversationId}: suppressed near-duplicate reply`,
      );
      return;
    }

    try {
      await this.inbox.sendMessage(job.companyId, job.conversationId, {
        type: SendMessageType.text,
        content: text,
      });
    } catch (e) {
      this.logger.debug(
        `ai-agent send failed (convo ${job.conversationId}) → handoff: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      await this.handoff(job.companyId, job.conversationId, 'send failed');
    }
  }

  /** Resolve DB-derived routing facts (order existence + auto-order scope). */
  private async loadRouteCtx(
    job: AgentJob,
    ctx: AgentContext,
  ): Promise<RouteCtx> {
    const convo = await this.prisma.conversation.findFirst({
      where: { id: job.conversationId, company_id: job.companyId },
      select: {
        ai_autoreply: true,
        ai_awaiting_payment_at: true,
        ai_closed_at: true,
        company: {
          select: {
            ai_auto_order_enabled: true,
            ai_auto_order_all_enabled: true,
            ai_autoreply_enabled: true,
          },
        },
      },
    });

    // Auto-order eligibility mirrors AiAutoReplyService / AiAutoOrderService.
    const allChats = convo?.company?.ai_autoreply_enabled === true;
    const perChat = convo?.ai_autoreply;
    const effectiveAuto =
      perChat === false ? false : allChats || perChat === true;
    const scopeA = perChat === true;
    const scopeB =
      convo?.company?.ai_auto_order_all_enabled === true && effectiveAuto;
    const autoOrderEligible =
      convo?.company?.ai_auto_order_enabled === true && (scopeA || scopeB);

    // Latest inbound message type (slip detection when awaiting payment).
    const lastInbound = await this.prisma.message.findFirst({
      where: {
        conversation_id: job.conversationId,
        company_id: job.companyId,
        direction: 'inbound',
      },
      orderBy: { timestamp: 'desc' },
      select: { message_type: true },
    });

    return {
      autoOrderEligible,
      defaultCountryCode: (ctx.defaultCountryCode || 'PK').toUpperCase().slice(0, 2),
      awaitingPaymentAt: convo?.ai_awaiting_payment_at ?? null,
      latestInboundType: lastInbound?.message_type ?? null,
      aiClosedAt: convo?.ai_closed_at ?? null,
      orderConfirmed: false,
    };
  }

  private buildUserText(ctx: AgentContext): string {
    return (
      `${ctx.contactLine}\n\nConversation so far:\n${ctx.transcript}\n\n` +
      `Write the single next WhatsApp message to send the customer now. Use ` +
      `your tools to get accurate, live information before answering. If you ` +
      `genuinely should not handle this yourself, reply with EXACTLY ` +
      `${HANDOFF_TOKEN} and nothing else.`
    );
  }

  // ── Specialist definitions ────────────────────────────────────────────

  private buildSpecialist(
    intent: AgentIntent,
    ctx: AgentContext,
    route: RouteCtx,
  ): { name: string; system: SystemBlock[]; tools: ToolDef[]; maxSteps: number } {
    const T = this.toolDefs();
    switch (intent) {
      case 'sales':
        return {
          name: 'sales',
          system: this.systemFor(
            ctx,
            `You are the SALES adviser. Help the customer choose and learn about ` +
              `products. ALWAYS use search_products for any product, price, stock ` +
              `or variant question — quote ONLY the exact price the tool returns. ` +
              `When a customer names a product family, first list the matching ` +
              `product NAMES (not bundles). Offer bundles/multi-packs when they ` +
              `ask about a deal or discount. If a tool result has a discount, ` +
              `present it EXACTLY as "{price} after {discountPercent}% discount ` +
              `(original price {originalPrice})" — relay those numbers verbatim, ` +
              `never compute or invent a discount. Use search_knowledge for ` +
              `ingredients, usage, policies or FAQs. Recommend only products that ` +
              `genuinely match what they asked. If they decide to buy, start ` +
              `collecting order details (product, quantity, name, phone, full ` +
              `address, city, payment).`,
          ),
          tools: [T.search_products, T.search_knowledge, T.get_payment_details],
          maxSteps: AI_AGENT_MAX_STEPS,
        };

      case 'order': {
        const canCreate = route.autoOrderEligible;
        const orderRule = canCreate
          ? `Collect: product(s) + quantity (confirm exact item/price via ` +
            `search_products), recipient name, phone, FULL address, city, and ` +
            `payment method (COD or prepaid/bank).\n` +
            `• COD → restate the final order and, only after the customer clearly ` +
            `says yes (ok/haan/ji/confirm), you MUST actually CALL the create_order ` +
            `tool with payment "cod". Placing an order = calling that tool — there ` +
            `is no other way. NEVER write "order placed/confirmed/successful" ` +
            `unless the create_order tool has just returned success to you. If you ` +
            `have all the details and the customer confirmed, CALL create_order ` +
            `now instead of describing it.\n` +
            `• PREPAID / advance / bank transfer → you must NOT place the order. ` +
            `Call create_order with payment "prepaid": it will give you the bank ` +
            `details to share. Show the order summary + bank details, ask the ` +
            `customer to pay and SEND THE PAYMENT SLIP. Do NOT say the order is ` +
            `placed — a human verifies the slip and finalises it.\n` +
            `Use get_shipping_rates if they ask about delivery charges; ` +
            `get_payment_details if they ask for the account before ordering.`
          : `You CANNOT place the order yourself here. Help the customer choose ` +
            `the product (search_products for exact price/stock) and collect the ` +
            `delivery details (product, quantity, name, phone, full address, city, ` +
            `payment); a human will finalise the order.`;
        const tools = canCreate
          ? [
              T.search_products,
              T.get_customer_history,
              T.get_shipping_rates,
              T.get_payment_details,
              T.create_order,
            ]
          : [T.search_products, T.get_customer_history, T.get_payment_details];
        return {
          name: canCreate ? 'order' : 'order(collect)',
          system: this.systemFor(
            ctx,
            `You are the ORDER-TAKING agent. ${orderRule}\nOffer the customer's ` +
              `saved address with get_customer_history when helpful. Quote ONLY ` +
              `prices/discounts returned by your tools — never compute a total, ` +
              `saving or discount yourself.`,
          ),
          tools,
          maxSteps: AI_AGENT_MAX_STEPS,
        };
      }

      case 'logistics':
        return {
          name: 'logistics',
          system: this.systemFor(
            ctx,
            `You are the LOGISTICS / order-status agent. For "where is my order" ` +
              `questions: ask for the order number if you don't have it, then use ` +
              `get_order_status and report the REAL delivery status + tracking — ` +
              `never guess a status, date or tracking number. NEVER mention ` +
              `payment status or say "payment pending" — COD orders are unpaid by ` +
              `design and that must not alarm the customer. Use ` +
              `get_customer_history for "my last order". An order already placed ` +
              `must NOT be re-confirmed or re-created; just answer the question.`,
          ),
          tools: [T.get_order_status, T.get_customer_history],
          maxSteps: AI_AGENT_MAX_STEPS,
        };

      case 'resolution':
        return {
          name: 'resolution',
          system: this.systemFor(
            ctx,
            `You are the RESOLUTION agent for returns, refunds, exchanges, ` +
              `cancellations, wrong/damaged/missing items, billing disputes and ` +
              `complaints. You do NOT perform refunds, returns, cancellations or ` +
              `any money action yourself. You may look up the order with ` +
              `get_order_status to acknowledge the issue and gather the order ` +
              `number + reason. Once you understand the problem (or for anything ` +
              `requiring a money/policy decision), reply with EXACTLY ` +
              `${HANDOFF_TOKEN} so a human takes over. Be empathetic and brief.`,
          ),
          tools: [T.get_order_status, T.get_customer_history],
          maxSteps: 2,
        };

      case 'general':
      default:
        return {
          name: 'general',
          system: this.systemFor(
            ctx,
            `You are the front-desk agent. Greet warmly and find out what the ` +
              `customer needs. For business info, hours, shipping or policy ` +
              `questions use search_knowledge. A very short or punctuation-only ` +
              `message ("?", "ok", an emoji) is NOT a reason to hand off — ask a ` +
              `short, friendly clarifying question.`,
          ),
          tools: [T.search_knowledge],
          maxSteps: 2,
        };
    }
  }

  /** Shared system prompt: common guardrails + the specialist's role + language. */
  private systemFor(ctx: AgentContext, roleText: string): SystemBlock[] {
    const tone = ctx.brandTone ? ` Brand voice to match: ${ctx.brandTone}.` : '';
    return [
      {
        text:
          `You are the AI assistant for the store "${ctx.companyName}", replying ` +
          `to a customer on WhatsApp. You may reply WITHOUT human review. Be ` +
          `genuinely helpful, accurate, friendly and concise.\n` +
          `State ONLY prices and facts returned by your tools or the knowledge ` +
          `base; NEVER invent or compute a price. For a discount, relay the ` +
          `tool's numbers verbatim as "{price} after {percent}% discount (original ` +
          `price {original})" — never calculate or invent one.\n` +
          `NEVER tell the customer an order is placed / received / confirmed ` +
          `unless the create_order tool actually returned success in THIS turn. Do ` +
          `not invent an order number, total, or tracking.\n` +
          `Do NOT repeat greetings, your name, or information already sent — the ` +
          `customer can see the whole chat; add only what is new and keep it ` +
          `short.\n` +
          `LANGUAGE: English or Urdu/Roman-Urdu ONLY. NEVER use Hindi or Roman ` +
          `Hindi (forbidden: dhanyavaad, kripya, namaste, prapt, uplabdh, etc.) — ` +
          `use Urdu (shukria, baraye meharbani) or English instead.\n\n` +
          `YOUR ROLE: ${roleText}${tone}`,
      },
      { text: `Language & script rule (follow exactly):\n${ctx.langRule}` },
    ];
  }

  // ── Tools ─────────────────────────────────────────────────────────────

  private toolDefs(): Record<string, ToolDef> {
    return {
      search_products: {
        name: 'search_products',
        description:
          'Search the store catalogue for products matching the customer query. ' +
          'Returns live product titles, variants, EXACT current prices, and stock. ' +
          'Use this for any product/price/stock question — never guess a price.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'What the customer is asking about, e.g. "vitamin c serum"',
            },
          },
          required: ['query'],
        },
      },
      get_order_status: {
        name: 'get_order_status',
        description:
          "Look up an existing order's real delivery status and tracking by its " +
          'order number. Use when the customer asks where their order is.',
        inputSchema: {
          type: 'object',
          properties: {
            order_number: {
              type: 'string',
              description: 'The order number digits, e.g. "1234"',
            },
          },
          required: ['order_number'],
        },
      },
      get_customer_history: {
        name: 'get_customer_history',
        description:
          "Get this customer's saved delivery address and recent orders (by their " +
          'WhatsApp number). Use to offer their usual address or answer "my last order".',
        inputSchema: { type: 'object', properties: {} },
      },
      search_knowledge: {
        name: 'search_knowledge',
        description:
          'Search the store knowledge base (shipping, returns, FAQ, policies, ' +
          'product details). Use for policy/FAQ questions.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The policy/FAQ topic to look up' },
          },
          required: ['query'],
        },
      },
      get_shipping_rates: {
        name: 'get_shipping_rates',
        description:
          'Get the live delivery/shipping charges for a cart to a destination. ' +
          'Use when the customer asks about delivery cost before ordering.',
        inputSchema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              description: 'Cart items',
              items: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: 'Product name to look up' },
                  quantity: { type: 'number' },
                },
                required: ['query', 'quantity'],
              },
            },
            city: { type: 'string' },
            address1: { type: 'string' },
            country_code: { type: 'string', description: 'ISO-2, e.g. "PK"' },
          },
          required: ['items', 'city'],
        },
      },
      get_payment_details: {
        name: 'get_payment_details',
        description:
          'Get the store bank/account details to share for a prepaid/advance ' +
          'payment (from the knowledge base). Use when the customer wants to pay ' +
          'in advance / by bank transfer and needs the account.',
        inputSchema: { type: 'object', properties: {} },
      },
      create_order: {
        name: 'create_order',
        description:
          'Finalise the order. For payment "cod" it creates a real COD order. For ' +
          'payment "prepaid" it does NOT create an order — it returns the bank ' +
          'details to share so the customer can pay and send a slip (a human then ' +
          'verifies and places it). Call ONLY after the customer confirmed the ' +
          'exact items + quantities and gave name, phone, full address and city.',
        inputSchema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description: 'Product name exactly as discussed (will be searched)',
                  },
                  quantity: { type: 'number' },
                },
                required: ['query', 'quantity'],
              },
            },
            name: { type: 'string', description: 'Recipient full name' },
            phone: { type: 'string', description: 'Delivery contact number' },
            address1: { type: 'string', description: 'Full street address' },
            city: { type: 'string' },
            country_code: { type: 'string', description: 'ISO-2, e.g. "PK"' },
            payment: { type: 'string', description: '"cod" or "prepaid"' },
            note: { type: 'string', description: 'Optional order note' },
          },
          required: ['items', 'name', 'phone', 'address1', 'city', 'payment'],
        },
      },
    };
  }

  /** Execute a tool call against live Shopify / RAG data. Returns a string. */
  private async executeTool(
    job: AgentJob,
    ctx: AgentContext,
    route: RouteCtx,
    name: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
    try {
      if (name === 'search_products') {
        const hits = await this.shopify.searchProducts(
          job.companyId,
          str(input.query),
        );
        if (!hits.length) return 'No matching products found.';
        return JSON.stringify(
          hits.slice(0, 10).map((h) => ({
            product: h.productTitle,
            variant: h.variantTitle || undefined,
            price: h.price,
            // Real discount straight from the store (server-computed % — relay
            // verbatim, never recompute). Present as "{price} after {pct}%
            // discount (original price {originalPrice})".
            discountPercent: h.discountPercent ?? undefined,
            originalPrice: h.compareAtPrice ?? undefined,
            inStock: h.available,
            url: h.productUrl || undefined,
          })),
        );
      }
      if (name === 'get_order_status') {
        const st = await this.shopify.getOrderStatus(
          job.companyId,
          str(input.order_number),
        );
        if (st.error) return 'Could not look up the order (lookup unavailable).';
        if (!st.found) return 'No order found with that number.';
        // Delivery status + tracking ONLY — never the financial/payment status
        // (COD orders are "unpaid"/"pending" by design and must not alarm).
        return JSON.stringify({
          order: st.name,
          deliveryStatus: this.humanizeFulfillment(st.fulfillmentStatus),
          tracking: (st.tracking ?? [])
            .map((t) => [t.company, t.number, t.url].filter(Boolean).join(' '))
            .filter(Boolean),
        });
      }
      if (name === 'get_customer_history') {
        if (!ctx.contactPhone) return 'No phone number on file for this customer.';
        const c = await this.shopify.getCustomerOrders(
          job.companyId,
          ctx.contactPhone,
        );
        if (!c.found) return 'No previous customer record found.';
        return JSON.stringify({
          name: c.name,
          savedAddress: c.defaultAddress,
          recentOrders: c.orders.map((o) => ({
            order: o.name,
            date: o.createdAt,
            fulfillment: o.fulfillment,
            payment: o.financial,
            total: o.total,
          })),
        });
      }
      if (name === 'search_knowledge') {
        const k = await this.rag.retrieve(job.companyId, str(input.query));
        return k && k.trim() ? k : 'No matching policy or FAQ found.';
      }
      if (name === 'get_payment_details') {
        const bank = await this.fetchPaymentDetails(job.companyId);
        return bank ?? 'No bank/payment details are configured. Hand off to a human.';
      }
      if (name === 'get_shipping_rates') {
        return this.toolShippingRates(job, route, input);
      }
      if (name === 'create_order') {
        return this.toolCreateOrder(job, ctx, route, input);
      }
    } catch (e) {
      return `Tool error: ${e instanceof Error ? e.message : String(e)}`;
    }
    return 'Unknown tool.';
  }

  /** Resolve each {query,quantity} item to its top store variant. */
  private async resolveLineItems(
    companyId: number,
    rawItems: unknown,
  ): Promise<Array<{ variantId: string; quantity: number }>> {
    const items = Array.isArray(rawItems) ? rawItems : [];
    const out: Array<{ variantId: string; quantity: number }> = [];
    for (const it of items) {
      const r = (it ?? {}) as Record<string, unknown>;
      const query = typeof r.query === 'string' ? r.query.trim() : '';
      const q = Number(r.quantity);
      const quantity = Number.isFinite(q) && q > 0 ? Math.floor(q) : 1;
      if (!query) continue;
      try {
        const hits = await this.shopify.searchProducts(companyId, query);
        if (hits[0]) out.push({ variantId: hits[0].variantId, quantity });
      } catch {
        /* skip unresolved product */
      }
    }
    return out;
  }

  private async toolShippingRates(
    job: AgentJob,
    route: RouteCtx,
    input: Record<string, unknown>,
  ): Promise<string> {
    const lineItems = await this.resolveLineItems(job.companyId, input.items);
    if (!lineItems.length) return 'Could not match those products to quote shipping.';
    const country =
      (typeof input.country_code === 'string' && input.country_code.trim()) ||
      route.defaultCountryCode;
    const rates = await this.shopify.getShippingRates(job.companyId, {
      lineItems,
      address1: typeof input.address1 === 'string' ? input.address1 : undefined,
      city: typeof input.city === 'string' ? input.city : undefined,
      countryCode: country.toUpperCase().slice(0, 2),
    });
    if (!Array.isArray(rates) || !rates.length) {
      return 'No shipping rates configured for that destination.';
    }
    return JSON.stringify(
      rates.map((r) => ({ title: r.title, amount: r.amount, currency: r.currencyCode })),
    );
  }

  /**
   * Finalise an order. COD → create a real Shopify order (reorder-safe duplicate
   * guard). PREPAID → never create here (Rule 4): return the bank details to
   * share + set the awaiting-payment flag so the slip → human handoff. Returns a
   * string telling the agent what to say next.
   */
  private async toolCreateOrder(
    job: AgentJob,
    ctx: AgentContext,
    route: RouteCtx,
    input: Record<string, unknown>,
  ): Promise<string> {
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
    if (!route.autoOrderEligible) {
      return 'Order creation is not enabled for this chat. Collect the details; a human will place the order.';
    }

    const name = str(input.name) || ctx.contactName || '';
    const phoneRaw = str(input.phone) || ctx.contactPhone || '';
    const address1 = str(input.address1);
    const city = str(input.city);
    const country = (str(input.country_code) || route.defaultCountryCode)
      .toUpperCase()
      .slice(0, 2);
    const payment = input.payment === 'prepaid' ? 'prepaid' : 'cod';
    const note = str(input.note) || undefined;

    const missing: string[] = [];
    if (!Array.isArray(input.items) || !input.items.length) missing.push('product');
    if (!name) missing.push('name');
    if (!phoneRaw) missing.push('phone');
    if (!address1) missing.push('full address');
    if (!city) missing.push('city');
    if (missing.length) {
      return `Cannot finalise the order yet — still missing: ${missing.join(
        ', ',
      )}. Ask the customer for these first.`;
    }

    const lineItems = await this.resolveLineItems(job.companyId, input.items);
    if (!lineItems.length) {
      return 'None of the requested products could be found in the store. Ask the customer to clarify the product name.';
    }

    // ── PREPAID (Rule 4): NEVER create an order. Share bank details + await slip.
    if (payment === 'prepaid') {
      const bank = await this.fetchPaymentDetails(job.companyId);
      await this.setAwaitingPayment(job.conversationId);
      return (
        `PREPAID — DO NOT create an order and DO NOT say it is placed. Show the ` +
        `customer their order summary, then share these bank details and ask them ` +
        `to pay and SEND THE PAYMENT SLIP. A human will verify and finalise it.\n` +
        `Bank details:\n${bank ?? '(no bank details configured — tell them a human will share the account shortly and hand off)'}`
      );
    }

    // ── COD: reorder-safe create via the shared placer. ──────────────────
    const phone = normalizePhone(phoneRaw, country);
    const r = await this.placeCodOrder(job, route, {
      lineItems,
      name,
      phone,
      address1,
      city,
      country,
      note,
    });
    if (r.status === 'duplicate') {
      return 'This exact order was just placed moments ago — do NOT create a duplicate. Tell the customer their order is already placed.';
    }
    if (r.status === 'failed') {
      return (
        `Order creation failed (${r.error}). Reply with EXACTLY ${HANDOFF_TOKEN} ` +
        `so a human can complete the order.`
      );
    }
    return (
      `ORDER CREATED SUCCESSFULLY: ${r.orderName} (Cash on Delivery). Now write ` +
      `the customer a short, warm confirmation in their language telling them ` +
      `their order ${r.orderName} is placed and the team will follow up. Do NOT ` +
      `mention any price or total.`
    );
  }

  /**
   * Shared COD order placer (used by the create_order tool AND the deterministic
   * backstop). Reorder-safe: an atomic claim blocks only the SAME cart within a
   * short window (mechanical duplicate); a different cart / later reorder passes.
   * Sets route.orderConfirmed on success or duplicate. Never throws.
   */
  private async placeCodOrder(
    job: AgentJob,
    route: RouteCtx,
    f: {
      lineItems: Array<{ variantId: string; quantity: number }>;
      name: string;
      phone: string;
      address1: string;
      city: string;
      country: string;
      note?: string;
    },
  ): Promise<{ status: 'created' | 'duplicate' | 'failed'; orderName?: string; error?: string }> {
    const signature = this.cartSignature(f.lineItems);
    const cutoff = new Date(Date.now() - REORDER_DUPLICATE_WINDOW_MS);
    const claim = await this.prisma.conversation.updateMany({
      where: {
        id: job.conversationId,
        company_id: job.companyId,
        NOT: {
          ai_last_order_signature: signature,
          ai_order_created_at: { gt: cutoff },
        },
      },
      data: {
        ai_order_created_at: new Date(),
        ai_last_order_signature: signature,
        ai_pending_order: Prisma.DbNull,
        ai_pending_order_at: null,
      },
    });
    if (claim.count === 0) {
      route.orderConfirmed = true;
      return { status: 'duplicate' };
    }

    let shippingLine: { title: string; price: number } | undefined;
    try {
      const rates = await this.shopify.getShippingRates(job.companyId, {
        lineItems: f.lineItems,
        address1: f.address1,
        city: f.city,
        countryCode: f.country,
      });
      const r0 = Array.isArray(rates) ? rates[0] : undefined;
      if (r0) shippingLine = { title: r0.title, price: parseFloat(r0.amount) || 0 };
    } catch (e) {
      this.logger.warn(
        `agent order shipping-rate lookup failed (convo ${job.conversationId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    try {
      const order = await this.shopify.createOrder(job.companyId, {
        lineItems: f.lineItems,
        customerName: f.name,
        phone: f.phone,
        address1: f.address1,
        city: f.city,
        countryCode: f.country,
        note: f.note,
        tags: ['CodesApp', 'AI auto-order'],
        prepaid: false,
        shippingLine,
      });
      route.orderConfirmed = true;
      await this.label(job.companyId, job.conversationId, AI_ORDER_LABEL);
      this.logger.log(
        `AI agent created COD Shopify order ${order.orderName} for conversation ${job.conversationId}`,
      );
      return { status: 'created', orderName: order.orderName };
    } catch (e) {
      await this.prisma.conversation
        .updateMany({
          where: { id: job.conversationId, company_id: job.companyId },
          data: { ai_order_created_at: null, ai_last_order_signature: null },
        })
        .catch(() => undefined);
      return {
        status: 'failed',
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /** Stable signature of a resolved cart (variant + qty) for duplicate detection. */
  private cartSignature(
    items: Array<{ variantId: string; quantity: number }>,
  ): string {
    return items
      .map((i) => `${i.variantId}x${i.quantity}`)
      .sort()
      .join(';');
  }

  // ── Deterministic order backstop ──────────────────────────────────────

  /**
   * System-driven confirm-before-create from the structured draft, so an order
   * is reliably summarised + placed without depending on the model to call the
   * tool. COD → summary then create on a clear yes; PREPAID → summary + bank
   * details + await slip (Rule 4); incomplete / unconfirmed / detour → 'collect'
   * so the order specialist asks conversationally (pending kept). Never throws.
   */
  private async runDeterministicOrder(
    job: AgentJob,
    ctx: AgentContext,
    route: RouteCtx,
  ): Promise<'handled' | 'collect'> {
    let draft: DraftOrderResult;
    try {
      draft = await this.ai.draftOrder(job.companyId, null, job.conversationId);
    } catch {
      return 'collect'; // extraction unavailable → let the specialist handle it
    }
    if (draft.intent !== 'place_order') return 'collect';

    const convo = await this.prisma.conversation.findFirst({
      where: { id: job.conversationId, company_id: job.companyId },
      select: {
        ai_pending_order: true,
        ai_pending_order_at: true,
        contact: { select: { name: true, phone: true } },
      },
    });

    const country = (draft.customer.countryCode || route.defaultCountryCode || 'PK')
      .toUpperCase()
      .slice(0, 2);
    const name = (draft.customer.name || convo?.contact?.name || '').trim();
    const phoneRaw = (draft.customer.phone || convo?.contact?.phone || '').trim();
    const address1 = (draft.customer.address1 || '').trim();
    const city = (draft.customer.city || '').trim();
    const complete =
      draft.items.length > 0 && !!name && !!phoneRaw && !!address1 && !!city;
    const payment: 'cod' | 'prepaid' | null =
      draft.paymentMethod === 'prepaid'
        ? 'prepaid'
        : draft.paymentMethod === 'cod'
          ? 'cod'
          : null;

    // Missing details, or payment method not yet stated → let the specialist ask.
    if (!complete || payment === null) return 'collect';

    // PREPAID (Rule 4): never create — summary + bank details + await the slip.
    if (payment === 'prepaid') {
      const bank = await this.fetchPaymentDetails(job.companyId);
      const summary = await this.safeComposeSummary(
        job,
        draft,
        name,
        phoneRaw,
        address1,
        city,
        'prepaid',
      );
      await this.setAwaitingPayment(job.conversationId);
      await this.send(
        job,
        `${summary}\n\n${bank ? `${bank}\n\n` : ''}Baraye meharbani payment kar ke ` +
          `slip yahan bhej dein — hum verify kar ke order confirm kar denge.`,
      );
      return 'handled';
    }

    // COD confirm-before-create.
    const pendingFresh =
      !!convo?.ai_pending_order_at &&
      Date.now() - new Date(convo.ai_pending_order_at).getTime() < PENDING_TTL_MS;
    const draftSig = this.draftCartSignature(
      draft.items.map((i) => ({ productQuery: i.productQuery, quantity: i.quantity })),
    );

    if (!pendingFresh) {
      await this.storePending(job, draft);
      await this.send(
        job,
        await this.safeComposeSummary(job, draft, name, phoneRaw, address1, city, 'cod'),
      );
      return 'handled';
    }

    // Cart changed since the summary (upsell / different pack) → re-summarise.
    const pendingItems = this.parsePendingItems(convo?.ai_pending_order);
    if (this.draftCartSignature(pendingItems) !== draftSig) {
      await this.storePending(job, draft);
      await this.send(
        job,
        await this.safeComposeSummary(job, draft, name, phoneRaw, address1, city, 'cod'),
      );
      return 'handled';
    }

    // Need an explicit affirmation of the summary to create.
    const latest = await this.latestInboundText(job);
    const affirmed = draft.readyToCreate || this.isOrderAffirmation(latest);
    if (!affirmed) return 'collect'; // a detour/question → specialist answers, pending kept

    const lineItems = await this.resolveLineItems(
      job.companyId,
      draft.items.map((i) => ({ query: i.productQuery, quantity: i.quantity })),
    );
    if (!lineItems.length) {
      await this.handoff(
        job.companyId,
        job.conversationId,
        'order confirmed but products did not resolve',
      );
      return 'handled';
    }
    const phone = normalizePhone(phoneRaw, country);
    const r = await this.placeCodOrder(job, route, {
      lineItems,
      name,
      phone,
      address1,
      city,
      country,
      note: draft.note || undefined,
    });
    if (r.status === 'failed') {
      await this.handoff(
        job.companyId,
        job.conversationId,
        `deterministic order create failed: ${r.error}`,
      );
      return 'handled';
    }
    await this.send(
      job,
      `✅ Aap ka order ${r.orderName ?? ''} place ho gaya hai (Cash on Delivery). ` +
        `Shukria! Hamari team raabta karegi.`,
    );
    return 'handled';
  }

  /** Best-effort send (never throws — 24h window etc.). */
  private async send(job: AgentJob, content: string): Promise<void> {
    try {
      await this.inbox.sendMessage(job.companyId, job.conversationId, {
        type: SendMessageType.text,
        content,
      });
    } catch (e) {
      this.logger.warn(
        `ai-agent send failed (convo ${job.conversationId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /** Order-confirmation summary in the customer's language (AI), with a
   *  deterministic English fallback. Numbers/items/address never change. */
  private async safeComposeSummary(
    job: AgentJob,
    draft: DraftOrderResult,
    name: string,
    phone: string,
    address1: string,
    city: string,
    payment: 'cod' | 'prepaid',
  ): Promise<string> {
    try {
      const { text } = await this.ai.composeOrderConfirmation(
        job.companyId,
        job.conversationId,
        {
          items: draft.items.map((i) => ({ quantity: i.quantity, title: i.productQuery })),
          name,
          phone,
          address1,
          city,
          payment,
        },
      );
      if (text && text.trim()) return text.trim();
    } catch {
      /* fall through */
    }
    const items = draft.items.map((i) => `• ${i.quantity} × ${i.productQuery}`).join('\n');
    return (
      `📋 Please confirm your order:\n\n${items}\n\n` +
      `Name: ${name}\nPhone: ${phone}\nAddress: ${address1}, ${city}\n` +
      `Payment: ${payment === 'prepaid' ? 'Prepaid' : 'Cash on Delivery'}\n\n` +
      `Reply YES to confirm.`
    );
  }

  private async storePending(job: AgentJob, draft: DraftOrderResult): Promise<void> {
    await this.prisma.conversation
      .update({
        where: { id: job.conversationId },
        data: {
          ai_pending_order: draft as unknown as Prisma.InputJsonValue,
          ai_pending_order_at: new Date(),
        },
      })
      .catch(() => undefined);
  }

  private parsePendingItems(
    pending: unknown,
  ): Array<{ productQuery: string; quantity: number }> {
    const raw = (pending as { items?: unknown })?.items;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((it) => {
        const r = (it ?? {}) as Record<string, unknown>;
        const q = Number(r.quantity);
        return {
          productQuery: typeof r.productQuery === 'string' ? r.productQuery : '',
          quantity: Number.isFinite(q) && q > 0 ? Math.floor(q) : 1,
        };
      })
      .filter((i) => i.productQuery.length > 0);
  }

  private draftCartSignature(
    items: Array<{ productQuery: string; quantity: number }>,
  ): string {
    return items
      .map((i) => `${(i.productQuery || '').trim().toLowerCase()}|${i.quantity}`)
      .sort()
      .join(';');
  }

  private async latestInboundText(job: AgentJob): Promise<string> {
    const m = await this.prisma.message.findFirst({
      where: {
        conversation_id: job.conversationId,
        company_id: job.companyId,
        direction: 'inbound',
      },
      orderBy: { timestamp: 'desc' },
      select: { content: true, transcription: true },
    });
    return (m?.content?.trim() || m?.transcription?.trim() || '').slice(0, 200);
  }

  /** Plain colloquial affirmation in English / Roman-Urdu (ok/haan/ji/theek…). */
  private isOrderAffirmation(text: string): boolean {
    const t = (text || '').trim().toLowerCase();
    if (!t || t.length > 40) return false;
    if (/^(g|ji|jee|ok|okay|k|haan|han|hn|yes|yep|yup|👍|✅|✓)$/i.test(t)) return true;
    return /(^|\s|,)(yes|yep|yeah|yup|ok|okay|done|confirm|confirmed|sure|haan|han|ji|jee|theek|thik|sahi|pakka|order\s?kar\s?do|order\s?kardo|kar\s?do|kardo|kr\s?do|krdo|place\s?order)(\s|$|!|\.|,|👍|✅)/i.test(
      t,
    );
  }

  /** Friendly delivery status from Shopify's displayFulfillmentStatus. */
  private humanizeFulfillment(s?: string): string {
    const v = (s ?? '').toUpperCase();
    switch (v) {
      case 'FULFILLED':
        return 'dispatched';
      case 'IN_TRANSIT':
        return 'in transit';
      case 'OUT_FOR_DELIVERY':
        return 'out for delivery';
      case 'DELIVERED':
        return 'delivered';
      case 'ATTEMPTED_DELIVERY':
        return 'delivery attempted';
      case 'PARTIALLY_FULFILLED':
        return 'partially dispatched';
      case 'UNFULFILLED':
      case '':
        return 'not dispatched yet';
      default:
        return v.replace(/_/g, ' ').toLowerCase();
    }
  }

  /** Bank/payment details for prepaid, from the tenant KB (RAG). Null if none. */
  private async fetchPaymentDetails(companyId: number): Promise<string | null> {
    try {
      const k = await this.rag.retrieve(
        companyId,
        'bank account details for advance prepaid payment IBAN account title',
      );
      return k && k.trim() ? k.trim() : null;
    } catch {
      return null;
    }
  }

  private async setAwaitingPayment(conversationId: number): Promise<void> {
    await this.prisma.conversation
      .update({
        where: { id: conversationId },
        data: { ai_awaiting_payment_at: new Date() },
      })
      .catch(() => undefined);
  }

  private async clearAwaitingPayment(conversationId: number): Promise<void> {
    await this.prisma.conversation
      .update({
        where: { id: conversationId },
        data: { ai_awaiting_payment_at: null },
      })
      .catch(() => undefined);
  }

  // ── Closing / anti-repeat ─────────────────────────────────────────────

  /**
   * Customer is ending the chat. If we haven't closed it yet, send ONE short
   * language-matched sign-off and resolve the conversation; if we already
   * closed it, stay silent (no loop on repeated thanks).
   */
  private async handleClosing(
    job: AgentJob,
    ctx: AgentContext,
    route: RouteCtx,
  ): Promise<void> {
    if (route.aiClosedAt) return; // already closed → silent

    let text = '';
    try {
      const res = await this.ai.runAgent(
        job.companyId,
        'autoreply',
        ctx.tier,
        {
          system: this.systemFor(
            ctx,
            `The customer is ENDING the conversation (a thank-you / sign-off; ` +
              `nothing more is needed). Reply with ONE short, warm closing in ` +
              `their language — a brief thanks / you're welcome. Do NOT ask a ` +
              `question, do NOT offer further help, do NOT mention any order or ` +
              `product. One short sentence only.`,
          ),
          userText: this.buildUserText(ctx),
          tools: [],
          maxSteps: 1,
          maxTokens: 80,
          temperature: 0.4,
        },
        async () => 'Unknown tool.',
      );
      text = res.text;
    } catch (e) {
      if (!(e instanceof ForbiddenException)) {
        this.logger.warn(
          `ai-agent closing reply failed (convo ${job.conversationId}): ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      // Close silently even if the reply couldn't be generated.
      await this.closeConversation(job);
      return;
    }

    if (text && !text.includes(HANDOFF_TOKEN)) {
      try {
        await this.inbox.sendMessage(job.companyId, job.conversationId, {
          type: SendMessageType.text,
          content: text,
        });
      } catch {
        /* 24h window closed etc. — still resolve below */
      }
    }
    await this.closeConversation(job);
  }

  /** Stamp ai_closed_at + resolve the conversation; push it live to the inbox. */
  private async closeConversation(job: AgentJob): Promise<void> {
    await this.prisma.conversation
      .update({
        where: { id: job.conversationId },
        data: { ai_closed_at: new Date(), status: 'resolved' },
      })
      .catch(() => undefined);
    this.gateway.emitToCompany(job.companyId, 'conversation.updated', {
      conversationId: job.conversationId,
    });
  }

  /** Clear the closed marker when the customer makes a real new request. */
  private async clearClosed(conversationId: number): Promise<void> {
    await this.prisma.conversation
      .update({ where: { id: conversationId }, data: { ai_closed_at: null } })
      .catch(() => undefined);
  }

  /**
   * Whether `text` is essentially the same as the AI's own last outbound
   * message (token Jaccard ≥ 0.85). Guards against repeat loops. Only applies to
   * messages of ≥5 words so short replies aren't over-suppressed.
   */
  private async isLoopingReply(job: AgentJob, text: string): Promise<boolean> {
    const cur = this.tokenize(text);
    if (cur.size < 5) return false;
    const last = await this.prisma.message.findFirst({
      where: {
        conversation_id: job.conversationId,
        company_id: job.companyId,
        direction: 'outbound',
      },
      orderBy: { timestamp: 'desc' },
      select: { content: true },
    });
    if (!last?.content) return false;
    const prev = this.tokenize(last.content);
    if (prev.size < 5) return false;
    let inter = 0;
    for (const w of cur) if (prev.has(w)) inter++;
    const union = cur.size + prev.size - inter;
    return union > 0 && inter / union >= 0.85;
  }

  /**
   * Heuristic: does the reply CLAIM the order is placed/created/confirmed? Used
   * only to catch a false claim when no order was actually created (English +
   * Roman-Urdu). Deliberately conservative — "place your order please" must NOT
   * match; only completed-action phrasing.
   */
  private claimsOrderPlaced(text: string): boolean {
    const t = (text || '').toLowerCase();
    return (
      /(placed successfully|successfully placed|has been placed|been placed successfully|order (is|has been) (placed|created|confirmed))/i.test(
        t,
      ) ||
      /(order .{0,30}(place ho (gaya|gya|gai|chuka|chuki)|ban gaya|ban gya|bana diya|ban diya|create ho gaya|confirm ho (gaya|gya|chuka)))/i.test(
        t,
      ) ||
      /(aap ka|apka) order .{0,30}(place|ban|create|confirm)/i.test(t)
    );
  }

  private tokenize(s: string): Set<string> {
    return new Set(
      (s || '')
        .toLowerCase()
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean),
    );
  }

  // ── Handoff / labels ──────────────────────────────────────────────────

  /** Flag for a human: pending status + mute auto-pilot + needs-human label. */
  private async handoff(
    companyId: number,
    conversationId: number,
    reason: string,
  ): Promise<void> {
    try {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { status: 'pending', ai_autoreply: false },
      });
      await this.label(companyId, conversationId, AI_HANDOFF_LABEL);
      this.logger.log(
        `AI agent handoff for conversation ${conversationId}: ${reason}`,
      );
    } catch (e) {
      this.logger.warn(
        `ai-agent handoff failed (convo ${conversationId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  private async label(
    companyId: number,
    conversationId: number,
    label: string,
  ): Promise<void> {
    await this.prisma.conversationLabel
      .upsert({
        where: {
          conversation_id_label: { conversation_id: conversationId, label },
        },
        create: { company_id: companyId, conversation_id: conversationId, label },
        update: {},
      })
      .catch(() => undefined);
    this.gateway.emitToCompany(companyId, 'conversation.updated', {
      conversationId,
      addedLabel: label,
    });
  }
}
