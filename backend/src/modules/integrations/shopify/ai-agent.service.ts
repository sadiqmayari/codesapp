import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { JobQueueService } from '../../../common/services/job-queue.service';
import { CompanyStatusService } from '../../../common/services/company-status.service';
import {
  AiService,
  AgentIntent,
  DraftOrderResult,
  TriageResult,
} from '../../ai/ai.service';
import { TicketsService } from '../../tickets/tickets.service';
import { AiRagService } from '../../ai/ai-rag.service';
import {
  AI_AGENT_MAX_STEPS,
  ActiveTopic,
  ANTI_REPEAT_HISTORY,
  INTENT_TO_TOPIC,
  ORDER_CONFIDENCE_MIN,
  TOPIC_OVERRIDE_CONFIDENCE,
  TRACKING_TOPIC_TTL_MS,
} from '../../ai/ai.constants';
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
  /** Timestamp of the latest inbound message (episode boundary anchor). */
  latestInboundAt: Date | null;
  /** Plain text/transcription of the latest inbound message (repeat-order match). */
  latestInboundText: string;
  /** Set when the AI already closed this chat (further thanks → stay silent). */
  aiClosedAt: Date | null;
  /** Current conversation topic (Topic-Aware Commerce). */
  activeTopic: ActiveTopic;
  /** ORDER_TRACKING expiry, if any. */
  topicExpiresAt: Date | null;
  /** Start of the current episode (lower-bounds the autonomous transcript). */
  episodeStartedAt: Date | null;
  /** A pending (awaiting-confirmation) order draft exists for this chat. */
  pendingOrderExists: boolean;
  /** An open support ticket exists for this chat (protects DISPUTE mid-flow). */
  openTicketExists: boolean;
  /** Contact id (for ticket creation). */
  contactId: number | null;
  /**
   * Mutated to true by create_order when a real order was placed (or already
   * exists) THIS turn. The post-run guard uses it to catch the model claiming
   * "order placed" without actually creating one.
   */
  orderConfirmed: boolean;
}

/** Customer memory (Enh 6.3): reusable name/phone/address for prefill. */
interface CustomerMemory {
  name: string | null;
  phone: string | null;
  email: string | null;
  address1: string | null;
  city: string | null;
  countryCode: string | null;
}

