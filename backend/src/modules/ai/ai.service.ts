import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingService } from '../../common/services/platform-setting.service';
import { LlmService } from './llm.service';
import {
  AgentMessage,
  ImageInput,
  SystemBlock,
  ToolDef,
} from './providers/llm-provider.interface';
import { AiMeteringService } from './ai-metering.service';
import { AiRagService } from './ai-rag.service';
import {
  AudioTranscriptionService,
  WHISPER_MICROS_PER_SEC,
} from './audio-transcription.service';
import {
  AiFeature,
  CONTEXT_MESSAGE_LIMIT,
  CONTEXT_WINDOW_HOURS,
  KB_CHAR_BUDGET,
  ModelTier,
} from './ai.constants';
import { RewriteMode } from './dto/ai-actions.dto';
import { resolveAiCapabilities } from '../../common/utils/ai-capabilities';

/** Max concurrent AI calls per company (interactive — protects the process). */
const MAX_CONCURRENCY_PER_COMPANY = 3;
/** Vision: most-recent inbound images fed to the model per call. */
const MAX_VISION_IMAGES = 3;
/** Vision: skip an image larger than this (matches the inbound image cap). */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Storage disk root for resolving `/storage/...` web paths. */
const STORAGE_DISK_ROOT = path.join(process.cwd(), '..');

/** Map an image file extension to a vision-supported MIME type. */
function imageMimeFromPath(p: string): string | null {
  const ext = p.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    default:
      return null;
  }
}

/** Resolve a stored `/storage/...` web path to an absolute disk path. */
function diskPathFromWeb(mediaUrl: string): string {
  return path.join(STORAGE_DISK_ROOT, mediaUrl.replace(/^\/+/, ''));
}

interface CompanyAiContext {
  name: string;
  brandTone: string | null;
  defaultLanguage: string | null;
  /** Tenant-selectable autonomous tier ('fast'|'smart'); null = platform default. */
  autonomousTier: string | null;
  /** Super-admin per-tenant kill-switch (forces baseline when true). */
  premiumLocked: boolean;
  visionEnabled: boolean;
  voiceEnabled: boolean;
  /** Auto-order master switch — when on, the order system owns confirmations. */
  autoOrderEnabled: boolean;
  /** Tenant default ISO-2 country for order creation (fallback for shipping). */
  defaultCountryCode: string | null;
}

/**
 * Triage classification produced by the orchestrator's MAIN agent. A cheap,
 * fast-tier, tool-less JSON call that routes each inbound message to ONE
 * specialist sub-agent (or straight to a human). The orchestrator computes
 * `orderInFlight` itself (a DB fact) and overrides the route accordingly.
 */
export type AgentIntent =
  | 'sales'
  | 'order'
  | 'logistics'
  | 'resolution'
  | 'general'
  | 'closing'
  | 'escalate';

export interface TriageResult {
  intent: AgentIntent;
  confidence: 'high' | 'low';
  /**
   * Numeric certainty 0–100 for the chosen intent (Enh 6.1). Drives the
   * topic-override rule: a switch only interrupts an in-progress protected topic
   * when score ≥ TOPIC_OVERRIDE_CONFIDENCE. Fail-safe parse → 50.
   */
  score: number;
  /** Customer explicitly asked for a human/agent. */
  wantsHuman: boolean;
  /** Sensitive topic (refund/return/cancel/complaint/legal/medical/anger). */
  sensitive: boolean;
}

export interface DraftOrderResult {
  items: Array<{ productQuery: string; quantity: number }>;
  customer: {
    name: string | null;
    phone: string | null;
    address1: string | null;
    city: string | null;
    countryCode: string | null;
  };
  paymentMethod: 'cod' | 'prepaid' | null;
  note: string | null;
  confidence: 'high' | 'low';
  missing: string[];
  /**
   * True ONLY when the customer has clearly CONFIRMED they want to place this
   * exact order now (not just asking/browsing) AND every required field
   * (≥1 product, name, phone, address, city) is present. Drives fully-automated
   * order creation; the interactive "Draft from chat" button ignores it.
   */
  readyToCreate: boolean;
  /**
   * What the customer's latest messages are about:
   *  - 'place_order'  → wants to buy / is giving order details
   *  - 'order_status' → asking about an existing order (where is it / update)
   *  - 'other'        → anything else (handled by the normal reply path)
   */
  intent: 'place_order' | 'order_status' | 'other';
  /** Order number the customer mentioned for a status query (digits, no #), else null. */
  orderNumber: string | null;
}

const EMPTY_DRAFT: DraftOrderResult = {
  items: [],
  customer: {
    name: null,
    phone: null,
    address1: null,
    city: null,
    countryCode: null,
  },
  paymentMethod: null,
  note: null,
  confidence: 'low',
  missing: ['all'],
  readyToCreate: false,
  intent: 'other',
  orderNumber: null,
};

