import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveAutoReply } from '../../common/utils/ai-capabilities';
import { AiMeteringService } from '../ai/ai-metering.service';
import { AiProfileService } from '../ai/ai-profile.service';
import { isOpenAt } from '../ai/agent/profile';
import { InboxGateway } from '../inbox/inbox.gateway';
import { parseMemory } from './memory';
import { HANDOFF_LABEL } from './handoff.service';
import { isPrivileged as isPrivilegedRole } from '../../common/auth/roles';

interface Viewer {
  companyId: number;
  userId: number;
  role: string;
}

export type ChatAiState =
  | 'off'
  | 'muted'
  | 'blocked'
  | 'handed_off'
  | 'human_active'
  | 'off_hours'
  | 'on_chat'
  | 'on_workspace';

const TRACE_TYPES = [
  'ai.reply',
  'ai.shadow',
  'conversation.handoff',
  'order.created',
  'tool.failed',
  'ai.reply.ungrounded_price',
  'ai.knowledge_miss',
  'lead.qualified',
];

/** Inbox AI state, traces, feedback and the tenant Performance view. */
@Injectable()
export class AgentInsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metering: AiMeteringService,
    private readonly profiles: AiProfileService,
    private readonly gateway: InboxGateway,
  ) {}

  private async visibleConvo(v: Viewer, id: number) {
    const convo = await this.prisma.conversation.findFirst({
      where: { id, company_id: v.companyId, deleted_at: null },
      select: {
        id: true,
        assigned_user_id: true,
        ai_autoreply: true,
        ai_paused_until: true,
        ai_handoff_at: true,
        ai_memory: true,
        status: true,
        company: { select: { ai_autoreply_enabled: true } },
      },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    const privileged = isPrivilegedRole(v.role);
    if (!privileged && convo.assigned_user_id !== null && convo.assigned_user_id !== v.userId) {
      throw new NotFoundException('Conversation not found');
    }
    return convo;
  }

  async state(v: Viewer, id: number) {
    const convo = await this.visibleConvo(v, id);
    const bundle = await this.profiles.load(v.companyId);
    const p = bundle.profile;
    const effective = resolveAutoReply(convo.ai_autoreply, convo.company?.ai_autoreply_enabled);
    const blocked = await this.metering.blockReason(v.companyId);
    const open = isOpenAt(p.hours, new Date(), bundle.timezone);
    const now = Date.now();
    let state: ChatAiState;
    let until: string | null = null;
    if (convo.ai_autoreply === false) state = 'muted';
    else if (!effective) state = 'off';
    else if (blocked) state = 'blocked';
    else if (convo.ai_paused_until && convo.ai_paused_until.getTime() > now) {
      state = 'handed_off';
      until = convo.ai_paused_until.toISOString();
    } else {
      const pause = p.handoff.humanReplyPauseMin;
      const lastHuman =
        pause > 0
          ? await this.prisma.message.findFirst({
              where: { conversation_id: id, company_id: v.companyId, direction: 'outbound', user_id: { not: null } },
              orderBy: { timestamp: 'desc' },
              select: { timestamp: true },
            })
          : null;
      if (lastHuman && now - lastHuman.timestamp.getTime() < pause * 60_000) {
        state = 'human_active';
        until = new Date(lastHuman.timestamp.getTime() + pause * 60_000).toISOString();
      } else if (!open) state = 'off_hours';
      else state = convo.ai_autoreply === true ? 'on_chat' : 'on_workspace';
    }
    return {
      state,
      until,
      blockReason: blocked,
      open,
      offHoursMode: p.hours.offHoursMode,
      engine: p.engine,
      stage: parseMemory(convo.ai_memory).stage,
      handoffAt: convo.ai_handoff_at?.toISOString() ?? null,
    };
  }

  async resume(v: Viewer, id: number) {
    const convo = await this.visibleConvo(v, id);
    await this.prisma.conversation.update({
      where: { id },
      data: {
        ai_paused_until: null,
        ai_handoff_at: null,
        // Workspace answers all chats → follow it; else force this chat on.
        ai_autoreply: convo.company?.ai_autoreply_enabled ? null : true,
      },
    });
    await this.prisma.conversationLabel
      .deleteMany({ where: { conversation_id: id, label: HANDOFF_LABEL } })
      .catch(() => undefined);
    this.gateway.emitToCompany(v.companyId, 'conversation.updated', { conversationId: id });
    return { ok: true };
  }

  async trace(v: Viewer, id: number) {
    await this.visibleConvo(v, id);
    const events = await this.prisma.event.findMany({
      where: {
        company_id: v.companyId,
        aggregate_type: 'CONVERSATION',
        aggregate_id: BigInt(id),
        type: { in: TRACE_TYPES },
      },
      orderBy: { id: 'desc' },
      take: 60,
      select: { id: true, type: true, payload: true, created_at: true },
    });
    const feedback = await this.prisma.aiFeedback.findMany({
      where: { company_id: v.companyId, conversation_id: id },
      select: { message_id: true, user_id: true, rating: true, reason: true },
    });
    return {
      events: events.map((e) => ({
        id: Number(e.id),
        type: e.type,
        at: e.created_at.toISOString(),
        payload: e.payload,
      })),
      feedback,
    };
  }

  async feedback(v: Viewer, dto: { messageId: number; rating: number; reason?: string; comment?: string }) {
    const msg = await this.prisma.message.findFirst({
      where: { id: dto.messageId, company_id: v.companyId },
      select: { id: true, conversation_id: true, sent_by_ai: true },
    });
    if (!msg) throw new NotFoundException('Message not found');
    if (!msg.sent_by_ai) throw new BadRequestException('Only AI-written messages can be rated');
    await this.visibleConvo(v, msg.conversation_id);
    await this.prisma.aiFeedback.upsert({
      where: { message_id_user_id: { message_id: msg.id, user_id: v.userId } },
      create: {
        company_id: v.companyId,
        conversation_id: msg.conversation_id,
        message_id: msg.id,
        user_id: v.userId,
        rating: dto.rating,
        reason: dto.reason ?? null,
        comment: dto.comment ?? null,
      },
      update: { rating: dto.rating, reason: dto.reason ?? null, comment: dto.comment ?? null },
    });
    return { ok: true };
  }

  /** Tenant AI performance over the last `days`. */
  async performance(companyId: number, days: number) {
    const from = new Date(Date.now() - days * 86400000);
    const [aiChats, aiReplies, handoffs, orders, leads, bookings, fb, cost, misses, shadow] = await Promise.all([
      this.prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(DISTINCT conversation_id) AS n FROM messages
        WHERE company_id = ${companyId} AND sent_by_ai = 1 AND created_at >= ${from}`,
      this.prisma.message.count({ where: { company_id: companyId, sent_by_ai: true, created_at: { gte: from } } }),
      this.prisma.$queryRaw<Array<{ cat: string | null; n: bigint }>>`
        SELECT JSON_UNQUOTE(JSON_EXTRACT(payload, '$.category')) AS cat, COUNT(*) AS n
        FROM events WHERE company_id = ${companyId} AND type = 'conversation.handoff'
          AND actor_type = 'AI' AND created_at >= ${from}
        GROUP BY cat`,
      this.prisma.event.count({
        where: { company_id: companyId, type: 'order.created', actor_type: 'AI', created_at: { gte: from } },
      }),
      this.prisma.event.count({ where: { company_id: companyId, type: 'lead.qualified', created_at: { gte: from } } }),
      this.prisma.aiBooking.count({ where: { company_id: companyId, created_by: 'ai', created_at: { gte: from } } }),
      this.prisma.aiFeedback.groupBy({
        by: ['rating'],
        where: { company_id: companyId, created_at: { gte: from } },
        _count: { _all: true },
      }),
      this.prisma.aiUsageLog.aggregate({
        where: { company_id: companyId, created_at: { gte: from } },
        _sum: { cost_micros: true },
      }),
      this.prisma.$queryRaw<Array<{ q: string | null; n: bigint }>>`
        SELECT JSON_UNQUOTE(JSON_EXTRACT(payload, '$.query')) AS q, COUNT(*) AS n
        FROM events WHERE company_id = ${companyId} AND type = 'ai.knowledge_miss' AND created_at >= ${from}
        GROUP BY q ORDER BY n DESC LIMIT 10`,
      this.prisma.event.count({ where: { company_id: companyId, type: 'ai.shadow', created_at: { gte: from } } }),
    ]);
    const chats = Number(aiChats[0]?.n ?? 0);
    const handoffTotal = handoffs.reduce((s, h) => s + Number(h.n), 0);
    const up = fb.find((f) => f.rating === 1)?._count._all ?? 0;
    const down = fb.find((f) => f.rating === -1)?._count._all ?? 0;
    const costMicros = Number(cost._sum.cost_micros ?? 0n);
    const multiplier = await this.metering.getMultiplier();
    return {
      days,
      aiChats: chats,
      aiReplies,
      resolvedByAiPct: chats ? Math.max(0, Math.round(((chats - handoffTotal) / chats) * 100)) : null,
      handoffs: handoffTotal,
      handoffsByReason: handoffs.map((h) => ({ reason: h.cat ?? 'other', count: Number(h.n) })),
      ordersCreated: orders,
      leadsQualified: leads,
      bookingsMade: bookings,
      feedback: { up, down, downPct: up + down ? Math.round((down / (up + down)) * 100) : null },
      billedUsd: Math.round((costMicros * multiplier) / 10000) / 100,
      costPerChatUsd: chats ? Math.round(((costMicros * multiplier) / chats) / 10000) / 100 : null,
      unanswered: misses.map((m) => ({ question: m.q ?? '', count: Number(m.n) })),
      shadowTurns: shadow,
    };
  }
}
