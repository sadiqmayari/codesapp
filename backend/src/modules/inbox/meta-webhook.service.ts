import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  forwardRef,
} from '@nestjs/common';
import * as path from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { UsageMeteringService } from '../usage-metering/usage-metering.service';
import { InboxGateway } from './inbox.gateway';
import { MetaClientService } from './meta-client.service';
import { BotEngineService } from '../bots/bot-engine.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';

const MEDIA_LIMITS: Record<string, number> = {
  image: 5 * 1024 * 1024, // 5MB
  audio: 10 * 1024 * 1024, // 10MB
  video: 16 * 1024 * 1024, // 16MB
  document: 10 * 1024 * 1024, // 10MB
  sticker: 5 * 1024 * 1024, // 5MB
};

const STORAGE_ROOT = path.join(process.cwd(), '..', 'storage', 'media');

// Meta delivery-failure codes that mean the recipient can't receive WhatsApp
// (wrong number / not a WhatsApp user / undeliverable). Used to tag the
// linked Shopify order "⚠ NO WhatsApp". 131026 = Message Undeliverable.
const NO_WHATSAPP_ERROR_CODES = new Set([131026]);

interface MetaWebhookEntry {
  id: string;
  changes?: Array<{
    field: string;
    value: {
      messaging_product?: string;
      metadata?: { phone_number_id: string; display_phone_number?: string };
      contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
      messages?: Array<MetaInboundMessage>;
      statuses?: Array<MetaStatusUpdate>;
    };
  }>;
}

interface MetaInboundMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  context?: { id?: string; from?: string };
  text?: { body: string };
  image?: { id: string; mime_type?: string; caption?: string };
  audio?: { id: string; mime_type?: string };
  video?: { id: string; mime_type?: string; caption?: string };
  document?: { id: string; mime_type?: string; filename?: string };
  sticker?: { id: string };
  // Emoji reaction to one of our/their earlier messages. `emoji` is empty when
  // the reaction is removed. `message_id` references the reacted message.
  reaction?: { message_id?: string; emoji?: string };
  location?: {
    latitude?: number;
    longitude?: number;
    name?: string;
    address?: string;
  };
  contacts?: Array<{
    name?: { formatted_name?: string };
    phones?: Array<{ phone?: string; wa_id?: string }>;
  }>;
  // Template quick-reply button tap (type 'button'); interactive reply for
  // interactive messages. Used by the Shopify confirm/cancel flow.
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
}

interface MetaStatusUpdate {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id?: string;
  errors?: Array<{
    code: number;
    title: string;
    message?: string;
    error_data?: { details?: string };
  }>;
}

@Injectable()
export class MetaWebhookService implements OnModuleInit {
  private readonly logger = new Logger(MetaWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobQueue: JobQueueService,
    private readonly metering: UsageMeteringService,
    private readonly metaClient: MetaClientService,
    @Inject(forwardRef(() => InboxGateway))
    private readonly gateway: InboxGateway,
    @Inject(forwardRef(() => BotEngineService))
    private readonly botEngine: BotEngineService,
    private readonly webhookDispatcher: WebhookDispatcherService,
  ) {}

  onModuleInit(): void {
    this.jobQueue.registerWorker('message', (p) => this.handle(p), 3);
    this.logger.log('Registered message worker (concurrency=3)');
  }

  async handle(payload: unknown): Promise<void> {
    const wrapper = payload as { rawPayload?: { entry?: MetaWebhookEntry[] } };
    const entries = wrapper?.rawPayload?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value?.metadata?.phone_number_id) continue;

        const company = await this.resolveCompany(value.metadata.phone_number_id);
        if (!company) {
          this.logger.warn(
            `No company found for phone_number_id=${value.metadata.phone_number_id}`,
          );
          continue;
        }

