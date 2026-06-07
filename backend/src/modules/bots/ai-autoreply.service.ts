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
import { PlatformSettingService } from '../../common/services/platform-setting.service';
import { AiService } from '../ai/ai.service';
import { InboxService } from '../inbox/inbox.service';
import { InboxGateway } from '../inbox/inbox.gateway';
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
    private readonly platformSetting: PlatformSettingService,
    @Inject(forwardRef(() => InboxService))
    private readonly inboxService: InboxService,
    @Inject(forwardRef(() => InboxGateway))
    private readonly gateway: InboxGateway,
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
        company: {
          select: {
            ai_auto_order_enabled: true,
            ai_auto_order_all_enabled: true,
            ai_autoreply_enabled: true,
          },
        },
      },
    });
    if (!convo) return;
    // Effective auto-reply resolution (mirrors BotEngineService): an explicit
    // per-chat FALSE (handoff-mute / tenant mute) ALWAYS wins so a human owns
    // the chat — even under workspace all-chats. Otherwise active when the
    // workspace all-chats toggle is on OR the chat is per-chat auto-piloted.
    // When active, the AI answers REGARDLESS of assignment (no assigned-user
    // bail) — assignment alone never mutes; only an explicit handoff does.
    const allChats = convo.company?.ai_autoreply_enabled === true;
    const perChat = convo.ai_autoreply; // true | false | null
    if (perChat === false) return; // muted / handed-off → leave it to the human
    const effectiveAuto = allChats || perChat === true;
    // Allow when the chat is AI-active OR this is an explicit forced reply
    // (an `ai_reply` bot action sets job.force on a non-muted chat).
    if (!effectiveAuto && !job.force) return;

    // Phase 2: when the tool-calling agent (orchestrator + specialists) is
    // enabled for this tenant it OWNS the whole conversation — including order
    // creation via its guarded create_order tool. Route here FIRST (before the
    // legacy ai-order pipeline) so there is a single brain and no duplicate
    // order path. The legacy two-brain flow below only runs for non-agent
    // tenants.
    if (await this.platformSetting.isAiAgentEnabled(job.companyId)) {
      await this.jobQueue.enqueue('ai-agent', {
        companyId: job.companyId,
        conversationId: job.conversationId,
        messageId: job.messageId,
      });
      return;
    }

    // Auto-order eligibility — two scopes:
    //  • scope A: this chat is EXPLICITLY in per-chat auto-pilot (ai_autoreply
    //    === true via the ✨ toggle);
    //  • scope B: the workspace opted into "auto-order for every auto-replied
    //    chat" (ai_auto_order_all_enabled) AND the AI is answering this chat
    //    (per-chat override or workspace default).
    // When eligible, let the auto-order worker (ShopifyModule, reached via the
    // `ai-order` queue) decide first; if it doesn't create an order it
    // re-enqueues an `ai` job with skipOrder=true, which lands here and falls
    // through to the normal reply below. (No module import — queue bridge only.)
    const orderScopeA = perChat === true;
    const orderScopeB =
      convo.company?.ai_auto_order_all_enabled === true && effectiveAuto;
    if (
      convo.company?.ai_auto_order_enabled &&
      (orderScopeA || orderScopeB) &&
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

    let decision: {
      reply: string | null;
      handoff: boolean;
      reason: string;
      skip?: boolean;
    };
    try {
      decision = await this.ai.autoReplyDecision(job.companyId, job.conversationId);
    } catch (e) {
      if (e instanceof ForbiddenException) {
        // AI disabled / over cap — silently skip (consume the job).
        return;
      }
      throw e; // genuine error → let the queue retry
    }

    // Nothing readable to answer (e.g. sticker / untranscribable voice note) →
    // consume the job WITHOUT marking needs-human (don't spam handoffs).
    if (decision.skip) return;

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
      // Push the pending status + needs-human label live so the inbox list
      // updates without a manual reload (the list refetches on this event).
      this.gateway.emitToCompany(companyId, 'conversation.updated', {
        conversationId,
        addedLabel: AI_HANDOFF_LABEL,
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
