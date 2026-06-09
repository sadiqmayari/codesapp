import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateTicketDto } from './dto/update-ticket.dto';

/** Statuses that count as still-open (a chat won't get a 2nd open ticket). */
const OPEN_STATUSES = ['open', 'in_progress', 'awaiting_customer'];

@Injectable()
export class TicketsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Tenant-scoped list, newest first, optional status/type filter. */
  list(
    companyId: number,
    opts?: { status?: string; type?: string },
  ) {
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

  async get(companyId: number, id: number) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id, company_id: companyId },
      include: {
        contact: { select: { id: true, name: true, phone: true } },
        assigned_user: { select: { id: true, name: true } },
        events: { orderBy: { created_at: 'asc' } },
      },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  /** Open ticket for a conversation, if any (for the inbox header chip). */
  findOpenForConversation(companyId: number, conversationId: number) {
    return this.prisma.supportTicket.findFirst({
      where: {
        company_id: companyId,
        conversation_id: conversationId,
        status: { in: OPEN_STATUSES },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  /**
   * Reuse the conversation's open ticket or create a new one (with a 'created'
   * timeline event). Used by the AI dispute branch. Tenant-scoped.
   */
  async createOrReuseForConversation(
    companyId: number,
    input: {
      conversationId: number;
      contactId: number;
      type: string;
      createdBy: 'ai' | 'agent';
      description?: string;
    },
  ): Promise<{
    ticket: { id: number; ticket_number: string; status: string };
    created: boolean;
  }> {
    const existing = await this.findOpenForConversation(
      companyId,
      input.conversationId,
    );
    if (existing) return { ticket: existing, created: false };

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

  /** Append an event to a ticket's timeline. Best-effort caller may ignore errors. */
  async addEvent(
    companyId: number,
    ticketId: number,
    e: {
      kind: string;
      actor: 'ai' | 'agent' | 'customer';
      body?: string | null;
      userId?: number | null;
    },
  ) {
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

  /** Agent-driven update (status / assignee / resolution note) + timeline events. */
  async update(
    companyId: number,
    id: number,
    dto: UpdateTicketDto,
    userId: number,
  ) {
    const current = await this.get(companyId, id);
    const data: Record<string, unknown> = {};

    if (dto.status && dto.status !== current.status) {
      data.status = dto.status;
      if (dto.status === 'resolved' || dto.status === 'rejected') {
        data.closed_at = new Date();
      } else {
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

  /** Append an agent note. */
  async addNote(companyId: number, id: number, body: string, userId: number) {
    await this.get(companyId, id);
    await this.addEvent(companyId, id, {
      kind: 'note',
      actor: 'agent',
      body,
      userId,
    });
    return this.get(companyId, id);
  }

  /** Per-company DSP-#### number (starts at DSP-1001). */
  private async nextTicketNumber(companyId: number): Promise<string> {
    const latest = await this.prisma.supportTicket.findFirst({
      where: { company_id: companyId },
      orderBy: { id: 'desc' },
      select: { ticket_number: true },
    });
    const last = latest?.ticket_number?.match(/(\d+)\s*$/);
    const next = last ? parseInt(last[1], 10) + 1 : 1001;
    return `DSP-${next}`;
  }
}
