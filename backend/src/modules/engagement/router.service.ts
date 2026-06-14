import { Injectable, Logger } from '@nestjs/common';
import { WorkItem } from '@prisma/client';
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
 * route() finds-or-opens the lane, tags the inbound message (work_item_id + seq),
 * and RETURNS the work item. In 'shadow' mode the orchestrator ignores the return
 * (tag-only, no reply change); in 'on' mode it uses the returned item to pick the
 * specialist and hard-scope the transcript. Best-effort / never-throws.
 * Disambiguation, protected-in-flight switching and focus land in a later phase.
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

  async route(params: {
    companyId: number;
    conversationId: number;
    messageId: number;
    intent: RouteIntent;
    contactId?: number | null;
  }): Promise<WorkItem | null> {
    try {
      const type = this.typeForIntent(params.intent);
      if (!type) return null;

      let contactId = params.contactId ?? null;
      if (contactId == null) {
        const convo = await this.prisma.conversation.findFirst({
          where: { id: params.conversationId, company_id: params.companyId },
          select: { contact_id: true },
        });
        contactId = convo?.contact_id ?? null;
      }
      if (contactId == null) return null;

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

      // Tag the inbound message to the lane, unless already routed (idempotent on
      // reprocess). Per-conversation seq is best-effort (chat is serialized).
      const msg = await this.prisma.message.findFirst({
        where: { id: params.messageId, company_id: params.companyId },
        select: { id: true, work_item_id: true },
      });
      if (msg && msg.work_item_id == null) {
        const agg = await this.prisma.message.aggregate({
          where: {
            conversation_id: params.conversationId,
            company_id: params.companyId,
          },
          _max: { seq: true },
        });
        await this.prisma.message.update({
          where: { id: params.messageId },
          data: { work_item_id: item.id, seq: (agg._max.seq ?? 0) + 1 },
        });
      }

      return item;
    } catch (e) {
      this.logger.debug(
        `route skipped (convo ${params.conversationId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return null;
    }
  }
}
