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
      select: { id: true, assigned_user_id: true },
    });
    if (!convo) return;
    // A human already owns this chat — never butt in.
    if (convo.assigned_user_id) return;

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
        data: { status: 'pending' },
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
