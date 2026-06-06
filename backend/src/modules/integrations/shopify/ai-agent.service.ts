import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { JobQueueService } from '../../../common/services/job-queue.service';
import { AiService } from '../../ai/ai.service';
import { AiRagService } from '../../ai/ai-rag.service';
import { AI_AGENT_MAX_STEPS } from '../../ai/ai.constants';
import {
  SystemBlock,
  ToolDef,
} from '../../ai/providers/llm-provider.interface';
import { InboxService } from '../../inbox/inbox.service';
import { InboxGateway } from '../../inbox/inbox.gateway';
import { SendMessageType } from '../../inbox/dto/send-message.dto';
import { ShopifyService } from './shopify.service';

/** Label applied when the agent hands a chat to a human (mirrors BotsModule). */
const AI_HANDOFF_LABEL = 'needs-human';
/** Sentinel the agent returns instead of a reply when it should hand off. */
const HANDOFF_TOKEN = '[[HANDOFF]]';

interface AgentJob {
  companyId: number;
  conversationId: number;
  messageId: number;
}

/**
 * Phase 2 — tool-calling AI agent (the unified conversational brain). Replaces
 * the free-form `autoReplyDecision` path for tenants where it's enabled
 * (platform_settings `ai_agent_company_ids`). It answers the customer using LIVE
 * Shopify data (products/price/stock, order status, customer history) + the RAG
 * knowledge base, so prices are never stale or invented. Lives in ShopifyModule
 * (which already has Shopify + Inbox + AI) and is reached via the `ai-agent` job
 * queue — no module import cycle.
 *
 * Scope (first cut): the agent CONVERSES + looks things up. Order CREATION still
 * runs through the hardened AiAutoOrderService confirm-before-create pipeline,
 * which falls back here for questions/detours. Bounded for shared hosting
 * (concurrency 2, ≤AI_AGENT_MAX_STEPS tool calls per message).
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

  private tools(): ToolDef[] {
    return [
      {
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
      {
        name: 'get_order_status',
        description:
          "Look up an existing order's real status, payment and tracking by its " +
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
      {
        name: 'get_customer_history',
        description:
          "Get this customer's saved delivery address and recent orders (by their " +
          'WhatsApp number). Use to offer their usual address or answer "my last order".',
        inputSchema: { type: 'object', properties: {} },
      },
      {
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
    ];
  }

  private async process(job: AgentJob): Promise<void> {
    let ctx: Awaited<ReturnType<AiService['buildAgentContext']>>;
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

    const system = this.buildSystem(ctx);
    const userText =
      `${ctx.contactLine}\n\nConversation so far:\n${ctx.transcript}\n\n` +
      `Write the single next WhatsApp message to send the customer now. Use ` +
      `your tools to get accurate, live information before answering. If you ` +
      `genuinely should not handle this yourself (refund/return/cancellation of ` +
      `an existing order, complaint, payment dispute, the customer asks for a ` +
      `human, or anything sensitive), reply with EXACTLY ${HANDOFF_TOKEN} and ` +
      `nothing else.`;

    let text: string;
    try {
      const res = await this.ai.runAgent(
        job.companyId,
        'autoreply',
        ctx.tier,
        {
          system,
          userText,
          tools: this.tools(),
          maxSteps: AI_AGENT_MAX_STEPS,
          maxTokens: 700,
          temperature: 0.3,
        },
        (name, input) => this.executeTool(job, ctx, name, input),
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
        text ? 'agent requested handoff' : 'agent produced no reply',
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

  /** Execute a tool call against live Shopify / RAG data. Returns a string. */
  private async executeTool(
    job: AgentJob,
    ctx: Awaited<ReturnType<AiService['buildAgentContext']>>,
    name: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
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
        return JSON.stringify({
          order: st.name,
          fulfillment: st.fulfillmentStatus,
          payment: st.financialStatus,
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
    } catch (e) {
      return `Tool error: ${e instanceof Error ? e.message : String(e)}`;
    }
    return 'Unknown tool.';
  }

  private buildSystem(
    ctx: Awaited<ReturnType<AiService['buildAgentContext']>>,
  ): SystemBlock[] {
    const tone = ctx.brandTone ? ` Brand voice to match: ${ctx.brandTone}.` : '';
    const orderRule = ctx.autoOrderEnabled
      ? `An automated order system handles order confirmations + placement. Do ` +
        `NOT ask "shall I confirm your order?", write an order summary, or tell ` +
        `the customer to reply YES — for a buyer, only answer their questions and ` +
        `help collect missing details (product, quantity, name, phone, full ` +
        `address, city, payment); the system takes over the confirmation.\n`
      : '';
    return [
      {
        text:
          `You are the AI assistant for the store "${ctx.companyName}", replying ` +
          `to a customer on WhatsApp. Be genuinely helpful, accurate, friendly ` +
          `and concise. You may reply WITHOUT human review.\n` +
          `USE YOUR TOOLS for any product, price, stock, order-status or ` +
          `customer-history question — get the real data first. State ONLY prices ` +
          `and facts returned by the tools or the knowledge base; NEVER invent or ` +
          `compute a price, discount, percentage or before/after price. If a tool ` +
          `returns nothing, say you'll confirm rather than guess.\n` +
          `Recommend only products that genuinely match what the customer asked; ` +
          `you may suggest a relevant bundle/multi-pack but quote its exact price ` +
          `only.\n` +
          orderRule +
          `ORDER STATUS: ask for the order number, then use get_order_status — ` +
          `never guess a status or tracking.\n` +
          `A very short or punctuation-only message (e.g. "?", "ok", an emoji) is ` +
          `not a reason to hand off — ask a short clarifying question.\n` +
          `Do NOT repeat greetings, your name, or information already sent; the ` +
          `customer can see the whole chat. Add only what is new; keep it short.` +
          tone,
      },
      {
        text:
          `Language & script rule (follow exactly):\n${ctx.langRule}`,
      },
    ];
  }

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
      await this.prisma.conversationLabel
        .upsert({
          where: {
            conversation_id_label: {
              conversation_id: conversationId,
              label: AI_HANDOFF_LABEL,
            },
          },
          create: {
            company_id: companyId,
            conversation_id: conversationId,
            label: AI_HANDOFF_LABEL,
          },
          update: {},
        })
        .catch(() => undefined);
      this.gateway.emitToCompany(companyId, 'conversation.updated', {
        conversationId,
        addedLabel: AI_HANDOFF_LABEL,
      });
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
}
