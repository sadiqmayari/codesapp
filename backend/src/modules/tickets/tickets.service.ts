import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InboxService } from '../inbox/inbox.service';
import { SendMessageType } from '../inbox/dto/send-message.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { CreateTicketDto } from './dto/create-ticket.dto';

/** Statuses that count as still-open (a chat won't get a 2nd open ticket). */
const OPEN_STATUSES = ['open', 'in_progress', 'awaiting_customer'];

@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inbox: InboxService,
  ) {}

  /**
   * Auto-acknowledge a newly opened ticket to the customer with its number.
   * Best-effort: a closed 24h window / suspended tenant / send failure must
   * NEVER fail ticket creation. Sent once, only when a NEW ticket is created
   * (AI dispute or manual-from-chat), never on reuse.
   */
  private async sendTicketAck(
    companyId: number,
    conversationId: number,
    ticketNumber: string,
  ): Promise<void> {
    try {
      await this.inbox.sendMessage(companyId, conversationId, {
        type: SendMessageType.text,
        content:
          `✅ Aap ki shikayat darj kar li gayi hai. Ticket number: ` +
          `${ticketNumber}. Hamari support team jald aap se raabta karegi. ` +
          `Shukria!`,
      });
    } catch (e) {
      this.logger.debug(
        `ticket ack not sent (convo ${conversationId}, ${ticketNumber}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

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
      linkedOrderName?: string;
      // When true, do NOT auto-send the "ticket created" WhatsApp ack — the
      // caller (e.g. the AI via the open_ticket tool) communicates it itself.
      silentAck?: boolean;
    },
  ): Promise<{
    ticket: { id: number; ticket_number: string; status: string };
    created: boolean;
  }> {
    const existing = await this.findOpenForConversation(
      companyId,
      input.conversationId,
    );
    if (existing) {
      // Backfill the order number onto a reused ticket if it doesn't have one
      // yet (e.g. the open ticket predates the customer giving their order #).
      if (input.linkedOrderName?.trim()) {
        await this.prisma.supportTicket.updateMany({
          where: { id: existing.id, linked_order_name: null },
          data: { linked_order_name: input.linkedOrderName.trim() },
        });
      }
      return { ticket: existing, created: false };
    }

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
        linked_order_name: input.linkedOrderName?.trim() || null,
      },
    });
    await this.addEvent(companyId, ticket.id, {
      kind: 'created',
      actor: input.createdBy,
      body: input.description ?? null,
    });
    if (!input.silentAck) {
      await this.sendTicketAck(companyId, input.conversationId, ticketNumber);
    }
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
    if (dto.resolutionCode !== undefined) {
      data.resolution_code = dto.resolutionCode || null;
    }
    if (dto.reasonCode !== undefined) {
      data.reason_code = dto.reasonCode || null;
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

  /**
   * Agent-created (manual) ticket, always tied to a conversation. The contact
   * is derived from the conversation (both tenant-scoped). Reuses the open
   * ticket if one already exists for the chat (no duplicate open tickets).
   */
  async createManual(companyId: number, userId: number, dto: CreateTicketDto) {
    const convo = await this.prisma.conversation.findFirst({
      where: { id: dto.conversationId, company_id: companyId },
      select: { id: true, contact_id: true },
    });
    if (!convo) throw new BadRequestException('Conversation not found');

    const existing = await this.findOpenForConversation(
      companyId,
      dto.conversationId,
    );
    if (existing) {
      // Don't open a second ticket for a chat that already has one; just note it.
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
