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
const job_queue_service_1 = require("../../../common/services/job-queue.service");
const ai_service_1 = require("../../ai/ai.service");
const inbox_service_1 = require("../../inbox/inbox.service");
const send_message_dto_1 = require("../../inbox/dto/send-message.dto");
const phone_1 = require("../../../common/utils/phone");
const shopify_service_1 = require("./shopify.service");
const AI_HANDOFF_LABEL = 'needs-human';
const AI_ORDER_LABEL = 'ai-order';
let AiAutoOrderService = AiAutoOrderService_1 = class AiAutoOrderService {
    constructor(prisma, jobQueue, ai, shopify, inbox) {
        this.prisma = prisma;
        this.jobQueue = jobQueue;
        this.ai = ai;
        this.shopify = shopify;
        this.inbox = inbox;
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
                ai_order_created_at: true,
                contact: { select: { name: true, phone: true } },
                company: {
                    select: { default_country_code: true, ai_auto_order_enabled: true },
                },
            },
        });
        if (!convo ||
            !convo.company?.ai_auto_order_enabled ||
            convo.ai_order_created_at) {
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
        if (!draft.readyToCreate)
            return this.fallbackReply(job);
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
        const country = draft.customer.countryCode ||
            convo.company?.default_country_code ||
            'PK';
        const name = (draft.customer.name || convo.contact?.name || '').trim();
        const phone = (0, phone_1.normalizePhone)(draft.customer.phone || convo.contact?.phone || '', country);
        const address1 = (draft.customer.address1 || '').trim();
        const city = (draft.customer.city || '').trim();
        if (!lineItems.length || !name || !phone || !address1 || !city) {
            return this.handoff(job.companyId, job.conversationId, 'order confirmed but details incomplete for auto-creation');
        }
        const claim = await this.prisma.conversation.updateMany({
            where: {
                id: job.conversationId,
                company_id: job.companyId,
                ai_order_created_at: null,
            },
            data: { ai_order_created_at: new Date() },
        });
        if (claim.count === 0)
            return;
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
    }
};
exports.AiAutoOrderService = AiAutoOrderService;
exports.AiAutoOrderService = AiAutoOrderService = AiAutoOrderService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        job_queue_service_1.JobQueueService,
        ai_service_1.AiService,
        shopify_service_1.ShopifyService,
        inbox_service_1.InboxService])
], AiAutoOrderService);
//# sourceMappingURL=ai-auto-order.service.js.map