        for (const msg of value.messages ?? []) {
          await this.handleInbound(company.id, msg, value.contacts ?? []);
        }
        for (const st of value.statuses ?? []) {
          await this.handleStatus(company.id, st);
        }
      }
    }
  }

  private async resolveCompany(phoneNumberId: string) {
    return this.prisma.company.findFirst({
      where: { phone_number_id: phoneNumberId },
      select: { id: true },
    });
  }

  private async handleInbound(
    companyId: number,
    msg: MetaInboundMessage,
    contacts: Array<{ wa_id: string; profile?: { name?: string } }>,
  ): Promise<void> {
    const profile = contacts.find((c) => c.wa_id === msg.from)?.profile;
    const displayName = profile?.name ?? msg.from;

    // Upsert contact
    const existing = await this.prisma.contact.findFirst({
      where: { company_id: companyId, phone: msg.from, deleted_at: null },
    });

    let contact;
    let isNewContact = false;
    if (existing) {
      contact = await this.prisma.contact.update({
        where: { id: existing.id },
        data: { last_message_at: new Date() },
      });
    } else {
      contact = await this.prisma.contact.create({
        data: {
          company_id: companyId,
          name: displayName,
          phone: msg.from,
          last_message_at: new Date(),
        },
      });
      isNewContact = true;
      await this.metering.incrementContacts(companyId);
    }

    // Find or create conversation
    let convo = await this.prisma.conversation.findFirst({
      where: {
        company_id: companyId,
        contact_id: contact.id,
        deleted_at: null,
      },
      orderBy: { id: 'desc' },
    });

    // An emoji reaction is NOT a new message — it's a badge on an existing
    // bubble (WhatsApp-style). Don't bump unread or set last_message for it.
    const isReaction = msg.type === 'reaction';

    const windowExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    let isNewConvoThisMonth = false;
    if (!convo) {
      convo = await this.prisma.conversation.create({
        data: {
          company_id: companyId,
          contact_id: contact.id,
          status: 'open',
          window_expires_at: windowExpiresAt,
          unread_count: isReaction ? 0 : 1,
        },
      });
      isNewConvoThisMonth = true;
    } else {
      convo = await this.prisma.conversation.update({
        where: { id: convo.id },
        data: {
          window_expires_at: windowExpiresAt,
          status: convo.status === 'resolved' ? 'open' : convo.status,
          unread_count: isReaction ? undefined : { increment: 1 },
        },
      });
    }

    // Reaction → attach the emoji to the reacted message + push a live update;
    // never create a message row, run bots/AI, or dispatch a webhook for it.
    if (isReaction) {
      await this.handleReaction(companyId, convo.id, msg);
      return;
    }

    // Build message row
    const messageType = this.normalizeType(msg.type);
    let textContent: string | null = null;
    let mediaUrl: string | null = null;
    let metaMediaUrl: string | null = null;
    let mediaExpiresAt: Date | null = null;

    if (msg.text?.body) {
      textContent = msg.text.body;
    } else if (msg.image?.caption) {
      textContent = msg.image.caption;
    } else if (msg.video?.caption) {
      textContent = msg.video.caption;
    } else if (msg.document?.filename) {
      textContent = msg.document.filename;
    } else if (msg.type === 'location') {
      const loc = msg.location;
      const label = [loc?.name, loc?.address].filter(Boolean).join(' — ');
      const coords =
        loc?.latitude != null && loc?.longitude != null
          ? `${loc.latitude}, ${loc.longitude}`
          : '';
      textContent = `📍 Location${label ? `: ${label}` : ''}${
        coords ? ` (${coords})` : ''
      }`;
    } else if (msg.type === 'contacts') {
      const parts = (msg.contacts ?? []).map((c) => {
        const nm = c.name?.formatted_name?.trim();
        const ph = c.phones?.map((p) => p.phone).filter(Boolean).join(', ');
        return [nm, ph].filter(Boolean).join(' ');
      });
      textContent = `👤 Contact${parts.length > 1 ? 's' : ''}: ${
        parts.filter(Boolean).join('; ') || 'shared'
      }`;
    }

    const mediaInfo = this.extractMediaId(msg);
    if (mediaInfo) {
      const maxBytes = MEDIA_LIMITS[messageType] ?? 5 * 1024 * 1024;
      try {
        const downloaded = await this.metaClient.downloadMedia(
          companyId,
          mediaInfo.id,
          STORAGE_ROOT,
          maxBytes,
        );
        // Store the WEB path (served by the /storage static mount), not the
        // absolute filesystem path — the browser must be able to load it.
        const rel = path
          .relative(STORAGE_ROOT, downloaded.path)
          .split(path.sep)
          .join('/');
        mediaUrl = `/storage/media/${rel}`;
        mediaExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      } catch (err) {
        this.logger.warn(
          `Media download failed for message ${msg.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Reply detection (best effort): if Meta says this is a reply to a
    // message we sent, link it to our internal row. Never throws.
    let contextMessageId: number | null = null;
    // A reply carries context.id; an emoji reaction carries reaction.message_id.
    // Both reference an earlier message we should quote.
    const referencedMetaId = msg.context?.id ?? msg.reaction?.message_id;
    if (referencedMetaId) {
      try {
        const ref = await this.prisma.message.findFirst({
          where: { meta_message_id: referencedMetaId, company_id: companyId },
          select: { id: true },
        });
        contextMessageId = ref?.id ?? null;
      } catch (err) {
        this.logger.warn(
          `Inbound reply-context lookup failed for ${referencedMetaId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Surface a tapped quick-reply / interactive button label in the thread.
    const buttonLabel =
      msg.button?.text ??
      msg.interactive?.button_reply?.title ??
      msg.interactive?.list_reply?.title ??
      null;
    if (buttonLabel && !textContent) textContent = buttonLabel;

    // Never store a fully blank inbound message. If we have no text and no media
    // (e.g. media download failed, or an unsupported/unknown WhatsApp type), put
    // a readable placeholder so the conversation is never silently dropped from
    // the thread by the empty-bubble guard.
    if (!textContent && !mediaUrl) {
      textContent =
        messageType === 'text' ? '(unsupported message)' : `(${messageType})`;
    }

    const message = await this.prisma.message.create({
      data: {
        conversation_id: convo.id,
        company_id: companyId,
        message_type: messageType,
        direction: 'inbound',
        content: textContent,
        media_url: mediaUrl,
        meta_media_url: metaMediaUrl,
        media_expires_at: mediaExpiresAt,
        status: 'delivered',
        meta_message_id: msg.id,
        context_message_id: contextMessageId,
        timestamp: new Date(Number(msg.timestamp) * 1000),
      },
      include: {
        context_message: {
          select: {
            id: true,
            direction: true,
            message_type: true,
            content: true,
            media_url: true,
          },
        },
      },
    });

    await this.prisma.conversation.update({
      where: { id: convo.id },
      data: {
        last_message: (textContent ?? `[${messageType}]`).slice(0, 500),
        last_message_at: new Date(),
      },
    });

    await this.metering.incrementMessages(companyId);
    if (isNewConvoThisMonth) {
      await this.metering.incrementConversations(companyId);
    }

    // Shopify order confirmation: if this is a button reply to a template
    // we sent for an order, enqueue the order tagging. Best-effort.
    // When it IS a recognised order-template Confirm/Cancel tap, we also skip the
    // bot/AI dispatch below — the tag flow owns it. Otherwise the AI auto-pilot
    // (bots are paused under auto-pilot) would treat a "Cancel" tap as a chat
    // message and, e.g., wrongly reply "order placed".
    let orderDecisionHandled = false;
    if (contextMessageId && buttonLabel) {
      try {
        const lbl = buttonLabel.toLowerCase();
        const decision = lbl.includes('cancel')
          ? 'cancel'
          : lbl.includes('confirm')
            ? 'confirm'
            : null;
        if (decision) {
          // Match by message + company only — NOT status. The customer can
          // change their mind (confirm→cancel or back) any number of times;
          // gating on status:'pending' here meant the SECOND tap found no row
          // (status was already 'confirmed'/'cancelled') so the swap never
          // happened. processOrderTag is idempotent and removes the pending +
          // opposite tag, so re-tagging an already-decided order is safe.
          const link = await this.prisma.shopifyOrderMessage.findFirst({
            where: {
              message_id: contextMessageId,
              company_id: companyId,
            },
            select: { id: true },
          });
          if (link) {
            orderDecisionHandled = true;
            await this.jobQueue.enqueue('shopify', {
              kind: 'tag',
              companyId,
              orderMessageId: link.id,
              decision,
            });
          }
        }
      } catch (err) {
        this.logger.warn(
          `Shopify order-tag enqueue failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    this.gateway.emitToCompany(companyId, 'message.received', {
      message,
      conversationId: convo.id,
      contactId: contact.id,
      contactName: contact.name ?? contact.phone,
      isNewContact,
    });
    await this.webhookDispatcher.dispatch(companyId, 'message.received', {
      messageId: message.id,
      conversationId: convo.id,
      contactId: contact.id,
      isNewContact,
      messageType,
    });

    // Fire bots. For an order-template Confirm/Cancel tap we still run the bot
    // engine but flag it (isOrderDecision): keyword bots fire (so the tenant's
    // "confirm"/"cancel" canned acknowledgement still replies, even on an
    // auto-piloted chat), while the AI auto-responder is skipped — letting the
    // AI handle a "Cancel" tap made it reply "order placed". The Shopify tag was
    // already enqueued above.
    try {
      await this.botEngine.runForMessage({
        id: message.id,
        companyId,
        conversationId: convo.id,
        direction: 'inbound',
        content: textContent ?? '',
        messageType,
        isOrderDecision: orderDecisionHandled,
      });
    } catch (err) {
      this.logger.warn(
        `Bot engine failed for message ${message.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async handleStatus(
    companyId: number,
    st: MetaStatusUpdate,
  ): Promise<void> {
    const message = await this.prisma.message.findFirst({
      where: { meta_message_id: st.id, company_id: companyId },
    });
    if (!message) return;

    const newStatus = st.status === 'sent' ? message.status : st.status;
    await this.prisma.message.update({
      where: { id: message.id },
      data: { status: newStatus },
    });

    // Broadcast aggregation
    if (message.broadcast_id) {
      if (st.status === 'delivered') {
        await this.prisma.broadcast.update({
          where: { id: message.broadcast_id },
          data: { delivered_count: { increment: 1 } },
        });
      } else if (st.status === 'read') {
        await this.prisma.broadcast.update({
          where: { id: message.broadcast_id },
          data: { read_count: { increment: 1 } },
        });
      }
    }

    let errorText: string | undefined;
    if (st.status === 'failed' && st.errors?.length) {
      errorText = st.errors
        .map(
          (e) =>
            `(${e.code}) ${e.title}` +
            (e.error_data?.details ? ` — ${e.error_data.details}` : ''),
        )
        .join('; ');
      this.logger.error(
        `Message ${message.id} (meta=${st.id}) FAILED: ${errorText}`,
      );

      // If this failed message was a Shopify order-confirmation template AND
      // the failure means the number can't receive WhatsApp, tag that order
      // "⚠ NO WhatsApp" (hardcoded, not client-configurable).
      const noWhatsapp = st.errors.some(
        (e) =>
          NO_WHATSAPP_ERROR_CODES.has(e.code) ||
          /undeliverable|not a whatsapp/i.test(
            `${e.title} ${e.message ?? ''}`,
          ),
      );
      if (noWhatsapp) {
        try {
          const link = await this.prisma.shopifyOrderMessage.findFirst({
            where: { message_id: message.id, company_id: companyId },
            select: { id: true },
          });
          if (link) {
            await this.jobQueue.enqueue('shopify', {
              kind: 'noWhatsapp',
              companyId,
              orderMessageId: link.id,
            });
          }
        } catch (err) {
          this.logger.warn(
            `NO WhatsApp tag enqueue failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    this.gateway.emitToCompany(companyId, 'message.status', {
      messageId: message.id,
      status: newStatus,
      ...(errorText ? { error: errorText } : {}),
    });

    const eventMap: Record<string, string> = {
      delivered: 'message.delivered',
      read: 'message.read',
      failed: 'message.failed',
    };
    const event = eventMap[st.status];
    if (event) {
      await this.webhookDispatcher.dispatch(companyId, event, {
        messageId: message.id,
        conversationId: message.conversation_id,
        status: st.status,
        metaMessageId: st.id,
      });
    }
  }

  /**
   * Apply a customer's emoji reaction to the reacted message (WhatsApp-style
   * badge), or clear it when the reaction was removed (empty emoji). Emits a
   * live `message.reaction` so the open thread updates the bubble without a
   * reload. Best-effort — a reaction to a message we don't have is ignored.
   */
  private async handleReaction(
    companyId: number,
    conversationId: number,
    msg: MetaInboundMessage,
  ): Promise<void> {
    const targetMetaId = msg.reaction?.message_id;
    if (!targetMetaId) return;
    const emoji = msg.reaction?.emoji?.trim() || null; // null = removed
    try {
      const target = await this.prisma.message.findFirst({
        where: { meta_message_id: targetMetaId, company_id: companyId },
        select: { id: true },
      });
      if (!target) return;
      await this.prisma.message.update({
        where: { id: target.id },
        data: { reaction: emoji },
      });
      this.gateway.emitToCompany(companyId, 'message.reaction', {
        conversationId,
        messageId: target.id,
        emoji,
      });
    } catch (err) {
      this.logger.warn(
        `Reaction handling failed for ${targetMetaId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private normalizeType(
    type: string,
  ): 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' {
    const allowed = ['text', 'image', 'audio', 'video', 'document', 'sticker'];
    return (allowed.includes(type) ? type : 'text') as
      | 'text'
      | 'image'
      | 'audio'
      | 'video'
      | 'document'
      | 'sticker';
  }

  private extractMediaId(msg: MetaInboundMessage): { id: string } | null {
    if (msg.image?.id) return { id: msg.image.id };
    if (msg.audio?.id) return { id: msg.audio.id };
    if (msg.video?.id) return { id: msg.video.id };
    if (msg.document?.id) return { id: msg.document.id };
    if (msg.sticker?.id) return { id: msg.sticker.id };
    return null;
  }
}
