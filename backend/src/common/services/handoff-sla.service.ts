import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventStoreService } from './event-store.service';
import { MailService } from './mail.service';
import { FeatureService } from './feature.service';

/**
 * Handoff SLA Management (enterprise hardening — increment 8, spec #10).
 *
 * WHY: a handoff is only useful if someone owns it and there's a deadline. This
 * service stamps every AI→human handoff with a DETERMINISTIC priority + SLA due
 * time (derived from the reason), and a sweep (cron) resolves picked-up handoffs
 * and ALERTS on breaches — so an angry/legal/fraud chat can't sit unattended.
 *
 * DESIGN
 * - Priority/SLA mapping is a pure function (`classify`) — fully testable.
 * - Pickup is DERIVED at sweep time from conversation state (assigned, or moved
 *   off 'pending'), so we don't have to instrument every human action; the worst
 *   case is a missed alert, never a false one (conservative).
 * - Recording is flag-gated (default OFF) per company, so the sweep naturally only
 *   processes opted-in tenants (disabled tenants never create rows). Fail-safe:
 *   record() never throws into the handoff path; sweep() never throws into cron.
 */

export type HandoffPriority = 'urgent' | 'high' | 'normal';
export type HandoffCategory =
  | 'fraud'
  | 'medical_legal'
  | 'angry'
  | 'frustration'
  | 'refund'
  | 'damaged'
  | 'payment'
  | 'general';

interface SlaDef {
  priority: HandoffPriority;
  minutes: number;
}

/** SLA table (spec #10): legal/fraud/angry fastest; general slowest. */
const SLA: Record<HandoffCategory, SlaDef> = {
  fraud: { priority: 'urgent', minutes: 15 },
  medical_legal: { priority: 'urgent', minutes: 15 },
  angry: { priority: 'urgent', minutes: 15 },
  frustration: { priority: 'high', minutes: 30 },
  refund: { priority: 'high', minutes: 60 },
  damaged: { priority: 'high', minutes: 120 },
  payment: { priority: 'normal', minutes: 60 },
  general: { priority: 'normal', minutes: 240 },
};

@Injectable()
export class HandoffSlaService {
  private readonly logger = new Logger(HandoffSlaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventStoreService,
    private readonly mail: MailService,
    private readonly featureService: FeatureService,
  ) {}

  /** Deterministically map a free-text handoff reason → category + SLA. Pure. */
  classify(reason: string): {
    category: HandoffCategory;
    priority: HandoffPriority;
    minutes: number;
  } {
    const r = (reason || '').toLowerCase();
    let category: HandoffCategory = 'general';
    if (/fraud/.test(r)) category = 'fraud';
    else if (/legal|medical|prescription|high_risk|compliance/.test(r))
      category = 'medical_legal';
    else if (/angry|abusiv|escalat|wants human/.test(r)) category = 'angry';
    else if (/frustrat/.test(r)) category = 'frustration';
    else if (/refund|return|cancel/.test(r)) category = 'refund';
    else if (/damag|broken|wrong|missing|defect/.test(r)) category = 'damaged';
    else if (/payment|prepaid|slip/.test(r)) category = 'payment';
    const def = SLA[category];
    return { category, priority: def.priority, minutes: def.minutes };
  }

