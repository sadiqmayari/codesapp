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
const company_status_service_1 = require("../../../common/services/company-status.service");
const platform_setting_service_1 = require("../../../common/services/platform-setting.service");
const router_service_1 = require("../../engagement/router.service");
const told_ledger_service_1 = require("../../engagement/told-ledger.service");
const work_item_service_1 = require("../../engagement/work-item.service");
const ai_service_1 = require("../../ai/ai.service");
const tickets_service_1 = require("../../tickets/tickets.service");
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
const WORKITEM_TYPE_TO_INTENT = {
    SALES: 'sales',
    ORDER: 'order',
    TRACKING: 'logistics',
    DISPUTE: 'resolution',
    SUPPORT: 'general',
};
const TOPIC_TO_INTENT = {
    NONE: 'general',
    SALES: 'sales',
    ORDER_CREATION: 'order',
    ORDER_TRACKING: 'logistics',
    DISPUTE: 'resolution',
    SUPPORT: 'general',
    HUMAN_HANDOFF: 'general',
};
const REORDER_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const HANDOFF_SLA_MS = 30 * 60 * 1000;
let AiAgentService = AiAgentService_1 = class AiAgentService {
    constructor(prisma, jobQueue, ai, rag, shopify, inbox, gateway, tickets, companyStatus, platformSetting, router, toldLedger, workItems) {
        this.prisma = prisma;
        this.jobQueue = jobQueue;
        this.ai = ai;
        this.rag = rag;
        this.shopify = shopify;
        this.inbox = inbox;
        this.gateway = gateway;
        this.tickets = tickets;
        this.companyStatus = companyStatus;
        this.platformSetting = platformSetting;
        this.router = router;
        this.toldLedger = toldLedger;
        this.workItems = workItems;
        this.logger = new common_1.Logger(AiAgentService_1.name);
        this.memCache = new Map();
        this.orderChains = new Map();
    }
    onModuleInit() {
        this.jobQueue.registerWorker('ai-agent', (p) => this.process(p), 2, 180);
    }
    async enqueue(job) {
        try {
            await this.jobQueue.enqueue('ai-agent', job, {
                serialKey: `conv:ai-agent:${job.conversationId}`,
            });
        }
        catch (e) {
            this.logger.warn(`ai-agent enqueue failed (convo ${job.conversationId}): ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    async process(job) {
        if (!(await this.companyStatus.isActive(job.companyId)))
            return;
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
        const wasClosed = route.aiClosedAt != null;
        if (wasClosed)
            await this.clearClosed(job.conversationId);
        let engRoutedItem = null;
        let engMode = 'off';
        try {
            if (await this.platformSetting.isEngagementEngineEnabled(job.companyId)) {
                engRoutedItem = await this.router.route({
                    companyId: job.companyId,
                    conversationId: job.conversationId,
                    messageId: job.messageId,
                    intent: triage.intent,
                    contactId: route.contactId,
                });
                engMode = await this.platformSetting.getEngagementMode();
                if (engMode === 'on' && engRoutedItem) {
                    route.engWorkItemId = engRoutedItem.id;
                }
            }
        }
        catch {
        }
        let intent;
        if (engMode === 'on' && engRoutedItem) {
            intent = WORKITEM_TYPE_TO_INTENT[engRoutedItem.type] ?? 'general';
        }
        else {
            const topicDecision = await this.applyTopicManager(job, ctx, route, triage, wasClosed);
            intent = topicDecision.intent;
            if (topicDecision.ctx)
                ctx = topicDecision.ctx;
            if (topicDecision.repeatForced && route.autoOrderEligible) {
                const res = await this.runRepeatOrder(job, ctx, route);
                if (res === 'handled')
                    return;
            }
        }
        if (intent === 'order' && route.autoOrderEligible) {
            const res = await this.runDeterministicOrder(job, ctx, route);
            if (res === 'handled')
                return;
        }
        if (intent === 'resolution') {
            await this.ensureDisputeTicket(job, route).catch(() => undefined);
        }
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
            await this.handoff(job.companyId, job.conversationId, text ? `${specialist.name} requested handoff` : 'agent produced no reply', route.engWorkItemId);
            return;
        }
        if (intent === 'order' && !route.orderConfirmed && this.claimsOrderPlaced(text)) {
            if (route.autoOrderEligible) {
                const recovered = await this.tryCreateFromDraft(job, ctx, route);
                if (recovered === 'created') {
                    this.logger.log(`ai-agent convo ${job.conversationId}: recovered a false "order placed" claim by creating the real order`);
                    return;
                }
            }
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
            await this.handoff(job.companyId, job.conversationId, 'model claimed order placed without a real order', route.engWorkItemId);
            return;
        }
        if (await this.isLoopingReply(job, text)) {
            this.logger.log(`ai-agent convo ${job.conversationId}: near-duplicate reply → regenerate`);
            let retry = '';
            try {
                const res = await this.ai.runAgent(job.companyId, 'autoreply', ctx.tier, {
                    system: specialist.system,
                    userText: this.buildUserText(ctx, `IMPORTANT: do NOT repeat any earlier reply you have already sent in ` +
                        `this chat. Say something new and useful, or briefly ask what else ` +
                        `you can help with.`),
                    tools: specialist.tools,
                    maxSteps: specialist.maxSteps,
                    maxTokens: 700,
                    temperature: 0.5,
                }, (name, input) => this.executeTool(job, ctx, route, name, input));
                retry = res.text;
            }
            catch (e) {
                if (e instanceof common_1.ForbiddenException)
                    return;
                retry = '';
            }
            if (!retry ||
                retry.includes(HANDOFF_TOKEN) ||
                (await this.isLoopingReply(job, retry))) {
                this.logger.log(`ai-agent convo ${job.conversationId}: suppressed near-duplicate reply`);
                return;
            }
            text = retry;
        }
        try {
            await this.inbox.sendMessage(job.companyId, job.conversationId, {
                type: send_message_dto_1.SendMessageType.text,
                content: text,
            });
        }
        catch (e) {
            this.logger.debug(`ai-agent send failed (convo ${job.conversationId}) → handoff: ${e instanceof Error ? e.message : String(e)}`);
            await this.handoff(job.companyId, job.conversationId, 'send failed', route.engWorkItemId);
        }
    }
    async loadRouteCtx(job, ctx) {
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
            select: {
                message_type: true,
                timestamp: true,
                content: true,
                transcription: true,
            },
        });
        const openTicket = await this.prisma.supportTicket.findFirst({
            where: {
                company_id: job.companyId,
                conversation_id: job.conversationId,
                status: { notIn: ['resolved', 'rejected'] },
            },
            select: { id: true },
        });
        const topic = convo?.ai_active_topic ?? 'NONE';
        return {
            autoOrderEligible,
            defaultCountryCode: (ctx.defaultCountryCode || 'PK').toUpperCase().slice(0, 2),
            awaitingPaymentAt: convo?.ai_awaiting_payment_at ?? null,
            latestInboundType: lastInbound?.message_type ?? null,
            latestInboundAt: lastInbound?.timestamp ?? null,
            latestInboundText: (lastInbound?.content?.trim() ||
                lastInbound?.transcription?.trim() ||
                '').slice(0, 300),
            aiClosedAt: convo?.ai_closed_at ?? null,
            activeTopic: topic,
            topicExpiresAt: convo?.ai_topic_expires_at ?? null,
            episodeStartedAt: convo?.ai_episode_started_at ?? null,
            pendingOrderExists: convo?.ai_pending_order != null,
            openTicketExists: !!openTicket,
            contactId: convo?.contact_id ?? null,
            orderConfirmed: false,
            engWorkItemId: null,
        };
    }
    async applyTopicManager(job, ctx, route, triage, wasClosed) {
        const now = new Date();
        const current = route.activeTopic;
        const trackingExpired = current === 'ORDER_TRACKING' &&
            !!route.topicExpiresAt &&
            now.getTime() > new Date(route.topicExpiresAt).getTime();
        const effectiveCurrent = trackingExpired ? 'NONE' : current;
        const repeat = this.detectRepeatOrder(route.latestInboundText);
        const repeatForced = repeat.match && route.autoOrderEligible && (await this.hasPriorOrder(job, ctx));
        let newTopic = repeatForced
            ? 'ORDER_CREATION'
            : ai_constants_1.INTENT_TO_TOPIC[triage.intent] ?? 'SUPPORT';
        let startNewEpisode = false;
        if (effectiveCurrent === 'NONE' || !route.episodeStartedAt) {
            startNewEpisode = true;
        }
        else if (wasClosed) {
            startNewEpisode = true;
        }
        else if (newTopic !== effectiveCurrent) {
            const protectedMidFlow = (effectiveCurrent === 'ORDER_CREATION' && route.pendingOrderExists) ||
                (effectiveCurrent === 'DISPUTE' && route.openTicketExists);
            if (protectedMidFlow &&
                !repeatForced &&
                triage.score < ai_constants_1.TOPIC_OVERRIDE_CONFIDENCE) {
                newTopic = effectiveCurrent;
            }
            else {
                startNewEpisode = true;
            }
        }
        const intent = repeatForced ? 'order' : TOPIC_TO_INTENT[newTopic];
        let episodeStart = route.episodeStartedAt;
        const data = {};
        if (startNewEpisode) {
            episodeStart = route.latestInboundAt
                ? new Date(new Date(route.latestInboundAt).getTime() - 1)
                : new Date(now.getTime() - 1000);
            data.ai_episode_started_at = episodeStart;
            data.ai_active_topic = newTopic;
            data.ai_topic_started_at = now;
            data.ai_topic_expires_at =
                newTopic === 'ORDER_TRACKING'
                    ? new Date(now.getTime() + ai_constants_1.TRACKING_TOPIC_TTL_MS)
                    : null;
            if (effectiveCurrent === 'ORDER_CREATION' && newTopic !== 'ORDER_CREATION') {
                data.ai_pending_order = client_1.Prisma.DbNull;
                data.ai_pending_order_at = null;
                data.ai_awaiting_payment_at = null;
                route.pendingOrderExists = false;
                route.awaitingPaymentAt = null;
            }
            if (newTopic !== 'ORDER_TRACKING')
                data.ai_linked_order_id = null;
        }
        else if (newTopic === 'ORDER_TRACKING') {
            data.ai_topic_expires_at = new Date(now.getTime() + ai_constants_1.TRACKING_TOPIC_TTL_MS);
        }
        if (Object.keys(data).length) {
            await this.prisma.conversation
                .update({ where: { id: job.conversationId }, data })
                .catch(() => undefined);
        }
        route.activeTopic = newTopic;
        route.episodeStartedAt = episodeStart ?? null;
        let newCtx;
        if (startNewEpisode && episodeStart) {
            try {
                newCtx = await this.ai.buildAgentContext(job.companyId, job.conversationId, episodeStart);
            }
            catch {
                newCtx = undefined;
            }
        }
        this.logger.log(`ai-agent convo ${job.conversationId}: topic ${current}->${newTopic}` +
            `${startNewEpisode ? ' (new episode)' : ''}` +
            `${repeatForced ? ' [repeat]' : ''} score=${triage.score}`);
        return { intent, ctx: newCtx, repeatForced };
    }
    detectRepeatOrder(text) {
        const t = (text || '').toLowerCase().trim();
        if (!t)
            return { match: false, quantity: null };
        const strong = /(same again|order again|re-?order|repeat (my |the )?order|same order|usual order|same as (last|before)|(dobara|dubara|dubra|phir se|wapis|wapas)\s*(order|mangwa|chahiy|chahiye|bhej)|order\s*(dobara|phir se|again)|same\s*(cheez|product|products|item|items)\s*(again|dobara|phir))/i;
        let match = strong.test(t);
        let quantity = null;
        const moreQty = t.match(/\b(\d{1,3})\s*(more|aur)\b/);
        if (moreQty) {
            match = true;
            const q = parseInt(moreQty[1], 10);
            if (q > 0 && q < 1000)
                quantity = q;
        }
        if (/\b(send|bhej|de)\s*(me\s*)?(\d{1,3}\s*)?more\b/i.test(t))
            match = true;
        return { match, quantity };
    }
    async hasPriorOrder(job, ctx) {
        if (!ctx.contactPhone)
            return false;
        try {
            const c = await this.shopify.getCustomerOrders(job.companyId, ctx.contactPhone);
            return c.found && c.orders.length > 0;
        }
        catch {
            return false;
        }
    }
    async loadCustomerMemory(companyId, ctx) {
        const mem = {
            name: ctx.contactName,
            phone: ctx.contactPhone,
            email: null,
            address1: null,
            city: null,
            countryCode: null,
        };
        if (!ctx.contactPhone)
            return mem;
        const key = `${companyId}:${ctx.contactPhone}`;
        const cached = this.memCache.get(key);
        if (cached && Date.now() - cached.at < 5 * 60 * 1000)
            return cached.mem;
        try {
            const last = await this.shopify.getLastOrderItems(companyId, ctx.contactPhone);
            if (last.found) {
                if (!mem.name && last.name)
                    mem.name = last.name;
                if (last.shipping) {
                    if (!mem.name && last.shipping.name)
                        mem.name = last.shipping.name;
                    if (!mem.phone && last.shipping.phone)
                        mem.phone = last.shipping.phone;
                    mem.address1 = last.shipping.address1 ?? null;
                    mem.city = last.shipping.city ?? null;
                    mem.countryCode = last.shipping.countryCode ?? null;
                }
            }
        }
        catch {
        }
        this.memCache.set(key, { at: Date.now(), mem });
        return mem;
    }
    async runRepeatOrder(job, ctx, route) {
        if (!ctx.contactPhone)
            return 'collect';
        let last;
        try {
            last = await this.shopify.getLastOrderItems(job.companyId, ctx.contactPhone);
        }
        catch {
            return 'collect';
        }
        if (!last.found || !last.items.length)
            return 'collect';
        const mem = await this.loadCustomerMemory(job.companyId, ctx);
        const country = (mem.countryCode || route.defaultCountryCode || 'PK')
            .toUpperCase()
            .slice(0, 2);
        const repeat = this.detectRepeatOrder(route.latestInboundText);
        const items = last.items.map((i) => ({
            productQuery: i.title,
            quantity: repeat.quantity && last.items.length === 1 ? repeat.quantity : i.quantity,
        }));
        const name = (mem.name || '').trim();
        const phoneRaw = (mem.phone || '').trim();
        const address1 = (mem.address1 || '').trim();
        const city = (mem.city || '').trim();
        const draft = {
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
            const summary = await this.safeComposeSummary(job, draft, name, phoneRaw, address1, city, 'cod');
            await this.send(job, summary);
        }
        else {
            await this.send(job, `Aap apna pichla order dobara mangwana chahte hain:\n\n${itemsLine}\n\n` +
                `Baraye meharbani delivery details (naam, phone, poora pata, sheher) ` +
                `bhej dein taake hum order confirm kar dein.`);
        }
        return 'handled';
    }
    orderConfidence(f) {
        let score = 0;
        const weak = [];
        if (f.lineItems.length && f.lineItems.every((i) => i.quantity > 0))
            score += 30;
        else
            weak.push('product');
        if (f.name)
            score += 10;
        else
            weak.push('name');
        if ((f.phone.match(/\d/g)?.length ?? 0) >= 8)
            score += 15;
        else
            weak.push('phone');
        if (f.address1)
            score += 15;
        else
            weak.push('full address');
        if (f.city)
            score += 10;
        else
            weak.push('city');
        if (f.explicitConfirm)
            score += 10;
        if (f.paymentClear)
            score += 5;
        if (f.draftConfidenceHigh)
            score += 5;
        return { score, weak };
    }
    async ensureDisputeTicket(job, route) {
        if (route.contactId == null)
            return;
        const { ticket, created } = await this.tickets.createOrReuseForConversation(job.companyId, {
            conversationId: job.conversationId,
            contactId: route.contactId,
            type: this.guessDisputeType(route.latestInboundText),
            createdBy: 'ai',
            description: route.latestInboundText || undefined,
        });
        if (created) {
            await this.label(job.companyId, job.conversationId, 'dispute');
        }
        const isPhoto = route.latestInboundType === 'image' ||
            route.latestInboundType === 'document';
        if (isPhoto) {
            await this.tickets.addEvent(job.companyId, ticket.id, {
                kind: 'photo_received',
                actor: 'customer',
                body: '(customer sent an image/document)',
            });
        }
        else if (route.latestInboundText) {
            await this.tickets.addEvent(job.companyId, ticket.id, {
                kind: 'note',
                actor: 'customer',
                body: route.latestInboundText,
            });
        }
    }
    guessDisputeType(text) {
        const t = (text || '').toLowerCase();
        if (/\brefund|paisa wapis|paise wapis\b/.test(t))
            return 'refund';
        if (/\breturn|wapis kar|wapas kar\b/.test(t))
            return 'return';
        if (/\bexchange|badal|tabdeel\b/.test(t))
            return 'exchange';
        if (/\bbroken|damaged|toota|kharab|tuta\b/.test(t))
            return 'damaged';
        if (/\bwrong|ghalat|galat\b/.test(t))
            return 'wrong_item';
        if (/\bmissing|nahi mila|nahi aaya|nahin aya\b/.test(t))
            return 'missing';
        return 'complaint';
    }
    buildUserText(ctx, extra) {
        return (`${ctx.contactLine}\n\nConversation so far:\n${ctx.transcript}\n\n` +
            `PRIORITY: the CUSTOMER'S LAST message is the directive — answer THAT. The ` +
            `earlier lines are recent context (lower priority); do not act on them ` +
            `unless the last message refers to them, and never re-raise an older order ` +
            `or topic the customer has moved on from.\n` +
            (extra ? `${extra}\n` : '') +
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
                        `product NAMES (not bundles). When they ask about a SPECIFIC product ` +
                        `by name, answer with THAT exact product's own price + availability ` +
                        `from search_products — never substitute a bundle/kit, and NEVER say a ` +
                        `product is "only available as part of a bundle" if search_products ` +
                        `returns it as its own product. Mention a bundle ONLY as an optional ` +
                        `add-on, clearly labelled as separate. A request for a "VIP/special ` +
                        `discount" is NOT a reason to switch the customer to a discounted ` +
                        `bundle — quote the asked product's real price and only a discount ` +
                        `that genuinely applies to it. Offer bundles/multi-packs when they ` +
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
                        `${HANDOFF_TOKEN} so a human reviews and decides. Be empathetic and brief.`),
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
                    `NEVER invent product usage, dosage, directions, application method, or ` +
                    `medical/health advice. State usage/dosage/ingredients ONLY if they appear ` +
                    `in a tool result or the knowledge base. If that information is not ` +
                    `available to you, do NOT guess — ask the customer to follow the ` +
                    `directions on the product packaging/label and offer to connect them with ` +
                    `the team. (An oral supplement/vitamin is NOT "for external use" — when ` +
                    `unsure how a product is used, DEFER, never invent instructions.)\n` +
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
                        email: {
                            type: 'string',
                            description: "Customer email if they gave one in the chat (else omit)",
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
                const deliveryStatus = this.humanizeFulfillment(st.fulfillmentStatus);
                const tracking = (st.tracking ?? [])
                    .map((t) => [t.company, t.number, t.url].filter(Boolean).join(' '))
                    .filter(Boolean);
                if (route.engWorkItemId) {
                    const { alreadyTold } = await this.toldLedger.noteAndCheck(job.companyId, route.engWorkItemId, `order_status:${st.name}`, `${deliveryStatus}|${tracking.join(',')}`);
                    if (alreadyTold) {
                        return JSON.stringify({
                            order: st.name,
                            deliveryStatus,
                            tracking,
                            note: 'You have ALREADY told the customer this exact status earlier in this chat. Do NOT repeat it verbatim — acknowledge briefly and ask if they need anything else, unless they explicitly ask again.',
                        });
                    }
                }
                return JSON.stringify({ order: st.name, deliveryStatus, tracking });
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
                const best = this.pickBestVariant(query, hits);
                if (best)
                    out.push({ variantId: best.variantId, quantity });
            }
            catch {
            }
        }
        return out;
    }
    pickBestVariant(query, hits) {
        if (!hits.length)
            return undefined;
        const norm = (s) => (s || '')
            .toLowerCase()
            .normalize('NFKC')
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .trim();
        const qNorm = norm(query);
        const qTokens = qNorm.split(/\s+/).filter((w) => w.length > 1);
        if (!qTokens.length)
            return hits[0];
        let best = hits[0];
        let bestScore = -Infinity;
        hits.forEach((h, idx) => {
            const titleTokens = new Set(norm(`${h.productTitle} ${h.variantTitle}`).split(/\s+/).filter(Boolean));
            let overlap = 0;
            for (const t of qTokens)
                if (titleTokens.has(t))
                    overlap++;
            let score = overlap / qTokens.length;
            if (norm(h.productTitle) === qNorm)
                score += 1;
            score -= idx * 1e-4;
            if (score > bestScore) {
                bestScore = score;
                best = h;
            }
        });
        return best;
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
        const email = this.validEmail(str(input.email));
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
        const phone = (0, phone_1.normalizePhone)(phoneRaw, country);
        const conf = this.orderConfidence({
            lineItems,
            name,
            phone,
            address1,
            city,
            paymentClear: true,
            explicitConfirm: true,
            draftConfidenceHigh: true,
        });
        if (conf.score < ai_constants_1.ORDER_CONFIDENCE_MIN) {
            return (`Order details are not confident enough to place yet (${conf.score}%). ` +
                `Confirm these with the customer first: ${conf.weak.join(', ')}. Do NOT ` +
                `create the order until they are clear.`);
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
            return (`Order creation failed (${r.error}). Reply with EXACTLY ${HANDOFF_TOKEN} ` +
                `so a human can complete the order.`);
        }
        return (`ORDER CREATED SUCCESSFULLY: ${r.orderName} (Cash on Delivery). Now write ` +
            `the customer a short, warm confirmation in their language telling them ` +
            `their order ${r.orderName} is placed and the team will follow up. Do NOT ` +
            `mention any price or total.`);
    }
    async withOrderLock(conversationId, fn) {
        const prev = this.orderChains.get(conversationId) ?? Promise.resolve();
        let release;
        const done = new Promise((res) => (release = res));
        const tail = prev.then(() => done);
        this.orderChains.set(conversationId, tail);
        await prev.catch(() => undefined);
        try {
            return await fn();
        }
        finally {
            release();
            if (this.orderChains.get(conversationId) === tail) {
                this.orderChains.delete(conversationId);
            }
        }
    }
    async placeCodOrder(job, route, f) {
        return this.withOrderLock(job.conversationId, () => this.placeCodOrderLocked(job, route, f));
    }
    async placeCodOrderLocked(job, route, f) {
        const signature = this.cartSignature(f.lineItems);
        const cutoff = new Date(Date.now() - REORDER_DUPLICATE_WINDOW_MS);
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
        let shippingLine;
        try {
            const rates = await this.shopify.getShippingRates(job.companyId, {
                lineItems: f.lineItems,
                address1: f.address1,
                city: f.city,
                countryCode: f.country,
            });
            const r0 = Array.isArray(rates) ? rates[0] : undefined;
            if (r0)
                shippingLine = { title: r0.title, price: parseFloat(r0.amount) || 0 };
        }
        catch (e) {
            this.logger.warn(`agent order shipping-rate lookup failed (convo ${job.conversationId}): ${e instanceof Error ? e.message : String(e)}`);
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
            await this.prisma.conversation
                .updateMany({
                where: { id: job.conversationId, company_id: job.companyId },
                data: {
                    ai_order_created_at: new Date(),
                    ai_last_order_signature: signature,
                    ai_pending_order: client_1.Prisma.DbNull,
                    ai_pending_order_at: null,
                },
            })
                .catch(() => undefined);
            route.orderConfirmed = true;
            await this.label(job.companyId, job.conversationId, AI_ORDER_LABEL);
            this.logger.log(`AI agent created COD Shopify order ${order.orderName} for conversation ${job.conversationId}`);
            return { status: 'created', orderName: order.orderName };
        }
        catch (e) {
            return {
                status: 'failed',
                error: e instanceof Error ? e.message : String(e),
            };
        }
    }
    cartSignature(items) {
        return items
            .map((i) => `${i.variantId}x${i.quantity}`)
            .sort()
            .join(';');
    }
    async runDeterministicOrder(job, ctx, route) {
        let draft;
        try {
            draft = await this.ai.draftOrder(job.companyId, null, job.conversationId, route.episodeStartedAt);
        }
        catch {
            return 'collect';
        }
        const convo = await this.prisma.conversation.findFirst({
            where: { id: job.conversationId, company_id: job.companyId },
            select: {
                ai_pending_order: true,
                ai_pending_order_at: true,
                contact: { select: { name: true, phone: true, email: true } },
            },
        });
        const storedPending = this.parsePendingDraft(convo?.ai_pending_order);
        const storedFresh = !!convo?.ai_pending_order_at &&
            Date.now() - new Date(convo.ai_pending_order_at).getTime() < PENDING_TTL_MS;
        if (storedFresh &&
            storedPending &&
            storedPending.items.length &&
            (draft.intent !== 'place_order' || draft.items.length === 0)) {
            draft = { ...storedPending, intent: 'place_order' };
        }
        if (draft.intent !== 'place_order')
            return 'collect';
        const mem = await this.loadCustomerMemory(job.companyId, ctx);
        const country = (draft.customer.countryCode || mem.countryCode || route.defaultCountryCode || 'PK')
            .toUpperCase()
            .slice(0, 2);
        const name = (draft.customer.name || convo?.contact?.name || mem.name || '').trim();
        const phoneRaw = (draft.customer.phone || convo?.contact?.phone || mem.phone || '').trim();
        const address1 = (draft.customer.address1 || mem.address1 || '').trim();
        const city = (draft.customer.city || mem.city || '').trim();
        const email = this.validEmail(draft.customer.email || convo?.contact?.email);
        const complete = draft.items.length > 0 && !!name && !!phoneRaw && !!address1 && !!city;
        const payment = draft.paymentMethod === 'prepaid'
            ? 'prepaid'
            : draft.paymentMethod === 'cod'
                ? 'cod'
                : null;
        if (!complete || payment === null)
            return 'collect';
        if (payment === 'prepaid') {
            const bank = await this.fetchPaymentDetails(job.companyId);
            const summary = await this.safeComposeSummary(job, draft, name, phoneRaw, address1, city, 'prepaid');
            await this.setAwaitingPayment(job.conversationId);
            await this.send(job, `${summary}\n\n${bank ? `${bank}\n\n` : ''}Baraye meharbani payment kar ke ` +
                `slip yahan bhej dein — hum verify kar ke order confirm kar denge.`);
            return 'handled';
        }
        const pendingFresh = !!convo?.ai_pending_order_at &&
            Date.now() - new Date(convo.ai_pending_order_at).getTime() < PENDING_TTL_MS;
        const draftSig = this.draftCartSignature(draft.items.map((i) => ({ productQuery: i.productQuery, quantity: i.quantity })));
        if (!pendingFresh) {
            await this.storePending(job, draft);
            await this.send(job, await this.safeComposeSummary(job, draft, name, phoneRaw, address1, city, 'cod'));
            return 'handled';
        }
        const pendingItems = this.parsePendingItems(convo?.ai_pending_order);
        if (this.draftCartSignature(pendingItems) !== draftSig) {
            await this.storePending(job, draft);
            await this.send(job, await this.safeComposeSummary(job, draft, name, phoneRaw, address1, city, 'cod'));
            return 'handled';
        }
        const latest = await this.latestInboundText(job);
        const affirmed = draft.readyToCreate || this.isOrderAffirmation(latest);
        if (!affirmed)
            return 'collect';
        const lineItems = await this.resolveLineItems(job.companyId, draft.items.map((i) => ({ query: i.productQuery, quantity: i.quantity })));
        if (!lineItems.length) {
            await this.handoff(job.companyId, job.conversationId, 'order confirmed but products did not resolve');
            return 'handled';
        }
        const phone = (0, phone_1.normalizePhone)(phoneRaw, country);
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
        if (conf.score < ai_constants_1.ORDER_CONFIDENCE_MIN) {
            this.logger.log(`ai-agent convo ${job.conversationId}: order confidence ${conf.score}% < ` +
                `${ai_constants_1.ORDER_CONFIDENCE_MIN}% (weak: ${conf.weak.join(', ')}) → collect`);
            return 'collect';
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
            await this.handoff(job.companyId, job.conversationId, `deterministic order create failed: ${r.error}`);
            return 'handled';
        }
        await this.send(job, this.orderPlacedMessage(r.orderName));
        return 'handled';
    }
    orderPlacedMessage(orderName) {
        const namePart = orderName ? ` ${orderName}` : '';
        return (`✅ Aap ka order${namePart} place ho gaya hai (Cash on Delivery). ` +
            `Shukria! Hamari team raabta karegi.`);
    }
    validEmail(v) {
        const e = (v ?? '').trim();
        return e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : undefined;
    }
    async tryCreateFromDraft(job, ctx, route) {
        let draft;
        try {
            draft = await this.ai.draftOrder(job.companyId, null, job.conversationId, route.episodeStartedAt);
        }
        catch {
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
        const storedPending = this.parsePendingDraft(convo?.ai_pending_order);
        const storedFresh = !!convo?.ai_pending_order_at &&
            Date.now() - new Date(convo.ai_pending_order_at).getTime() < PENDING_TTL_MS;
        if (storedFresh && storedPending && storedPending.items.length && !draft.items.length) {
            draft = { ...storedPending, intent: 'place_order' };
        }
        if (!draft.items.length)
            return 'no';
        if (draft.paymentMethod === 'prepaid')
            return 'no';
        const mem = await this.loadCustomerMemory(job.companyId, ctx);
        const country = (draft.customer.countryCode ||
            mem.countryCode ||
            route.defaultCountryCode ||
            'PK')
            .toUpperCase()
            .slice(0, 2);
        const name = (draft.customer.name || convo?.contact?.name || mem.name || '').trim();
        const phoneRaw = (draft.customer.phone ||
            convo?.contact?.phone ||
            mem.phone ||
            '').trim();
        const address1 = (draft.customer.address1 || mem.address1 || '').trim();
        const city = (draft.customer.city || mem.city || '').trim();
        const email = this.validEmail(draft.customer.email || convo?.contact?.email);
        if (!name || !phoneRaw || !address1 || !city)
            return 'no';
        const lineItems = await this.resolveLineItems(job.companyId, draft.items.map((i) => ({ query: i.productQuery, quantity: i.quantity })));
        if (!lineItems.length)
            return 'no';
        const phone = (0, phone_1.normalizePhone)(phoneRaw, country);
        const conf = this.orderConfidence({
            lineItems,
            name,
            phone,
            address1,
            city,
            paymentClear: draft.paymentMethod !== null,
            explicitConfirm: true,
            draftConfidenceHigh: draft.confidence === 'high',
        });
        if (conf.score < ai_constants_1.ORDER_CONFIDENCE_MIN)
            return 'no';
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
        if (r.status === 'failed')
            return 'no';
        await this.send(job, this.orderPlacedMessage(r.orderName));
        return 'created';
    }
    async send(job, content) {
        try {
            await this.inbox.sendMessage(job.companyId, job.conversationId, {
                type: send_message_dto_1.SendMessageType.text,
                content,
            });
        }
        catch (e) {
            this.logger.warn(`ai-agent send failed (convo ${job.conversationId}): ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    async safeComposeSummary(job, draft, name, phone, address1, city, payment) {
        try {
            const { text } = await this.ai.composeOrderConfirmation(job.companyId, job.conversationId, {
                items: draft.items.map((i) => ({ quantity: i.quantity, title: i.productQuery })),
                name,
                phone,
                address1,
                city,
                payment,
            });
            if (text && text.trim())
                return text.trim();
        }
        catch {
        }
        const items = draft.items.map((i) => `• ${i.quantity} × ${i.productQuery}`).join('\n');
        return (`📋 Please confirm your order:\n\n${items}\n\n` +
            `Name: ${name}\nPhone: ${phone}\nAddress: ${address1}, ${city}\n` +
            `Payment: ${payment === 'prepaid' ? 'Prepaid' : 'Cash on Delivery'}\n\n` +
            `Reply YES to confirm.`);
    }
    async storePending(job, draft) {
        await this.prisma.conversation
            .update({
            where: { id: job.conversationId },
            data: {
                ai_pending_order: draft,
                ai_pending_order_at: new Date(),
            },
        })
            .catch(() => undefined);
    }
    parsePendingItems(pending) {
        const raw = pending?.items;
        if (!Array.isArray(raw))
            return [];
        return raw
            .map((it) => {
            const r = (it ?? {});
            const q = Number(r.quantity);
            return {
                productQuery: typeof r.productQuery === 'string' ? r.productQuery : '',
                quantity: Number.isFinite(q) && q > 0 ? Math.floor(q) : 1,
            };
        })
            .filter((i) => i.productQuery.length > 0);
    }
    parsePendingDraft(pending) {
        const items = this.parsePendingItems(pending);
        if (!items.length)
            return null;
        const p = (pending ?? {});
        const cust = (p.customer ?? {});
        const s = (v) => typeof v === 'string' && v.trim() ? v.trim() : null;
        const payment = p.paymentMethod === 'prepaid'
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
    draftCartSignature(items) {
        return items
            .map((i) => `${(i.productQuery || '').trim().toLowerCase()}|${i.quantity}`)
            .sort()
            .join(';');
    }
    async latestInboundText(job) {
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
    isOrderAffirmation(text) {
        const t = (text || '').trim().toLowerCase();
        if (!t || t.length > 40)
            return false;
        if (/^(g|ji|jee|ok|okay|k|haan|han|hn|yes|yep|yup|👍|✅|✓)$/i.test(t))
            return true;
        return /(^|\s|,)(yes|yep|yeah|yup|ok|okay|done|confirm|confirmed|sure|haan|han|ji|jee|theek|thik|sahi|pakka|order\s?kar\s?do|order\s?kardo|kar\s?do|kardo|kr\s?do|krdo|place\s?order)(\s|$|!|\.|,|👍|✅)/i.test(t);
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
        const recent = await this.prisma.message.findMany({
            where: {
                conversation_id: job.conversationId,
                company_id: job.companyId,
                direction: 'outbound',
            },
            orderBy: { timestamp: 'desc' },
            take: ai_constants_1.ANTI_REPEAT_HISTORY,
            select: { content: true },
        });
        for (const m of recent) {
            if (!m.content)
                continue;
            const prev = this.tokenize(m.content);
            if (prev.size < 5)
                continue;
            let inter = 0;
            for (const w of cur)
                if (prev.has(w))
                    inter++;
            const union = cur.size + prev.size - inter;
            if (union > 0 && inter / union >= 0.85)
                return true;
        }
        return false;
    }
    claimsOrderPlaced(text) {
        const t = (text || '').toLowerCase();
        return (/(placed successfully|successfully placed|has been placed|been placed successfully)/i.test(t) ||
            /\border\b[^.?!\n]{0,40}\b(is|has|have|had|was|been|already)\b[^.?!\n]{0,20}\b(placed|created|confirmed|booked|done)\b/i.test(t) ||
            /(order .{0,30}(place ho (gaya|gya|gai|chuka|chuki)|ban gaya|ban gya|bana diya|ban diya|ban chuka|create ho (gaya|gya|chuka)|confirm ho (gaya|gya|chuka)|ho gaya hai|ho chuka))/i.test(t) ||
            /(aap ka|apka|aapka) order .{0,30}(place ho (gaya|gya|chuka)|placed|ban gaya|ban gya|ban diya|create ho (gaya|gya)|created|confirm ho (gaya|gya|chuka))/i.test(t));
    }
    tokenize(s) {
        return new Set((s || '')
            .toLowerCase()
            .normalize('NFKC')
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .split(/\s+/)
            .filter(Boolean));
    }
    async handoff(companyId, conversationId, reason, workItemId) {
        try {
            await this.prisma.conversation.update({
                where: { id: conversationId },
                data: { status: 'pending', ai_autoreply: false },
            });
            await this.label(companyId, conversationId, AI_HANDOFF_LABEL);
            if (workItemId) {
                await this.workItems.handoff(companyId, workItemId, reason, HANDOFF_SLA_MS);
            }
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
        inbox_gateway_1.InboxGateway,
        tickets_service_1.TicketsService,
        company_status_service_1.CompanyStatusService,
        platform_setting_service_1.PlatformSettingService,
        router_service_1.RouterService,
        told_ledger_service_1.ToldLedgerService,
        work_item_service_1.WorkItemService])
], AiAgentService);
//# sourceMappingURL=ai-agent.service.js.map