@Injectable()
export class AiService {
  /** companyId → in-flight interactive AI calls. */
  private readonly inflight = new Map<number, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly metering: AiMeteringService,
    private readonly platformSetting: PlatformSettingService,
    private readonly audio: AudioTranscriptionService,
    private readonly rag: AiRagService,
  ) {}

  // ── Public features ──────────────────────────────────────────────────

  async suggestReply(
    companyId: number,
    userId: number | null,
    conversationId: number,
    instruction?: string,
  ): Promise<{ text: string }> {
    const { transcript, contactLine, images, customerQuery } =
      await this.loadTranscript(companyId, conversationId);
    const company = await this.loadCompany(companyId);
    const system = this.baseSystem(
      company,
      await this.buildKnowledge(companyId, customerQuery),
    );

    const langRule = this.languageRule(company);

    const task =
      `${contactLine}\n\nConversation so far:\n${transcript}\n\n` +
      `Write ONLY the next message the agent should send to the customer — ` +
      `no preamble, no quotes, no "Agent:" label. Be concise, helpful, and on-brand. ${langRule}` +
      (instruction ? `\n\nExtra instruction from the agent: ${instruction}` : '');

    return this.run(companyId, userId, 'suggest_reply', 'fast', {
      system,
      userText: task,
      images,
      maxTokens: 600,
      temperature: 0.5,
    });
  }

  async summarize(
    companyId: number,
    userId: number | null,
    conversationId: number,
  ): Promise<{ text: string }> {
    const { transcript, contactLine, images } = await this.loadTranscript(
      companyId,
      conversationId,
    );
    const task =
      `${contactLine}\n\nConversation:\n${transcript}\n\n` +
      `Summarize this conversation for an agent picking it up. Use short bullet points: ` +
      `who the customer is, what they want, what's been done, and the next action needed. Keep it tight.`;

    return this.run(companyId, userId, 'summarize', 'smart', {
      system: [
        {
          text: 'You are a support-operations assistant. You write crisp, scannable handoff summaries.',
        },
      ],
      userText: task,
      images,
      maxTokens: 500,
      temperature: 0.3,
    });
  }

  /**
   * Draft-order extraction (Shopify). Reads the conversation and returns a
   * STRUCTURED draft the agent reviews/edits in the Create-order modal before
   * anything is created in Shopify — the AI never creates an order itself.
   *
   * Product names are returned as free-text queries; the frontend resolves them
   * to real variants via the existing /shopify/products search (this keeps
   * AiModule free of any Shopify/Inbox dependency — see the module cycle note).
   */
  async draftOrder(
    companyId: number,
    userId: number | null,
    conversationId: number,
    episodeStartedAt?: Date | null,
  ): Promise<DraftOrderResult> {
    const { transcript, contactLine, images, customerQuery } =
      await this.loadTranscript(companyId, conversationId, {
        windowHours: CONTEXT_WINDOW_HOURS,
        episodeStartedAt: episodeStartedAt ?? null,
      });
    const company = await this.loadCompany(companyId);
    const system = this.baseSystem(
      company,
      await this.buildKnowledge(companyId, customerQuery),
    );

    system.push({
      text:
        `You extract a Shopify order draft from a WhatsApp support/sales chat. ` +
        `Use ONLY information the CUSTOMER (lines starting "Customer:") actually ` +
        `stated. NEVER take items, quantities, name, phone, address or payment ` +
        `from "Agent:" lines, an order-confirmation template, or any message the ` +
        `store sent — those are the store's OWN messages, NOT a new order. Never ` +
        `invent ` +
        `product the customer wants, output the product name exactly as the ` +
        `customer/agent referred to it as "productQuery" (it will be searched in ` +
        `the store) plus the quantity (default 1 if a product is clearly wanted ` +
        `but no quantity was given). paymentMethod is "cod" (cash on delivery) ` +
        `or "prepaid" only if clearly indicated, else null. countryCode is an ` +
        `ISO-2 code (e.g. "PK") if the country is clear, else null. Set ` +
        `"confidence" to "low" if the order details are unclear or incomplete.\n\n` +
        `For the customer NAME, use the name the customer gives in THIS chat for ` +
        `the order/delivery (the recipient) — this is more reliable than their ` +
        `WhatsApp profile name; only fall back to null if no name is stated. ` +
        `For PHONE, capture the delivery/contact number stated in the chat ` +
        `EXACTLY as written (keep leading zeros, e.g. "03171234567"); set null ` +
        `if none is given (do not guess).\n\n` +
        `Set "readyToCreate" to true ONLY if the customer has clearly CONFIRMED ` +
        `they want to place THIS order now (an explicit yes/confirm/"order it", ` +
        `not just asking about or browsing products) AND all of: at least one ` +
        `product, name, phone, address and city are present. Otherwise false.\n\n` +
        `Classify the customer's latest intent as "intent": "order_status" if ` +
        `they are asking about an EXISTING order (e.g. "where is my order", ` +
        `"any update", "tracking", "kab tak aayega"); "place_order" if they want ` +
        `to buy or are giving order details; else "other". If they mention an ` +
        `order number, put just its digits in "orderNumber" (no "#"), else null.\n\n` +
        `Respond with ONLY a JSON object, no markdown, no prose:\n` +
        `{"items":[{"productQuery":string,"quantity":number}],` +
        `"customer":{"name":string|null,"phone":string|null,"address1":string|null,` +
        `"city":string|null,"countryCode":string|null},` +
        `"paymentMethod":"cod"|"prepaid"|null,` +
        `"note":string|null,"confidence":"high"|"low","missing":string[],` +
        `"readyToCreate":boolean,` +
        `"intent":"place_order"|"order_status"|"other","orderNumber":string|null}`,
    });

    const task = `${contactLine}\n\nConversation so far:\n${transcript}`;

    // Order extraction is an autonomous decision → use the tenant's effective
    // tier (their choice, or the platform default; forced fast when locked).
    const tier = resolveAiCapabilities(
      {
        ai_autonomous_tier: company.autonomousTier,
        ai_premium_locked: company.premiumLocked,
      },
      await this.platformSetting.getAutonomousTier(),
    ).tier;
    const { text } = await this.run(companyId, userId, 'draft_order', tier, {
      system,
      userText: task,
      images,
      maxTokens: 700,
      temperature: 0.2,
    });
    return this.parseDraftOrder(text);
  }

  /**
   * Compose an order-confirmation summary in the customer's own language, from
   * EXACT structured cart data. The numbers/items/address must not change — the
   * model only phrases + translates. Returns a ready-to-send WhatsApp message.
   * Caller passes already-resolved/validated fields; on any failure the caller
   * falls back to its deterministic English summary.
   */
  async composeOrderConfirmation(
    companyId: number,
    conversationId: number,
    cart: {
      items: Array<{ quantity: number; title: string }>;
      name: string;
      phone: string;
      address1: string;
      city: string;
      payment: 'cod' | 'prepaid';
    },
  ): Promise<{ text: string }> {
    const company = await this.loadCompany(companyId);
    const { transcript } = await this.loadTranscript(companyId, conversationId, {
      windowHours: CONTEXT_WINDOW_HOURS,
    });
    const langRule = this.languageRule(company);

    const itemLines = cart.items
      .map((i) => `- ${i.quantity} x ${i.title}`)
      .join('\n');
    const paymentLabel =
      cart.payment === 'prepaid' ? 'Prepaid' : 'Cash on Delivery';

    const system: SystemBlock[] = [
      {
        text:
          `You write ONE short WhatsApp order-confirmation message for the store ` +
          `"${company.name}". You are given the EXACT order details. Reproduce ` +
          `every item, quantity, name, phone, address and payment method EXACTLY ` +
          `as given — never change, add, remove, translate or reformat a number, ` +
          `product name or address, and never mention a price or discount. List ` +
          `the items and the delivery details clearly, then ask the customer to ` +
          `reply to confirm the order. Output ONLY the message text. ${langRule}`,
      },
    ];
    const userText =
      `Recent conversation (for language only):\n${transcript}\n\n` +
      `ORDER TO CONFIRM (reproduce exactly):\n` +
      `Items:\n${itemLines}\n` +
      `Name: ${cart.name}\n` +
      `Phone: ${cart.phone}\n` +
      `Address: ${cart.address1}, ${cart.city}\n` +
      `Payment: ${paymentLabel}\n\n` +
      `Write the confirmation message now, asking them to reply to confirm.`;

    return this.run(companyId, null, 'autoreply', 'fast', {
      system,
      userText,
      maxTokens: 400,
      temperature: 0.3,
    });
  }

  async rewrite(
    companyId: number,
    userId: number | null,
    text: string,
    mode: RewriteMode,
  ): Promise<{ text: string }> {
    const company = await this.loadCompany(companyId);
    const instructions: Record<RewriteMode, string> = {
      polite:
        'Rewrite the message to be warm, polite and professional, keeping the meaning.',
      shorten: 'Rewrite the message to be shorter and clearer, keeping the meaning.',
      expand:
        'Expand the message with a little more helpful detail and warmth, keeping the meaning.',
      fix: 'Fix spelling, grammar and punctuation. Keep the wording and tone as close to the original as possible.',
    };
    const toneLine = company.brandTone
      ? ` Match this brand voice: ${company.brandTone}.`
      : '';

    const task =
      `${instructions[mode]}${toneLine}\n\n` +
      `Return ONLY the rewritten message, nothing else.\n\nMessage:\n${text}`;

    return this.run(companyId, userId, 'rewrite', 'fast', {
      system: [
        { text: 'You rewrite WhatsApp messages for customer-support agents.' },
      ],
      userText: task,
      maxTokens: 800,
      temperature: 0.4,
    });
  }

  async translate(
    companyId: number,
    userId: number | null,
    text: string,
    targetLang: string,
  ): Promise<{ text: string }> {
    const task =
      `Translate the following message into ${targetLang}. ` +
      `Keep the tone natural and conversational for WhatsApp. ` +
      `Return ONLY the translation, nothing else.\n\nMessage:\n${text}`;

    return this.run(companyId, userId, 'translate', 'fast', {
      system: [
        {
          text: 'You are a professional translator for customer-support chat messages.',
        },
      ],
      userText: task,
      maxTokens: 1000,
      temperature: 0.2,
    });
  }

  // ── Tool-calling agent (Phase 2) ─────────────────────────────────────

  /**
   * Conversation context for the tool-calling agent (lives in ShopifyModule).
   * Exposes everything the agent needs to build its prompt WITHOUT reaching into
   * AiService internals — keeps AiModule free of any Shopify dependency.
   */
  async buildAgentContext(
    companyId: number,
    conversationId: number,
    episodeStartedAt?: Date | null,
  ): Promise<{
    transcript: string;
    contactLine: string;
    contactName: string | null;
    contactPhone: string | null;
    hasCustomerText: boolean;
    customerQuery: string;
    companyName: string;
    brandTone: string | null;
    langRule: string;
    tier: ModelTier;
    autoOrderEnabled: boolean;
    defaultCountryCode: string | null;
  }> {
    const company = await this.loadCompany(companyId);
    const { transcript, contactLine, customerQuery, hasCustomerText } =
      await this.loadTranscript(companyId, conversationId, {
        windowHours: CONTEXT_WINDOW_HOURS,
        episodeStartedAt: episodeStartedAt ?? null,
      });
    const convo = await this.prisma.conversation.findFirst({
      where: { id: conversationId, company_id: companyId },
      select: { contact: { select: { name: true, phone: true } } },
    });
    const tier = resolveAiCapabilities(
      {
        ai_autonomous_tier: company.autonomousTier,
        ai_premium_locked: company.premiumLocked,
      },
      await this.platformSetting.getAutonomousTier(),
    ).tier;
    return {
      transcript,
      contactLine,
      contactName: convo?.contact?.name ?? null,
      contactPhone: convo?.contact?.phone ?? null,
      hasCustomerText,
      customerQuery,
      companyName: company.name,
      brandTone: company.brandTone,
      langRule: this.languageRule(company),
      tier,
      autoOrderEnabled: company.autoOrderEnabled,
      defaultCountryCode: company.defaultCountryCode,
    };
  }

  /**
   * MAIN agent — triage router. One cheap, fast-tier, tool-less JSON call that
   * classifies the customer's latest message into a single specialist route.
   * Gated + metered (feature 'triage'). Fail-safe: any parse/format error →
   * a low-confidence 'general' route (the orchestrator decides what to do with
   * low confidence). Throws ForbiddenException when AI is off / over cap so the
   * orchestrator consumes the job silently.
   */
  async classifyIntent(
    companyId: number,
    transcript: string,
  ): Promise<TriageResult> {
    await this.metering.assertAllowed(companyId);
    const system: SystemBlock[] = [
      {
        text:
          `You are the triage router for a WhatsApp store's customer support. ` +
          `Read the conversation and classify the CUSTOMER'S MOST RECENT message ` +
          `into exactly one intent:\n` +
          `- "sales": pre-purchase — asking about products, price, stock, ` +
          `availability, recommendations, catalogue, bundles (no order being ` +
          `placed yet).\n` +
          `- "order": wants to buy / is placing an order / giving delivery ` +
          `details / choosing payment / confirming a new order.\n` +
          `- "logistics": asking about an EXISTING order's status, tracking, ` +
          `delivery time, or a delivery problem.\n` +
          `- "resolution": return, refund, exchange, cancellation, wrong/damaged/` +
          `missing item, billing dispute, or a complaint.\n` +
          `- "closing": the customer is ENDING the conversation with a pure ` +
          `acknowledgement / sign-off and needs nothing more — e.g. "ok thanks", ` +
          `"shukria", "thank you", "kuch nahi chahiye", "bye", "theek hai bas". ` +
          `IMPORTANT: an "ok"/"haan"/"yes" that ANSWERS your question or confirms ` +
          `an order in progress is NOT closing — that is "order". Use "closing" ` +
          `only for a clear farewell with nothing pending.\n` +
          `- "general": greeting, small talk, business info/hours, a vague ` +
          `opener, or anything not covered above.\n` +
          `- "escalate": the customer is angry/abusive, explicitly asks for a ` +
          `human/agent, or it's a legal/medical/fraud matter.\n` +
          `Set "wantsHuman" true ONLY if they explicitly ask for a human. Set ` +
          `"sensitive" true for resolution/escalate-type topics. Use ` +
          `"confidence":"low" when the message is too short/ambiguous to be sure.\n` +
          `Also output "score": an integer 0-100 = how CERTAIN you are about the ` +
          `intent of the customer's most recent message (100 = unmistakable, e.g. ` +
          `a clear "where is my order" or "I want to buy 2"; 40-60 = ambiguous ` +
          `one-word or off-topic line). Base the score on the LATEST message, not ` +
          `the older context.\n` +
          `Respond with ONLY a JSON object, no markdown, no prose: ` +
          `{"intent":"sales"|"order"|"logistics"|"resolution"|"general"|"closing"|"escalate",` +
          `"confidence":"high"|"low","score":number,"wantsHuman":boolean,"sensitive":boolean}`,
      },
    ];
    const result = await this.llm.complete({
      tier: 'fast',
      system,
      userText: `Conversation so far:\n${transcript}`,
      maxTokens: 120,
      temperature: 0,
    });
    await this.metering.recordUsage(
      companyId,
      null,
      'triage',
      result.provider,
      'fast',
      result.usage,
    );
    return this.parseTriage(result.text);
  }

  /** Parse the triage JSON, fail-safe to a low-confidence 'general' route. */
  private parseTriage(raw: string): TriageResult {
    const safe: TriageResult = {
      intent: 'general',
      confidence: 'low',
      score: 50,
      wantsHuman: false,
      sensitive: false,
    };
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return safe;
    try {
      const o = JSON.parse(match[0]) as Record<string, unknown>;
      const intents: AgentIntent[] = [
        'sales',
        'order',
        'logistics',
        'resolution',
        'general',
        'closing',
        'escalate',
      ];
      const intent = intents.includes(o.intent as AgentIntent)
        ? (o.intent as AgentIntent)
        : 'general';
      const rawScore = Number(o.score);
      const score = Number.isFinite(rawScore)
        ? Math.min(100, Math.max(0, Math.round(rawScore)))
        : o.confidence === 'high'
          ? 90
          : 50;
      return {
        intent,
        confidence: o.confidence === 'high' ? 'high' : 'low',
        score,
        wantsHuman: o.wantsHuman === true,
        sensitive: o.sensitive === true,
      };
    } catch {
      return safe;
    }
  }

  /**
   * Run a bounded tool-calling agent loop. The CALLER supplies the tools +
   * `executeTool` (so AiModule never imports Shopify/Inbox). Each model
   * round-trip is gated + metered; the loop is capped to keep one chat from
   * monopolising the single shared-hosting process. The final step is forced to
   * a text answer (no tools) so the agent always returns a reply.
   */
  async runAgent(
    companyId: number,
    feature: AiFeature,
    tier: ModelTier,
    opts: {
      system: SystemBlock[];
      userText: string;
      tools: ToolDef[];
      maxSteps?: number;
      maxTokens?: number;
      temperature?: number;
    },
    executeTool: (
      name: string,
      input: Record<string, unknown>,
    ) => Promise<string>,
  ): Promise<{ text: string }> {
    await this.metering.assertAllowed(companyId);
    const maxSteps = Math.min(Math.max(opts.maxSteps ?? 4, 1), 6);
    const messages: AgentMessage[] = [{ role: 'user', text: opts.userText }];
    let finalText = '';

    for (let step = 0; step <= maxSteps; step++) {
      const lastStep = step === maxSteps;
      const result = await this.llm.completeWithTools({
        tier,
        system: opts.system,
        messages,
        tools: lastStep ? [] : opts.tools, // force a text answer on the last step
        maxTokens: opts.maxTokens ?? 700,
        temperature: opts.temperature,
      });
      await this.metering.recordUsage(
        companyId,
        null,
        feature,
        result.provider,
        tier,
        result.usage,
      );

      if (!lastStep && result.stop === 'tool_use' && result.toolCalls.length) {
        messages.push({
          role: 'assistant',
          text: result.text,
          toolCalls: result.toolCalls,
        });
        for (const tc of result.toolCalls) {
          let out: string;
          try {
            out = await executeTool(tc.name, tc.input);
          } catch (e) {
            out = `Error: ${e instanceof Error ? e.message : String(e)}`;
          }
          messages.push({
            role: 'tool',
            toolCallId: tc.id,
            name: tc.name,
            content: (out || '').slice(0, 6000),
          });
        }
        continue;
      }

      finalText = (result.text ?? '').trim();
      break;
    }
    return { text: finalText };
  }

  // ── Internals ────────────────────────────────────────────────────────

  /**
   * Gate → concurrency-limit → call model → record usage. The model call is
   * made WITHOUT holding any DB connection (context already loaded). Metering
   * is recorded after.
   */
  private async run(
    companyId: number,
    userId: number | null,
    feature: AiFeature,
    tier: ModelTier,
    opts: {
      system: SystemBlock[];
      userText: string;
      images?: ImageInput[];
      maxTokens: number;
      temperature?: number;
    },
  ): Promise<{ text: string }> {
    await this.metering.assertAllowed(companyId);
    this.acquire(companyId);
    try {
      const result = await this.llm.complete({
        tier,
        system: opts.system,
        userText: opts.userText,
        images: opts.images,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
      });
      await this.metering.recordUsage(
        companyId,
        userId,
        feature,
        result.provider,
        tier,
        result.usage,
      );
      return { text: result.text };
    } finally {
      this.release(companyId);
    }
  }

  /**
   * Phase 2 auto-responder decision. Returns a structured, confidence-gated
   * choice: either a reply to auto-send, or a handoff to a human. Used by the
   * bot engine's AI auto-reply path. Goes through the same gate + metering +
   * concurrency limiter as interactive calls (feature 'autoreply').
   */
  async autoReplyDecision(
    companyId: number,
    conversationId: number,
  ): Promise<{
    reply: string | null;
    handoff: boolean;
    reason: string;
    /** True → silently consume (don't reply, don't mark needs-human). */
    skip?: boolean;
  }> {
    await this.metering.assertAllowed(companyId);
    const { transcript, contactLine, images, customerQuery, hasCustomerText } =
      await this.loadTranscript(companyId, conversationId, {
        windowHours: CONTEXT_WINDOW_HOURS,
      });

    // Unreadable media only (e.g. a sticker, or a voice note we couldn't
    // transcribe) and no image to look at → there's nothing to answer. Skip
    // silently instead of handing off to a human (don't spam needs-human).
    if (!hasCustomerText && images.length === 0) {
      return {
        reply: null,
        handoff: false,
        skip: true,
        reason: 'no readable customer input',
      };
    }

    const company = await this.loadCompany(companyId);
    const system = this.baseSystem(
      company,
      await this.buildKnowledge(companyId, customerQuery),
    );

    const langRule = this.languageRule(company);

    system.push({
      text:
        `You are operating in AUTONOMOUS mode: your reply may be sent to the ` +
        `customer WITHOUT a human reviewing it. Your job is to be genuinely ` +
        `HELPFUL — answer the customer yourself by DEFAULT.\n\n` +
        `Handle these normally (set "handoff" false and write the reply): ` +
        `greetings and small talk; questions about products, pricing, ` +
        `availability, shipping, delivery time and policies; and customers who ` +
        `want to BUY or place an order — guide them and collect the details ` +
        `(product, quantity, name, phone, complete address with house no., ` +
        `city, payment method). Wanting to buy is the MOST important case to ` +
        `handle, never a reason to hand off. When details are missing, ask for ` +
        `the specific ones still needed. If a specific detail isn't in the ` +
        `knowledge base, ask the customer a short clarifying question instead ` +
        `of handing off — only state facts (prices, stock, policies) that the ` +
        `knowledge base or the conversation actually supports, and never invent ` +
        `them.\n\n` +
        `CRITICAL — you CANNOT place, create, or confirm orders yourself. ` +
        `NEVER tell the customer their order has been placed, created, ` +
        `confirmed, or is being processed, and never invent an order number or ` +
        `total. The system creates the order automatically once all details ` +
        `are collected and the customer confirms a summary, and it sends the ` +
        `confirmation message itself. If the customer asks whether their order ` +
        `is done, reassure them it will be confirmed as soon as the remaining ` +
        `details are provided — do NOT claim it is already placed.\n\n` +
        (company.autoOrderEnabled
          ? `ORDER CONFIRMATIONS ARE NOT YOURS TO DO: an automated order system ` +
            `handles them. Do NOT ask "shall I confirm your order?", do NOT write ` +
            `an order summary, and do NOT tell the customer to reply YES — the ` +
            `system sends the summary and asks for confirmation itself. Your job ` +
            `for a buyer is only to answer their questions and collect any missing ` +
            `details (product, quantity, name, phone, full address, city, payment). ` +
            `Once details are gathered, just acknowledge briefly; the system takes ` +
            `over the confirmation.\n\n`
          : '') +
        `ORDER STATUS / TRACKING: if the customer asks about an EXISTING order ` +
        `(where is it, any update, tracking), do NOT guess a status, date, or ` +
        `tracking number. Ask for their order number so it can be looked up.\n\n` +
        `A very short or punctuation-only message (e.g. "?", "ok", "hello", an ` +
        `emoji) is NOT a reason to hand off — reply with a short, friendly ` +
        `clarifying question to find out what they need.\n\n` +
        `Do NOT repeat yourself: the customer can see the whole conversation, so ` +
        `never re-send a greeting, your name, or information you already gave, ` +
        `and never restate the same sentence. Add only what is new; keep it ` +
        `short.\n\n` +
        `Set "handoff" to true (and leave "reply" null) ONLY when you truly ` +
        `should not answer alone: the customer is angry/abusive or explicitly ` +
        `asks for a human/agent; it's a refund, return, cancellation of an ` +
        `existing order, a payment dispute, a complaint, or a legal/medical ` +
        `matter; or it needs an account-specific action you cannot perform or ` +
        `verify. When in doubt about ordinary sales/support, prefer to reply ` +
        `(asking a clarifying question) rather than hand off. ${langRule}\n\n` +
        `Respond with ONLY a JSON object, no markdown, no prose: ` +
        `{"handoff": boolean, "reply": string|null, "reason": string}.`,
    });

    const task = `${contactLine}\n\nConversation so far:\n${transcript}`;

    // Autonomous reply → the tenant's effective tier (their choice, or the
    // platform default; forced fast when the super-admin kill-switch is set).
    const tier = resolveAiCapabilities(
      {
        ai_autonomous_tier: company.autonomousTier,
        ai_premium_locked: company.premiumLocked,
      },
      await this.platformSetting.getAutonomousTier(),
    ).tier;

    // No interactive semaphore here — this runs in the AI job worker, which is
    // already concurrency-bounded.
    const result = await this.llm.complete({
      tier,
      system,
      userText: task,
      images,
      maxTokens: 600,
      temperature: 0.3,
    });
    await this.metering.recordUsage(
      companyId,
      null,
      'autoreply',
      result.provider,
      tier,
      result.usage,
    );
    return this.parseDecision(result.text);
  }

  private parseDecision(raw: string): {
    reply: string | null;
    handoff: boolean;
    reason: string;
  } {
    // Strip code fences / surrounding prose; grab the first {...} block.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return { reply: null, handoff: true, reason: 'unparseable model output' };
    }
    try {
      const obj = JSON.parse(match[0]) as {
        handoff?: unknown;
        reply?: unknown;
        reason?: unknown;
      };
      const handoff = obj.handoff === true;
      const reply =
        typeof obj.reply === 'string' && obj.reply.trim()
          ? obj.reply.trim()
          : null;
      // If not a handoff but there's no usable reply, fail safe to handoff.
      if (!handoff && !reply) {
        return { reply: null, handoff: true, reason: 'empty reply' };
      }
      return {
        reply: handoff ? null : reply,
        handoff,
        reason: typeof obj.reason === 'string' ? obj.reason : '',
      };
    } catch {
      return { reply: null, handoff: true, reason: 'invalid JSON' };
    }
  }

  /** Parse the draft-order JSON with a fail-safe empty draft on any error. */
  private parseDraftOrder(raw: string): DraftOrderResult {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return EMPTY_DRAFT;
    try {
      const o = JSON.parse(match[0]) as Record<string, unknown>;
      const str = (v: unknown): string | null =>
        typeof v === 'string' && v.trim() ? v.trim() : null;

      const itemsRaw = Array.isArray(o.items) ? o.items : [];
      const items = itemsRaw
        .map((it) => {
          const rec = (it ?? {}) as Record<string, unknown>;
          const q = Number(rec.quantity);
          return {
            productQuery: str(rec.productQuery) ?? '',
            quantity: Number.isFinite(q) && q > 0 ? Math.floor(q) : 1,
          };
        })
        .filter((it) => it.productQuery.length > 0);

      const cust = (o.customer ?? {}) as Record<string, unknown>;
      const cc = str(cust.countryCode);
      const pm = str(o.paymentMethod);

      return {
        items,
        customer: {
          name: str(cust.name),
          phone: str(cust.phone),
          address1: str(cust.address1),
          city: str(cust.city),
          countryCode: cc ? cc.toUpperCase().slice(0, 2) : null,
        },
        paymentMethod: pm === 'cod' || pm === 'prepaid' ? pm : null,
        note: str(o.note),
        confidence: o.confidence === 'high' ? 'high' : 'low',
        missing: Array.isArray(o.missing)
          ? o.missing.filter((m): m is string => typeof m === 'string')
          : [],
        readyToCreate: o.readyToCreate === true,
        intent:
          o.intent === 'order_status'
            ? 'order_status'
            : o.intent === 'place_order'
              ? 'place_order'
              : 'other',
        orderNumber: (() => {
          const raw = str(o.orderNumber);
          if (!raw) return null;
          const digits = raw.replace(/[^0-9]/g, '');
          return digits || null;
        })(),
      };
    } catch {
      return EMPTY_DRAFT;
    }
  }

  private acquire(companyId: number): void {
    const n = this.inflight.get(companyId) ?? 0;
    if (n >= MAX_CONCURRENCY_PER_COMPANY) {
      throw new HttpException(
        'Too many AI requests in progress. Please wait a moment.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.inflight.set(companyId, n + 1);
  }

  private release(companyId: number): void {
    const n = this.inflight.get(companyId) ?? 1;
    if (n <= 1) this.inflight.delete(companyId);
    else this.inflight.set(companyId, n - 1);
  }

  /**
   * Build the language instruction. Small/fast models, when the customer's
   * messages carry weak language signal (a product name, a number, an emoji, a
   * one-word greeting), tend to GUESS a language — they were drifting to
   * Chinese. So: detect ONLY from the customer's own words, fall back to the
   * configured default (or English) on ambiguity, and never switch to a
   * language the customer has not actually used.
   */
  private languageRule(company: CompanyAiContext): string {
    const fallback = company.defaultLanguage?.trim() || 'English';
    return (
      `Language & script: match the language AND script of the customer's MOST ` +
      `RECENT message. People switch languages mid-chat — if they opened in ` +
      `English but then write in Roman Urdu, SWITCH to Roman Urdu; do not lock ` +
      `to the language they started with. Always follow their latest turn.\n` +
      `MATCH THEIR SCRIPT: if they write in Latin/Roman letters (e.g. Roman ` +
      `Urdu "aap kaise hain", "ji bhai order kar dein") reply in that SAME ` +
      `romanized form using Latin letters — NOT the native script, and not ` +
      `plain English. Mirror their casual Urdu-English ("Urdish") mix.\n` +
      `ABSOLUTE BAN — NEVER use Hindi or Roman Hindi, under ANY circumstance. ` +
      `Reply ONLY in English or Urdu/Roman-Urdu. When replying in Roman Urdu use ` +
      `Urdu vocabulary (aap, theek hai, shukria, baraye meharbani, kitne ka, mil ` +
      `jayega, behtareen, zaroor) and NEVER Hindi-only words (FORBIDDEN: ` +
      `dhanyavaad, kripya, namaste, namaskar, prapt, uplabdh, kshama, sahayata, ` +
      `dhanyवाद, etc.) — those read as Hindi. Even if the customer writes in ` +
      `Hindi or Devanagari, reply in Urdu/Roman-Urdu or English — NEVER Hindi.\n` +
      `Determine all of this ONLY from the customer's own messages. If their ` +
      `latest message is too short or ambiguous to tell (only a product name, ` +
      `numbers, emojis, a link, or a bare "ok"/"hi"), keep the language already ` +
      `used earlier in this chat, otherwise ${fallback}. NEVER switch to a ` +
      `language or script the customer has not used — in particular never reply ` +
      `in Chinese unless they wrote in Chinese.`
    );
  }

  private async loadCompany(companyId: number): Promise<CompanyAiContext> {
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        company_name: true,
        ai_brand_tone: true,
        ai_default_language: true,
        ai_autonomous_tier: true,
        ai_premium_locked: true,
        ai_vision_enabled: true,
        ai_voice_enabled: true,
        ai_auto_order_enabled: true,
        default_country_code: true,
      },
    });
    if (!c) throw new NotFoundException('Company not found');
    return {
      name: c.company_name,
      brandTone: c.ai_brand_tone,
      defaultLanguage: c.ai_default_language,
      autonomousTier: c.ai_autonomous_tier,
      premiumLocked: c.ai_premium_locked,
      visionEnabled: c.ai_vision_enabled,
      voiceEnabled: c.ai_voice_enabled,
      autoOrderEnabled: c.ai_auto_order_enabled,
      defaultCountryCode: c.default_country_code,
    };
  }

  private async loadKnowledge(companyId: number): Promise<string | null> {
    const entries = await this.prisma.aiKnowledgeBase.findMany({
      where: { company_id: companyId, enabled: true },
      orderBy: { title: 'asc' },
      select: { title: true, content: true },
    });
    if (entries.length === 0) return null;
    let out = '';
    for (const e of entries) {
      const block = `## ${e.title}\n${e.content}\n\n`;
      // Skip an entry that wouldn't fit, but keep adding the rest (a single
      // oversized entry must not drop every entry after it).
      if (out.length + block.length > KB_CHAR_BUDGET) continue;
      out += block;
    }
    return out.trim() || null;
  }

  /**
   * Build the knowledge context for a grounded answer: the tenant's manual KB
   * entries (small, always included) PLUS the RAG-retrieved product/policy
   * chunks most relevant to what the customer is asking. When embeddings are
   * unavailable (no OPENAI_API_KEY) retrieval returns null and this is just the
   * manual KB — exactly the previous behaviour. The combined text is bounded by
   * KB_CHAR_BUDGET (manual first, retrieval fills the rest).
   */
  private async buildKnowledge(
    companyId: number,
    query: string,
  ): Promise<string | null> {
    const manual = await this.loadKnowledge(companyId);
    let retrieved: string | null = null;
    try {
      const remaining =
        KB_CHAR_BUDGET - (manual ? manual.length + 2 : 0);
      if (remaining > 1000) {
        retrieved = await this.rag.retrieve(companyId, query, {
          maxChars: remaining,
        });
      }
    } catch {
      retrieved = null; // RAG must never break a reply
    }
    const parts = [manual, retrieved].filter((p): p is string => !!p);
    return parts.length ? parts.join('\n\n') : null;
  }

  private baseSystem(
    company: CompanyAiContext,
    knowledge: string | null,
  ): SystemBlock[] {
    const tone = company.brandTone
      ? ` Brand voice to match: ${company.brandTone}.`
      : '';
    const blocks: SystemBlock[] = [
      {
        text:
          `You are an AI copilot helping a human customer-support/sales agent at "${company.name}" ` +
          `reply to customers on WhatsApp. Be helpful, accurate, friendly and concise. ` +
          `Never invent facts, policies, order details or promises that are not supported ` +
          `by the conversation or the knowledge base. If you are unsure, say what to ask the customer ` +
          `instead of guessing.\n` +
          `PRICES & PRODUCT FACTS: only state a price, stock status, or product detail that appears ` +
          `VERBATIM in the knowledge base for that EXACT product. Never estimate, convert, round, or ` +
          `carry a price over from a different product. If a price or detail isn't in the knowledge ` +
          `base, say you'll confirm it rather than guess.\n` +
          `DISCOUNTS: State a discount, % off, or original price ONLY if it appears in the knowledge ` +
          `base / tool data for that EXACT product (a real compare-at price). Relay it VERBATIM in the ` +
          `form "{price} after {percent}% discount (original price {original})" — e.g. "Kids Duo is ` +
          `3346 after 7% discount (original price 3600)". NEVER calculate, derive, round, or invent a ` +
          `discount, percentage, or before/after price yourself. If the data shows no discount for that ` +
          `exact product, there is NO discount — only quote the current price.${tone}`,
      },
    ];
    if (knowledge) {
      blocks.push({
        // Cache the (large, stable) KB so repeat calls in the 5-min window are cheap.
        cache: true,
        text:
          `Company knowledge base. The product entries below are CANDIDATES that may match the ` +
          `customer's question — recommend ONLY the ones that genuinely match what they asked, and ` +
          `do NOT list unrelated products or other brands just because they appear here. You may ` +
          `suggest a bundle/multi-pack product if it clearly matches what they want; quote its price ` +
          `EXACTLY as written, and if a discount/original price is written for it, relay that verbatim ` +
          `too — never compute or invent a saving, percentage, or discount that isn't written here:` +
          `\n\n${knowledge}`,
      });
    }
    return blocks;
  }

  /**
   * Load a conversation (tenant-scoped) and render it as a transcript. When the
   * tenant has vision/voice enabled it ALSO: (a) transcribes recent inbound
   * voice notes via Whisper (cached on messages.transcription, metered once),
   * and (b) collects recent inbound images as base64 for vision models.
   */
  private async loadTranscript(
    companyId: number,
    conversationId: number,
    opts?: { windowHours?: number; episodeStartedAt?: Date | null },
  ): Promise<{
    transcript: string;
    contactLine: string;
    images: ImageInput[];
    /** Recent customer text → the RAG retrieval query. */
    customerQuery: string;
    /** True if any recent inbound message has real text/transcription. */
    hasCustomerText: boolean;
  }> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, company_id: companyId, deleted_at: null },
      select: {
        cleared_before: true,
        contact: { select: { name: true, phone: true, tags: true } },
        company: {
          select: {
            ai_vision_enabled: true,
            ai_voice_enabled: true,
            ai_premium_locked: true,
          },
        },
      },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');

    // Effective vision/voice = tenant's flag AND not killed by the super-admin
    // per-tenant lock (single source of truth in resolveAiCapabilities).
    const caps = resolveAiCapabilities(conversation.company ?? {}, 'fast');
    const visionOn = caps.vision;
    const voiceOn = caps.voice;

    // Lower-bound the transcript by the LATER of: the conversation's
    // cleared_before marker, (for autonomous callers) a recency window, and (for
    // the topic-aware orchestrator) the current EPISODE start. The episode bound
    // is what keeps a NEW commerce journey from seeing the previous one's
    // order/tracking replies — the core of the topic-aware refactor.
    const lowerMs = Math.max(
      conversation.cleared_before
        ? new Date(conversation.cleared_before).getTime()
        : 0,
      opts?.windowHours
        ? Date.now() - opts.windowHours * 3600_000
        : 0,
      opts?.episodeStartedAt
        ? new Date(opts.episodeStartedAt).getTime()
        : 0,
    );
    const messages = await this.prisma.message.findMany({
      where: {
        conversation_id: conversationId,
        company_id: companyId,
        ...(lowerMs ? { timestamp: { gt: new Date(lowerMs) } } : {}),
      },
      orderBy: { timestamp: 'desc' },
      take: CONTEXT_MESSAGE_LIMIT,
      select: {
        id: true,
        direction: true,
        message_type: true,
        content: true,
        media_url: true,
        transcription: true,
        context_message_id: true,
      },
    });

    // Rule 2 — NEVER feed templates (or replies to them) to the model. The
    // order-confirmation card is stored as message_type='template'; the
    // customer's Confirm/Cancel tap (and any context-linked auto-reply) carries
    // a context_message_id pointing back at that template. Both are conversation
    // NOISE that made the model loop and invent "payment pending" answers — strip
    // them so the AI only ever sees real customer/agent conversation.
    const templateIds = new Set(
      messages.filter((m) => m.message_type === 'template').map((m) => m.id),
    );
    const ordered = messages
      .filter(
        (m) =>
          m.message_type !== 'template' &&
          !(m.context_message_id && templateIds.has(m.context_message_id)),
      )
      .reverse();

    // Voice: transcribe recent inbound audio (lazy + cached) when enabled.
    if (voiceOn) {
      for (const m of ordered) {
        if (
          m.direction !== 'inbound' ||
          m.message_type !== 'audio' ||
          !m.media_url ||
          (m.content && m.content.trim()) ||
          (m.transcription && m.transcription.trim())
        ) {
          continue;
        }
        const result = await this.audio.transcribe(
          diskPathFromWeb(m.media_url),
        );
        if (result) {
          m.transcription = result.text;
          await this.prisma.message
            .update({
              where: { id: m.id },
              data: { transcription: result.text },
            })
            .catch(() => undefined);
          await this.metering.recordTranscription(
            companyId,
            Math.round(result.durationSec * WHISPER_MICROS_PER_SEC),
          );
        }
      }
    }

    const lines = ordered.map((m) => {
      const who = m.direction === 'inbound' ? 'Customer' : 'Agent';
      let body = m.content?.trim() ?? '';
      if (!body && m.message_type === 'audio' && m.transcription?.trim()) {
        body = `(voice note) ${m.transcription.trim()}`;
      }
      if (!body) {
        body = m.message_type === 'text' ? '(empty)' : `(sent ${m.message_type})`;
      }
      return `${who}: ${body}`;
    });

    // Vision: collect up to MAX_VISION_IMAGES most-recent inbound images.
    const images: ImageInput[] = [];
    if (visionOn) {
      for (let i = ordered.length - 1; i >= 0; i--) {
        if (images.length >= MAX_VISION_IMAGES) break;
        const m = ordered[i];
        if (
          m.direction !== 'inbound' ||
          m.message_type !== 'image' ||
          !m.media_url
        ) {
          continue;
        }
        const mime = imageMimeFromPath(m.media_url);
        if (!mime) continue;
        try {
          const disk = diskPathFromWeb(m.media_url);
          const stat = fs.statSync(disk);
          if (stat.size > IMAGE_MAX_BYTES) continue;
          const dataBase64 = fs.readFileSync(disk).toString('base64');
          images.push({ mime, dataBase64 });
        } catch {
          /* missing/expired file → skip */
        }
      }
      images.reverse(); // chronological order
    }

    const transcript = lines.join('\n') || '(no messages yet)';

    // RAG query: the last few customer (inbound) messages — what they're
    // actually asking about — used to retrieve the relevant product/policy
    // chunks. Falls back to the whole transcript tail if no inbound text.
    const customerTexts = ordered
      .filter((m) => m.direction === 'inbound')
      .map((m) => {
        const t = m.content?.trim() || m.transcription?.trim() || '';
        return t;
      })
      .filter((t) => t.length > 0);
    const customerQuery =
      customerTexts.slice(-3).join('\n') ||
      lines.slice(-4).join('\n');
    const hasCustomerText = customerTexts.length > 0;

    const contact = conversation.contact;
    const tags = Array.isArray(contact?.tags)
      ? (contact.tags as unknown[]).filter((t) => typeof t === 'string')
      : [];
    const contactLine =
      `Customer: ${contact?.name ?? 'Unknown'}` +
      (tags.length ? ` (tags: ${tags.join(', ')})` : '');

    return { transcript, contactLine, images, customerQuery, hasCustomerText };
  }
}