  /**
   * Record a handoff with its SLA. Flag-gated + best-effort (never throws into the
   * handoff path). Supersedes any still-open handoff for the same conversation so
   * there is at most one active SLA per chat.
   */
  async record(
    companyId: number,
    conversationId: number,
    reason: string,
  ): Promise<void> {
    try {
      if (!(await this.featureService.handoffSlaEnabled(companyId))) return;
      const { category, priority, minutes } = this.classify(reason);
      const now = Date.now();
      const slaDueAt = new Date(now + minutes * 60_000);

      // Supersede prior open handoffs for this conversation.
      await this.prisma.handoff.updateMany({
        where: {
          company_id: companyId,
          conversation_id: conversationId,
          resolved_at: null,
        },
        data: { resolved_at: new Date() },
      });

      await this.prisma.handoff.create({
        data: {
          company_id: companyId,
          conversation_id: conversationId,
          reason: reason.slice(0, 255),
          reason_category: category,
          priority,
          sla_due_at: slaDueAt,
        },
      });

      await this.events.append({
        companyId,
        aggregateType: 'CONVERSATION',
        aggregateId: conversationId,
        type: 'handoff.sla_set',
        actorType: 'SYSTEM',
        payload: { category, priority, slaDueAt: slaDueAt.toISOString() },
      });
    } catch (e) {
      this.logger.warn(
        `handoff SLA record failed (convo ${conversationId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * Cron sweep: for every unresolved, un-escalated, past-due handoff, mark it
   * resolved if a human picked it up, else escalate (alert once). Never throws.
   */
  async sweepOverdue(): Promise<{
    checked: number;
    resolved: number;
    breached: number;
  }> {
    let resolved = 0;
    let breached = 0;
    let due: Array<{
      id: number;
      company_id: number;
      conversation_id: number;
      reason: string;
      reason_category: string;
      priority: string;
      sla_due_at: Date;
    }> = [];
    try {
      due = await this.prisma.handoff.findMany({
        where: {
          resolved_at: null,
          escalated_at: null,
          sla_due_at: { lte: new Date() },
        },
        take: 500,
        select: {
          id: true,
          company_id: true,
          conversation_id: true,
          reason: true,
          reason_category: true,
          priority: true,
          sla_due_at: true,
        },
      });
    } catch (e) {
      this.logger.warn(
        `handoff SLA sweep query failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return { checked: 0, resolved: 0, breached: 0 };
    }

    for (const h of due) {
      try {
        const convo = await this.prisma.conversation.findFirst({
          where: { id: h.conversation_id, company_id: h.company_id },
          select: { status: true, assigned_user_id: true },
        });
        // Conservative pickup: assigned, or moved off the 'pending' handoff state.
        const pickedUp =
          !!convo &&
          (convo.assigned_user_id != null || convo.status !== 'pending');

        if (pickedUp) {
          await this.prisma.handoff.update({
            where: { id: h.id },
            data: { resolved_at: new Date() },
          });
          resolved++;
        } else {
          await this.prisma.handoff.update({
            where: { id: h.id },
            data: { escalated_at: new Date() },
          });
          await this.alertBreach(h);
          breached++;
        }
      } catch (e) {
        this.logger.warn(
          `handoff SLA sweep row ${h.id} failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    return { checked: due.length, resolved, breached };
  }

  /** Emit the breach event + email the owner. Best-effort (MailService never throws). */
  private async alertBreach(h: {
    id: number;
    company_id: number;
    conversation_id: number;
    reason: string;
    reason_category: string;
    priority: string;
    sla_due_at: Date;
  }): Promise<void> {
    await this.events.append({
      companyId: h.company_id,
      aggregateType: 'CONVERSATION',
      aggregateId: h.conversation_id,
      type: 'handoff.sla_breached',
      actorType: 'SYSTEM',
      payload: {
        handoffId: h.id,
        category: h.reason_category,
        priority: h.priority,
        slaDueAt: h.sla_due_at.toISOString(),
      },
    });

    const owner = await this.prisma.user
      .findFirst({
        where: { company_id: h.company_id, role: 'owner' },
        select: { email: true },
      })
      .catch(() => null);
    if (owner?.email) {
      await this.mail.send(
        owner.email,
        `Unattended conversation (SLA breached · ${h.priority})`,
        `<p>A conversation handed to your team has passed its response SLA.</p>` +
          `<ul><li>Conversation: #${h.conversation_id}</li>` +
          `<li>Reason: ${h.reason_category} (${h.priority})</li>` +
          `<li>Due by: ${h.sla_due_at.toISOString()}</li></ul>` +
          `<p>Please open your inbox and assign/respond.</p>`,
      );
    }
  }
}
