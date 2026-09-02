import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { PlatformSettingService } from '../../common/services/platform-setting.service';
import { CompanyStatusService } from '../../common/services/company-status.service';

/** Conversation label applied when the AI hands off to a human. */
export const AI_HANDOFF_LABEL = 'needs-human';

interface AutoReplyJob {
  companyId: number;
  conversationId: number;
  messageId: number;
  /**
   * Force a reply even when a human is assigned. Set by an explicit ai_reply
   * bot action and by a per-conversation auto-pilot override (ai_autoreply ===
   * true). Inherited/workspace-default auto-replies leave this falsy.
   */
  force?: boolean;
}

/**
 * AI auto-reply GATE + bridge to the orchestrator.
 *
 * This service no longer generates replies itself — the single conversational
 * brain is `AiAgentService` (ShopifyModule, `ai-agent` queue). All this worker
 * does is resolve whether the AI is allowed to answer this chat and, if so,
 * hand the message to the orchestrator. The old "two-brain" flow (a separate
 * `ai-order` pipeline plus `AiService.autoReplyDecision`) was removed: it was a
 * second, divergent implementation of the same behaviour.
 *
 * Runs in a dedicated `ai` job queue (not the inbound message worker) so the
 * gate never holds a message-worker slot. Lives in BotsModule to avoid an
 * AiModule → InboxModule import cycle.
 */
@Injectable()
export class AiAutoReplyService implements OnModuleInit {
  private readonly logger = new Logger(AiAutoReplyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobQueue: JobQueueService,
    private readonly platformSetting: PlatformSettingService,
    private readonly companyStatus: CompanyStatusService,
  ) {}

  onModuleInit(): void {
    // The gate itself is cheap (one DB read + an enqueue), but keep a generous
    // lease so a slow DB never lets a second worker double-enqueue.
    this.jobQueue.registerWorker(
      'ai',
      (p) => this.process(p as AutoReplyJob),
      3,
      120,
    );
  }

  /** Queue an auto-reply for an inbound message (best-effort, never throws). */
  async enqueue(job: AutoReplyJob): Promise<void> {
    try {
      // Serialize AI work per conversation: the decision for an earlier message
      // must complete before the next is evaluated, otherwise two
      // near-simultaneous inbound messages produce parallel / duplicate replies.
      await this.jobQueue.enqueue('ai', job, {
        serialKey: `conv:ai:${job.conversationId}`,
      });
    } catch (e) {
      this.logger.warn(
        `AI auto-reply enqueue failed for convo ${job.conversationId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  private async process(job: AutoReplyJob): Promise<void> {
    // Suspended/inactive tenant: pause AI auto-reply (guards a job queued
    // before suspension took effect).
    if (!(await this.companyStatus.isActive(job.companyId))) return;

    const convo = await this.prisma.conversation.findFirst({
      where: {
        id: job.conversationId,
        company_id: job.companyId,
        deleted_at: null,
      },
      select: {
        id: true,
        ai_autoreply: true,
        company: { select: { ai_autoreply_enabled: true } },
      },
    });
    if (!convo) return;

    // Effective auto-reply resolution (mirrors BotEngineService): an explicit
    // per-chat FALSE (handoff-mute / tenant mute) ALWAYS wins so a human owns
    // the chat — even under workspace all-chats. Otherwise active when the
    // workspace toggle is on OR the chat is per-chat auto-piloted. When active,
    // the AI answers REGARDLESS of assignment; only an explicit mute stops it.
    const allChats = convo.company?.ai_autoreply_enabled === true;
    const perChat = convo.ai_autoreply; // true | false | null
    if (perChat === false) return; // muted / handed-off → leave it to the human
    const effectiveAuto = allChats || perChat === true;
    // Allow when the chat is AI-active OR this is an explicit forced reply
    // (an `ai_reply` bot action sets job.force on a non-muted chat).
    if (!effectiveAuto && !job.force) return;

    // Platform rollout gate. When the orchestrator is not enabled for this
    // tenant there is no other brain to fall back to, so the AI simply stays
    // silent and the chat is left to a human.
    if (!(await this.platformSetting.isAiAgentEnabled(job.companyId))) {
      this.logger.debug(
        `ai-agent not enabled for company ${job.companyId} → no AI reply (convo ${job.conversationId})`,
      );
      return;
    }

    // Hand off to the orchestrator. The serialKey MUST match the one
    // AiAgentService.enqueue() uses (`conv:ai-agent:{id}`) — we enqueue the
    // 'ai-agent' queue directly here (no module import, to avoid the
    // Billing↔Ai↔Inbox cycle), so without this key two near-simultaneous
    // inbound messages spawn two parallel agent runs → duplicate AI replies.
    await this.jobQueue.enqueue(
      'ai-agent',
      {
        companyId: job.companyId,
        conversationId: job.conversationId,
        messageId: job.messageId,
      },
      { serialKey: `conv:ai-agent:${job.conversationId}` },
    );
  }
}
