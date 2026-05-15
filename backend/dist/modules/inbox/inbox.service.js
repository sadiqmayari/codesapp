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
const prisma_service_1 = require("../../prisma/prisma.service");
const usage_metering_service_1 = require("../usage-metering/usage-metering.service");
const inbox_gateway_1 = require("./inbox.gateway");
const meta_client_service_1 = require("./meta-client.service");
const send_message_dto_1 = require("./dto/send-message.dto");
const list_conversations_dto_1 = require("./dto/list-conversations.dto");
const DEFAULT_PAGE_SIZE = 20;
const MAX_MESSAGES_PER_PAGE = 50;
let InboxService = InboxService_1 = class InboxService {
    constructor(prisma, metering, gateway, metaClient, config) {
        this.prisma = prisma;
        this.metering = metering;
        this.gateway = gateway;
        this.metaClient = metaClient;
        this.config = config;
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
        if (dto.status && dto.status !== list_conversations_dto_1.ConversationListStatus.all) {
            where.status = dto.status;
        }
        if (dto.assignedUserId) {
            where.assigned_user_id = dto.assignedUserId;
        }
        if (dto.label) {
            where.labels = { some: { label: dto.label } };
        }
        if (dto.search) {
            where.contact = {
                is: {
                    OR: [
                        { name: { contains: dto.search } },
                        { phone: { contains: dto.search } },
                    ],
                },
            };
        }
        const [total, rows] = await Promise.all([
            this.prisma.conversation.count({ where }),
            this.prisma.conversation.findMany({
                where,
                orderBy: { updated_at: 'desc' },
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
        const user = await this.prisma.user.findFirst({
            where: { id: userId, company_id: companyId, status: 'active' },
            select: { id: true },
        });
        if (!user)
            throw new common_1.NotFoundException('User not found in this company');
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
        await this.requireConversation(companyId, id);
        const take = Math.min(limit || MAX_MESSAGES_PER_PAGE, MAX_MESSAGES_PER_PAGE);
        const where = {
            conversation_id: id,
            company_id: companyId,
        };
        if (cursor)
            where.id = { lt: cursor };
        const rows = await this.prisma.message.findMany({
            where,
            orderBy: { id: 'desc' },
            take,
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
    async sendMessage(companyId, conversationId, dto) {
        const convo = await this.requireConversation(companyId, conversationId);
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
                text: { body: dto.content },
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
            textContent = `[template:${tpl.name}]`;
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
                timestamp: new Date(),
            },
        });
        await this.prisma.conversation.update({
            where: { id: conversationId },
            data: {
                last_message: textContent?.slice(0, 500) ?? `[${messageType}]`,
            },
        });
        await this.metering.incrementMessages(companyId);
        this.gateway.emitToCompany(companyId, 'message.sent', { message });
        return message;
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
        config_1.ConfigService])
], InboxService);
//# sourceMappingURL=inbox.service.js.map