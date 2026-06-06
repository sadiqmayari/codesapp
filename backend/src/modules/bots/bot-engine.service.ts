import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { InboxService } from '../inbox/inbox.service';
import { SendMessageType } from '../inbox/dto/send-message.dto';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { AiAutoReplyService } from './ai-autoreply.service';
import { resolveAiCapabilities } from '../../common/utils/ai-capabilities';

export interface BotInboundMessage {
  id: number;
  companyId: number;
  conversationId: number;
  direction: 'inbound' | 'outbound';
  content: string;
  /** WhatsApp message type ('text'|'image'|'audio'|'video'|…). Lets the AI
   *  auto-responder act on media-only messages (voice notes, caption-less
   *  photos) the tenant has enabled vision/voice for. */
  messageType?: string;
}

interface ReplyTemplateAction {
  type: 'reply_template';
  templateId: number;
  variables?: Record<string, string>;
}
interface SendTextAction {
  type: 'send_text';
  message: string;
}
interface AssignAgentAction {
  type: 'assign_agent';
  userId: number;
}
interface ApplyTagAction {
  type: 'apply_tag';
  tag: string;
}
interface FireWebhookAction {
  type: 'fire_webhook';
  webhookEndpointId: number;
}
interface AiReplyAction {
  type: 'ai_reply';
}

export type BotAction =
  | ReplyTemplateAction
  | SendTextAction
  | AssignAgentAction
  | ApplyTagAction
  | FireWebhookAction
  | AiReplyAction;

interface ActiveBot {
  id: number;
  trigger_type: 'exact' | 'contains' | 'regex';
  keyword: string;
  actions: BotAction[];
}

const BOTS_CACHE_TTL_SEC = 60;

@Injectable()
export class BotEngineService {
  private readonly logger = new Logger(BotEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly jobQueue: JobQueueService,
    @Inject(forwardRef(() => InboxService))
    private readonly inboxService: InboxService,
    private readonly webhookDispatcher: WebhookDispatcherService,
    private readonly aiAutoReply: AiAutoReplyService,
  ) {}

  /**
   * Pure-function matcher exposed for unit testing.
   */
  static matchKeyword(
    triggerType: 'exact' | 'contains' | 'regex',
    keyword: string,
    text: string,
  ): boolean {
    const lower = text.trim().toLowerCase();
    switch (triggerType) {
      case 'exact':
        return lower === keyword.trim().toLowerCase();
      case 'contains':
        return lower.includes(keyword.toLowerCase());
      case 'regex': {
        try {
          return new RegExp(keyword, 'i').test(text);
        } catch {
          return false;
        }
      }
    }
  }

