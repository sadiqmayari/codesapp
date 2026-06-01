"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const llm_service_1 = require("./llm.service");
const ai_metering_service_1 = require("./ai-metering.service");
const ai_constants_1 = require("./ai.constants");
const MAX_CONCURRENCY_PER_COMPANY = 3;
let AiService = class AiService {
    constructor(prisma, llm, metering) {
        this.prisma = prisma;
        this.llm = llm;
        this.metering = metering;
        this.inflight = new Map();
    }
    async suggestReply(companyId, userId, conversationId, instruction) {
        const { transcript, contactLine } = await this.loadTranscript(companyId, conversationId);
        const company = await this.loadCompany(companyId);
        const system = this.baseSystem(company, await this.loadKnowledge(companyId));
        const langRule = company.defaultLanguage
            ? `Reply in the same language the customer is using; if unclear, use ${company.defaultLanguage}.`
            : 'Reply in the same language the customer is using.';
        const task = `${contactLine}\n\nConversation so far:\n${transcript}\n\n` +
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
    async summarize(companyId, userId, conversationId) {
        const { transcript, contactLine } = await this.loadTranscript(companyId, conversationId);
        const task = `${contactLine}\n\nConversation:\n${transcript}\n\n` +
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
    async rewrite(companyId, userId, text, mode) {
        const company = await this.loadCompany(companyId);
        const instructions = {
            polite: 'Rewrite the message to be warm, polite and professional, keeping the meaning.',
            shorten: 'Rewrite the message to be shorter and clearer, keeping the meaning.',
            expand: 'Expand the message with a little more helpful detail and warmth, keeping the meaning.',
            fix: 'Fix spelling, grammar and punctuation. Keep the wording and tone as close to the original as possible.',
        };
        const toneLine = company.brandTone
            ? ` Match this brand voice: ${company.brandTone}.`
            : '';
        const task = `${instructions[mode]}${toneLine}\n\n` +
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
    async translate(companyId, userId, text, targetLang) {
        const task = `Translate the following message into ${targetLang}. ` +
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
    async run(companyId, userId, feature, tier, opts) {
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
            await this.metering.recordUsage(companyId, userId, feature, result.provider, tier, result.usage);
            return { text: result.text };
        }
        finally {
            this.release(companyId);
        }
    }
    async autoReplyDecision(companyId, conversationId) {
        await this.metering.assertAllowed(companyId);
        const { transcript, contactLine } = await this.loadTranscript(companyId, conversationId);
        const company = await this.loadCompany(companyId);
        const system = this.baseSystem(company, await this.loadKnowledge(companyId));
        const langRule = company.defaultLanguage
            ? `Reply in the same language the customer is using; if unclear, use ${company.defaultLanguage}.`
            : 'Reply in the same language the customer is using.';
        system.push({
            text: `You are operating in AUTONOMOUS mode: your reply may be sent to the ` +
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
        const result = await this.llm.complete({
            tier: 'fast',
            system,
            userText: task,
            maxTokens: 600,
            temperature: 0.3,
        });
        await this.metering.recordUsage(companyId, null, 'autoreply', result.provider, 'fast', result.usage);
        return this.parseDecision(result.text);
    }
    parseDecision(raw) {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) {
            return { reply: null, handoff: true, reason: 'unparseable model output' };
        }
        try {
            const obj = JSON.parse(match[0]);
            const handoff = obj.handoff === true;
            const reply = typeof obj.reply === 'string' && obj.reply.trim()
                ? obj.reply.trim()
                : null;
            if (!handoff && !reply) {
                return { reply: null, handoff: true, reason: 'empty reply' };
            }
            return {
                reply: handoff ? null : reply,
                handoff,
                reason: typeof obj.reason === 'string' ? obj.reason : '',
            };
        }
        catch {
            return { reply: null, handoff: true, reason: 'invalid JSON' };
        }
    }
    acquire(companyId) {
        const n = this.inflight.get(companyId) ?? 0;
        if (n >= MAX_CONCURRENCY_PER_COMPANY) {
            throw new common_1.HttpException('Too many AI requests in progress. Please wait a moment.', common_1.HttpStatus.TOO_MANY_REQUESTS);
        }
        this.inflight.set(companyId, n + 1);
    }
    release(companyId) {
        const n = this.inflight.get(companyId) ?? 1;
        if (n <= 1)
            this.inflight.delete(companyId);
        else
            this.inflight.set(companyId, n - 1);
    }
    async loadCompany(companyId) {
        const c = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: {
                company_name: true,
                ai_brand_tone: true,
                ai_default_language: true,
            },
        });
        if (!c)
            throw new common_1.NotFoundException('Company not found');
        return {
            name: c.company_name,
            brandTone: c.ai_brand_tone,
            defaultLanguage: c.ai_default_language,
        };
    }
    async loadKnowledge(companyId) {
        const entries = await this.prisma.aiKnowledgeBase.findMany({
            where: { company_id: companyId, enabled: true },
            orderBy: { title: 'asc' },
            select: { title: true, content: true },
        });
        if (entries.length === 0)
            return null;
        let out = '';
        for (const e of entries) {
            const block = `## ${e.title}\n${e.content}\n\n`;
            if (out.length + block.length > ai_constants_1.KB_CHAR_BUDGET)
                break;
            out += block;
        }
        return out.trim() || null;
    }
    baseSystem(company, knowledge) {
        const tone = company.brandTone
            ? ` Brand voice to match: ${company.brandTone}.`
            : '';
        const blocks = [
            {
                text: `You are an AI copilot helping a human customer-support/sales agent at "${company.name}" ` +
                    `reply to customers on WhatsApp. Be helpful, accurate, friendly and concise. ` +
                    `Never invent facts, prices, policies, order details or promises that are not supported ` +
                    `by the conversation or the knowledge base. If you are unsure, say what to ask the customer ` +
                    `instead of guessing.${tone}`,
            },
        ];
        if (knowledge) {
            blocks.push({
                cache: true,
                text: `Company knowledge base — use it to answer accurately:\n\n${knowledge}`,
            });
        }
        return blocks;
    }
    async loadTranscript(companyId, conversationId) {
        const conversation = await this.prisma.conversation.findFirst({
            where: { id: conversationId, company_id: companyId, deleted_at: null },
            select: {
                cleared_before: true,
                contact: { select: { name: true, phone: true, tags: true } },
            },
        });
        if (!conversation)
            throw new common_1.NotFoundException('Conversation not found');
        const messages = await this.prisma.message.findMany({
            where: {
                conversation_id: conversationId,
                company_id: companyId,
                ...(conversation.cleared_before
                    ? { timestamp: { gt: conversation.cleared_before } }
                    : {}),
            },
            orderBy: { timestamp: 'desc' },
            take: ai_constants_1.CONTEXT_MESSAGE_LIMIT,
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
            ? contact.tags.filter((t) => typeof t === 'string')
            : [];
        const contactLine = `Customer: ${contact?.name ?? 'Unknown'}` +
            (tags.length ? ` (tags: ${tags.join(', ')})` : '');
        return { transcript, contactLine };
    }
};
exports.AiService = AiService;
exports.AiService = AiService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        llm_service_1.LlmService,
        ai_metering_service_1.AiMeteringService])
], AiService);
//# sourceMappingURL=ai.service.js.map