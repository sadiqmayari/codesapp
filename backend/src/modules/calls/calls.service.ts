import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { InboxGateway } from '../inbox/inbox.gateway';
import { CallEventDto } from './dto/call-event.dto';

const digits = (s?: string | null) => (s ?? '').replace(/\D/g, '');

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: InboxGateway,
    private readonly config: ConfigService,
  ) {}

  /**
   * Resolve the tenant company from the business WhatsApp number on the call,
   * then the contact + conversation from the customer number, upsert the
   * call_logs row for this call lifecycle event, and emit a scoped socket event.
   * Fully best-effort — a call must never fail because logging did.
   */
  async handleEvent(dto: CallEventDto): Promise<{ ok: boolean }> {
    try {
      const businessRaw = dto.direction === 'inbound' ? dto.to : dto.from;
      const customerRaw = dto.direction === 'inbound' ? dto.from : dto.to;
      const businessDigits = digits(businessRaw);
      if (!businessDigits) return { ok: false };

      // Company via the business WhatsApp number.
      const numbers = await this.prisma.whatsAppNumber.findMany({
        select: { company_id: true, display_phone_number: true },
      });
      const match = numbers.find(
        (n) => digits(n.display_phone_number).endsWith(businessDigits.slice(-11)),
      );
      if (!match) {
        this.logger.warn(`call event: no company for business ${businessDigits}`);
        return { ok: false };
      }
      const companyId = match.company_id;

      // Contact + latest conversation via the customer number.
      const cust = digits(customerRaw);
      let contactId: number | null = null;
      let conversationId: number | null = null;
      let assignedUserId: number | null = null;
      if (cust) {
        const variants = [cust, `+${cust}`, cust.slice(-10), cust.slice(-11)];
        const contact = await this.prisma.contact.findFirst({
          where: { company_id: companyId, phone: { in: variants } },
          select: { id: true },
        });
        if (contact) {
          contactId = contact.id;
          const convo = await this.prisma.conversation.findFirst({
            where: { company_id: companyId, contact_id: contact.id, deleted_at: null },
            orderBy: { last_message_at: 'desc' },
            select: { id: true, assigned_user_id: true },
          });
          if (convo) {
            conversationId = convo.id;
            assignedUserId = convo.assigned_user_id ?? null;
          }
        }
      }

      const existing = await this.prisma.callLog.findFirst({
        where: { company_id: companyId, provider_call_id: dto.callId },
        select: { id: true, started_at: true },
      });

      const now = new Date();
      let row;
      if (dto.event === 'call_started') {
        row = existing
          ? await this.prisma.callLog.update({
              where: { id: existing.id },
              data: { status: 'ringing' },
            })
          : await this.prisma.callLog.create({
              data: {
                company_id: companyId,
                conversation_id: conversationId,
                contact_id: contactId,
                direction: dto.direction,
                status: 'ringing',
                from_number: dto.from ?? null,
                to_number: dto.to ?? null,
                provider_call_id: dto.callId,
                started_at: now,
              },
            });
      } else if (dto.event === 'call_answered') {
        row = await this.upsert(existing?.id, companyId, dto, conversationId, contactId, {
          status: 'answered',
          answered_at: now,
        });
      } else {
        // call_ended
        const answered = dto.answered === true || (dto.durationSec ?? 0) > 0;
        row = await this.upsert(existing?.id, companyId, dto, conversationId, contactId, {
          status: answered ? 'completed' : 'missed',
          ended_at: now,
          duration_sec: dto.durationSec ?? null,
        });
      }

      this.gateway.emitToConversationScoped(companyId, assignedUserId, 'call.updated', {
        conversationId,
        call: row,
      });
      return { ok: true };
    } catch (e) {
      this.logger.error(`handleEvent failed: ${(e as Error).message}`);
      return { ok: false };
    }
  }

  private async upsert(
    id: number | undefined,
    companyId: number,
    dto: CallEventDto,
    conversationId: number | null,
    contactId: number | null,
    data: Record<string, unknown>,
  ) {
    if (id) {
      return this.prisma.callLog.update({ where: { id }, data });
    }
    return this.prisma.callLog.create({
      data: {
        company_id: companyId,
        conversation_id: conversationId,
        contact_id: contactId,
        direction: dto.direction,
        from_number: dto.from ?? null,
        to_number: dto.to ?? null,
        provider_call_id: dto.callId,
        started_at: new Date(),
        ...data,
      } as never,
    });
  }

  listForConversation(companyId: number, conversationId: number) {
    return this.prisma.callLog.findMany({
      where: { company_id: companyId, conversation_id: conversationId },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
  }

  /**
   * Ephemeral SIP credentials for the in-browser (JsSIP/WSS) softphone.
   * NOTE: v1 single-agent test harness — returns the shared `agent1` endpoint.
   * Per-agent provisioning (one SIP endpoint per user, stored encrypted) is the
   * next step before multi-agent rollout.
   */
  sipCredentials() {
    const wssUrl = this.config.get<string>('SIP_WSS_URL') ?? '';
    return {
      configured: !!wssUrl,
      wssUrl, // e.g. wss://sip.codentra.pk:8089/ws
      realm: this.config.get<string>('SIP_REALM') ?? 'sip.codentra.pk',
      username: this.config.get<string>('SIP_AGENT_USERNAME') ?? 'agent1',
      password: this.config.get<string>('SIP_AGENT_PASSWORD') ?? '',
    };
  }
}
