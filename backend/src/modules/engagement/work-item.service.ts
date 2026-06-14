import { Injectable, Logger } from '@nestjs/common';
import { WorkItem } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  EventStoreService,
  ActorType,
} from '../../common/services/event-store.service';
import { nextState, isTerminal, FsmDef } from './state/fsm';
import {
  FSM_BY_TYPE,
  WorkItemType,
  statusForState,
  TERMINAL_STATUSES,
} from './state/work-item-states';

/**
 * The per-type FSMs are concrete unions (FsmDef<OrderState> | …); at runtime we
 * dispatch on a string state, so widen to FsmDef<string> at the call site.
 */
function fsmFor(type: string): FsmDef<string> {
  return FSM_BY_TYPE[type as WorkItemType] as unknown as FsmDef<string>;
}

export interface OpenWorkItemInput {
  companyId: number;
  conversationId: number;
  contactId: number;
  type: WorkItemType;
  owner?: 'AI' | 'HUMAN' | 'SYSTEM';
  externalRef?: string | null;
  priority?: number;
  actorType?: ActorType;
  actorId?: string | null;
  /** Optional: makes the open() idempotent (e.g. one ORDER per cart signature). */
  idempotencyKey?: string | null;
}

export interface TransitionInput {
  companyId: number;
  workItemId: number;
  event: string;
  actorType: ActorType;
  actorId?: string | null;
  payload?: unknown;
  /** When set, the transition+event are recorded at most once. */
  idempotencyKey?: string | null;
  /** Optional updates applied alongside the state change. */
  patch?: {
    externalRef?: string | null;
    assignedUserId?: number | null;
    owner?: 'AI' | 'HUMAN' | 'SYSTEM';
    expiresAt?: Date | null;
    priority?: number;
  };
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly type: string,
    public readonly from: string,
    public readonly event: string,
  ) {
    super(`Invalid ${type} transition: ${from} --(${event})-->`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * The single authority for work-item lifecycle. Every state change goes through
 * transition(), which validates against the type's declared FSM and appends an
 * event — there are NO ad-hoc `status:`/`state:` writes elsewhere. Tenant-scoped
 * on every query.
 *
 * Phase 1 ships this service + the FSMs; the router/commands wire it into the
 * live inbound flow in later phases (behind the engagement feature flag).
 */
@Injectable()
export class WorkItemService {
  private readonly logger = new Logger(WorkItemService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventStoreService,
  ) {}

  async open(input: OpenWorkItemInput): Promise<WorkItem> {
    const fsm = fsmFor(input.type);
    const item = await this.prisma.workItem.create({
      data: {
        company_id: input.companyId,
        conversation_id: input.conversationId,
        contact_id: input.contactId,
        type: input.type,
        state: fsm.initial,
        status: 'OPEN',
        owner: input.owner ?? 'AI',
        external_ref: input.externalRef ?? null,
        priority: input.priority ?? 5,
        last_activity_at: new Date(),
      },
    });

    await this.events.append({
      companyId: input.companyId,
      aggregateType: 'WORK_ITEM',
      aggregateId: item.id,
      type: `work_item.opened.${input.type.toLowerCase()}`,
      actorType: input.actorType ?? 'SYSTEM',
      actorId: input.actorId ?? null,
      payload: { type: input.type, state: fsm.initial },
      idempotencyKey: input.idempotencyKey ?? null,
    });

    return item;
  }

  /**
   * Apply a declared transition. Throws InvalidTransitionError if the event is
   * not allowed from the current state (or the item is terminal). Returns the
   * updated row.
   */
  async transition(input: TransitionInput): Promise<WorkItem> {
    const item = await this.prisma.workItem.findFirst({
      where: { id: input.workItemId, company_id: input.companyId },
    });
    if (!item) {
      throw new InvalidTransitionError('?', 'missing', input.event);
    }

    const fsm = fsmFor(item.type);
    if (!fsm) {
      throw new InvalidTransitionError(item.type, item.state, input.event);
    }

    const to = nextState(fsm, item.state, input.event);
    if (!to) {
      throw new InvalidTransitionError(item.type, item.state, input.event);
    }

    const newStatus = statusForState(item.type as WorkItemType, to);
    const terminal =
      isTerminal(fsm, to) || TERMINAL_STATUSES.has(newStatus);

    const updated = await this.prisma.workItem.update({
      where: { id: item.id },
      data: {
        state: to,
        status: newStatus,
        last_activity_at: new Date(),
        ...(terminal ? { closed_at: new Date() } : {}),
        ...(input.patch?.externalRef !== undefined
          ? { external_ref: input.patch.externalRef }
          : {}),
        ...(input.patch?.assignedUserId !== undefined
          ? { assigned_user_id: input.patch.assignedUserId }
          : {}),
        ...(input.patch?.owner !== undefined ? { owner: input.patch.owner } : {}),
        ...(input.patch?.expiresAt !== undefined
          ? { expires_at: input.patch.expiresAt }
          : {}),
        ...(input.patch?.priority !== undefined
          ? { priority: input.patch.priority }
          : {}),
      },
    });

    await this.events.append({
      companyId: input.companyId,
      aggregateType: 'WORK_ITEM',
      aggregateId: item.id,
      type: `work_item.${item.type.toLowerCase()}.${input.event}`,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      payload: { from: item.state, to, event: input.event, data: input.payload },
      idempotencyKey: input.idempotencyKey ?? null,
    });

    return updated;
  }

  /**
   * Hand a work item to a human: owner→HUMAN + an SLA deadline (expires_at), so
   * the item shows up in the human queue and the SLA sweep can re-escalate it if
   * it sits unowned. Orthogonal to the FSM state (which keeps its meaning).
   * Best-effort — a handoff must never fail because of bookkeeping.
   */
  async handoff(
    companyId: number,
    workItemId: number,
    reason: string,
    slaMs?: number,
  ): Promise<void> {
    try {
      await this.prisma.workItem.updateMany({
        where: { id: workItemId, company_id: companyId },
        data: {
          owner: 'HUMAN',
          last_activity_at: new Date(),
          ...(slaMs ? { expires_at: new Date(Date.now() + slaMs) } : {}),
        },
      });
      await this.events.append({
        companyId,
        aggregateType: 'WORK_ITEM',
        aggregateId: workItemId,
        type: 'work_item.handoff',
        actorType: 'AI',
        payload: { reason },
      });
    } catch (e) {
      this.logger.debug(
        `work-item handoff bookkeeping skipped (${workItemId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * SLA sweep: human-owned, still-open work items whose deadline has passed and
   * which nobody has picked up. Returns them so a cron can re-escalate/notify.
   */
  findOverdueHandoffs(limit = 100): Promise<WorkItem[]> {
    return this.prisma.workItem.findMany({
      where: {
        owner: 'HUMAN',
        status: 'OPEN',
        assigned_user_id: null,
        expires_at: { not: null, lt: new Date() },
      },
      orderBy: { expires_at: 'asc' },
      take: limit,
    });
  }

  /**
   * Cron entry: for each overdue, unowned handoff, record an SLA-breach event and
   * push the deadline out one window so it re-fires next sweep if still unpicked
   * (without spamming every run). Returns the breached items (conversation ids)
   * so the caller can surface/notify. Best-effort per item.
   */
  async sweepOverdueHandoffs(
    slaMs: number,
    limit = 100,
  ): Promise<{ swept: number; conversationIds: number[] }> {
    const overdue = await this.findOverdueHandoffs(limit);
    const conversationIds: number[] = [];
    for (const item of overdue) {
      try {
        await this.events.append({
          companyId: item.company_id,
          aggregateType: 'WORK_ITEM',
          aggregateId: item.id,
          type: 'work_item.handoff.sla_breach',
          actorType: 'SYSTEM',
          payload: { type: item.type, conversationId: item.conversation_id },
        });
        await this.prisma.workItem.update({
          where: { id: item.id },
          data: { expires_at: new Date(Date.now() + slaMs) },
        });
        conversationIds.push(item.conversation_id);
      } catch {
        /* best-effort per item */
      }
    }
    return { swept: conversationIds.length, conversationIds };
  }

  /** All non-terminal work items for a conversation (the concurrent engagements). */
  listOpen(companyId: number, conversationId: number): Promise<WorkItem[]> {
    return this.prisma.workItem.findMany({
      where: {
        company_id: companyId,
        conversation_id: conversationId,
        status: { in: ['OPEN', 'SNOOZED'] },
      },
      orderBy: { last_activity_at: 'desc' },
    });
  }

  get(companyId: number, id: number): Promise<WorkItem | null> {
    return this.prisma.workItem.findFirst({
      where: { id, company_id: companyId },
    });
  }
}
