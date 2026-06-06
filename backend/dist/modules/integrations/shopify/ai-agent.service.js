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
var AiAgentService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiAgentService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../prisma/prisma.service");
const job_queue_service_1 = require("../../../common/services/job-queue.service");
const ai_service_1 = require("../../ai/ai.service");
const ai_rag_service_1 = require("../../ai/ai-rag.service");
const ai_constants_1 = require("../../ai/ai.constants");
const inbox_service_1 = require("../../inbox/inbox.service");
const inbox_gateway_1 = require("../../inbox/inbox.gateway");
const send_message_dto_1 = require("../../inbox/dto/send-message.dto");
const shopify_service_1 = require("./shopify.service");
const AI_HANDOFF_LABEL = 'needs-human';
const HANDOFF_TOKEN = '[[HANDOFF]]';
let AiAgentService = AiAgentService_1 = class AiAgentService {
    constructor(prisma, jobQueue, ai, rag, shopify, inbox, gateway) {
        this.prisma = prisma;
        this.jobQueue = jobQueue;
        this.ai = ai;
        this.rag = rag;
        this.shopify = shopify;
        this.inbox = inbox;
        this.gateway = gateway;
        this.logger = new common_1.Logger(AiAgentService_1.name);
    }
    onModuleInit() {
        this.jobQueue.registerWorker('ai-agent', (p) => this.process(p), 2);
    }
    async enqueue(job) {
        try {
            await this.jobQueue.enqueue('ai-agent', job);
        }
        catch (e) {
            this.logger.warn(`ai-agent enqueue failed (convo ${job.conversationId}): ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    tools() {
        return [
            {
                name: 'search_products',
                description: 'Search the store catalogue for products matching the customer query. ' +
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
                description: "Look up an existing order's real status, payment and tracking by its " +
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
                description: "Get this customer's saved delivery address and recent orders (by their " +
                    'WhatsApp number). Use to offer their usual address or answer "my last order".',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'search_knowledge',
                description: 'Search the store knowledge base (shipping, returns, FAQ, policies, ' +
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
    async process(job) {
        let ctx;
        try {
            ctx = await this.ai.buildAgentContext(job.companyId, job.conversationId);
        }
        catch (e) {
            this.logger.warn(`ai-agent context load failed (convo ${job.conversationId}): ${e instanceof Error ? e.message : String(e)}`);
            return;
        }
        if (!ctx.hasCustomerText)
            return;
        const system = this.buildSystem(ctx);
        const userText = `${ctx.contactLine}\n\nConversation so far:\n${ctx.transcript}\n\n` +
            `Write the single next WhatsApp message to send the customer now. Use ` +
            `your tools to get accurate, live information before answering. If you ` +
            `genuinely should not handle this yourself (refund/return/cancellation of ` +
            `an existing order, complaint, payment dispute, the customer asks for a ` +
            `human, or anything sensitive), reply with EXACTLY ${HANDOFF_TOKEN} and ` +
            `nothing else.`;
        let text;
        try {
            const res = await this.ai.runAgent(job.companyId, 'autoreply', ctx.tier, {
                system,
                userText,
                tools: this.tools(),
                maxSteps: ai_constants_1.AI_AGENT_MAX_STEPS,
                maxTokens: 700,
                temperature: 0.3,
            }, (name, input) => this.executeTool(job, ctx, name, input));
            text = res.text;
        }
        catch (e) {
            if (e instanceof common_1.ForbiddenException)
                return;
            throw e;
        }
        if (!text || text.includes(HANDOFF_TOKEN)) {
            await this.handoff(job.companyId, job.conversationId, text ? 'agent requested handoff' : 'agent produced no reply');
            return;
        }
        try {
            await this.inbox.sendMessage(job.companyId, job.conversationId, {
                type: send_message_dto_1.SendMessageType.text,
                content: text,
            });
        }
        catch (e) {
            this.logger.debug(`ai-agent send failed (convo ${job.conversationId}) → handoff: ${e instanceof Error ? e.message : String(e)}`);
            await this.handoff(job.companyId, job.conversationId, 'send failed');
        }
    }
    async executeTool(job, ctx, name, input) {
        const str = (v) => (typeof v === 'string' ? v : '');
        try {
            if (name === 'search_products') {
                const hits = await this.shopify.searchProducts(job.companyId, str(input.query));
                if (!hits.length)
                    return 'No matching products found.';
                return JSON.stringify(hits.slice(0, 10).map((h) => ({
                    product: h.productTitle,
                    variant: h.variantTitle || undefined,
                    price: h.price,
                    inStock: h.available,
                    url: h.productUrl || undefined,
                })));
            }
            if (name === 'get_order_status') {
                const st = await this.shopify.getOrderStatus(job.companyId, str(input.order_number));
                if (st.error)
                    return 'Could not look up the order (lookup unavailable).';
                if (!st.found)
                    return 'No order found with that number.';
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
                if (!ctx.contactPhone)
                    return 'No phone number on file for this customer.';
                const c = await this.shopify.getCustomerOrders(job.companyId, ctx.contactPhone);
                if (!c.found)
                    return 'No previous customer record found.';
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
        }
        catch (e) {
            return `Tool error: ${e instanceof Error ? e.message : String(e)}`;
        }
        return 'Unknown tool.';
    }
    buildSystem(ctx) {
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
                text: `You are the AI assistant for the store "${ctx.companyName}", replying ` +
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
                text: `Language & script rule (follow exactly):\n${ctx.langRule}`,
            },
        ];
    }
    async handoff(companyId, conversationId, reason) {
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
            this.logger.log(`AI agent handoff for conversation ${conversationId}: ${reason}`);
        }
        catch (e) {
            this.logger.warn(`ai-agent handoff failed (convo ${conversationId}): ${e instanceof Error ? e.message : String(e)}`);
        }
    }
};
exports.AiAgentService = AiAgentService;
exports.AiAgentService = AiAgentService = AiAgentService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        job_queue_service_1.JobQueueService,
        ai_service_1.AiService,
        ai_rag_service_1.AiRagService,
        shopify_service_1.ShopifyService,
        inbox_service_1.InboxService,
        inbox_gateway_1.InboxGateway])
], AiAgentService);
//# sourceMappingURL=ai-agent.service.js.map