  async runForMessage(msg: BotInboundMessage): Promise<void> {
    if (msg.direction !== 'inbound') return;

    const convo = await this.prisma.conversation.findUnique({
      where: { id: msg.conversationId },
      select: {
        id: true,
        contact_id: true,
        assigned_user_id: true,
        ai_autoreply: true,
        company: {
          select: {
            ai_autoreply_enabled: true,
            ai_premium_locked: true,
            ai_vision_enabled: true,
            ai_voice_enabled: true,
          },
        },
      },
    });
    if (!convo) return;

    // A media-only message (voice note / caption-less photo) has no text, so it
    // can't match keyword bots — but the AI auto-responder CAN act on it when the
    // tenant has the matching capability (voice→audio, vision→image). For text
    // we proceed as normal; for empty content we only continue if it's such an
    // AI-actionable media message (else bail — no point spending an AI call on a
    // sticker/video/document the AI can't read).
    const hasText = !!msg.content;
    const caps = resolveAiCapabilities(convo.company ?? {}, 'fast');
    const aiActionableMedia =
      (msg.messageType === 'audio' && caps.voice) ||
      (msg.messageType === 'image' && caps.vision);
    if (!hasText && !aiActionableMedia) return;

    const bots = hasText ? await this.loadActiveBots(msg.companyId) : [];
    // Did a keyword bot already produce a customer-facing reply? If so, the
    // catch-all AI auto-reply must NOT also fire.
    let repliedByBot = false;
    const REPLY_ACTIONS = ['reply_template', 'send_text', 'ai_reply'];

    for (const bot of bots) {
      const matched = BotEngineService.matchKeyword(
        bot.trigger_type,
        bot.keyword,
        msg.content,
      );
      if (!matched) continue;

      const actionsRun: string[] = [];
      for (const action of bot.actions ?? []) {
        try {
          if (action.type === 'assign_agent' && convo.assigned_user_id) {
            // Skip auto-assign if conversation is already assigned
            continue;
          }
          await this.executeAction(action, msg, convo.contact_id, bot.id);
          actionsRun.push(action.type);
          if (REPLY_ACTIONS.includes(action.type)) repliedByBot = true;
        } catch (err) {
          this.logger.warn(
            `Bot ${bot.id} action ${action.type} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      if (actionsRun.length > 0) {
        await this.prisma.auditLog.create({
          data: {
            company_id: msg.companyId,
            user_id: null, // system actor — no user (audit_logs.user_id is nullable)
            action: 'bot.executed',
            entity: 'bots',
            entity_id: bot.id,
            metadata: {
              messageId: msg.id,
              conversationId: msg.conversationId,
              actionsRun,
            },
          },
        }).catch((err) => {
          // audit log is best-effort — users.id=0 may not exist; do not throw
          this.logger.debug(
            `bot.executed audit failed (non-fatal): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
    }

    // Catch-all AI auto-responder. Effective auto-reply resolution:
    //  • an explicit per-chat FALSE (handoff-mute or tenant mute) ALWAYS wins —
    //    the AI stays quiet so a human owns it (even under workspace all-chats);
    //  • otherwise the AI is active when the workspace "answer all chats" toggle
    //    is on OR the chat is per-chat auto-piloted (ai_autoreply === true).
    // When active, the AI answers REGARDLESS of assignment (force) — assignment
    // alone never mutes; only an explicit handoff/mute does.
    const allChats = convo.company?.ai_autoreply_enabled === true;
    const perChat = convo.ai_autoreply; // true | false | null
    const effectiveAuto =
      perChat === false ? false : allChats || perChat === true;
    const forced = effectiveAuto;
    if (!repliedByBot && effectiveAuto) {
      await this.aiAutoReply.enqueue({
        companyId: msg.companyId,
        conversationId: msg.conversationId,
        messageId: msg.id,
        force: forced,
      });
    }
  }

  private async executeAction(
    action: BotAction,
    msg: BotInboundMessage,
    contactId: number,
    botId: number,
  ): Promise<void> {
    switch (action.type) {
      case 'reply_template': {
        await this.inboxService.sendMessage(msg.companyId, msg.conversationId, {
          type: SendMessageType.template,
          templateId: action.templateId,
          variables: action.variables,
        });
        return;
      }
      case 'send_text': {
        await this.inboxService.sendMessage(msg.companyId, msg.conversationId, {
          type: SendMessageType.text,
          content: action.message,
        });
        return;
      }
      case 'assign_agent': {
        await this.prisma.conversation.update({
          where: { id: msg.conversationId },
          data: { assigned_user_id: action.userId },
        });
        return;
      }
      case 'apply_tag': {
        const contact = await this.prisma.contact.findUnique({
          where: { id: contactId },
          select: { tags: true },
        });
        const existing = Array.isArray(contact?.tags) ? (contact!.tags as string[]) : [];
        if (!existing.includes(action.tag)) {
          await this.prisma.contact.update({
            where: { id: contactId },
            data: { tags: [...existing, action.tag] },
          });
        }
        return;
      }
      case 'fire_webhook': {
        await this.webhookDispatcher.dispatch(
          msg.companyId,
          'keyword.triggered',
          {
            conversationId: msg.conversationId,
            messageId: msg.id,
            contactId,
            botId,
            webhookEndpointId: action.webhookEndpointId,
          },
        );
        return;
      }
      case 'ai_reply': {
        // Defer to the AI auto-reply worker (confidence-gated send/handoff).
        // An explicit ai_reply action forces a reply even if the same bot (or a
        // prior one) assigned the chat to an agent — otherwise the assignment
        // would suppress the very reply the user asked the bot to send.
        await this.aiAutoReply.enqueue({
          companyId: msg.companyId,
          conversationId: msg.conversationId,
          messageId: msg.id,
          force: true,
        });
        return;
      }
    }
  }

  private async loadActiveBots(companyId: number): Promise<ActiveBot[]> {
    const key = `bots:active:${companyId}`;
    const cached = this.cache.get<ActiveBot[]>(key);
    if (cached) return cached;

    const rows = await this.prisma.bot.findMany({
      where: { company_id: companyId, status: 'active' },
      select: {
        id: true,
        trigger_type: true,
        keyword: true,
        actions: true,
      },
    });
    const bots: ActiveBot[] = rows.map((r) => ({
      id: r.id,
      trigger_type: r.trigger_type,
      keyword: r.keyword,
      actions: (r.actions ?? []) as unknown as BotAction[],
    }));
    this.cache.set(key, bots, BOTS_CACHE_TTL_SEC);
    return bots;
  }
}
