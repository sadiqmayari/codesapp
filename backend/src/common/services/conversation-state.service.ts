import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EventStoreService } from './event-store.service';
import { FeatureService } from './feature.service';
import {
  ConversationState,
  ConversationStateMachine,
} from './conversation-state-machine';

/**
 * Persistence + audit wrapper around the pure ConversationStateMachine
 * (increment 9 / spec #1). The backend is the ONLY writer of conversation state.
 *
 * SHADOW MODE: `apply()` is flag-gated (default OFF) and best-effort — it records
 * the canonical state + validates the transition alongside the live flow without
 * altering any existing behavior. A legal transition advances the persisted state
 * and logs `state.transition`; an ILLEGAL one is REJECTED (state unchanged) and
 * logged as `state.invalid_transition` — exactly the signal we need to prove the
 * transition table against real traffic before making it authoritative. Never
 * throws into the orchestrator.
 */

export interface StateMeta {
  lockedIntent?: string | null;
  activeOrderId?: string | null;
  activeTicketId?: number | null;
  expiresAt?: Date | null;
  collectedFields?: Record<string, unknown> | null;
}

@Injectable()
export class ConversationStateService {
  private readonly logger = new Logger(ConversationStateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventStoreService,
    private readonly machine: ConversationStateMachine,
    private readonly featureService: FeatureService,
  ) {}

  /** Current persisted state for a conversation, or null if none yet. */
  async current(
    companyId: number,
    conversationId: number,
  ): Promise<ConversationState | null> {
    const row = await this.prisma.conversationState
      .findUnique({
        where: { conversation_id: conversationId },
        select: { current_state: true, company_id: true },
      })
      .catch(() => null);
    if (!row || row.company_id !== companyId) return null;
    return this.machine.isState(row.current_state) ? row.current_state : null;
  }

  /**
   * Validate + apply a transition to `target`. Flag-gated + best-effort.
   * - No prior state → record `target` as the initial state.
   * - Legal transition → advance + log `state.transition`.
   * - Illegal transition → REJECT (keep current) + log `state.invalid_transition`.
   */
  async apply(
    companyId: number,
    conversationId: number,
    target: ConversationState,
    meta?: StateMeta,
  ): Promise<void> {
    try {
      if (!(await this.featureService.conversationStateMachineEnabled(companyId)))
        return;

      const existing = await this.prisma.conversationState
        .findUnique({ where: { conversation_id: conversationId } })
        .catch(() => null);
      const from: ConversationState | null =
        existing && this.machine.isState(existing.current_state)
          ? existing.current_state
          : null;

      if (from && from !== target) {
        const { ok } = this.machine.validate(from, target);
        if (!ok) {
          await this.events.append({
            companyId,
            aggregateType: 'CONVERSATION',
            aggregateId: conversationId,
            type: 'state.invalid_transition',
            actorType: 'SYSTEM',
            payload: { from, to: target },
          });
          return; // REJECT — state unchanged (shadow validation signal)
        }
      }

      const data = {
        current_state: target,
        ...(meta?.lockedIntent !== undefined
          ? { locked_intent: meta.lockedIntent }
          : {}),
        ...(meta?.activeOrderId !== undefined
          ? { active_order_id: meta.activeOrderId }
          : {}),
        ...(meta?.activeTicketId !== undefined
          ? { active_ticket_id: meta.activeTicketId }
          : {}),
        ...(meta?.expiresAt !== undefined ? { expires_at: meta.expiresAt } : {}),
        ...(meta?.collectedFields !== undefined
          ? {
              collected_fields: (meta.collectedFields ??
                Prisma.JsonNull) as Prisma.InputJsonValue,
            }
          : {}),
      };

      await this.prisma.conversationState.upsert({
        where: { conversation_id: conversationId },
        create: {
          company_id: companyId,
          conversation_id: conversationId,
          ...data,
        },
        update: data,
      });

      // Only log an actual change (skip idempotent self-transitions to cut noise).
      if (from !== target) {
        await this.events.append({
          companyId,
          aggregateType: 'CONVERSATION',
          aggregateId: conversationId,
          type: 'state.transition',
          actorType: 'SYSTEM',
          payload: { from: from ?? null, to: target },
        });
      }
    } catch (e) {
      this.logger.warn(
        `conversation state apply failed (convo ${conversationId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}
