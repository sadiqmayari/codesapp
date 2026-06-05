import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { AiService } from '../ai/ai.service';
import { InboxService } from '../inbox/inbox.service';
import { SendMessageType } from '../inbox/dto/send-message.dto';

/** Conversation label applied when the AI hands off to a human. */
export const AI_HANDOFF_LABEL = 'needs-human';

interface AutoReplyJob {
  companyId: number;
  conversationId: number;
  messageId: number;
  /**
   * Force a reply even when a human is assigned. Set by an explicit ai_reply
   * bot action and by a per-conversation auto-pilot override (ai_autoreply ===
   * true). Inherited/workspace-default auto-replies leave this falsy and keep
   * the "skip if assigned" behavior.
   */
  force?: boolean;
  /**
   * Set when this `ai` job was re-enqueued by the auto-order worker after it
   * decided NOT to create an order. Stops the auto-order branch from
   * re-enqueueing another `ai-order` job (infinite loop guard).
   */
  skipOrder?: boolean;
}

/**
 * Phase 2 AI auto-responder. Runs in a dedicated `ai` job queue (not the
 * inbound message worker) so the slow model call never holds a message-worker
 * slot. Confidence-gated: the model either returns a reply to auto-send or
 * signals a handoff, in which case the conversation is flagged for a human.
 *
 * Lives in BotsModule (which already has InboxService via forwardRef) to avoid
 * an AiModule → InboxModule import cycle.
 */
@Injectable()
export class AiAutoReplyService implements OnModuleInit {
  private readonly logger = new Logger(AiAutoReplyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobQueue: JobQueueService,
    private readonly ai: AiService,
    @Inject(forwardRef(() => InboxService))
    private readonly inboxService: InboxService,
  ) {}

  onModuleInit(): void {
    this.jobQueue.registerWorker('ai', (p) => this.process(p as AutoReplyJob), 2);
  }

  /** Queue an auto-reply for an inbound message (best-effort, never throws). */
  async enqueue(job: AutoReplyJob): Promise<void> {
    try {
      await this.jobQueue.enqueue('ai', job);
    } catch (e) {
      this.logger.warn(
        `AI auto-reply enqueue failed for convo ${job.conversationId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  private async process(job: AutoReplyJob): Promise<void> {
    const convo = await this.prisma.conversation.findFirst({
      where: {
        id: job.conversationId,
        company_id: job.companyId,
        deleted_at: null,
      },
      select: {
        id: true,
        assigned_user_id: true,
        ai_autoreply: true,
        ai_order_created_at: true,
        company: { select: { ai_auto_order_enabled: true } },
      },
    });
    if (!convo) return;
    // A human already owns this chat — never butt in, UNLESS this reply was
    // explicitly forced (explicit ai_reply action or per-chat auto-pilot on).
    if (convo.assigned_user_id && !job.force) return;

    // Auto-order: ONLY on chats EXPLICITLY put in auto-pilot (per-chat
    // ai_autoreply === true via the ✨ toggle) — NOT chats that merely inherit
    // the workspace-wide auto-reply default. Otherwise every chat would attempt
    // an order. When eligible, let the auto-order worker (ShopifyModule, reached
    // via the `ai-order` queue) decide first; if it doesn't create an order it
    // re-enqueues an `ai` job with skipOrder=true, which lands here and falls
    // through to the normal reply below. (No module import — queue bridge only.)
    if (
      convo.company?.ai_auto_order_enabled &&
      convo.ai_autoreply === true &&
      !convo.ai_order_created_at &&
      !job.skipOrder
    ) {
      try {
        await this.jobQueue.enqueue('ai-order', {
          companyId: job.companyId,
          conversationId: job.conversationId,
          messageId: job.messageId,
        });
        return;
      } catch (e) {
        // If enqueue fails, fall through to a normal reply rather than going
        // silent.
        this.logger.warn(
          `ai-order enqueue failed (convo ${job.conversationId}) → normal reply: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }

    let decision: { reply: string | null; handoff: boolean; reason: string };
    try {
      decision = await this.ai.autoReplyDecision(job.companyId, job.conversationId);
    } catch (e) {
      if (e instanceof ForbiddenException) {
        // AI disabled / over cap — silently skip (consume the job).
        return;
      }
      throw e; // genuine error → let the queue retry
    }

    if (decision.handoff || !decision.reply) {
      await this.handoff(job.companyId, job.conversationId, decision.reason);
      return;
    }

    try {
      await this.inboxService.sendMessage(job.companyId, job.conversationId, {
        type: SendMessageType.text,
        content: decision.reply,
      });
    } catch (e) {
      // 24h window closed (or any send failure) → hand off instead.
      this.logger.debug(
        `AI auto-reply send failed (convo ${job.conversationId}) → handoff: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      await this.handoff(job.companyId, job.conversationId, 'send failed');
    }
  }

  /** Flag the conversation for a human: pending status + 'needs-human' label. */
  private async handoff(
    companyId: number,
    conversationId: number,
    reason: string,
  ): Promise<void> {
    try {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        // Stop the AI from re-triggering on a chat it just gave up on: mute the
        // per-chat auto-pilot. A human can re-enable it from the inbox.
        data: { status: 'pending', ai_autoreply: false },
      });
      await this.prisma.conversationLabel.upsert({
        where: {
          conversation_id_label: {
            conversation_id: conversationId,
            label: AI_HANDOFF_LABEL,
          },
        },
        create: {
          company_id: companyId,
          conversation_id: conversationId,
          label: AI_HANDOFF_LABEL,
        },
        update: {},
      });
      this.logger.log(
        `AI handoff for conversation ${conversationId}: ${reason}`,
      );
    } catch (e) {
      this.logger.warn(
        `AI handoff flagging failed for convo ${conversationId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}
