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
var TicketsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TicketsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const inbox_service_1 = require("../inbox/inbox.service");
const send_message_dto_1 = require("../inbox/dto/send-message.dto");
const OPEN_STATUSES = ['open', 'in_progress', 'awaiting_customer'];
let TicketsService = TicketsService_1 = class TicketsService {
    constructor(prisma, inbox) {
        this.prisma = prisma;
        this.inbox = inbox;
        this.logger = new common_1.Logger(TicketsService_1.name);
    }
    async sendTicketAck(companyId, conversationId, ticketNumber) {
        try {
            await this.inbox.sendMessage(companyId, conversationId, {
                type: send_message_dto_1.SendMessageType.text,
                content: `✅ Aap ki shikayat darj kar li gayi hai. Ticket number: ` +
                    `${ticketNumber}. Hamari support team jald aap se raabta karegi. ` +
                    `Shukria!`,
            });
        }
        catch (e) {
            this.logger.debug(`ticket ack not sent (convo ${conversationId}, ${ticketNumber}): ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    list(companyId, opts) {
        return this.prisma.supportTicket.findMany({
            where: {
                company_id: companyId,
                ...(opts?.status ? { status: opts.status } : {}),
                ...(opts?.type ? { type: opts.type } : {}),
            },
            orderBy: { updated_at: 'desc' },
            include: {
                contact: { select: { id: true, name: true, phone: true } },
                assigned_user: { select: { id: true, name: true } },
            },
            take: 200,
        });
    }
    async get(companyId, id) {
        const ticket = await this.prisma.supportTicket.findFirst({
            where: { id, company_id: companyId },
            include: {
                contact: { select: { id: true, name: true, phone: true } },
                assigned_user: { select: { id: true, name: true } },
                events: { orderBy: { created_at: 'asc' } },
            },
        });
        if (!ticket)
            throw new common_1.NotFoundException('Ticket not found');
        return ticket;
    }
    findOpenForConversation(companyId, conversationId) {
        return this.prisma.supportTicket.findFirst({
            where: {
                company_id: companyId,
                conversation_id: conversationId,
                status: { in: OPEN_STATUSES },
            },
            orderBy: { created_at: 'desc' },
        });
    }
    async createOrReuseForConversation(companyId, input) {
        const existing = await this.findOpenForConversation(companyId, input.conversationId);
        if (existing)
            return { ticket: existing, created: false };
        const ticketNumber = await this.nextTicketNumber(companyId);
        const ticket = await this.prisma.supportTicket.create({
            data: {
                company_id: companyId,
                conversation_id: input.conversationId,
                contact_id: input.contactId,
                ticket_number: ticketNumber,
                type: input.type,
                status: 'open',
                created_by: input.createdBy,
                description: input.description ?? null,
            },
        });
        await this.addEvent(companyId, ticket.id, {
            kind: 'created',
            actor: input.createdBy,
            body: input.description ?? null,
        });
        await this.sendTicketAck(companyId, input.conversationId, ticketNumber);
        return { ticket, created: true };
    }
    async addEvent(companyId, ticketId, e) {
        return this.prisma.ticketEvent.create({
            data: {
                company_id: companyId,
                ticket_id: ticketId,
                kind: e.kind,
                actor: e.actor,
                body: e.body ?? null,
                user_id: e.userId ?? null,
            },
        });
    }
    async update(companyId, id, dto, userId) {
        const current = await this.get(companyId, id);
        const data = {};
        if (dto.status && dto.status !== current.status) {
            data.status = dto.status;
            if (dto.status === 'resolved' || dto.status === 'rejected') {
                data.closed_at = new Date();
            }
            else {
                data.closed_at = null;
            }
        }
        if (dto.assignedUserId !== undefined) {
            data.assigned_user_id = dto.assignedUserId;
        }
        if (dto.resolutionNote !== undefined) {
            data.resolution_note = dto.resolutionNote;
        }
        if (Object.keys(data).length) {
            await this.prisma.supportTicket.update({ where: { id }, data });
        }
        if (dto.status && dto.status !== current.status) {
            await this.addEvent(companyId, id, {
                kind: 'status_change',
                actor: 'agent',
                body: `${current.status} → ${dto.status}`,
                userId,
            });
        }
        return this.get(companyId, id);
    }
    async addNote(companyId, id, body, userId) {
        await this.get(companyId, id);
        await this.addEvent(companyId, id, {
            kind: 'note',
            actor: 'agent',
            body,
            userId,
        });
        return this.get(companyId, id);
    }
    async createManual(companyId, userId, dto) {
        const convo = await this.prisma.conversation.findFirst({
            where: { id: dto.conversationId, company_id: companyId },
            select: { id: true, contact_id: true },
        });
        if (!convo)
            throw new common_1.BadRequestException('Conversation not found');
        const existing = await this.findOpenForConversation(companyId, dto.conversationId);
        if (existing) {
            await this.addEvent(companyId, existing.id, {
                kind: 'note',
                actor: 'agent',
                body: dto.description?.trim() || '(opened from inbox)',
                userId,
            });
            return this.get(companyId, existing.id);
        }
        const ticketNumber = await this.nextTicketNumber(companyId);
        const ticket = await this.prisma.supportTicket.create({
            data: {
                company_id: companyId,
                conversation_id: convo.id,
                contact_id: convo.contact_id,
                ticket_number: ticketNumber,
                type: dto.type,
                status: 'open',
                created_by: 'agent',
                description: dto.description?.trim() || null,
                linked_order_name: dto.linkedOrderName?.trim() || null,
                assigned_user_id: dto.assignedUserId ?? null,
            },
        });
        await this.addEvent(companyId, ticket.id, {
            kind: 'created',
            actor: 'agent',
            body: dto.description?.trim() || null,
            userId,
        });
        await this.sendTicketAck(companyId, convo.id, ticketNumber);
        return this.get(companyId, ticket.id);
    }
    async nextTicketNumber(companyId) {
        const latest = await this.prisma.supportTicket.findFirst({
            where: { company_id: companyId },
            orderBy: { id: 'desc' },
            select: { ticket_number: true },
        });
        const last = latest?.ticket_number?.match(/(\d+)\s*$/);
        const next = last ? parseInt(last[1], 10) + 1 : 1001;
        return `DSP-${next}`;
    }
};
exports.TicketsService = TicketsService;
exports.TicketsService = TicketsService = TicketsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        inbox_service_1.InboxService])
], TicketsService);
//# sourceMappingURL=tickets.service.js.map