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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TicketsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const OPEN_STATUSES = ['open', 'in_progress', 'awaiting_customer'];
let TicketsService = class TicketsService {
    constructor(prisma) {
        this.prisma = prisma;
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
exports.TicketsService = TicketsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], TicketsService);
//# sourceMappingURL=tickets.service.js.map