/** Reverse of INTENT_TO_TOPIC — the specialist a kept topic routes to. */
const TOPIC_TO_INTENT: Record<ActiveTopic, AgentIntent> = {
  NONE: 'general',
  SALES: 'sales',
  ORDER_CREATION: 'order',
  ORDER_TRACKING: 'logistics',
  DISPUTE: 'resolution',
  SUPPORT: 'general',
  HUMAN_HANDOFF: 'general',
};

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
    private readonly tickets: TicketsService,
    private readonly companyStatus: CompanyStatusService,
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
    // Suspended/inactive tenant: do nothing — no reply, no order creation, no AI
    // spend. (Guards a job that was already queued when suspension took effect;
    // new inbound is stopped earlier in BotEngineService.runForMessage.)
    if (!(await this.companyStatus.isActive(job.companyId))) return;

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
    const wasClosed = route.aiClosedAt != null;
    // A real request after a close → reopen the AI for this chat.
    if (wasClosed) await this.clearClosed(job.conversationId);

    // ── TOPIC MANAGER + EPISODE BOUNDARIES (Topic-Aware Commerce) ────────
    // Decide the effective topic/specialist for THIS message, start a new
    // episode on a confident switch / tracking-expiry / post-close return /
    // hard-coded repeat-order, clear stale cross-topic state, and re-scope the
    // transcript so a new journey never sees the previous one's replies.
    const topicDecision = await this.applyTopicManager(
      job,
      ctx,
      route,
      triage,
      wasClosed,
    );
    const intent: AgentIntent = topicDecision.intent;
    if (topicDecision.ctx) ctx = topicDecision.ctx; // episode-scoped transcript

    // Hard-coded repeat order (Enh 6.2): the customer asked to reorder and has a
    // prior order — seed the cart deterministically and send a confirm summary.
    if (topicDecision.repeatForced && route.autoOrderEligible) {
      const res = await this.runRepeatOrder(job, ctx, route);
      if (res === 'handled') return;
    }

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

    // ── DISPUTE: ensure a ticket exists, record the turn, then run resolution.
    if (intent === 'resolution') {
      await this.ensureDisputeTicket(job, route).catch(() => undefined);
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
    // ONLY for the ORDER specialist: other specialists (resolution/logistics/
    // sales/general) legitimately say things like "aap ka order number confirm
    // karein" that must NOT be mistaken for a fake order-placed claim — doing so
    // clobbered real complaint/tracking replies with the order fallback + handoff.
    if (intent === 'order' && !route.orderConfirmed && this.claimsOrderPlaced(text)) {
      // The model announced the order is placed/created but create_order never
      // actually succeeded this turn. On an order-eligible chat, RECOVER: build
      // the order from the structured draft and create it for real, so a missed
      // model-create still produces an order (the customer was already told it
      // exists). Only when recovery can't (incomplete / prepaid / unresolved)
      // do we fall back to an honest message + human handoff.
      if (route.autoOrderEligible) {
        const recovered = await this.tryCreateFromDraft(job, ctx, route);
        if (recovered === 'created') {
          this.logger.log(
            `ai-agent convo ${job.conversationId}: recovered a false "order placed" claim by creating the real order`,
          );
          return;
        }
      }
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

    // Anti-repeat safety net (Change 5): if this reply nearly duplicates one of
    // the AI's last 10 outbound messages, make ONE bounded regenerate attempt
    // with an explicit "do not repeat" instruction; if it is still a duplicate,
    // stay silent instead of looping.
    if (await this.isLoopingReply(job, text)) {
      this.logger.log(
        `ai-agent convo ${job.conversationId}: near-duplicate reply → regenerate`,
      );
      let retry = '';
      try {
        const res = await this.ai.runAgent(
          job.companyId,
          'autoreply',
          ctx.tier,
          {
            system: specialist.system,
            userText: this.buildUserText(
              ctx,
              `IMPORTANT: do NOT repeat any earlier reply you have already sent in ` +
                `this chat. Say something new and useful, or briefly ask what else ` +
                `you can help with.`,
            ),
            tools: specialist.tools,
            maxSteps: specialist.maxSteps,
            maxTokens: 700,
            temperature: 0.5,
          },
          (name, input) => this.executeTool(job, ctx, route, name, input),
        );
        retry = res.text;
      } catch (e) {
        if (e instanceof ForbiddenException) return;
        retry = '';
      }
      if (
        !retry ||
        retry.includes(HANDOFF_TOKEN) ||
        (await this.isLoopingReply(job, retry))
      ) {
        this.logger.log(
          `ai-agent convo ${job.conversationId}: suppressed near-duplicate reply`,
        );
        return;
      }
      text = retry;
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
        ai_active_topic: true,
        ai_topic_expires_at: true,
        ai_episode_started_at: true,
        ai_pending_order: true,
        contact_id: true,
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

    // Latest inbound message (slip detection + episode anchor + repeat-order match).
    const lastInbound = await this.prisma.message.findFirst({
      where: {
        conversation_id: job.conversationId,
        company_id: job.companyId,
        direction: 'inbound',
      },
      orderBy: { timestamp: 'desc' },
      select: {
        message_type: true,
        timestamp: true,
        content: true,
        transcription: true,
      },
    });

    // Open support ticket (DISPUTE mid-flow protection).
    const openTicket = await this.prisma.supportTicket.findFirst({
      where: {
        company_id: job.companyId,
        conversation_id: job.conversationId,
        status: { notIn: ['resolved', 'rejected'] },
      },
      select: { id: true },
    });

    const topic = (convo?.ai_active_topic as ActiveTopic | null) ?? 'NONE';
    return {
      autoOrderEligible,
      defaultCountryCode: (ctx.defaultCountryCode || 'PK').toUpperCase().slice(0, 2),
      awaitingPaymentAt: convo?.ai_awaiting_payment_at ?? null,
      latestInboundType: lastInbound?.message_type ?? null,
      latestInboundAt: lastInbound?.timestamp ?? null,
      latestInboundText: (
        lastInbound?.content?.trim() ||
        lastInbound?.transcription?.trim() ||
        ''
      ).slice(0, 300),
      aiClosedAt: convo?.ai_closed_at ?? null,
      activeTopic: topic,
      topicExpiresAt: convo?.ai_topic_expires_at ?? null,
      episodeStartedAt: convo?.ai_episode_started_at ?? null,
      pendingOrderExists: convo?.ai_pending_order != null,
      openTicketExists: !!openTicket,
      contactId: convo?.contact_id ?? null,
      orderConfirmed: false,
    };
  }

  // ── Topic manager + episode boundaries ────────────────────────────────

  /**
   * Decide the effective topic/specialist for this message and manage episode
   * boundaries. Starts a NEW episode (re-scoping the transcript) on: first-ever
   * message, a confident topic switch (Enh 6.1), an expired ORDER_TRACKING
   * session, a post-close return, or a hard-coded repeat order (Enh 6.2). An
   * in-progress order/dispute is protected from a low-confidence reclassification.
   */
  private async applyTopicManager(
    job: AgentJob,
    ctx: AgentContext,
    route: RouteCtx,
    triage: TriageResult,
    wasClosed: boolean,
  ): Promise<{ intent: AgentIntent; ctx?: AgentContext; repeatForced: boolean }> {
    const now = new Date();
    const current = route.activeTopic;

    // Tracking session expiry → treat current as cleared (free reclassification).
    const trackingExpired =
      current === 'ORDER_TRACKING' &&
      !!route.topicExpiresAt &&
      now.getTime() > new Date(route.topicExpiresAt).getTime();
    const effectiveCurrent: ActiveTopic = trackingExpired ? 'NONE' : current;

    // Hard-coded repeat-order detection (Enh 6.2) — only when a prior order exists.
    const repeat = this.detectRepeatOrder(route.latestInboundText);
    const repeatForced =
      repeat.match && route.autoOrderEligible && (await this.hasPriorOrder(job, ctx));

    // Map triage → topic (escalate/closing already handled before here).
    let newTopic: ActiveTopic = repeatForced
      ? 'ORDER_CREATION'
      : INTENT_TO_TOPIC[triage.intent] ?? 'SUPPORT';

    // Decide whether to start a NEW episode.
    let startNewEpisode = false;
    if (effectiveCurrent === 'NONE' || !route.episodeStartedAt) {
      startNewEpisode = true; // first ever / cleared / expired tracking
    } else if (wasClosed) {
      startNewEpisode = true; // returning after a close → fresh journey
    } else if (newTopic !== effectiveCurrent) {
      // A topic switch. Protect an in-progress order / dispute from a noisy
      // (low-confidence) reclassification — keep the current topic unless the
      // model is confident (Enh 6.1) or this is a hard-coded repeat order.
      const protectedMidFlow =
        (effectiveCurrent === 'ORDER_CREATION' && route.pendingOrderExists) ||
        (effectiveCurrent === 'DISPUTE' && route.openTicketExists);
      if (
        protectedMidFlow &&
        !repeatForced &&
        triage.score < TOPIC_OVERRIDE_CONFIDENCE
      ) {
        newTopic = effectiveCurrent; // keep — do not tear down a live flow
      } else {
        startNewEpisode = true; // confident switch
      }
    }

    const intent: AgentIntent = repeatForced ? 'order' : TOPIC_TO_INTENT[newTopic];

    // Persist topic/episode state + clear stale cross-topic state.
    let episodeStart = route.episodeStartedAt;
    const data: Prisma.ConversationUpdateInput = {};
    if (startNewEpisode) {
      // Anchor the episode 1ms before the trigger message so it (and the current
      // burst) is included while older episode messages are excluded.
      episodeStart = route.latestInboundAt
        ? new Date(new Date(route.latestInboundAt).getTime() - 1)
        : new Date(now.getTime() - 1000);
      data.ai_episode_started_at = episodeStart;
      data.ai_active_topic = newTopic;
      data.ai_topic_started_at = now;
      data.ai_topic_expires_at =
        newTopic === 'ORDER_TRACKING'
          ? new Date(now.getTime() + TRACKING_TOPIC_TTL_MS)
          : null;
      // Leaving ORDER_CREATION → drop a stale pending cart / awaiting-payment.
      if (effectiveCurrent === 'ORDER_CREATION' && newTopic !== 'ORDER_CREATION') {
        data.ai_pending_order = Prisma.DbNull;
        data.ai_pending_order_at = null;
        data.ai_awaiting_payment_at = null;
        route.pendingOrderExists = false;
        route.awaitingPaymentAt = null;
      }
      // Linked order is only meaningful for a tracking session.
      if (newTopic !== 'ORDER_TRACKING') data.ai_linked_order_id = null;
    } else if (newTopic === 'ORDER_TRACKING') {
      // Refresh the tracking session TTL on each tracking turn.
      data.ai_topic_expires_at = new Date(now.getTime() + TRACKING_TOPIC_TTL_MS);
    }

    if (Object.keys(data).length) {
      await this.prisma.conversation
        .update({ where: { id: job.conversationId }, data })
        .catch(() => undefined);
    }
    route.activeTopic = newTopic;
    route.episodeStartedAt = episodeStart ?? null;

    // Re-derive the transcript scoped to the (new) episode so the specialist
    // never sees the previous journey's order/tracking replies.
    let newCtx: AgentContext | undefined;
    if (startNewEpisode && episodeStart) {
      try {
        newCtx = await this.ai.buildAgentContext(
          job.companyId,
          job.conversationId,
          episodeStart,
        );
      } catch {
        newCtx = undefined;
      }
    }

    this.logger.log(
      `ai-agent convo ${job.conversationId}: topic ${current}->${newTopic}` +
        `${startNewEpisode ? ' (new episode)' : ''}` +
        `${repeatForced ? ' [repeat]' : ''} score=${triage.score}`,
    );
    return { intent, ctx: newCtx, repeatForced };
  }

  /**
   * Hard-coded repeat-order phrases (English + Roman-Urdu). Deterministic — does
   * NOT depend on the model. Returns a quantity when an explicit "N more" is given.
   */
  private detectRepeatOrder(text: string): { match: boolean; quantity: number | null } {
    const t = (text || '').toLowerCase().trim();
    if (!t) return { match: false, quantity: null };
    const strong =
      /(same again|order again|re-?order|repeat (my |the )?order|same order|usual order|same as (last|before)|(dobara|dubara|dubra|phir se|wapis|wapas)\s*(order|mangwa|chahiy|chahiye|bhej)|order\s*(dobara|phir se|again)|same\s*(cheez|product|products|item|items)\s*(again|dobara|phir))/i;
    let match = strong.test(t);
    let quantity: number | null = null;
    const moreQty = t.match(/\b(\d{1,3})\s*(more|aur)\b/);
    if (moreQty) {
      match = true;
      const q = parseInt(moreQty[1], 10);
      if (q > 0 && q < 1000) quantity = q;
    }
    if (/\b(send|bhej|de)\s*(me\s*)?(\d{1,3}\s*)?more\b/i.test(t)) match = true;
    return { match, quantity };
  }

  /** Whether this customer has at least one prior Shopify order. */
  private async hasPriorOrder(job: AgentJob, ctx: AgentContext): Promise<boolean> {
    if (!ctx.contactPhone) return false;
    try {
      const c = await this.shopify.getCustomerOrders(job.companyId, ctx.contactPhone);
      return c.found && c.orders.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Customer memory (Enh 6.3): name / phone / delivery address resolved from the
   * contact row then the customer's most recent Shopify order. 5-min cached.
   */
  private readonly memCache = new Map<
    string,
    { at: number; mem: CustomerMemory }
  >();

  private async loadCustomerMemory(
    companyId: number,
    ctx: AgentContext,
  ): Promise<CustomerMemory> {
    const mem: CustomerMemory = {
      name: ctx.contactName,
      phone: ctx.contactPhone,
      email: null,
      address1: null,
      city: null,
      countryCode: null,
    };
    if (!ctx.contactPhone) return mem;
    const key = `${companyId}:${ctx.contactPhone}`;
    const cached = this.memCache.get(key);
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.mem;
    try {
      const last = await this.shopify.getLastOrderItems(companyId, ctx.contactPhone);
      if (last.found) {
        if (!mem.name && last.name) mem.name = last.name;
        if (last.shipping) {
          if (!mem.name && last.shipping.name) mem.name = last.shipping.name;
          if (!mem.phone && last.shipping.phone) mem.phone = last.shipping.phone;
          mem.address1 = last.shipping.address1 ?? null;
          mem.city = last.shipping.city ?? null;
          mem.countryCode = last.shipping.countryCode ?? null;
        }
      }
    } catch {
      /* best-effort */
    }
    this.memCache.set(key, { at: Date.now(), mem });
    return mem;
  }

  /**
   * Repeat-order path (Enh 6.2): seed the cart from the customer's last order +
   * saved address (Enh 6.3) and send a confirm-to-reorder summary. On the
   * customer's "yes" the deterministic order flow creates it (hydrating from the
   * seeded pending). Returns 'collect' to fall back to the order specialist when
   * there is nothing reliable to seed.
   */
  private async runRepeatOrder(
    job: AgentJob,
    ctx: AgentContext,
    route: RouteCtx,
  ): Promise<'handled' | 'collect'> {
    if (!ctx.contactPhone) return 'collect';
    let last: Awaited<ReturnType<ShopifyService['getLastOrderItems']>>;
    try {
      last = await this.shopify.getLastOrderItems(job.companyId, ctx.contactPhone);
    } catch {
      return 'collect';
    }
    if (!last.found || !last.items.length) return 'collect';

    const mem = await this.loadCustomerMemory(job.companyId, ctx);
    const country = (mem.countryCode || route.defaultCountryCode || 'PK')
      .toUpperCase()
      .slice(0, 2);
    const repeat = this.detectRepeatOrder(route.latestInboundText);
    const items = last.items.map((i) => ({
      productQuery: i.title,
      // An explicit "N more" applies to a single-line previous order.
      quantity:
        repeat.quantity && last.items.length === 1 ? repeat.quantity : i.quantity,
    }));
    const name = (mem.name || '').trim();
    const phoneRaw = (mem.phone || '').trim();
    const address1 = (mem.address1 || '').trim();
    const city = (mem.city || '').trim();

    const draft: DraftOrderResult = {
      items,
      customer: {
        name: name || null,
        phone: phoneRaw || null,
        email: this.validEmail(mem.email) ?? null,
        address1: address1 || null,
        city: city || null,
        countryCode: country,
      },
      paymentMethod: 'cod',
      note: `Repeat of ${last.name ?? 'previous order'}`,
      confidence: 'high',
      missing: [],
      readyToCreate: false,
      intent: 'place_order',
      orderNumber: null,
    };
    await this.storePending(job, draft);
    route.pendingOrderExists = true;

    const itemsLine = items
      .map((i) => `• ${i.quantity} × ${i.productQuery}`)
      .join('\n');
    if (name && phoneRaw && address1 && city) {
      const summary = await this.safeComposeSummary(
        job,
        draft,
        name,
        phoneRaw,
        address1,
        city,
        'cod',
      );
      await this.send(job, summary);
    } else {
      await this.send(
        job,
        `Aap apna pichla order dobara mangwana chahte hain:\n\n${itemsLine}\n\n` +
          `Baraye meharbani delivery details (naam, phone, poora pata, sheher) ` +
          `bhej dein taake hum order confirm kar dein.`,
      );
    }
    return 'handled';
  }

  /**
   * Deterministic order-confidence score (Enh 6.4): 0–100 from weighted checks.
   * Gates auto-creation so an incomplete/garbage order never reaches Shopify.
   */
  private orderConfidence(f: {
    lineItems: Array<{ variantId: string; quantity: number }>;
    name: string;
    phone: string; // already normalized to E.164 (best-effort)
    address1: string;
    city: string;
    paymentClear: boolean;
    explicitConfirm: boolean;
    draftConfidenceHigh: boolean;
  }): { score: number; weak: string[] } {
    let score = 0;
    const weak: string[] = [];
    if (f.lineItems.length && f.lineItems.every((i) => i.quantity > 0)) score += 30;
    else weak.push('product');
    if (f.name) score += 10;
    else weak.push('name');
    // A plausible phone: 8+ digits.
    if ((f.phone.match(/\d/g)?.length ?? 0) >= 8) score += 15;
    else weak.push('phone');
    if (f.address1) score += 15;
    else weak.push('full address');
    if (f.city) score += 10;
    else weak.push('city');
    if (f.explicitConfirm) score += 10;
    if (f.paymentClear) score += 5;
    if (f.draftConfidenceHigh) score += 5;
    return { score, weak };
  }

  /**
   * Ensure an open dispute ticket exists for this conversation and record the
   * customer's latest message on its timeline. Best-effort (never throws).
   */
  private async ensureDisputeTicket(
    job: AgentJob,
    route: RouteCtx,
  ): Promise<void> {
    if (route.contactId == null) return;
    const { ticket, created } = await this.tickets.createOrReuseForConversation(
      job.companyId,
      {
        conversationId: job.conversationId,
        contactId: route.contactId,
        type: this.guessDisputeType(route.latestInboundText),
        createdBy: 'ai',
        description: route.latestInboundText || undefined,
      },
    );
    if (created) {
      await this.label(job.companyId, job.conversationId, 'dispute');
    }
    const isPhoto =
      route.latestInboundType === 'image' ||
      route.latestInboundType === 'document';
    if (isPhoto) {
      await this.tickets.addEvent(job.companyId, ticket.id, {
        kind: 'photo_received',
        actor: 'customer',
        body: '(customer sent an image/document)',
      });
    } else if (route.latestInboundText) {
      await this.tickets.addEvent(job.companyId, ticket.id, {
        kind: 'note',
        actor: 'customer',
        body: route.latestInboundText,
      });
    }
  }

  /** Best-effort dispute-type guess from the customer's words. */
  private guessDisputeType(text: string): string {
    const t = (text || '').toLowerCase();
    if (/\brefund|paisa wapis|paise wapis\b/.test(t)) return 'refund';
    if (/\breturn|wapis kar|wapas kar\b/.test(t)) return 'return';
    if (/\bexchange|badal|tabdeel\b/.test(t)) return 'exchange';
    if (/\bbroken|damaged|toota|kharab|tuta\b/.test(t)) return 'damaged';
    if (/\bwrong|ghalat|galat\b/.test(t)) return 'wrong_item';
    if (/\bmissing|nahi mila|nahi aaya|nahin aya\b/.test(t)) return 'missing';
    return 'complaint';
  }

  private buildUserText(ctx: AgentContext, extra?: string): string {
    return (
      `${ctx.contactLine}\n\nConversation so far:\n${ctx.transcript}\n\n` +
      `PRIORITY: the CUSTOMER'S LAST message is the directive — answer THAT. The ` +
      `earlier lines are recent context (lower priority); do not act on them ` +
      `unless the last message refers to them, and never re-raise an older order ` +
      `or topic the customer has moved on from.\n` +
      (extra ? `${extra}\n` : '') +
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
              `complaints. A support TICKET has been opened for this issue. Your ` +
              `job is to (1) empathise briefly, (2) collect the ORDER NUMBER ` +
              `(verify with get_order_status), the exact ISSUE, and (3) ask the ` +
              `customer to SEND A PHOTO of the problem. You must NEVER promise, ` +
              `approve, reject, or even estimate a refund / return / replacement / ` +
              `money decision — a human decides that.\n` +
              `CRITICAL: ALWAYS write a real reply to the customer — NEVER hand ` +
              `off on their FIRST message about a problem and NEVER stay silent. ` +
              `On that first reply: apologise briefly, ask for the ORDER NUMBER if ` +
              `they have not given it, and explicitly ask them to SEND A PHOTO of ` +
              `the issue. Only AFTER you have the order number AND a photo (or the ` +
              `customer clearly says they have none) may you reply with EXACTLY ` +
              `${HANDOFF_TOKEN} so a human reviews and decides. Be empathetic and brief.`,
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
          `The "Customer: <name>" line tells you WHO you are talking to — their ` +
          `name is NOT a product and NOT a request. NEVER search the catalogue ` +
          `for the customer's name or for the store's name, and NEVER mention the ` +
          `customer's name as a topic or ask if they want information "about" it. ` +
          `If the customer's latest message is only a greeting or small talk ` +
          `("hi", "salam", "asalam o alaikum") with no product, order or question, ` +
          `simply greet them warmly and ask how you can help — do NOT run a ` +
          `product search.\n` +
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
            email: {
              type: 'string',
              description:
                "Customer email if they gave one in the chat (else omit)",
            },
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

  /** Resolve each {query,quantity} item to the BEST-MATCHING store variant. */
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
        const best = this.pickBestVariant(query, hits);
        if (best) out.push({ variantId: best.variantId, quantity });
      } catch {
        /* skip unresolved product */
      }
    }
    return out;
  }

  /**
   * Choose the variant whose product title best matches the query rather than
   * blindly trusting Shopify's relevance order. Shopify's `products(query:)`
   * search ranks by its OWN relevance, so for a catalogue full of similarly
   * named products ("Yummy Gummy …") the FIRST hit was frequently a DIFFERENT
   * product than the one the customer confirmed — creating the order for the
   * wrong item AND the wrong price. We pick the hit containing the most of the
   * query's words (an exact product-title match wins outright); ties keep
   * Shopify's order. Falls back to the first hit only when nothing scores.
   */
  private pickBestVariant<
    T extends { variantId: string; productTitle: string; variantTitle: string },
  >(query: string, hits: T[]): T | undefined {
    if (!hits.length) return undefined;
    const norm = (s: string) =>
      (s || '')
        .toLowerCase()
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .trim();
    const qNorm = norm(query);
    const qTokens = qNorm.split(/\s+/).filter((w) => w.length > 1);
    if (!qTokens.length) return hits[0];
    let best = hits[0];
    let bestScore = -Infinity;
    hits.forEach((h, idx) => {
      const titleTokens = new Set(
        norm(`${h.productTitle} ${h.variantTitle}`).split(/\s+/).filter(Boolean),
      );
      let overlap = 0;
      for (const t of qTokens) if (titleTokens.has(t)) overlap++;
      let score = overlap / qTokens.length; // fraction of query words matched
      if (norm(h.productTitle) === qNorm) score += 1; // exact title = strongest
      score -= idx * 1e-4; // stable: earlier Shopify hits win ties
      if (score > bestScore) {
        bestScore = score;
        best = h;
      }
    });
    return best;
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
    const email = this.validEmail(str(input.email));
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
    // Enh 6.4: order-confidence gate — never push an incomplete/garbage order.
    const conf = this.orderConfidence({
      lineItems,
      name,
      phone,
      address1,
      city,
      paymentClear: true,
      explicitConfirm: true, // the model only calls create_order after confirm
      draftConfidenceHigh: true,
    });
    if (conf.score < ORDER_CONFIDENCE_MIN) {
      return (
        `Order details are not confident enough to place yet (${conf.score}%). ` +
        `Confirm these with the customer first: ${conf.weak.join(', ')}. Do NOT ` +
        `create the order until they are clear.`
      );
    }
    const r = await this.placeCodOrder(job, route, {
      lineItems,
      name,
      phone,
      email,
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
   * Per-conversation in-process serialisation of order creation. Hostinger runs
   * a SINGLE Node process, so an in-process mutex is enough to guarantee only one
   * order is created at a time for a given chat. Without it, two concurrent
   * ai-agent jobs for the same confirmation (duplicate Meta webhook / retry
   * overlap; worker concurrency 2) raced — the loser read the winner's
   * not-yet-committed claim as a "duplicate" and falsely told the customer the
   * order was placed, while the winner could still fail and roll back, leaving a
   * false "placed" with NO real order.
   */
  private readonly orderChains = new Map<number, Promise<void>>();

  private async withOrderLock<T>(
    conversationId: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.orderChains.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((res) => (release = res));
    const tail = prev.then(() => done);
    this.orderChains.set(conversationId, tail);
    await prev.catch(() => undefined); // wait our turn
    try {
      return await fn();
    } finally {
      release();
      // GC the entry when no later job chained onto us.
      if (this.orderChains.get(conversationId) === tail) {
        this.orderChains.delete(conversationId);
      }
    }
  }

  /**
   * Shared COD order placer (used by the create_order tool AND the deterministic
   * backstop). Reorder-safe: a REAL order with the same cart within a short
   * window is a mechanical duplicate (no second order); a different cart / later
   * reorder passes. Concurrency-safe: serialised per conversation, and the dedup
   * marker is written ONLY after Shopify confirms a real order — so it can never
   * be mistaken for "in-flight". Sets route.orderConfirmed on success or a real
   * duplicate. Never throws.
   */
  private async placeCodOrder(
    job: AgentJob,
    route: RouteCtx,
    f: {
      lineItems: Array<{ variantId: string; quantity: number }>;
      name: string;
      phone: string;
      email?: string;
      address1: string;
      city: string;
      country: string;
      note?: string;
    },
  ): Promise<{ status: 'created' | 'duplicate' | 'failed'; orderName?: string; error?: string }> {
    return this.withOrderLock(job.conversationId, () =>
      this.placeCodOrderLocked(job, route, f),
    );
  }

  private async placeCodOrderLocked(
    job: AgentJob,
    route: RouteCtx,
    f: {
      lineItems: Array<{ variantId: string; quantity: number }>;
      name: string;
      phone: string;
      email?: string;
      address1: string;
      city: string;
      country: string;
      note?: string;
    },
  ): Promise<{ status: 'created' | 'duplicate' | 'failed'; orderName?: string; error?: string }> {
    const signature = this.cartSignature(f.lineItems);
    const cutoff = new Date(Date.now() - REORDER_DUPLICATE_WINDOW_MS);

    // Genuine duplicate: a REAL order with this exact cart was already committed
    // within the window. The marker is set only AFTER a confirmed Shopify order
    // (below), so its presence always means a real order exists — never in-flight.
    const committed = await this.prisma.conversation.findFirst({
      where: {
        id: job.conversationId,
        company_id: job.companyId,
        ai_last_order_signature: signature,
        ai_order_created_at: { gt: cutoff },
      },
      select: { id: true },
    });
    if (committed) {
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
        email: f.email,
        address1: f.address1,
        city: f.city,
        countryCode: f.country,
        note: f.note,
        tags: ['CodesApp', 'AI auto-order'],
        prepaid: false,
        shippingLine,
      });
      // Commit the dedup marker + clear the pending cart ONLY now that a real
      // order exists. (Never before the create — that was the false-duplicate bug.)
      await this.prisma.conversation
        .updateMany({
          where: { id: job.conversationId, company_id: job.companyId },
          data: {
            ai_order_created_at: new Date(),
            ai_last_order_signature: signature,
            ai_pending_order: Prisma.DbNull,
            ai_pending_order_at: null,
          },
        })
        .catch(() => undefined);
      route.orderConfirmed = true;
      await this.label(job.companyId, job.conversationId, AI_ORDER_LABEL);
      this.logger.log(
        `AI agent created COD Shopify order ${order.orderName} for conversation ${job.conversationId}`,
      );
      return { status: 'created', orderName: order.orderName };
    } catch (e) {
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
      draft = await this.ai.draftOrder(
        job.companyId,
        null,
        job.conversationId,
        route.episodeStartedAt, // episode-scoped extraction
      );
    } catch {
      return 'collect'; // extraction unavailable → let the specialist handle it
    }

    const convo = await this.prisma.conversation.findFirst({
      where: { id: job.conversationId, company_id: job.companyId },
      select: {
        ai_pending_order: true,
        ai_pending_order_at: true,
        contact: { select: { name: true, phone: true, email: true } },
      },
    });

    // Hydrate from a fresh stored pending cart when the model couldn't re-extract
    // the cart this turn (e.g. customer just said "yes", or a seeded repeat order
    // — Enh 6.2). The stored draft IS the agreed cart, so trust it.
    const storedPending = this.parsePendingDraft(convo?.ai_pending_order);
    const storedFresh =
      !!convo?.ai_pending_order_at &&
      Date.now() - new Date(convo.ai_pending_order_at).getTime() < PENDING_TTL_MS;
    if (
      storedFresh &&
      storedPending &&
      storedPending.items.length &&
      (draft.intent !== 'place_order' || draft.items.length === 0)
    ) {
      draft = { ...storedPending, intent: 'place_order' };
    }

    if (draft.intent !== 'place_order') return 'collect';

    // Customer memory (Enh 6.3): backfill missing name/address from the contact
    // and the last Shopify order so the AI confirms a saved address rather than
    // re-asking. The customer's stated value always wins (draft first).
    const mem = await this.loadCustomerMemory(job.companyId, ctx);
    const country = (draft.customer.countryCode || mem.countryCode || route.defaultCountryCode || 'PK')
      .toUpperCase()
      .slice(0, 2);
    const name = (draft.customer.name || convo?.contact?.name || mem.name || '').trim();
    const phoneRaw = (draft.customer.phone || convo?.contact?.phone || mem.phone || '').trim();
    const address1 = (draft.customer.address1 || mem.address1 || '').trim();
    const city = (draft.customer.city || mem.city || '').trim();
    const email = this.validEmail(draft.customer.email || convo?.contact?.email);
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
    // Enh 6.4: order-confidence gate before creating in Shopify.
    const conf = this.orderConfidence({
      lineItems,
      name,
      phone,
      address1,
      city,
      paymentClear: payment !== null,
      explicitConfirm: affirmed,
      draftConfidenceHigh: draft.confidence === 'high',
    });
    if (conf.score < ORDER_CONFIDENCE_MIN) {
      this.logger.log(
        `ai-agent convo ${job.conversationId}: order confidence ${conf.score}% < ` +
          `${ORDER_CONFIDENCE_MIN}% (weak: ${conf.weak.join(', ')}) → collect`,
      );
      return 'collect'; // ask for the weak fields via the specialist
    }
    const r = await this.placeCodOrder(job, route, {
      lineItems,
      name,
      phone,
      email,
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
    await this.send(job, this.orderPlacedMessage(r.orderName));
    return 'handled';
  }

  /** COD "order placed" confirmation — no double space when the order name is
   *  unknown (e.g. a verified duplicate). */
  private orderPlacedMessage(orderName?: string): string {
    const namePart = orderName ? ` ${orderName}` : '';
    return (
      `✅ Aap ka order${namePart} place ho gaya hai (Cash on Delivery). ` +
      `Shukria! Hamari team raabta karegi.`
    );
  }

  /** Return a syntactically-valid email, else undefined (never a junk value). */
  private validEmail(v: string | null | undefined): string | undefined {
    const e = (v ?? '').trim();
    return e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : undefined;
  }

  /**
   * False-claim recovery: the model told the customer the order is placed but
   * create_order never succeeded. Build the order from the structured draft
   * (+ stored pending + customer memory) and create it for real — NO confirm
   * gating (the customer was already told it's done). COD only (prepaid must
   * still go to a human, Rule 4). Returns 'created' on a real order, else 'no'.
   */
  private async tryCreateFromDraft(
    job: AgentJob,
    ctx: AgentContext,
    route: RouteCtx,
  ): Promise<'created' | 'no'> {
    let draft: DraftOrderResult;
    try {
      draft = await this.ai.draftOrder(
        job.companyId,
        null,
        job.conversationId,
        route.episodeStartedAt,
      );
    } catch {
      return 'no';
    }

    const convo = await this.prisma.conversation.findFirst({
      where: { id: job.conversationId, company_id: job.companyId },
      select: {
        ai_pending_order: true,
        ai_pending_order_at: true,
        contact: { select: { name: true, phone: true, email: true } },
      },
    });
    // Hydrate from a fresh stored pending cart if the model couldn't re-extract.
    const storedPending = this.parsePendingDraft(convo?.ai_pending_order);
    const storedFresh =
      !!convo?.ai_pending_order_at &&
      Date.now() - new Date(convo.ai_pending_order_at).getTime() < PENDING_TTL_MS;
    if (storedFresh && storedPending && storedPending.items.length && !draft.items.length) {
      draft = { ...storedPending, intent: 'place_order' };
    }
    if (!draft.items.length) return 'no';
    if (draft.paymentMethod === 'prepaid') return 'no'; // Rule 4 — never auto-create prepaid

    const mem = await this.loadCustomerMemory(job.companyId, ctx);
    const country = (
      draft.customer.countryCode ||
      mem.countryCode ||
      route.defaultCountryCode ||
      'PK'
    )
      .toUpperCase()
      .slice(0, 2);
    const name = (draft.customer.name || convo?.contact?.name || mem.name || '').trim();
    const phoneRaw = (
      draft.customer.phone ||
      convo?.contact?.phone ||
      mem.phone ||
      ''
    ).trim();
    const address1 = (draft.customer.address1 || mem.address1 || '').trim();
    const city = (draft.customer.city || mem.city || '').trim();
    const email = this.validEmail(draft.customer.email || convo?.contact?.email);
    if (!name || !phoneRaw || !address1 || !city) return 'no';

    const lineItems = await this.resolveLineItems(
      job.companyId,
      draft.items.map((i) => ({ query: i.productQuery, quantity: i.quantity })),
    );
    if (!lineItems.length) return 'no';

    const phone = normalizePhone(phoneRaw, country);
    const conf = this.orderConfidence({
      lineItems,
      name,
      phone,
      address1,
      city,
      paymentClear: draft.paymentMethod !== null,
      explicitConfirm: true, // the model already announced completion
      draftConfidenceHigh: draft.confidence === 'high',
    });
    if (conf.score < ORDER_CONFIDENCE_MIN) return 'no';

    const r = await this.placeCodOrder(job, route, {
      lineItems,
      name,
      phone,
      email,
      address1,
      city,
      country,
      note: draft.note || undefined,
    });
    if (r.status === 'failed') return 'no';
    // 'duplicate' means a real order already exists for this cart → also fine.
    await this.send(job, this.orderPlacedMessage(r.orderName));
    return 'created';
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

  /** Parse the FULL stored pending draft (items + customer + payment) back into a
   *  DraftOrderResult for hydration (Enh 6.2). Null if nothing usable. */
  private parsePendingDraft(pending: unknown): DraftOrderResult | null {
    const items = this.parsePendingItems(pending);
    if (!items.length) return null;
    const p = (pending ?? {}) as Record<string, unknown>;
    const cust = (p.customer ?? {}) as Record<string, unknown>;
    const s = (v: unknown): string | null =>
      typeof v === 'string' && v.trim() ? v.trim() : null;
    const payment =
      p.paymentMethod === 'prepaid'
        ? 'prepaid'
        : p.paymentMethod === 'cod'
          ? 'cod'
          : null;
    return {
      items,
      customer: {
        name: s(cust.name),
        phone: s(cust.phone),
        email: s(cust.email),
        address1: s(cust.address1),
        city: s(cust.city),
        countryCode: s(cust.countryCode),
      },
      paymentMethod: payment,
      note: s(p.note),
      confidence: p.confidence === 'high' ? 'high' : 'low',
      missing: [],
      readyToCreate: false,
      intent: 'place_order',
      orderNumber: null,
    };
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
    const recent = await this.prisma.message.findMany({
      where: {
        conversation_id: job.conversationId,
        company_id: job.companyId,
        direction: 'outbound',
      },
      orderBy: { timestamp: 'desc' },
      take: ANTI_REPEAT_HISTORY,
      select: { content: true },
    });
    for (const m of recent) {
      if (!m.content) continue;
      const prev = this.tokenize(m.content);
      if (prev.size < 5) continue;
      let inter = 0;
      for (const w of cur) if (prev.has(w)) inter++;
      const union = cur.size + prev.size - inter;
      if (union > 0 && inter / union >= 0.85) return true;
    }
    return false;
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
      /(placed successfully|successfully placed|has been placed|been placed successfully)/i.test(
        t,
      ) ||
      // "order [for this product] (is|has|has been|already been|was) … placed/created/confirmed/booked"
      // The {0,40} gap allows intervening words ("order for this product has
      // already been created"), which the old `order (is|has been)` adjacency missed.
      /\border\b[^.?!\n]{0,40}\b(is|has|have|had|was|been|already)\b[^.?!\n]{0,20}\b(placed|created|confirmed|booked|done)\b/i.test(
        t,
      ) ||
      /(order .{0,30}(place ho (gaya|gya|gai|chuka|chuki)|ban gaya|ban gya|bana diya|ban diya|ban chuka|create ho (gaya|gya|chuka)|confirm ho (gaya|gya|chuka)|ho gaya hai|ho chuka))/i.test(
        t,
      ) ||
      // Completion-only (must include a "done" verb). The old clause matched a
      // bare "aap ka order confirm karein" (asking the customer to confirm) and
      // even non-order replies, falsely firing the fake-placed handoff.
      /(aap ka|apka|aapka) order .{0,30}(place ho (gaya|gya|chuka)|placed|ban gaya|ban gya|ban diya|create ho (gaya|gya)|created|confirm ho (gaya|gya|chuka))/i.test(
        t,
      )
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
