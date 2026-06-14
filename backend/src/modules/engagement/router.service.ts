import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkItemService } from './work-item.service';
import { WorkItemType } from './state/work-item-states';

/** Triage intents the orchestrator already computes (AiService.classifyIntent). */
export type RouteIntent =
  | 'sales'
  | 'order'
  | 'logistics'
  | 'resolution'
  | 'general'
  | 'escalate'
  | 'closing';

/**
 * Deterministic router (engagement-engine Phase 2). Maps a triage intent to a
 * work-item type, finds the existing OPEN item of that type or opens a new one,
 * and tags the inbound message to it (+ a per-conversation seq).
 *
 * Phase 2 is SHADOW-ONLY: shadowTag() runs alongside the existing orchestrator
 * for engagement-enabled tenants to populate work_items + message.work_item_id so
 * routing correctness can be observed BEFORE work items become authoritative
 * (Phase 3). It is best-effort / never-throws and never alters the reply path.
 * The authoritative router (disambiguation, protected-in-flight switching,
 * focus) replaces applyTopicManager in Phase 3.
 */
@Injectable()
export class RouterService {
  private readonly logger = new Logger(RouterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workItems: WorkItemService,
  ) {}

  /** Intent → work-item lane. escalate/closing are handled by the orchestrator. */
  private typeForIntent(intent: RouteIntent): WorkItemType | null {
    switch (intent) {
      case 'sales':
        return 'SALES';
      case 'order':
        return 'ORDER';
      case 'logistics':
        return 'TRACKING';
      case 'resolution':
        return 'DISPUTE';
      case 'general':
        return 'SUPPORT';
      default:
        return null;
    }
  }

  async shadowTag(params: {
    companyId: number;
    conversationId: number;
    messageId: number;
    intent: RouteIntent;
    contactId?: number | null;
  }): Promise<void> {
    try {
      const type = this.typeForIntent(params.intent);
      if (!type) return;

      // Already routed → leave it (don't re-home a message on reprocess).
      const msg = await this.prisma.message.findFirst({
        where: { id: params.messageId, company_id: params.companyId },
        select: { id: true, work_item_id: true },
      });
      if (!msg || msg.work_item_id != null) return;

      let contactId = params.contactId ?? null;
      if (contactId == null) {
        const convo = await this.prisma.conversation.findFirst({
          where: { id: params.conversationId, company_id: params.companyId },
          select: { contact_id: true },
        });
        contactId = convo?.contact_id ?? null;
      }
      if (contactId == null) return;

      // Reuse the open lane of this type, else open one (concurrent engagements).
      const open = await this.workItems.listOpen(
        params.companyId,
        params.conversationId,
      );
      let item = open.find((w) => w.type === type) ?? null;
      if (!item) {
        item = await this.workItems.open({
          companyId: params.companyId,
          conversationId: params.conversationId,
          contactId,
          type,
          owner: 'AI',
          actorType: 'CUSTOMER',
        });
      }

      // Per-conversation seq (best-effort; conversation is serialized so no race).
      const agg = await this.prisma.message.aggregate({
        where: {
          conversation_id: params.conversationId,
          company_id: params.companyId,
        },
        _max: { seq: true },
      });
      const nextSeq = (agg._max.seq ?? 0) + 1;

      await this.prisma.message.update({
        where: { id: params.messageId },
        data: { work_item_id: item.id, seq: nextSeq },
      });
    } catch (e) {
      this.logger.debug(
        `shadowTag skipped (convo ${params.conversationId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}
