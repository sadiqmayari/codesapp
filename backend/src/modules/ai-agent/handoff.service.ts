import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventStoreService } from '../../common/services/event-store.service';
import { InboxService } from '../inbox/inbox.service';
import { InboxGateway } from '../inbox/inbox.gateway';
import { SendMessageType } from '../inbox/dto/send-message.dto';
import { HandoffConfig } from '../ai/agent/profile';

export const HANDOFF_LABEL = 'needs-human';

/** Reason categories (drive priority + analytics). */
export type HandoffCategory =
  | 'asked_human'
  | 'upset'
  | 'sensitive'
  | 'no_progress'
  | 'payment_slip'
  | 'order_value'
  | 'manual_order'
  | 'keyword'
  | 'error'
  | 'model';

const HIGH_PRIORITY: HandoffCategory[] = ['upset', 'sensitive', 'payment_slip', 'error'];

/**
 * AI → human handoff (v2). Unlike v1 (silent + permanent mute):
 *  - tells the customer (in-hours / off-hours message from the profile)
 *  - assigns the chat (least-busy active agent) unless the tenant uses the pool
 *  - writes a `handoffs` row (reason, category, priority, SLA due) + the
 *    `needs-human` label + a socket update + an event
 *  - PAUSES the AI for `resumeAfterMin` (0 = until a human turns it back on)
 *    instead of muting it forever
 * Never throws.
 */
@Injectable()
export class AgentHandoffService {
  private readonly logger = new Logger(AgentHandoffService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inbox: InboxService,
    private readonly gateway: InboxGateway,
    private readonly events: EventStoreService,
  ) {}

  /** Least-busy active owner/admin/agent (fewest open/pending assigned chats). */
  async pickAgent(companyId: number): Promise<number | null> {
    const users = await this.prisma.user.findMany({
      where: {
        company_id: companyId,
        status: 'active',
        role: { in: ['agent', 'admin', 'owner'] },
      },
      select: { id: true, role: true },
    });
    if (!users.length) return null;
    const loads = await this.prisma.conversation.groupBy({
      by: ['assigned_user_id'],
      where: {
        company_id: companyId,
        deleted_at: null,
        status: { in: ['open', 'pending'] },
        assigned_user_id: { in: users.map((u) => u.id) },
      },
      _count: { _all: true },
    });
    const load = new Map(loads.map((l) => [l.assigned_user_id, l._count._all]));
    // Prefer agents; owners/admins only when no agent exists.
    const agents = users.filter((u) => u.role === 'agent');
    const pool = agents.length ? agents : users;
    pool.sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || a.id - b.id);
    return pool[0]?.id ?? null;
  }

  async handoff(input: {
    companyId: number;
    conversationId: number;
    reason: string;
    category: HandoffCategory;
    cfg: HandoffConfig;
    open: boolean;
    /** Send the customer the handoff message (default true). */
    notify?: boolean;
    /** Custom customer message (overrides the profile text). */
    message?: string;
    dryRun?: boolean;
  }): Promise<{ assignedUserId: number | null; message: string | null }> {
    const { companyId, conversationId, cfg } = input;
    const text =
      input.notify === false
        ? null
        : input.message?.trim() || (input.open ? cfg.messageInHours : cfg.messageOffHours);
    if (input.dryRun) return { assignedUserId: null, message: text };

    let assignedUserId: number | null = null;
    try {
      if (text) {
        await this.inbox
          .sendMessage(
            companyId,
            conversationId,
            { type: SendMessageType.text, content: text },
            undefined,
            { sentByAi: true },
          )
          .catch((e) =>
            this.logger.warn(
              `handoff message failed (convo ${conversationId}): ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
      }

      const convo = await this.prisma.conversation.findFirst({
        where: { id: conversationId, company_id: companyId },
        select: { assigned_user_id: true },
      });
      assignedUserId = convo?.assigned_user_id ?? null;
      if (!assignedUserId && cfg.assignTo === 'round_robin') {
        const pick = await this.pickAgent(companyId);
        if (pick) {
          await this.inbox.assign(companyId, conversationId, pick).catch(() => undefined);
          assignedUserId = pick;
        }
      }

      const now = new Date();
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          status: 'pending',
          ai_handoff_at: now,
          ...(cfg.resumeAfterMin > 0
            ? { ai_paused_until: new Date(now.getTime() + cfg.resumeAfterMin * 60_000) }
            : { ai_autoreply: false, ai_paused_until: null }),
        },
      });

      await this.prisma.handoff
        .create({
          data: {
            company_id: companyId,
            conversation_id: conversationId,
            reason: input.reason.slice(0, 255),
            reason_category: input.category,
            priority: HIGH_PRIORITY.includes(input.category) ? 'high' : 'normal',
            assigned_user_id: assignedUserId,
            sla_due_at: new Date(now.getTime() + 15 * 60_000),
          },
        })
        .catch(() => undefined);

      await this.prisma.conversationLabel
        .upsert({
          where: { conversation_id_label: { conversation_id: conversationId, label: HANDOFF_LABEL } },
          create: { company_id: companyId, conversation_id: conversationId, label: HANDOFF_LABEL },
          update: {},
        })
        .catch(() => undefined);

      this.gateway.emitToCompany(companyId, 'conversation.updated', {
        conversationId,
        addedLabel: HANDOFF_LABEL,
        aiHandoff: { category: input.category, reason: input.reason },
      });

      await this.events.append({
        companyId,
        aggregateType: 'CONVERSATION',
        aggregateId: conversationId,
        type: 'conversation.handoff',
        actorType: 'AI',
        payload: {
          reason: input.reason,
          category: input.category,
          assignedUserId,
          resumeAfterMin: cfg.resumeAfterMin,
        },
      });
    } catch (e) {
      this.logger.warn(
        `handoff failed (convo ${conversationId}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return { assignedUserId, message: text };
  }
}
