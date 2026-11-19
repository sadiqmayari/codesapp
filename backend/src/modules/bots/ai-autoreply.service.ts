import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobQueueService } from '../../common/services/job-queue.service';

/** Conversation label applied when the AI hands off to a human. */
export const AI_HANDOFF_LABEL = 'needs-human';

/** Burst window: wait this long after an inbound message so a customer's rapid
 *  "hi" / "price?" / [photo] arrive as ONE turn with ONE reply. */
export const AI_BURST_MS = 5000;

interface AutoReplyJob {
  companyId: number;
  conversationId: number;
  messageId: number;
  /**
   * Force a reply even when the chat isn't auto-piloted. Set by an explicit
   * ai_reply bot action. An explicit per-chat mute (ai_autoreply === false)
   * still wins — the runtime re-checks every gate when the job runs.
   */
  force?: boolean;
}

/**
 * Bridge from inbound automation (BotEngine) to the AI agent runtime
 * (`ai-agent` queue, AiAgentModule).
 *
 * v2: enqueues the agent DIRECTLY (the old `ai` gate hop only re-read the same
 * flags and added a job + latency). One pending turn per conversation
 * (dedupKey) after a short burst window, serialised per conversation. ALL
 * gates (mute, handoff pause, business hours, opt-out, cap) are evaluated by
 * the runtime at RUN time, so a queued job never replies into a chat a human
 * has taken over. The `ai` worker remains only to forward jobs queued before
 * this deploy. Lives in BotsModule to avoid an AiModule → InboxModule cycle.
 */
@Injectable()
export class AiAutoReplyService implements OnModuleInit {
  private readonly logger = new Logger(AiAutoReplyService.name);

  constructor(private readonly jobQueue: JobQueueService) {}

  onModuleInit(): void {
    // Legacy forwarder: pre-v2 jobs in the `ai` queue.
    this.jobQueue.registerWorker(
      'ai',
      (p) => this.enqueue(p as AutoReplyJob),
      2,
      60,
    );
  }

  /** Queue an AI turn for an inbound message (best-effort, never throws). */
  async enqueue(job: AutoReplyJob): Promise<void> {
    try {
      await this.jobQueue.enqueue(
        'ai-agent',
        {
          companyId: job.companyId,
          conversationId: job.conversationId,
          messageId: job.messageId,
          force: !!job.force,
        },
        {
          delayMs: AI_BURST_MS,
          serialKey: `conv:ai-agent:${job.conversationId}`,
          // One PENDING turn per chat — later messages in the burst fold into
          // it (the runtime always reads every unanswered inbound message).
          dedupKey: `ai-agent:turn:${job.conversationId}`,
        },
      );
    } catch (e) {
      this.logger.warn(
        `AI turn enqueue failed for convo ${job.conversationId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}
