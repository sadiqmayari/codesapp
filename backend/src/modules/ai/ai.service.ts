import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from './llm.service';
import { SystemBlock } from './providers/llm-provider.interface';
import { AiMeteringService } from './ai-metering.service';
import {
  AiFeature,
  CONTEXT_MESSAGE_LIMIT,
  KB_CHAR_BUDGET,
  ModelTier,
} from './ai.constants';
import { RewriteMode } from './dto/ai-actions.dto';

/** Max concurrent AI calls per company (interactive — protects the process). */
const MAX_CONCURRENCY_PER_COMPANY = 3;

interface CompanyAiContext {
  name: string;
  brandTone: string | null;
  defaultLanguage: string | null;
}

@Injectable()
export class AiService {
  /** companyId → in-flight interactive AI calls. */
  private readonly inflight = new Map<number, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly metering: AiMeteringService,
  ) {}

  // ── Public features ──────────────────────────────────────────────────

  async suggestReply(
    companyId: number,
    userId: number | null,
    conversationId: number,
    instruction?: string,
  ): Promise<{ text: string }> {
    const { transcript, contactLine } = await this.loadTranscript(
      companyId,
      conversationId,
    );
    const company = await this.loadCompany(companyId);
    const system = this.baseSystem(company, await this.loadKnowledge(companyId));

    const langRule = this.languageRule(company);

    const task =
      `${contactLine}\n\nConversation so far:\n${transcript}\n\n` +
      `Write ONLY the next message the agent should send to the customer — ` +
      `no preamble, no quotes, no "Agent:" label. Be concise, helpful, and on-brand. ${langRule}` +
      (instruction ? `\n\nExtra instruction from the agent: ${instruction}` : '');

    return this.run(companyId, userId, 'suggest_reply', 'fast', {
      system,
      userText: task,
      maxTokens: 600,
      temperature: 0.5,
    });
  }

  async summarize(
    companyId: number,
    userId: number | null,
    conversationId: number,
  ): Promise<{ text: string }> {
    const { transcript, contactLine } = await this.loadTranscript(
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
      maxTokens: 500,
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
    const { transcript, contactLine } = await this.loadTranscript(
      companyId,
      conversationId,
    );
    const company = await this.loadCompany(companyId);
    const system = this.baseSystem(company, await this.loadKnowledge(companyId));

    const langRule = this.languageRule(company);

    system.push({
      text:
        `You are operating in AUTONOMOUS mode: your reply may be sent to the ` +
        `customer WITHOUT a human reviewing it. Therefore be conservative. ` +
        `Set "handoff" to true (and leave "reply" null) whenever ANY of these ` +
        `hold: the customer is angry/frustrated or asks for a human; the ` +
        `request needs an action you cannot verify (refund, cancellation, ` +
        `order change, payment, complaint, legal); you are not confident the ` +
        `answer is correct and supported by the knowledge base or conversation; ` +
        `or it would require promising something. Otherwise set "handoff" false ` +
        `and put the message to send in "reply". ${langRule}\n\n` +
        `Respond with ONLY a JSON object, no markdown, no prose: ` +
        `{"handoff": boolean, "reply": string|null, "reason": string}.`,
    });

    const task = `${contactLine}\n\nConversation so far:\n${transcript}`;

    // No interactive semaphore here — this runs in the AI job worker, which is
    // already concurrency-bounded.
    const result = await this.llm.complete({
      tier: 'fast',
      system,
      userText: task,
      maxTokens: 600,
      temperature: 0.3,
    });
    await this.metering.recordUsage(
      companyId,
      null,
      'autoreply',
      result.provider,
      'fast',
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
      `Language: determine the reply language ONLY from the customer's own ` +
      `messages in this conversation. If those messages are too short or ` +
      `ambiguous to be sure of the language (for example only a product name, ` +
      `numbers, emojis, a link, or a short greeting like "ok" or "hi"), reply ` +
      `in ${fallback}. NEVER reply in a language the customer has not clearly ` +
      `used themselves — in particular, do not switch to Chinese or any other ` +
      `language unless the customer actually wrote in it.`
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
      if (out.length + block.length > KB_CHAR_BUDGET) break;
      out += block;
    }
    return out.trim() || null;
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

  /** Load a conversation (tenant-scoped) and render it as a transcript. */
  private async loadTranscript(
    companyId: number,
    conversationId: number,
  ): Promise<{ transcript: string; contactLine: string }> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, company_id: companyId, deleted_at: null },
      select: {
        cleared_before: true,
        contact: { select: { name: true, phone: true, tags: true } },
      },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');

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
      select: { direction: true, message_type: true, content: true },
    });

    const lines = messages
      .reverse()
      .map((m) => {
        const who = m.direction === 'inbound' ? 'Customer' : 'Agent';
        let body = m.content?.trim() ?? '';
        if (!body) {
          body =
            m.message_type === 'text'
              ? '(empty)'
              : `(sent ${m.message_type})`;
        }
        return `${who}: ${body}`;
      });

    const transcript = lines.join('\n') || '(no messages yet)';
    const contact = conversation.contact;
    const tags = Array.isArray(contact?.tags)
      ? (contact.tags as unknown[]).filter((t) => typeof t === 'string')
      : [];
    const contactLine =
      `Customer: ${contact?.name ?? 'Unknown'}` +
      (tags.length ? ` (tags: ${tags.join(', ')})` : '');

    return { transcript, contactLine };
  }
}
