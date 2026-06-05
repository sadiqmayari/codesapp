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
import { ImageInput, SystemBlock } from './providers/llm-provider.interface';
import { AiMeteringService } from './ai-metering.service';
import { AiRagService } from './ai-rag.service';
import {
  AudioTranscriptionService,
  WHISPER_MICROS_PER_SEC,
} from './audio-transcription.service';
import {
  AiFeature,
  CONTEXT_MESSAGE_LIMIT,
  KB_CHAR_BUDGET,
  ModelTier,
} from './ai.constants';
import { RewriteMode } from './dto/ai-actions.dto';

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
  ): Promise<DraftOrderResult> {
    const { transcript, contactLine, images, customerQuery } =
      await this.loadTranscript(companyId, conversationId);
    const company = await this.loadCompany(companyId);
    const system = this.baseSystem(
      company,
      await this.buildKnowledge(companyId, customerQuery),
    );

    system.push({
      text:
        `You extract a Shopify order draft from a WhatsApp support/sales chat. ` +
        `Use ONLY information actually stated in the conversation — never invent ` +
        `products, quantities, addresses, prices or a payment method. If a field ` +
        `was not stated, set it to null and add its name to "missing". For each ` +
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
        `Respond with ONLY a JSON object, no markdown, no prose:\n` +
        `{"items":[{"productQuery":string,"quantity":number}],` +
        `"customer":{"name":string|null,"phone":string|null,"address1":string|null,` +
        `"city":string|null,"countryCode":string|null},` +
        `"paymentMethod":"cod"|"prepaid"|null,` +
        `"note":string|null,"confidence":"high"|"low","missing":string[],` +
        `"readyToCreate":boolean}`,
    });

    const task = `${contactLine}\n\nConversation so far:\n${transcript}`;

    // Order extraction is an autonomous decision → use the super-admin tier.
    const tier = await this.platformSetting.getAutonomousTier();
    const { text } = await this.run(companyId, userId, 'draft_order', tier, {
      system,
      userText: task,
      images,
      maxTokens: 700,
      temperature: 0.2,
    });
    return this.parseDraftOrder(text);
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
  ): Promise<{ reply: string | null; handoff: boolean; reason: string }> {
    await this.metering.assertAllowed(companyId);
    const { transcript, contactLine, images, customerQuery } =
      await this.loadTranscript(companyId, conversationId);
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

    // Autonomous reply → super-admin-controlled tier (platform-wide).
    const tier = await this.platformSetting.getAutonomousTier();

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
      `Language & script: reply in the SAME language AND the same script/style ` +
      `the customer is using in their own messages. Crucially, MATCH THEIR ` +
      `SCRIPT: if they write a language in Latin/Roman letters — e.g. Roman ` +
      `Urdu ("aap kaise hain", "ji bhai order kar dein"), Roman Hindi, ` +
      `Roman Arabic — reply in that SAME romanized form using Latin letters, ` +
      `NOT in the native script (do not switch Roman Urdu to Urdu/Arabic ` +
      `script, and do not answer Roman Urdu in plain English). Mirror their ` +
      `mix too (e.g. casual Urdu-English "Urdish"). Determine all of this ONLY ` +
      `from the customer's own messages. If their messages are too short or ` +
      `ambiguous to tell (only a product name, numbers, emojis, a link, or a ` +
      `bare "ok"/"hi"), reply in ${fallback}. NEVER switch to a language or ` +
      `script the customer has not actually used — in particular never reply ` +
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
      },
    });
    if (!c) throw new NotFoundException('Company not found');
    return {
      name: c.company_name,
      brandTone: c.ai_brand_tone,
      defaultLanguage: c.ai_default_language,
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
          `Never invent facts, prices, policies, order details or promises that are not supported ` +
          `by the conversation or the knowledge base. If you are unsure, say what to ask the customer ` +
          `instead of guessing.${tone}`,
      },
    ];
    if (knowledge) {
      blocks.push({
        // Cache the (large, stable) KB so repeat calls in the 5-min window are cheap.
        cache: true,
        text: `Company knowledge base — use it to answer accurately:\n\n${knowledge}`,
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
  ): Promise<{
    transcript: string;
    contactLine: string;
    images: ImageInput[];
    /** Recent customer text → the RAG retrieval query. */
    customerQuery: string;
  }> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, company_id: companyId, deleted_at: null },
      select: {
        cleared_before: true,
        contact: { select: { name: true, phone: true, tags: true } },
        company: {
          select: { ai_vision_enabled: true, ai_voice_enabled: true },
        },
      },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');

    const visionOn = conversation.company?.ai_vision_enabled === true;
    const voiceOn = conversation.company?.ai_voice_enabled === true;

    const messages = await this.prisma.message.findMany({
      where: {
        conversation_id: conversationId,
        company_id: companyId,
        ...(conversation.cleared_before
          ? { timestamp: { gt: conversation.cleared_before } }
          : {}),
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
      },
    });

    const ordered = messages.slice().reverse();

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

    const contact = conversation.contact;
    const tags = Array.isArray(contact?.tags)
      ? (contact.tags as unknown[]).filter((t) => typeof t === 'string')
      : [];
    const contactLine =
      `Customer: ${contact?.name ?? 'Unknown'}` +
      (tags.length ? ` (tags: ${tags.join(', ')})` : '');

    return { transcript, contactLine, images, customerQuery };
  }
}
