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
var AiAutoOrderService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiAutoOrderService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../prisma/prisma.service");
const client_1 = require("@prisma/client");
const job_queue_service_1 = require("../../../common/services/job-queue.service");
const ai_service_1 = require("../../ai/ai.service");
const inbox_service_1 = require("../../inbox/inbox.service");
const inbox_gateway_1 = require("../../inbox/inbox.gateway");
const send_message_dto_1 = require("../../inbox/dto/send-message.dto");
const phone_1 = require("../../../common/utils/phone");
const shopify_service_1 = require("./shopify.service");
const AI_HANDOFF_LABEL = 'needs-human';
const AI_ORDER_LABEL = 'ai-order';
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
let AiAutoOrderService = AiAutoOrderService_1 = class AiAutoOrderService {
    constructor(prisma, jobQueue, ai, shopify, inbox, gateway) {
        this.prisma = prisma;
        this.jobQueue = jobQueue;
        this.ai = ai;
        this.shopify = shopify;
        this.inbox = inbox;
        this.gateway = gateway;
        this.logger = new common_1.Logger(AiAutoOrderService_1.name);
    }
    onModuleInit() {
        this.jobQueue.registerWorker('ai-order', (p) => this.process(p), 1);
    }
    async enqueue(job) {
        try {
            await this.jobQueue.enqueue('ai-order', job);
        }
        catch (e) {
            this.logger.warn(`ai-order enqueue failed for convo ${job.conversationId}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    async process(job) {
        const convo = await this.prisma.conversation.findFirst({
            where: {
                id: job.conversationId,
                company_id: job.companyId,
                deleted_at: null,
            },
            select: {
                id: true,
                ai_autoreply: true,
                ai_order_created_at: true,
                ai_pending_order: true,
                ai_pending_order_at: true,
                contact: { select: { name: true, phone: true } },
                company: {
                    select: {
                        default_country_code: true,
                        ai_auto_order_enabled: true,
                        ai_auto_order_all_enabled: true,
                        ai_autoreply_enabled: true,
                    },
                },
            },
        });
        if (!convo || !convo.company?.ai_auto_order_enabled) {
            return this.fallbackReply(job);
        }
        const allChats = convo.company.ai_autoreply_enabled === true;
        const perChat = convo.ai_autoreply;
        const effectiveAuto = perChat === false ? false : allChats || perChat === true;
        const scopeA = perChat === true;
        const scopeB = convo.company.ai_auto_order_all_enabled === true && effectiveAuto;
        if (!scopeA && !scopeB) {
            return this.fallbackReply(job);
        }
        let draft;
        try {
            draft = await this.ai.draftOrder(job.companyId, null, job.conversationId);
        }
        catch (e) {
            if (e instanceof common_1.ForbiddenException)
                return this.fallbackReply(job);
            throw e;
        }
        if (draft.intent === 'order_status') {
            return this.handleOrderStatus(job, draft);
        }
        const country = draft.customer.countryCode || convo.company.default_country_code || 'PK';
        const name = (draft.customer.name || convo.contact?.name || '').trim();
        const phone = (0, phone_1.normalizePhone)(draft.customer.phone || convo.contact?.phone || '', country);
        const address1 = (draft.customer.address1 || '').trim();
        const city = (draft.customer.city || '').trim();
        const complete = draft.items.length > 0 && !!name && !!phone && !!address1 && !!city;
        const pendingFresh = !!convo.ai_pending_order_at &&
            Date.now() - new Date(convo.ai_pending_order_at).getTime() <
                PENDING_TTL_MS;
        if (!pendingFresh) {
            if (!complete) {
                if (draft.items.length > 0) {
                    await this.send(job, this.buildMissingPrompt(draft, name, phone, address1, city));
                    return;
                }
                return this.fallbackReply(job);
            }
            await this.storePending(job, draft);
            await this.send(job, await this.composeSummary(job, draft, name, phone, address1, city));
            return;
        }
        const pendingItems = this.parsePendingItems(convo.ai_pending_order);
        const cartChanged = this.cartSignature(draft.items) !== this.cartSignature(pendingItems);
        if (cartChanged && complete) {
            await this.storePending(job, draft);
            await this.send(job, await this.composeSummary(job, draft, name, phone, address1, city));
            return;
        }
        const latestInbound = await this.latestInboundText(job.companyId, job.conversationId);
        const affirmed = draft.readyToCreate || this.isOrderAffirmation(latestInbound);
        if (!complete || !affirmed) {
            return this.fallbackReply(job);
        }
        const lineItems = [];
        for (const it of draft.items) {
            try {
                const hits = await this.shopify.searchProducts(job.companyId, it.productQuery);
                const v = hits[0];
                if (v)
                    lineItems.push({ variantId: v.variantId, quantity: it.quantity });
            }
            catch {
            }
        }
        if (!lineItems.length) {
            return this.handoff(job.companyId, job.conversationId, 'order confirmed but no products resolved for auto-creation');
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
        if (claim.count === 0)
            return;
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
            this.logger.warn(`auto-order shipping-rate lookup failed (convo ${job.conversationId}): ${e instanceof Error ? e.message : String(e)}`);
        }
        try {
            const order = await this.shopify.createOrder(job.companyId, {
                lineItems,
                customerName: name,
                phone,
                address1,
                city,
                countryCode: country,
                note: draft.note || undefined,
                tags: ['CodesApp', 'AI auto-order'],
                prepaid: draft.paymentMethod === 'prepaid',
                shippingLine,
            });
            try {
                await this.inbox.sendMessage(job.companyId, job.conversationId, {
                    type: send_message_dto_1.SendMessageType.text,
                    content: `✅ Your order ${order.orderName} has been placed` +
                        `${draft.paymentMethod === 'prepaid' ? '' : ' (Cash on Delivery)'}` +
                        `. Thank you! Our team will be in touch with the details.`,
                });
            }
            catch (e) {
                this.logger.warn(`auto-order confirmation send failed (convo ${job.conversationId}): ${e instanceof Error ? e.message : String(e)}`);
            }
            await this.label(job.companyId, job.conversationId, AI_ORDER_LABEL);
            this.logger.log(`AI auto-created Shopify order ${order.orderName} for conversation ${job.conversationId}`);
        }
        catch (e) {
            await this.prisma.conversation
                .updateMany({
                where: { id: job.conversationId, company_id: job.companyId },
                data: { ai_order_created_at: null },
            })
                .catch(() => undefined);
            await this.handoff(job.companyId, job.conversationId, `auto order creation failed: ${e instanceof Error ? e.message : String(e)}`);
        }
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
            .catch((e) => this.logger.warn(`store pending order failed (convo ${job.conversationId}): ${e instanceof Error ? e.message : String(e)}`));
    }
    async send(job, content) {
        try {
            await this.inbox.sendMessage(job.companyId, job.conversationId, {
                type: send_message_dto_1.SendMessageType.text,
                content,
            });
        }
        catch (e) {
            this.logger.warn(`auto-order message send failed (convo ${job.conversationId}): ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    async handleOrderStatus(job, draft) {
        if (!draft.orderNumber) {
            await this.send(job, 'Sure — please share your order number (e.g. #1234) so I can check its status for you.');
            return;
        }
        const st = await this.shopify.getOrderStatus(job.companyId, draft.orderNumber);
        if (st.error) {
            return this.handoff(job.companyId, job.conversationId, 'order status lookup failed (scope/connection) — needs a human');
        }
        if (!st.found) {
            await this.send(job, `I couldn't find order #${draft.orderNumber}. Could you double-check the order number?`);
            return;
        }
        const humanize = (s) => s ? s.replace(/_/g, ' ').toLowerCase() : 'unknown';
        const lines = [`Order ${st.name}`];
        lines.push(`• Delivery: ${humanize(st.fulfillmentStatus)}`);
        lines.push(`• Payment: ${humanize(st.financialStatus)}`);
        const track = (st.tracking ?? []).filter((t) => t.number || t.url);
        if (track.length) {
            for (const t of track) {
                const bits = [t.company, t.number, t.url].filter(Boolean).join(' ');
                lines.push(`• Tracking: ${bits}`);
            }
        }
        await this.send(job, lines.join('\n'));
    }
    async composeSummary(job, draft, name, phone, address1, city) {
        try {
            const { text } = await this.ai.composeOrderConfirmation(job.companyId, job.conversationId, {
                items: draft.items.map((i) => ({
                    quantity: i.quantity,
                    title: i.productQuery,
                })),
                name,
                phone,
                address1,
                city,
                payment: draft.paymentMethod === 'prepaid' ? 'prepaid' : 'cod',
            });
            if (text && text.trim())
                return text.trim();
        }
        catch (e) {
            this.logger.warn(`compose order confirmation failed (convo ${job.conversationId}): ${e instanceof Error ? e.message : String(e)}`);
        }
        return this.buildOrderSummary(draft, name, phone, address1, city);
    }
    cartSignature(items) {
        return items
            .map((i) => `${(i.productQuery || '').trim().toLowerCase()}|${i.quantity}`)
            .sort()
            .join(';');
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
    async latestInboundText(companyId, conversationId) {
        const m = await this.prisma.message.findFirst({
            where: {
                conversation_id: conversationId,
                company_id: companyId,
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
        if (/^(g|ji|jee|ok|okay|k|haan|han|hn|yes|yep|yup|👍|✅|✓)$/i.test(t)) {
            return true;
        }
        return /(^|\s|,)(yes|yep|yeah|yup|ok|okay|done|confirm|confirmed|sure|haan|han|ji|jee|theek|thik|sahi|pakka|order\s?kar\s?do|order\s?kardo|kar\s?do|kardo|kr\s?do|krdo|place\s?order)(\s|$|!|\.|,|👍|✅)/i.test(t);
    }
    buildOrderSummary(draft, name, phone, address1, city) {
        const items = draft.items
            .map((i) => `• ${i.quantity} × ${i.productQuery}`)
            .join('\n');
        const payment = draft.paymentMethod === 'prepaid' ? 'Prepaid' : 'Cash on Delivery';
        return (`📋 Please confirm your order:\n\n` +
            `${items}\n\n` +
            `Name: ${name}\n` +
            `Phone: ${phone}\n` +
            `Address: ${address1}, ${city}\n` +
            `Payment: ${payment}\n\n` +
            `Reply YES to place the order, or tell me what to change.`);
    }
    buildMissingPrompt(draft, name, phone, address1, city) {
        const items = draft.items
            .map((i) => `${i.quantity} × ${i.productQuery}`)
            .join(', ');
        const need = [];
        if (!name)
            need.push('your full name');
        if (!phone)
            need.push('your phone number');
        if (!address1)
            need.push('your complete delivery address (house no. + street)');
        if (!city)
            need.push('your city');
        return (`Sure${items ? `, to place your order for ${items}` : ''} — please share ` +
            `${need.join(', ')} so I can confirm it for you.`);
    }
    async fallbackReply(job) {
        try {
            await this.jobQueue.enqueue('ai', { ...job, skipOrder: true });
        }
        catch (e) {
            this.logger.warn(`fallback ai reply enqueue failed (convo ${job.conversationId}): ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    async handoff(companyId, conversationId, reason) {
        try {
            await this.prisma.conversation.update({
                where: { id: conversationId },
                data: { status: 'pending', ai_autoreply: false },
            });
            await this.label(companyId, conversationId, AI_HANDOFF_LABEL);
            this.logger.log(`AI auto-order handoff for conversation ${conversationId}: ${reason}`);
        }
        catch (e) {
            this.logger.warn(`auto-order handoff failed (convo ${conversationId}): ${e instanceof Error ? e.message : String(e)}`);
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
exports.AiAutoOrderService = AiAutoOrderService;
exports.AiAutoOrderService = AiAutoOrderService = AiAutoOrderService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        job_queue_service_1.JobQueueService,
        ai_service_1.AiService,
        shopify_service_1.ShopifyService,
        inbox_service_1.InboxService,
        inbox_gateway_1.InboxGateway])
], AiAutoOrderService);
//# sourceMappingURL=ai-auto-order.service.js.map