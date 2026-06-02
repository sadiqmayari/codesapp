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
var InboxService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.InboxService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const fs = require("fs");
const path = require("path");
const uuid_1 = require("uuid");
const prisma_service_1 = require("../../prisma/prisma.service");
const usage_metering_service_1 = require("../usage-metering/usage-metering.service");
const inbox_gateway_1 = require("./inbox.gateway");
const meta_client_service_1 = require("./meta-client.service");
const webhook_dispatcher_service_1 = require("../webhooks/webhook-dispatcher.service");
const send_message_dto_1 = require("./dto/send-message.dto");
const list_conversations_dto_1 = require("./dto/list-conversations.dto");
const DEFAULT_PAGE_SIZE = 20;
const MAX_MESSAGES_PER_PAGE = 50;
const STORAGE_ROOT = path.join(process.cwd(), '..', 'storage', 'media');
const MEDIA_RULES = [
    {
        kind: 'image',
        maxBytes: 5 * 1024 * 1024,
        mimes: ['image/jpeg', 'image/png'],
    },
    {
        kind: 'video',
        maxBytes: 16 * 1024 * 1024,
        mimes: ['video/mp4', 'video/3gpp'],
    },
    {
        kind: 'audio',
        maxBytes: 10 * 1024 * 1024,
        mimes: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'],
    },
    {
        kind: 'document',
        maxBytes: 10 * 1024 * 1024,
        mimes: [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'text/plain',
        ],
    },
];
const MIME_EXT = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'audio/aac': 'aac',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/amr': 'amr',
    'audio/ogg': 'ogg',
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'text/plain': 'txt',
};
const CONTEXT_SELECT = {
    id: true,
    direction: true,
    message_type: true,
    content: true,
    media_url: true,
};
const MESSAGE_INCLUDE = {
    context_message: { select: CONTEXT_SELECT },
};
let InboxService = InboxService_1 = class InboxService {
    constructor(prisma, metering, gateway, metaClient, config, webhookDispatcher) {
        this.prisma = prisma;
        this.metering = metering;
        this.gateway = gateway;
        this.metaClient = metaClient;
        this.config = config;
        this.webhookDispatcher = webhookDispatcher;
        this.logger = new common_1.Logger(InboxService_1.name);
    }
    async listConversations(companyId, dto) {
        const page = dto.page ?? 1;
        const limit = dto.limit ?? DEFAULT_PAGE_SIZE;
        const skip = (page - 1) * limit;
        const where = {
            company_id: companyId,
            deleted_at: null,
        };
        if (dto.status === list_conversations_dto_1.ConversationListStatus.unread) {
            where.unread_count = { gt: 0 };
        }
        else if (dto.status === list_conversations_dto_1.ConversationListStatus.open) {
            where.window_expires_at = { gt: new Date() };
        }
        else if (dto.status && dto.status !== list_conversations_dto_1.ConversationListStatus.all) {
            where.status = dto.status;
        }
        if (dto.assignedUserId) {
            where.assigned_user_id = dto.assignedUserId;
        }
        if (dto.label) {
            where.labels = { some: { label: dto.label } };
        }
        if (dto.search) {
            where.OR = [
                {
                    contact: {
                        is: {
                            OR: [
                                { name: { contains: dto.search } },
                                { phone: { contains: dto.search } },
                            ],
                        },
                    },
                },
                { messages: { some: { content: { contains: dto.search } } } },
            ];
        }
        const [total, rows] = await Promise.all([
            this.prisma.conversation.count({ where }),
            this.prisma.conversation.findMany({
                where,
                orderBy: [
                    { pinned_at: 'desc' },
                    { last_message_at: 'desc' },
                    { updated_at: 'desc' },
                ],
                skip,
                take: limit,
                include: {
                    contact: { select: { id: true, name: true, phone: true, email: true } },
                    assigned_user: { select: { id: true, name: true, email: true } },
                    labels: { select: { label: true } },
                },
            }),
        ]);
        return {
            success: true,
            data: rows,
            message: 'OK',
            meta: { page, limit, total },
        };
    }
    async getConversation(companyId, id) {
        const convo = await this.prisma.conversation.findFirst({
            where: { id, company_id: companyId, deleted_at: null },
            include: {
                contact: true,
                assigned_user: { select: { id: true, name: true, email: true } },
                labels: { select: { id: true, label: true } },
            },
        });
        if (!convo)
            throw new common_1.NotFoundException('Conversation not found');
        return convo;
    }
    async assign(companyId, id, userId) {
        await this.requireConversation(companyId, id);
        if (userId !== null) {
            const user = await this.prisma.user.findFirst({
                where: { id: userId, company_id: companyId, status: 'active' },
                select: { id: true },
            });
            if (!user)
                throw new common_1.NotFoundException('User not found in this company');
        }
        const updated = await this.prisma.conversation.update({
            where: { id },
            data: { assigned_user_id: userId },
        });
        this.gateway.emitToCompany(companyId, 'conversation.assigned', {
            conversationId: id,
            userId,
        });
        return updated;
    }
    async setStatus(companyId, id, status) {
        await this.requireConversation(companyId, id);
        const updated = await this.prisma.conversation.update({
            where: { id },
            data: { status },
        });
        this.gateway.emitToCompany(companyId, 'conversation.updated', {
            conversationId: id,
            status,
        });
        return updated;
    }
    async setPinned(companyId, id, pinned) {
        await this.requireConversation(companyId, id);
        const updated = await this.prisma.conversation.update({
            where: { id },
            data: { pinned_at: pinned ? new Date() : null },
        });
        this.gateway.emitToCompany(companyId, 'conversation.updated', {
            conversationId: id,
        });
        return updated;
    }
    async setAiAutoReply(companyId, id, mode) {
        await this.requireConversation(companyId, id);
        const value = mode === 'on' ? true : mode === 'off' ? false : null;
        const updated = await this.prisma.conversation.update({
            where: { id },
            data: { ai_autoreply: value },
        });
        this.gateway.emitToCompany(companyId, 'conversation.updated', {
            conversationId: id,
        });
        return updated;
    }
    async clearHistory(companyId, id) {
        await this.requireConversation(companyId, id);
        const updated = await this.prisma.conversation.update({
            where: { id },
            data: { cleared_before: new Date() },
        });
        this.gateway.emitToCompany(companyId, 'conversation.updated', {
            conversationId: id,
        });
        return updated;
    }
    async addLabel(companyId, id, label) {
        await this.requireConversation(companyId, id);
        try {
            const row = await this.prisma.conversationLabel.create({
                data: { company_id: companyId, conversation_id: id, label },
            });
            this.gateway.emitToCompany(companyId, 'conversation.updated', {
                conversationId: id,
                addedLabel: label,
            });
            return row;
        }
        catch (err) {
            const existing = await this.prisma.conversationLabel.findFirst({
                where: { conversation_id: id, label },
            });
            if (existing)
                return existing;
            throw err;
        }
    }
    async removeLabel(companyId, id, label) {
        await this.requireConversation(companyId, id);
        await this.prisma.conversationLabel.deleteMany({
            where: { company_id: companyId, conversation_id: id, label },
        });
        this.gateway.emitToCompany(companyId, 'conversation.updated', {
            conversationId: id,
            removedLabel: label,
        });
        return { removed: true };
    }
    async addNote(companyId, id, userId, body) {
        await this.requireConversation(companyId, id);
        return this.prisma.conversationNote.create({
            data: { company_id: companyId, conversation_id: id, user_id: userId, body },
        });
    }
    async listNotes(companyId, id) {
        await this.requireConversation(companyId, id);
        return this.prisma.conversationNote.findMany({
            where: { company_id: companyId, conversation_id: id },
            orderBy: { created_at: 'desc' },
            take: 100,
        });
    }
    async listMessages(companyId, id, cursor, limit) {
        const convo = await this.requireConversation(companyId, id);
        const take = Math.min(limit || MAX_MESSAGES_PER_PAGE, MAX_MESSAGES_PER_PAGE);
        const where = {
            conversation_id: id,
            company_id: companyId,
        };
        if (cursor)
            where.id = { lt: cursor };
        if (convo.cleared_before) {
            where.timestamp = { gt: convo.cleared_before };
        }
        const rows = await this.prisma.message.findMany({
            where,
            orderBy: { id: 'desc' },
            take,
            include: MESSAGE_INCLUDE,
        });
        const nextCursor = rows.length === take ? rows[rows.length - 1].id : null;
        return { rows, nextCursor };
    }
    async markRead(companyId, id, userId) {
        await this.requireConversation(companyId, id);
        const now = new Date();
        await this.prisma.message.updateMany({
            where: {
                conversation_id: id,
                company_id: companyId,
                direction: 'inbound',
                read_at: null,
            },
            data: { read_at: now, read_by_user_id: userId },
        });
        await this.prisma.conversation.update({
            where: { id },
            data: { unread_count: 0 },
        });
        this.gateway.emitToCompany(companyId, 'message.read.bulk', {
            conversationId: id,
            readBy: userId,
            readAt: now.toISOString(),
        });
        return { ok: true };
    }
    async autoAssignOnReply(companyId, conversationId, currentAssignedUserId, userId) {
        if (!userId || currentAssignedUserId != null)
            return;
        try {
            await this.prisma.conversation.update({
                where: { id: conversationId },
                data: { assigned_user_id: userId },
            });
            this.gateway.emitToCompany(companyId, 'conversation.assigned', {
                conversationId,
                userId,
            });
        }
        catch {
        }
    }
    async sendMessage(companyId, conversationId, dto, userId) {
        const convo = await this.requireConversation(companyId, conversationId);
        await this.metaClient.assertOnboarded(companyId);
        if (dto.type !== send_message_dto_1.SendMessageType.template) {
            const now = new Date();
            if (!convo.window_expires_at ||
                convo.window_expires_at.getTime() < now.getTime()) {
                throw new common_1.ForbiddenException('24-hour window closed — only template messages allowed');
            }
        }
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { phone_number_id: true },
        });
        if (!company?.phone_number_id) {
            throw new common_1.ForbiddenException('WhatsApp phone number not configured');
        }
        const contact = await this.prisma.contact.findUnique({
            where: { id: convo.contact_id },
            select: { phone: true },
        });
        if (!contact)
            throw new common_1.NotFoundException('Contact not found');
        let payload;
        let messageType;
        let textContent = null;
        if (dto.type === send_message_dto_1.SendMessageType.text) {
            if (!dto.content) {
                throw new common_1.ForbiddenException('content is required for text messages');
            }
            messageType = 'text';
            textContent = dto.content;
            payload = {
                messaging_product: 'whatsapp',
                to: contact.phone,
                type: 'text',
                text: { body: dto.content, preview_url: true },
            };
        }
        else if (dto.type === send_message_dto_1.SendMessageType.template) {
            if (!dto.templateId) {
                throw new common_1.ForbiddenException('templateId is required for template messages');
            }
            const tpl = await this.prisma.template.findFirst({
                where: { id: dto.templateId, company_id: companyId, deleted_at: null },
            });
            if (!tpl || !tpl.meta_template_id) {
                throw new common_1.NotFoundException('Template not found or not approved');
            }
            const components = this.buildTemplateComponents(dto.variables ?? {});
            messageType = 'template';
            textContent = this.renderTemplateText(tpl.content, dto.variables ?? {});
            const langCode = tpl.content?.language ?? 'en_US';
            payload = {
                messaging_product: 'whatsapp',
                to: contact.phone,
                type: 'template',
                template: {
                    name: tpl.name,
                    language: { code: langCode },
                    components,
                },
            };
        }
        else {
            if (!dto.mediaPath) {
                throw new common_1.ForbiddenException('mediaPath is required for media messages');
            }
            messageType = dto.type;
            textContent = dto.content ?? null;
            const mediaSpec = { link: dto.mediaPath };
            if (dto.content)
                mediaSpec.caption = dto.content;
            payload = {
                messaging_product: 'whatsapp',
                to: contact.phone,
                type: messageType,
                [messageType]: mediaSpec,
            };
        }
        const contextMessageId = await this.resolveContext(companyId, dto.contextMessageId, payload);
        const response = await this.metaClient.sendMessage(companyId, company.phone_number_id, payload);
        const metaMessageId = response.messages?.[0]?.id ?? null;
        const message = await this.prisma.message.create({
            data: {
                conversation_id: conversationId,
                company_id: companyId,
                message_type: messageType,
                direction: 'outbound',
                content: textContent,
                status: 'sent',
                meta_message_id: metaMessageId,
                context_message_id: contextMessageId,
                user_id: userId ?? null,
                timestamp: new Date(),
            },
            include: MESSAGE_INCLUDE,
        });
        await this.prisma.conversation.update({
            where: { id: conversationId },
            data: {
                last_message: textContent?.slice(0, 500) ?? `[${messageType}]`,
                last_message_at: new Date(),
            },
        });
        await this.metering.incrementMessages(companyId);
        await this.autoAssignOnReply(companyId, conversationId, convo.assigned_user_id, userId);
        this.gateway.emitToCompany(companyId, 'message.sent', { message });
        await this.webhookDispatcher.dispatch(companyId, 'message.sent', {
            messageId: message.id,
            conversationId,
            contactId: convo.contact_id,
            messageType,
        });
        return message;
    }
    async sendMedia(input) {
        const { companyId, conversationId, file } = input;
        const convo = await this.requireConversation(companyId, conversationId);
        await this.metaClient.assertOnboarded(companyId);
        const now = new Date();
        if (!convo.window_expires_at ||
            convo.window_expires_at.getTime() < now.getTime()) {
            throw new common_1.ForbiddenException('24-hour window closed — only template messages allowed');
        }
        const mime = (file.mimetype || '').toLowerCase();
        const rule = MEDIA_RULES.find((r) => r.mimes.includes(mime));
        if (!rule) {
            throw new common_1.BadRequestException(`Unsupported media type: ${mime || 'unknown'}`);
        }
        if (file.size > rule.maxBytes) {
            throw new common_1.BadRequestException(`${rule.kind} exceeds the ${Math.round(rule.maxBytes / (1024 * 1024))}MB limit`);
        }
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { phone_number_id: true },
        });
        if (!company?.phone_number_id) {
            throw new common_1.ForbiddenException('WhatsApp phone number not configured');
        }
        const contact = await this.prisma.contact.findUnique({
            where: { id: convo.contact_id },
            select: { phone: true },
        });
        if (!contact)
            throw new common_1.NotFoundException('Contact not found');
        const messageType = rule.kind;
        const caption = input.caption?.trim() || undefined;
        const filename = (file.originalname || `file.${MIME_EXT[mime] ?? 'bin'}`)
            .replace(/[\r\n"]/g, '')
            .slice(0, 240);
        const dir = path.join(STORAGE_ROOT, String(companyId), String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'));
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        const diskName = `${(0, uuid_1.v4)()}.${MIME_EXT[mime] ?? 'bin'}`;
        fs.writeFileSync(path.join(dir, diskName), file.buffer);
        const rel = path
            .relative(STORAGE_ROOT, path.join(dir, diskName))
            .split(path.sep)
            .join('/');
        const mediaWebPath = `/storage/media/${rel}`;
        const { mediaId } = await this.metaClient.uploadMedia(companyId, file.buffer, mime, filename);
        const mediaSpec = { id: mediaId };
        if (caption && (messageType === 'image' || messageType === 'video')) {
            mediaSpec.caption = caption;
        }
        if (messageType === 'document') {
            mediaSpec.filename = filename;
        }
        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: contact.phone,
            type: messageType,
            [messageType]: mediaSpec,
        };
        const contextMessageId = await this.resolveContext(companyId, input.contextMessageId, payload);
        this.logger.log(`sendMedia company=${companyId} convo=${conversationId} type=${messageType} mime=${mime} bytes=${file.size} mediaId=${mediaId}`);
        const response = await this.metaClient.sendMessage(companyId, company.phone_number_id, payload);
        const metaMessageId = response.messages?.[0]?.id ?? null;
        this.logger.log(`sendMedia Meta accepted convo=${conversationId} metaMessageId=${metaMessageId}`);
        const message = await this.prisma.message.create({
            data: {
                conversation_id: conversationId,
                company_id: companyId,
                message_type: messageType,
                direction: 'outbound',
                content: caption ?? null,
                media_url: mediaWebPath,
                media_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                media_expired: false,
                status: 'sent',
                meta_message_id: metaMessageId,
                context_message_id: contextMessageId,
                user_id: input.userId ?? null,
                timestamp: new Date(),
            },
            include: MESSAGE_INCLUDE,
        });
        await this.prisma.conversation.update({
            where: { id: conversationId },
            data: {
                last_message: (caption ?? `[${messageType}]`).slice(0, 500),
                last_message_at: new Date(),
            },
        });
        await this.metering.incrementMessages(companyId);
        await this.autoAssignOnReply(companyId, conversationId, convo.assigned_user_id, input.userId);
        this.gateway.emitToCompany(companyId, 'message.sent', { message });
        await this.webhookDispatcher.dispatch(companyId, 'message.sent', {
            messageId: message.id,
            conversationId,
            contactId: convo.contact_id,
            messageType,
        });
        return message;
    }
    async resolveContext(companyId, contextMessageId, payload) {
        if (!contextMessageId)
            return null;
        try {
            const ref = await this.prisma.message.findFirst({
                where: { id: contextMessageId, company_id: companyId },
                select: { id: true, meta_message_id: true },
            });
            if (!ref) {
                this.logger.warn(`Reply context ${contextMessageId} not found for company ${companyId} — sending without context`);
                return null;
            }
            if (ref.meta_message_id) {
                payload.context = {
                    message_id: ref.meta_message_id,
                };
            }
            else {
                this.logger.warn(`Reply context ${contextMessageId} has no meta_message_id — sending without context`);
            }
            return ref.id;
        }
        catch (err) {
            this.logger.warn(`resolveContext failed for ${contextMessageId}: ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    }
    buildTemplateComponents(variables) {
        const entries = Object.entries(variables);
        if (entries.length === 0)
            return [];
        return [
            {
                type: 'body',
                parameters: entries
                    .sort(([a], [b]) => Number(a) - Number(b))
                    .map(([, value]) => ({ type: 'text', text: value })),
            },
        ];
    }
    renderTemplateText(content, variables) {
        const comps = (content
            ?.components ?? []);
        const find = (t) => comps.find((c) => String(c.type ?? '').toUpperCase() === t);
        const fill = (s) => s.replace(/\{\{(\d+)\}\}/g, (_, n) => variables[n] ?? `{{${n}}}`);
        const out = [];
        const header = find('HEADER');
        if (header && typeof header.text === 'string') {
            out.push(fill(header.text));
        }
        const body = find('BODY');
        if (body && typeof body.text === 'string') {
            out.push(fill(body.text));
        }
        const footer = find('FOOTER');
        if (footer && typeof footer.text === 'string') {
            out.push(fill(footer.text));
        }
        const buttons = find('BUTTONS');
        const btns = (buttons?.buttons ?? []);
        if (btns.length) {
            out.push(btns.map((b) => `[ ${b.text ?? 'Button'} ]`).join('  '));
        }
        const text = out.filter(Boolean).join('\n\n').trim();
        return text || '[template message]';
    }
    async requireConversation(companyId, id) {
        const convo = await this.prisma.conversation.findFirst({
            where: { id, company_id: companyId, deleted_at: null },
        });
        if (!convo)
            throw new common_1.NotFoundException('Conversation not found');
        return convo;
    }
};
exports.InboxService = InboxService;
exports.InboxService = InboxService = InboxService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(2, (0, common_1.Inject)((0, common_1.forwardRef)(() => inbox_gateway_1.InboxGateway))),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        usage_metering_service_1.UsageMeteringService,
        inbox_gateway_1.InboxGateway,
        meta_client_service_1.MetaClientService,
        config_1.ConfigService,
        webhook_dispatcher_service_1.WebhookDispatcherService])
], InboxService);
//# sourceMappingURL=inbox.service.js.map