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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var MetaWebhookService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetaWebhookService = void 0;
const common_1 = require("@nestjs/common");
const path = require("path");
const prisma_service_1 = require("../../prisma/prisma.service");
const job_queue_service_1 = require("../../common/services/job-queue.service");
const usage_metering_service_1 = require("../usage-metering/usage-metering.service");
const inbox_gateway_1 = require("./inbox.gateway");
const meta_client_service_1 = require("./meta-client.service");
const bot_engine_service_1 = require("../bots/bot-engine.service");
const webhook_dispatcher_service_1 = require("../webhooks/webhook-dispatcher.service");
const MEDIA_LIMITS = {
    image: 5 * 1024 * 1024,
    audio: 10 * 1024 * 1024,
    video: 16 * 1024 * 1024,
    document: 10 * 1024 * 1024,
    sticker: 5 * 1024 * 1024,
};
const STORAGE_ROOT = path.join(process.cwd(), '..', 'storage', 'media');
const NO_WHATSAPP_ERROR_CODES = new Set([131026]);
let MetaWebhookService = MetaWebhookService_1 = class MetaWebhookService {
    constructor(prisma, jobQueue, metering, metaClient, gateway, botEngine, webhookDispatcher) {
        this.prisma = prisma;
        this.jobQueue = jobQueue;
        this.metering = metering;
        this.metaClient = metaClient;
        this.gateway = gateway;
        this.botEngine = botEngine;
        this.webhookDispatcher = webhookDispatcher;
        this.logger = new common_1.Logger(MetaWebhookService_1.name);
    }
    onModuleInit() {
        this.jobQueue.registerWorker('message', (p) => this.handle(p), 3);
        this.logger.log('Registered message worker (concurrency=3)');
    }
    async handle(payload) {
        const wrapper = payload;
        const entries = wrapper?.rawPayload?.entry ?? [];
        for (const entry of entries) {
            for (const change of entry.changes ?? []) {
                const value = change.value;
                if (!value?.metadata?.phone_number_id)
                    continue;
                const company = await this.resolveCompany(value.metadata.phone_number_id);
                if (!company) {
                    this.logger.warn(`No company found for phone_number_id=${value.metadata.phone_number_id}`);
                    continue;
                }
                for (const msg of value.messages ?? []) {
                    await this.handleInbound(company.id, msg, value.contacts ?? []);
                }
                for (const st of value.statuses ?? []) {
                    await this.handleStatus(company.id, st);
                }
            }
        }
    }
    async resolveCompany(phoneNumberId) {
        return this.prisma.company.findFirst({
            where: { phone_number_id: phoneNumberId },
            select: { id: true },
        });
    }
    async handleInbound(companyId, msg, contacts) {
        const profile = contacts.find((c) => c.wa_id === msg.from)?.profile;
        const displayName = profile?.name ?? msg.from;
        const existing = await this.prisma.contact.findFirst({
            where: { company_id: companyId, phone: msg.from, deleted_at: null },
        });
        let contact;
        let isNewContact = false;
        if (existing) {
            contact = await this.prisma.contact.update({
                where: { id: existing.id },
                data: { last_message_at: new Date() },
            });
        }
        else {
            contact = await this.prisma.contact.create({
                data: {
                    company_id: companyId,
                    name: displayName,
                    phone: msg.from,
                    last_message_at: new Date(),
                },
            });
            isNewContact = true;
            await this.metering.incrementContacts(companyId);
        }
        let convo = await this.prisma.conversation.findFirst({
            where: {
                company_id: companyId,
                contact_id: contact.id,
                deleted_at: null,
            },
            orderBy: { id: 'desc' },
        });
        const windowExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        let isNewConvoThisMonth = false;
        if (!convo) {
            convo = await this.prisma.conversation.create({
                data: {
                    company_id: companyId,
                    contact_id: contact.id,
                    status: 'open',
                    window_expires_at: windowExpiresAt,
                    unread_count: 1,
                },
            });
            isNewConvoThisMonth = true;
        }
        else {
            convo = await this.prisma.conversation.update({
                where: { id: convo.id },
                data: {
                    window_expires_at: windowExpiresAt,
                    status: convo.status === 'resolved' ? 'open' : convo.status,
                    unread_count: { increment: 1 },
                },
            });
        }
        const messageType = this.normalizeType(msg.type);
        let textContent = null;
        let mediaUrl = null;
        let metaMediaUrl = null;
        let mediaExpiresAt = null;
        if (msg.text?.body) {
            textContent = msg.text.body;
        }
        else if (msg.image?.caption) {
            textContent = msg.image.caption;
        }
        else if (msg.video?.caption) {
            textContent = msg.video.caption;
        }
        else if (msg.document?.filename) {
            textContent = msg.document.filename;
        }
        const mediaInfo = this.extractMediaId(msg);
        if (mediaInfo) {
            const maxBytes = MEDIA_LIMITS[messageType] ?? 5 * 1024 * 1024;
            try {
                const downloaded = await this.metaClient.downloadMedia(companyId, mediaInfo.id, STORAGE_ROOT, maxBytes);
                const rel = path
                    .relative(STORAGE_ROOT, downloaded.path)
                    .split(path.sep)
                    .join('/');
                mediaUrl = `/storage/media/${rel}`;
                mediaExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            }
            catch (err) {
                this.logger.warn(`Media download failed for message ${msg.id}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        let contextMessageId = null;
        if (msg.context?.id) {
            try {
                const ref = await this.prisma.message.findFirst({
                    where: { meta_message_id: msg.context.id, company_id: companyId },
                    select: { id: true },
                });
                contextMessageId = ref?.id ?? null;
            }
            catch (err) {
                this.logger.warn(`Inbound reply-context lookup failed for ${msg.context.id}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        const buttonLabel = msg.button?.text ??
            msg.interactive?.button_reply?.title ??
            msg.interactive?.list_reply?.title ??
            null;
        if (buttonLabel && !textContent)
            textContent = buttonLabel;
        const message = await this.prisma.message.create({
            data: {
                conversation_id: convo.id,
                company_id: companyId,
                message_type: messageType,
                direction: 'inbound',
                content: textContent,
                media_url: mediaUrl,
                meta_media_url: metaMediaUrl,
                media_expires_at: mediaExpiresAt,
                status: 'delivered',
                meta_message_id: msg.id,
                context_message_id: contextMessageId,
                timestamp: new Date(Number(msg.timestamp) * 1000),
            },
            include: {
                context_message: {
                    select: {
                        id: true,
                        direction: true,
                        message_type: true,
                        content: true,
                        media_url: true,
                    },
                },
            },
        });
        await this.prisma.conversation.update({
            where: { id: convo.id },
            data: {
                last_message: (textContent ?? `[${messageType}]`).slice(0, 500),
                last_message_at: new Date(),
            },
        });
        await this.metering.incrementMessages(companyId);
        if (isNewConvoThisMonth) {
            await this.metering.incrementConversations(companyId);
        }
        if (contextMessageId && buttonLabel) {
            try {
                const lbl = buttonLabel.toLowerCase();
                const decision = lbl.includes('cancel')
                    ? 'cancel'
                    : lbl.includes('confirm')
                        ? 'confirm'
                        : null;
                if (decision) {
                    const link = await this.prisma.shopifyOrderMessage.findFirst({
                        where: {
                            message_id: contextMessageId,
                            company_id: companyId,
                        },
                        select: { id: true },
                    });
                    if (link) {
                        await this.jobQueue.enqueue('shopify', {
                            kind: 'tag',
                            companyId,
                            orderMessageId: link.id,
                            decision,
                        });
                    }
                }
            }
            catch (err) {
                this.logger.warn(`Shopify order-tag enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        this.gateway.emitToCompany(companyId, 'message.received', {
            message,
            conversationId: convo.id,
            contactId: contact.id,
            contactName: contact.name ?? contact.phone,
            isNewContact,
        });
        await this.webhookDispatcher.dispatch(companyId, 'message.received', {
            messageId: message.id,
            conversationId: convo.id,
            contactId: contact.id,
            isNewContact,
            messageType,
        });
        try {
            await this.botEngine.runForMessage({
                id: message.id,
                companyId,
                conversationId: convo.id,
                direction: 'inbound',
                content: textContent ?? '',
            });
        }
        catch (err) {
            this.logger.warn(`Bot engine failed for message ${message.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    async handleStatus(companyId, st) {
        const message = await this.prisma.message.findFirst({
            where: { meta_message_id: st.id, company_id: companyId },
        });
        if (!message)
            return;
        const newStatus = st.status === 'sent' ? message.status : st.status;
        await this.prisma.message.update({
            where: { id: message.id },
            data: { status: newStatus },
        });
        if (message.broadcast_id) {
            if (st.status === 'delivered') {
                await this.prisma.broadcast.update({
                    where: { id: message.broadcast_id },
                    data: { delivered_count: { increment: 1 } },
                });
            }
            else if (st.status === 'read') {
                await this.prisma.broadcast.update({
                    where: { id: message.broadcast_id },
                    data: { read_count: { increment: 1 } },
                });
            }
        }
        let errorText;
        if (st.status === 'failed' && st.errors?.length) {
            errorText = st.errors
                .map((e) => `(${e.code}) ${e.title}` +
                (e.error_data?.details ? ` — ${e.error_data.details}` : ''))
                .join('; ');
            this.logger.error(`Message ${message.id} (meta=${st.id}) FAILED: ${errorText}`);
            const noWhatsapp = st.errors.some((e) => NO_WHATSAPP_ERROR_CODES.has(e.code) ||
                /undeliverable|not a whatsapp/i.test(`${e.title} ${e.message ?? ''}`));
            if (noWhatsapp) {
                try {
                    const link = await this.prisma.shopifyOrderMessage.findFirst({
                        where: { message_id: message.id, company_id: companyId },
                        select: { id: true },
                    });
                    if (link) {
                        await this.jobQueue.enqueue('shopify', {
                            kind: 'noWhatsapp',
                            companyId,
                            orderMessageId: link.id,
                        });
                    }
                }
                catch (err) {
                    this.logger.warn(`NO WhatsApp tag enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
        this.gateway.emitToCompany(companyId, 'message.status', {
            messageId: message.id,
            status: newStatus,
            ...(errorText ? { error: errorText } : {}),
        });
        const eventMap = {
            delivered: 'message.delivered',
            read: 'message.read',
            failed: 'message.failed',
        };
        const event = eventMap[st.status];
        if (event) {
            await this.webhookDispatcher.dispatch(companyId, event, {
                messageId: message.id,
                conversationId: message.conversation_id,
                status: st.status,
                metaMessageId: st.id,
            });
        }
    }
    normalizeType(type) {
        const allowed = ['text', 'image', 'audio', 'video', 'document', 'sticker'];
        return (allowed.includes(type) ? type : 'text');
    }
    extractMediaId(msg) {
        if (msg.image?.id)
            return { id: msg.image.id };
        if (msg.audio?.id)
            return { id: msg.audio.id };
        if (msg.video?.id)
            return { id: msg.video.id };
        if (msg.document?.id)
            return { id: msg.document.id };
        if (msg.sticker?.id)
            return { id: msg.sticker.id };
        return null;
    }
};
exports.MetaWebhookService = MetaWebhookService;
exports.MetaWebhookService = MetaWebhookService = MetaWebhookService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(4, (0, common_1.Inject)((0, common_1.forwardRef)(() => inbox_gateway_1.InboxGateway))),
    __param(5, (0, common_1.Inject)((0, common_1.forwardRef)(() => bot_engine_service_1.BotEngineService))),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        job_queue_service_1.JobQueueService,
        usage_metering_service_1.UsageMeteringService,
        meta_client_service_1.MetaClientService,
        inbox_gateway_1.InboxGateway,
        bot_engine_service_1.BotEngineService,
        webhook_dispatcher_service_1.WebhookDispatcherService])
], MetaWebhookService);
//# sourceMappingURL=meta-webhook.service.js.map