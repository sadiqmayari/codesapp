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
const fs = require("fs");
const path = require("path");
const prisma_service_1 = require("../../prisma/prisma.service");
const platform_setting_service_1 = require("../../common/services/platform-setting.service");
const llm_service_1 = require("./llm.service");
const ai_metering_service_1 = require("./ai-metering.service");
const audio_transcription_service_1 = require("./audio-transcription.service");
const ai_constants_1 = require("./ai.constants");
const MAX_CONCURRENCY_PER_COMPANY = 3;
const MAX_VISION_IMAGES = 3;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const STORAGE_DISK_ROOT = path.join(process.cwd(), '..');
function imageMimeFromPath(p) {
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
function diskPathFromWeb(mediaUrl) {
    return path.join(STORAGE_DISK_ROOT, mediaUrl.replace(/^\/+/, ''));
}
const EMPTY_DRAFT = {
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
let AiService = class AiService {
    constructor(prisma, llm, metering, platformSetting, audio) {
        this.prisma = prisma;
        this.llm = llm;
        this.metering = metering;
        this.platformSetting = platformSetting;
        this.audio = audio;
        this.inflight = new Map();
    }
    async suggestReply(companyId, userId, conversationId, instruction) {
        const { transcript, contactLine, images } = await this.loadTranscript(companyId, conversationId);
        const company = await this.loadCompany(companyId);
        const system = this.baseSystem(company, await this.loadKnowledge(companyId));
        const langRule = this.languageRule(company);
        const task = `${contactLine}\n\nConversation so far:\n${transcript}\n\n` +
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
    async summarize(companyId, userId, conversationId) {
        const { transcript, contactLine, images } = await this.loadTranscript(companyId, conversationId);
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
            images,
            maxTokens: 500,
            temperature: 0.3,
        });
    }
    async draftOrder(companyId, userId, conversationId) {
        const { transcript, contactLine, images } = await this.loadTranscript(companyId, conversationId);
        const company = await this.loadCompany(companyId);
        const system = this.baseSystem(company, await this.loadKnowledge(companyId));
        system.push({
            text: `You extract a Shopify order draft from a WhatsApp support/sales chat. ` +
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
                images: opts.images,
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
        const { transcript, contactLine, images } = await this.loadTranscript(companyId, conversationId);
        const company = await this.loadCompany(companyId);
        const system = this.baseSystem(company, await this.loadKnowledge(companyId));
        const langRule = this.languageRule(company);
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
        const tier = await this.platformSetting.getAutonomousTier();
        const result = await this.llm.complete({
            tier,
            system,
            userText: task,
            images,
            maxTokens: 600,
            temperature: 0.3,
        });
        await this.metering.recordUsage(companyId, null, 'autoreply', result.provider, tier, result.usage);
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
    parseDraftOrder(raw) {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match)
            return EMPTY_DRAFT;
        try {
            const o = JSON.parse(match[0]);
            const str = (v) => typeof v === 'string' && v.trim() ? v.trim() : null;
            const itemsRaw = Array.isArray(o.items) ? o.items : [];
            const items = itemsRaw
                .map((it) => {
                const rec = (it ?? {});
                const q = Number(rec.quantity);
                return {
                    productQuery: str(rec.productQuery) ?? '',
                    quantity: Number.isFinite(q) && q > 0 ? Math.floor(q) : 1,
                };
            })
                .filter((it) => it.productQuery.length > 0);
            const cust = (o.customer ?? {});
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
                    ? o.missing.filter((m) => typeof m === 'string')
                    : [],
                readyToCreate: o.readyToCreate === true,
            };
        }
        catch {
            return EMPTY_DRAFT;
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
    languageRule(company) {
        const fallback = company.defaultLanguage?.trim() || 'English';
        return (`Language: determine the reply language ONLY from the customer's own ` +
            `messages in this conversation. If those messages are too short or ` +
            `ambiguous to be sure of the language (for example only a product name, ` +
            `numbers, emojis, a link, or a short greeting like "ok" or "hi"), reply ` +
            `in ${fallback}. NEVER reply in a language the customer has not clearly ` +
            `used themselves — in particular, do not switch to Chinese or any other ` +
            `language unless the customer actually wrote in it.`);
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
                company: {
                    select: { ai_vision_enabled: true, ai_voice_enabled: true },
                },
            },
        });
        if (!conversation)
            throw new common_1.NotFoundException('Conversation not found');
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
            take: ai_constants_1.CONTEXT_MESSAGE_LIMIT,
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
        if (voiceOn) {
            for (const m of ordered) {
                if (m.direction !== 'inbound' ||
                    m.message_type !== 'audio' ||
                    !m.media_url ||
                    (m.content && m.content.trim()) ||
                    (m.transcription && m.transcription.trim())) {
                    continue;
                }
                const result = await this.audio.transcribe(diskPathFromWeb(m.media_url));
                if (result) {
                    m.transcription = result.text;
                    await this.prisma.message
                        .update({
                        where: { id: m.id },
                        data: { transcription: result.text },
                    })
                        .catch(() => undefined);
                    await this.metering.recordTranscription(companyId, Math.round(result.durationSec * audio_transcription_service_1.WHISPER_MICROS_PER_SEC));
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
        const images = [];
        if (visionOn) {
            for (let i = ordered.length - 1; i >= 0; i--) {
                if (images.length >= MAX_VISION_IMAGES)
                    break;
                const m = ordered[i];
                if (m.direction !== 'inbound' ||
                    m.message_type !== 'image' ||
                    !m.media_url) {
                    continue;
                }
                const mime = imageMimeFromPath(m.media_url);
                if (!mime)
                    continue;
                try {
                    const disk = diskPathFromWeb(m.media_url);
                    const stat = fs.statSync(disk);
                    if (stat.size > IMAGE_MAX_BYTES)
                        continue;
                    const dataBase64 = fs.readFileSync(disk).toString('base64');
                    images.push({ mime, dataBase64 });
                }
                catch {
                }
            }
            images.reverse();
        }
        const transcript = lines.join('\n') || '(no messages yet)';
        const contact = conversation.contact;
        const tags = Array.isArray(contact?.tags)
            ? contact.tags.filter((t) => typeof t === 'string')
            : [];
        const contactLine = `Customer: ${contact?.name ?? 'Unknown'}` +
            (tags.length ? ` (tags: ${tags.join(', ')})` : '');
        return { transcript, contactLine, images };
    }
};
exports.AiService = AiService;
exports.AiService = AiService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        llm_service_1.LlmService,
        ai_metering_service_1.AiMeteringService,
        platform_setting_service_1.PlatformSettingService,
        audio_transcription_service_1.AudioTranscriptionService])
], AiService);
//# sourceMappingURL=ai.service.js.map