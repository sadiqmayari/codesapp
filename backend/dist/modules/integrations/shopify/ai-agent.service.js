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
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../../prisma/prisma.service");
const job_queue_service_1 = require("../../../common/services/job-queue.service");
const ai_service_1 = require("../../ai/ai.service");
const ai_rag_service_1 = require("../../ai/ai-rag.service");
const ai_constants_1 = require("../../ai/ai.constants");
const inbox_service_1 = require("../../inbox/inbox.service");
const inbox_gateway_1 = require("../../inbox/inbox.gateway");
const send_message_dto_1 = require("../../inbox/dto/send-message.dto");
const phone_1 = require("../../../common/utils/phone");
const shopify_service_1 = require("./shopify.service");
const AI_HANDOFF_LABEL = 'needs-human';
const AI_ORDER_LABEL = 'ai-order';
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
        const route = await this.loadRouteCtx(job, ctx);
        let triage;
        try {
            triage = await this.ai.classifyIntent(job.companyId, ctx.transcript);
        }
        catch (e) {
            if (e instanceof common_1.ForbiddenException)
                return;
            throw e;
        }
        if (triage.intent === 'escalate' || triage.wantsHuman) {
            await this.handoff(job.companyId, job.conversationId, `triage → handoff (${triage.intent}${triage.wantsHuman ? ', wants human' : ''})`);
            return;
        }
        let intent = triage.intent;
        if (route.orderInFlight && intent === 'order')
            intent = 'logistics';
        const specialist = this.buildSpecialist(intent, ctx, route);
        this.logger.log(`ai-agent convo ${job.conversationId}: ${triage.intent} → ${specialist.name}`);
        let text;
        try {
            const res = await this.ai.runAgent(job.companyId, 'autoreply', ctx.tier, {
                system: specialist.system,
                userText: this.buildUserText(ctx),
                tools: specialist.tools,
                maxSteps: specialist.maxSteps,
                maxTokens: 700,
                temperature: 0.3,
            }, (name, input) => this.executeTool(job, ctx, route, name, input));
            text = res.text;
        }
        catch (e) {
            if (e instanceof common_1.ForbiddenException)
                return;
            throw e;
        }
        if (!text || text.includes(HANDOFF_TOKEN)) {
            await this.handoff(job.companyId, job.conversationId, text ? `${specialist.name} requested handoff` : 'agent produced no reply');
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
    async loadRouteCtx(job, ctx) {
        const convo = await this.prisma.conversation.findFirst({
            where: { id: job.conversationId, company_id: job.companyId },
            select: {
                ai_autoreply: true,
                ai_order_created_at: true,
                company: {
                    select: {
                        ai_auto_order_enabled: true,
                        ai_auto_order_all_enabled: true,
                        ai_autoreply_enabled: true,
                    },
                },
            },
        });
        const orderInFlight = !!convo?.ai_order_created_at ||
            !!(await this.prisma.shopifyOrderMessage.findFirst({
                where: { conversation_id: job.conversationId, company_id: job.companyId },
                select: { id: true },
            }));
        const allChats = convo?.company?.ai_autoreply_enabled === true;
        const perChat = convo?.ai_autoreply;
        const effectiveAuto = perChat === false ? false : allChats || perChat === true;
        const scopeA = perChat === true;
        const scopeB = convo?.company?.ai_auto_order_all_enabled === true && effectiveAuto;
        const autoOrderEligible = convo?.company?.ai_auto_order_enabled === true && (scopeA || scopeB);
        return {
            orderInFlight,
            autoOrderEligible,
            defaultCountryCode: (ctx.defaultCountryCode || 'PK').toUpperCase().slice(0, 2),
        };
    }
    buildUserText(ctx) {
        return (`${ctx.contactLine}\n\nConversation so far:\n${ctx.transcript}\n\n` +
            `Write the single next WhatsApp message to send the customer now. Use ` +
            `your tools to get accurate, live information before answering. If you ` +
            `genuinely should not handle this yourself, reply with EXACTLY ` +
            `${HANDOFF_TOKEN} and nothing else.`);
    }
    buildSpecialist(intent, ctx, route) {
        const T = this.toolDefs();
        switch (intent) {
            case 'sales':
                return {
                    name: 'sales',
                    system: this.systemFor(ctx, `You are the SALES adviser. Help the customer choose and learn about ` +
                        `products. ALWAYS use search_products for any product, price, stock ` +
                        `or variant question — quote ONLY the exact price the tool returns. ` +
                        `Use search_knowledge for ingredients, usage, policies or FAQs. ` +
                        `Recommend only products that genuinely match what they asked; you ` +
                        `may suggest a relevant bundle/multi-pack but quote its exact price ` +
                        `only. If they decide to buy, start collecting order details ` +
                        `(product, quantity, name, phone, full address, city, payment).`),
                    tools: [T.search_products, T.search_knowledge],
                    maxSteps: ai_constants_1.AI_AGENT_MAX_STEPS,
                };
            case 'order': {
                const canCreate = route.autoOrderEligible;
                const orderRule = canCreate
                    ? `You can place the order yourself with create_order. Before calling ` +
                        `it: confirm the exact product(s) + quantity via search_products, and ` +
                        `make sure you have name, phone, FULL address, city and payment ` +
                        `method (COD/prepaid). Restate the final order to the customer and ` +
                        `only call create_order after they clearly say yes (ok/haan/ji/confirm ` +
                        `etc.). NEVER tell the customer the order is placed until create_order ` +
                        `has actually succeeded. Use get_shipping_rates if they ask about ` +
                        `delivery charges.`
                    : `You CANNOT place the order yourself here. Help the customer choose ` +
                        `the product (search_products for exact price/stock) and collect the ` +
                        `delivery details (product, quantity, name, phone, full address, city, ` +
                        `payment); a human will finalise the order.`;
                const tools = canCreate
                    ? [
                        T.search_products,
                        T.get_customer_history,
                        T.get_shipping_rates,
                        T.create_order,
                    ]
                    : [T.search_products, T.get_customer_history];
                return {
                    name: canCreate ? 'order' : 'order(collect)',
                    system: this.systemFor(ctx, `You are the ORDER-TAKING agent. ${orderRule} Offer the customer's ` +
                        `saved address with get_customer_history when helpful. Quote ONLY ` +
                        `prices returned by your tools — never compute totals or discounts.`),
                    tools,
                    maxSteps: ai_constants_1.AI_AGENT_MAX_STEPS,
                };
            }
            case 'logistics':
                return {
                    name: 'logistics',
                    system: this.systemFor(ctx, `You are the LOGISTICS / order-status agent. For "where is my order" ` +
                        `questions: ask for the order number if you don't have it, then use ` +
                        `get_order_status and report the REAL fulfilment/payment/tracking — ` +
                        `never guess a status, date or tracking number. Use ` +
                        `get_customer_history for "my last order". An order already placed ` +
                        `must NOT be re-confirmed or re-created; just answer the question.`),
                    tools: [T.get_order_status, T.get_customer_history],
                    maxSteps: ai_constants_1.AI_AGENT_MAX_STEPS,
                };
            case 'resolution':
                return {
                    name: 'resolution',
                    system: this.systemFor(ctx, `You are the RESOLUTION agent for returns, refunds, exchanges, ` +
                        `cancellations, wrong/damaged/missing items, billing disputes and ` +
                        `complaints. You do NOT perform refunds, returns, cancellations or ` +
                        `any money action yourself. You may look up the order with ` +
                        `get_order_status to acknowledge the issue and gather the order ` +
                        `number + reason. Once you understand the problem (or for anything ` +
                        `requiring a money/policy decision), reply with EXACTLY ` +
                        `${HANDOFF_TOKEN} so a human takes over. Be empathetic and brief.`),
                    tools: [T.get_order_status, T.get_customer_history],
                    maxSteps: 2,
                };
            case 'general':
            default:
                return {
                    name: 'general',
                    system: this.systemFor(ctx, `You are the front-desk agent. Greet warmly and find out what the ` +
                        `customer needs. For business info, hours, shipping or policy ` +
                        `questions use search_knowledge. A very short or punctuation-only ` +
                        `message ("?", "ok", an emoji) is NOT a reason to hand off — ask a ` +
                        `short, friendly clarifying question.`),
                    tools: [T.search_knowledge],
                    maxSteps: 2,
                };
        }
    }
    systemFor(ctx, roleText) {
        const tone = ctx.brandTone ? ` Brand voice to match: ${ctx.brandTone}.` : '';
        return [
            {
                text: `You are the AI assistant for the store "${ctx.companyName}", replying ` +
                    `to a customer on WhatsApp. You may reply WITHOUT human review. Be ` +
                    `genuinely helpful, accurate, friendly and concise.\n` +
                    `State ONLY prices and facts returned by your tools or the knowledge ` +
                    `base; NEVER invent or compute a price, discount, percentage or ` +
                    `before/after price (e.g. never "actual X, after 50% off Y"). If a tool ` +
                    `returns nothing, say you'll confirm rather than guess.\n` +
                    `Do NOT repeat greetings, your name, or information already sent — the ` +
                    `customer can see the whole chat; add only what is new and keep it ` +
                    `short.\n\n` +
                    `YOUR ROLE: ${roleText}${tone}`,
            },
            { text: `Language & script rule (follow exactly):\n${ctx.langRule}` },
        ];
    }
    toolDefs() {
        return {
            search_products: {
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
            get_order_status: {
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
            get_customer_history: {
                name: 'get_customer_history',
                description: "Get this customer's saved delivery address and recent orders (by their " +
                    'WhatsApp number). Use to offer their usual address or answer "my last order".',
                inputSchema: { type: 'object', properties: {} },
            },
            search_knowledge: {
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
            get_shipping_rates: {
                name: 'get_shipping_rates',
                description: 'Get the live delivery/shipping charges for a cart to a destination. ' +
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
            create_order: {
                name: 'create_order',
                description: 'Place the order in the store. ONLY call this after the customer has ' +
                    'confirmed the exact items + quantities and given name, phone, full ' +
                    'address, city and payment method (COD/prepaid). Creates a real order.',
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
    async executeTool(job, ctx, route, name, input) {
        const str = (v) => (typeof v === 'string' ? v.trim() : '');
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
            if (name === 'get_shipping_rates') {
                return this.toolShippingRates(job, route, input);
            }
            if (name === 'create_order') {
                return this.toolCreateOrder(job, ctx, route, input);
            }
        }
        catch (e) {
            return `Tool error: ${e instanceof Error ? e.message : String(e)}`;
        }
        return 'Unknown tool.';
    }
    async resolveLineItems(companyId, rawItems) {
        const items = Array.isArray(rawItems) ? rawItems : [];
        const out = [];
        for (const it of items) {
            const r = (it ?? {});
            const query = typeof r.query === 'string' ? r.query.trim() : '';
            const q = Number(r.quantity);
            const quantity = Number.isFinite(q) && q > 0 ? Math.floor(q) : 1;
            if (!query)
                continue;
            try {
                const hits = await this.shopify.searchProducts(companyId, query);
                if (hits[0])
                    out.push({ variantId: hits[0].variantId, quantity });
            }
            catch {
            }
        }
        return out;
    }
    async toolShippingRates(job, route, input) {
        const lineItems = await this.resolveLineItems(job.companyId, input.items);
        if (!lineItems.length)
            return 'Could not match those products to quote shipping.';
        const country = (typeof input.country_code === 'string' && input.country_code.trim()) ||
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
        return JSON.stringify(rates.map((r) => ({ title: r.title, amount: r.amount, currency: r.currencyCode })));
    }
    async toolCreateOrder(job, ctx, route, input) {
        const str = (v) => (typeof v === 'string' ? v.trim() : '');
        if (!route.autoOrderEligible) {
            return 'Order creation is not enabled for this chat. Collect the details; a human will place the order.';
        }
        if (route.orderInFlight) {
            return 'An order already exists for this conversation — do NOT create another. Help with status instead.';
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
        const missing = [];
        if (!Array.isArray(input.items) || !input.items.length)
            missing.push('product');
        if (!name)
            missing.push('name');
        if (!phoneRaw)
            missing.push('phone');
        if (!address1)
            missing.push('full address');
        if (!city)
            missing.push('city');
        if (missing.length) {
            return `Cannot create the order yet — still missing: ${missing.join(', ')}. Ask the customer for these before placing the order.`;
        }
        const lineItems = await this.resolveLineItems(job.companyId, input.items);
        if (!lineItems.length) {
            return 'None of the requested products could be found in the store. Ask the customer to clarify the product name.';
        }
        const claim = await this.prisma.conversation.updateMany({
            where: {
                id: job.conversationId,
                company_id: job.companyId,
                ai_order_created_at: null,
            },
            data: {
                ai_order_created_at: new Date(),
                ai_pending_order: client_1.Prisma.DbNull,
                ai_pending_order_at: null,
            },
        });
        if (claim.count === 0) {
            route.orderInFlight = true;
            return 'An order was just created for this conversation — do NOT create another.';
        }
        const phone = (0, phone_1.normalizePhone)(phoneRaw, country);
        let shippingLine;
        try {
            const rates = await this.shopify.getShippingRates(job.companyId, {
                lineItems,
                address1,
                city,
                countryCode: country,
            });
            const r = Array.isArray(rates) ? rates[0] : undefined;
            if (r)
                shippingLine = { title: r.title, price: parseFloat(r.amount) || 0 };
        }
        catch (e) {
            this.logger.warn(`agent order shipping-rate lookup failed (convo ${job.conversationId}): ${e instanceof Error ? e.message : String(e)}`);
        }
        try {
            const order = await this.shopify.createOrder(job.companyId, {
                lineItems,
                customerName: name,
                phone,
                address1,
                city,
                countryCode: country,
                note,
                tags: ['CodesApp', 'AI auto-order'],
                prepaid: payment === 'prepaid',
                shippingLine,
            });
            route.orderInFlight = true;
            await this.label(job.companyId, job.conversationId, AI_ORDER_LABEL);
            this.logger.log(`AI agent created Shopify order ${order.orderName} for conversation ${job.conversationId}`);
            return (`ORDER CREATED SUCCESSFULLY: ${order.orderName} (${payment === 'prepaid' ? 'Prepaid' : 'Cash on Delivery'}). Now write the customer a short, warm confirmation in their language ` +
                `telling them their order ${order.orderName} is placed and the team will ` +
                `follow up. Do NOT mention any price or total.`);
        }
        catch (e) {
            await this.prisma.conversation
                .updateMany({
                where: { id: job.conversationId, company_id: job.companyId },
                data: { ai_order_created_at: null },
            })
                .catch(() => undefined);
            return (`Order creation failed (${e instanceof Error ? e.message : String(e)}). Reply with EXACTLY ${HANDOFF_TOKEN} so a human can complete the order.`);
        }
    }
    async handoff(companyId, conversationId, reason) {
        try {
            await this.prisma.conversation.update({
                where: { id: conversationId },
                data: { status: 'pending', ai_autoreply: false },
            });
            await this.label(companyId, conversationId, AI_HANDOFF_LABEL);
            this.logger.log(`AI agent handoff for conversation ${conversationId}: ${reason}`);
        }
        catch (e) {
            this.logger.warn(`ai-agent handoff failed (convo ${conversationId}): ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    async label(companyId, conversationId, label) {
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