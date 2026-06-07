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
const REORDER_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
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
        if (route.awaitingPaymentAt &&
            (route.latestInboundType === 'image' ||
                route.latestInboundType === 'document')) {
            try {
                await this.inbox.sendMessage(job.companyId, job.conversationId, {
                    type: send_message_dto_1.SendMessageType.text,
                    content: 'Shukria! Aap ki payment verify kar ke order confirm kar diya ' +
                        'jayega. Hamari team thori dair mein aap se raabta karegi.',
                });
            }
            catch {
            }
            await this.clearAwaitingPayment(job.conversationId);
            await this.handoff(job.companyId, job.conversationId, 'prepaid payment slip received → human verification');
            return;
        }
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
        if (triage.intent === 'closing') {
            await this.handleClosing(job, ctx, route);
            return;
        }
        if (route.aiClosedAt)
            await this.clearClosed(job.conversationId);
        const intent = triage.intent;
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
        if (!route.orderConfirmed && this.claimsOrderPlaced(text)) {
            this.logger.warn(`ai-agent convo ${job.conversationId}: blocked false "order placed" claim (no order created) → handoff`);
            try {
                await this.inbox.sendMessage(job.companyId, job.conversationId, {
                    type: send_message_dto_1.SendMessageType.text,
                    content: 'Aap ke order ki tafseelat mil gayi hain. Hamari team thori dair ' +
                        'mein aap ka order confirm kar degi. Shukria!',
                });
            }
            catch {
            }
            await this.handoff(job.companyId, job.conversationId, 'model claimed order placed without a real order');
            return;
        }
        if (await this.isLoopingReply(job, text)) {
            this.logger.log(`ai-agent convo ${job.conversationId}: suppressed near-duplicate reply`);
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
                ai_awaiting_payment_at: true,
                ai_closed_at: true,
                company: {
                    select: {
                        ai_auto_order_enabled: true,
                        ai_auto_order_all_enabled: true,
                        ai_autoreply_enabled: true,
                    },
                },
            },
        });
        const allChats = convo?.company?.ai_autoreply_enabled === true;
        const perChat = convo?.ai_autoreply;
        const effectiveAuto = perChat === false ? false : allChats || perChat === true;
        const scopeA = perChat === true;
        const scopeB = convo?.company?.ai_auto_order_all_enabled === true && effectiveAuto;
        const autoOrderEligible = convo?.company?.ai_auto_order_enabled === true && (scopeA || scopeB);
        const lastInbound = await this.prisma.message.findFirst({
            where: {
                conversation_id: job.conversationId,
                company_id: job.companyId,
                direction: 'inbound',
            },
            orderBy: { timestamp: 'desc' },
            select: { message_type: true },
        });
        return {
            autoOrderEligible,
            defaultCountryCode: (ctx.defaultCountryCode || 'PK').toUpperCase().slice(0, 2),
            awaitingPaymentAt: convo?.ai_awaiting_payment_at ?? null,
            latestInboundType: lastInbound?.message_type ?? null,
            aiClosedAt: convo?.ai_closed_at ?? null,
            orderConfirmed: false,
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
                        `When a customer names a product family, first list the matching ` +
                        `product NAMES (not bundles). Offer bundles/multi-packs when they ` +
                        `ask about a deal or discount. If a tool result has a discount, ` +
                        `present it EXACTLY as "{price} after {discountPercent}% discount ` +
                        `(original price {originalPrice})" — relay those numbers verbatim, ` +
                        `never compute or invent a discount. Use search_knowledge for ` +
                        `ingredients, usage, policies or FAQs. Recommend only products that ` +
                        `genuinely match what they asked. If they decide to buy, start ` +
                        `collecting order details (product, quantity, name, phone, full ` +
                        `address, city, payment).`),
                    tools: [T.search_products, T.search_knowledge, T.get_payment_details],
                    maxSteps: ai_constants_1.AI_AGENT_MAX_STEPS,
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
                    system: this.systemFor(ctx, `You are the ORDER-TAKING agent. ${orderRule}\nOffer the customer's ` +
                        `saved address with get_customer_history when helpful. Quote ONLY ` +
                        `prices/discounts returned by your tools — never compute a total, ` +
                        `saving or discount yourself.`),
                    tools,
                    maxSteps: ai_constants_1.AI_AGENT_MAX_STEPS,
                };
            }
            case 'logistics':
                return {
                    name: 'logistics',
                    system: this.systemFor(ctx, `You are the LOGISTICS / order-status agent. For "where is my order" ` +
                        `questions: ask for the order number if you don't have it, then use ` +
                        `get_order_status and report the REAL delivery status + tracking — ` +
                        `never guess a status, date or tracking number. NEVER mention ` +
                        `payment status or say "payment pending" — COD orders are unpaid by ` +
                        `design and that must not alarm the customer. Use ` +
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
                    `base; NEVER invent or compute a price. For a discount, relay the ` +
                    `tool's numbers verbatim as "{price} after {percent}% discount (original ` +
                    `price {original})" — never calculate or invent one.\n` +
                    `NEVER tell the customer an order is placed / received / confirmed ` +
                    `unless the create_order tool actually returned success in THIS turn. Do ` +
                    `not invent an order number, total, or tracking.\n` +
                    `Do NOT repeat greetings, your name, or information already sent — the ` +
                    `customer can see the whole chat; add only what is new and keep it ` +
                    `short.\n` +
                    `LANGUAGE: English or Urdu/Roman-Urdu ONLY. NEVER use Hindi or Roman ` +
                    `Hindi (forbidden: dhanyavaad, kripya, namaste, prapt, uplabdh, etc.) — ` +
                    `use Urdu (shukria, baraye meharbani) or English instead.\n\n` +
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
                description: "Look up an existing order's real delivery status and tracking by its " +
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
            get_payment_details: {
                name: 'get_payment_details',
                description: 'Get the store bank/account details to share for a prepaid/advance ' +
                    'payment (from the knowledge base). Use when the customer wants to pay ' +
                    'in advance / by bank transfer and needs the account.',
                inputSchema: { type: 'object', properties: {} },
            },
            create_order: {
                name: 'create_order',
                description: 'Finalise the order. For payment "cod" it creates a real COD order. For ' +
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
                    discountPercent: h.discountPercent ?? undefined,
                    originalPrice: h.compareAtPrice ?? undefined,
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
                    deliveryStatus: this.humanizeFulfillment(st.fulfillmentStatus),
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
            return `Cannot finalise the order yet — still missing: ${missing.join(', ')}. Ask the customer for these first.`;
        }
        const lineItems = await this.resolveLineItems(job.companyId, input.items);
        if (!lineItems.length) {
            return 'None of the requested products could be found in the store. Ask the customer to clarify the product name.';
        }
        if (payment === 'prepaid') {
            const bank = await this.fetchPaymentDetails(job.companyId);
            await this.setAwaitingPayment(job.conversationId);
            return (`PREPAID — DO NOT create an order and DO NOT say it is placed. Show the ` +
                `customer their order summary, then share these bank details and ask them ` +
                `to pay and SEND THE PAYMENT SLIP. A human will verify and finalise it.\n` +
                `Bank details:\n${bank ?? '(no bank details configured — tell them a human will share the account shortly and hand off)'}`);
        }
        const signature = this.cartSignature(lineItems);
        const cutoff = new Date(Date.now() - REORDER_DUPLICATE_WINDOW_MS);
        const claim = await this.prisma.conversation.updateMany({
            where: {
                id: job.conversationId,
                company_id: job.companyId,
                NOT: {
                    ai_last_order_signature: signature,
                    ai_order_created_at: { gt: cutoff },
                },
            },
            data: {
                ai_order_created_at: new Date(),
                ai_last_order_signature: signature,
                ai_pending_order: client_1.Prisma.DbNull,
                ai_pending_order_at: null,
            },
        });
        if (claim.count === 0) {
            route.orderConfirmed = true;
            return 'This exact order was just placed moments ago — do NOT create a duplicate. Tell the customer their order is already placed.';
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
                prepaid: false,
                shippingLine,
            });
            route.orderConfirmed = true;
            await this.label(job.companyId, job.conversationId, AI_ORDER_LABEL);
            this.logger.log(`AI agent created COD Shopify order ${order.orderName} for conversation ${job.conversationId}`);
            return (`ORDER CREATED SUCCESSFULLY: ${order.orderName} (Cash on Delivery). Now ` +
                `write the customer a short, warm confirmation in their language telling ` +
                `them their order ${order.orderName} is placed and the team will follow ` +
                `up. Do NOT mention any price or total.`);
        }
        catch (e) {
            await this.prisma.conversation
                .updateMany({
                where: { id: job.conversationId, company_id: job.companyId },
                data: { ai_order_created_at: null, ai_last_order_signature: null },
            })
                .catch(() => undefined);
            return (`Order creation failed (${e instanceof Error ? e.message : String(e)}). Reply with EXACTLY ${HANDOFF_TOKEN} so a human can complete the order.`);
        }
    }
    cartSignature(items) {
        return items
            .map((i) => `${i.variantId}x${i.quantity}`)
            .sort()
            .join(';');
    }
    humanizeFulfillment(s) {
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
    async fetchPaymentDetails(companyId) {
        try {
            const k = await this.rag.retrieve(companyId, 'bank account details for advance prepaid payment IBAN account title');
            return k && k.trim() ? k.trim() : null;
        }
        catch {
            return null;
        }
    }
    async setAwaitingPayment(conversationId) {
        await this.prisma.conversation
            .update({
            where: { id: conversationId },
            data: { ai_awaiting_payment_at: new Date() },
        })
            .catch(() => undefined);
    }
    async clearAwaitingPayment(conversationId) {
        await this.prisma.conversation
            .update({
            where: { id: conversationId },
            data: { ai_awaiting_payment_at: null },
        })
            .catch(() => undefined);
    }
    async handleClosing(job, ctx, route) {
        if (route.aiClosedAt)
            return;
        let text = '';
        try {
            const res = await this.ai.runAgent(job.companyId, 'autoreply', ctx.tier, {
                system: this.systemFor(ctx, `The customer is ENDING the conversation (a thank-you / sign-off; ` +
                    `nothing more is needed). Reply with ONE short, warm closing in ` +
                    `their language — a brief thanks / you're welcome. Do NOT ask a ` +
                    `question, do NOT offer further help, do NOT mention any order or ` +
                    `product. One short sentence only.`),
                userText: this.buildUserText(ctx),
                tools: [],
                maxSteps: 1,
                maxTokens: 80,
                temperature: 0.4,
            }, async () => 'Unknown tool.');
            text = res.text;
        }
        catch (e) {
            if (!(e instanceof common_1.ForbiddenException)) {
                this.logger.warn(`ai-agent closing reply failed (convo ${job.conversationId}): ${e instanceof Error ? e.message : String(e)}`);
            }
            await this.closeConversation(job);
            return;
        }
        if (text && !text.includes(HANDOFF_TOKEN)) {
            try {
                await this.inbox.sendMessage(job.companyId, job.conversationId, {
                    type: send_message_dto_1.SendMessageType.text,
                    content: text,
                });
            }
            catch {
            }
        }
        await this.closeConversation(job);
    }
    async closeConversation(job) {
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
    async clearClosed(conversationId) {
        await this.prisma.conversation
            .update({ where: { id: conversationId }, data: { ai_closed_at: null } })
            .catch(() => undefined);
    }
    async isLoopingReply(job, text) {
        const cur = this.tokenize(text);
        if (cur.size < 5)
            return false;
        const last = await this.prisma.message.findFirst({
            where: {
                conversation_id: job.conversationId,
                company_id: job.companyId,
                direction: 'outbound',
            },
            orderBy: { timestamp: 'desc' },
            select: { content: true },
        });
        if (!last?.content)
            return false;
        const prev = this.tokenize(last.content);
        if (prev.size < 5)
            return false;
        let inter = 0;
        for (const w of cur)
            if (prev.has(w))
                inter++;
        const union = cur.size + prev.size - inter;
        return union > 0 && inter / union >= 0.85;
    }
    claimsOrderPlaced(text) {
        const t = (text || '').toLowerCase();
        return (/(placed successfully|successfully placed|has been placed|been placed successfully|order (is|has been) (placed|created|confirmed))/i.test(t) ||
            /(order .{0,30}(place ho (gaya|gya|gai|chuka|chuki)|ban gaya|ban gya|bana diya|ban diya|create ho gaya|confirm ho (gaya|gya|chuka)))/i.test(t) ||
            /(aap ka|apka) order .{0,30}(place|ban|create|confirm)/i.test(t));
    }
    tokenize(s) {
        return new Set((s || '')
            .toLowerCase()
            .normalize('NFKC')
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .split(/\s+/)
            .filter(Boolean));
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