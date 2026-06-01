import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AnthropicClientService,
  SystemBlock,
} from './anthropic-client.service';
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
    private readonly anthropic: AnthropicClientService,
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

    const langRule = company.defaultLanguage
      ? `Reply in the same language the customer is using; if unclear, use ${company.defaultLanguage}.`
      : 'Reply in the same language the customer is using.';

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
      const result = await this.anthropic.complete({
        tier,
        system: opts.system,
        messages: [{ role: 'user', content: opts.userText }],
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
      });
      await this.metering.recordUsage(
        companyId,
        userId,
        feature,
        tier,
        result.usage,
      );
      return { text: result.text };
    } finally {
      this.release(companyId);
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
