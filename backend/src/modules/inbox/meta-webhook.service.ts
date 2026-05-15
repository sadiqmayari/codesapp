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

const MEDIA_LIMITS: Record<string, number> = {
  image: 5 * 1024 * 1024, // 5MB
  audio: 10 * 1024 * 1024, // 10MB
  video: 16 * 1024 * 1024, // 16MB
  document: 10 * 1024 * 1024, // 10MB
  sticker: 5 * 1024 * 1024, // 5MB
};

const STORAGE_ROOT = path.join(process.cwd(), '..', 'storage', 'media');

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
  text?: { body: string };
  image?: { id: string; mime_type?: string; caption?: string };
  audio?: { id: string; mime_type?: string };
  video?: { id: string; mime_type?: string; caption?: string };
  document?: { id: string; mime_type?: string; filename?: string };
  sticker?: { id: string };
}

interface MetaStatusUpdate {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id?: string;
  errors?: Array<{ code: number; title: string }>;
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

    const windowExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    let isNewConvoThisMonth = false;
    if (!convo) {
      convo = await this.prisma.conversation.create({
        data: {
          company_id: companyId,
          contact_id: contact.id,
          status: 'open',
          window_expires_at: windowExpiresAt,
        },
      });
      isNewConvoThisMonth = true;
    } else {
      convo = await this.prisma.conversation.update({
        where: { id: convo.id },
        data: {
          window_expires_at: windowExpiresAt,
          status: convo.status === 'resolved' ? 'open' : convo.status,
          unread_count: { increment: 1 },
        },
      });
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
        mediaUrl = downloaded.path;
        mediaExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      } catch (err) {
        this.logger.warn(
          `Media download failed for message ${msg.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
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
        timestamp: new Date(Number(msg.timestamp) * 1000),
      },
    });

    await this.prisma.conversation.update({
      where: { id: convo.id },
      data: {
        last_message: (textContent ?? `[${messageType}]`).slice(0, 500),
      },
    });

    await this.metering.incrementMessages(companyId);
    if (isNewConvoThisMonth) {
      await this.metering.incrementConversations(companyId);
    }

    this.gateway.emitToCompany(companyId, 'message.received', {
      message,
      conversationId: convo.id,
      contactId: contact.id,
      isNewContact,
    });

    // Fire bots
    try {
      await this.botEngine.runForMessage({
        id: message.id,
        companyId,
        conversationId: convo.id,
        direction: 'inbound',
        content: textContent ?? '',
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

    this.gateway.emitToCompany(companyId, 'message.status', {
      messageId: message.id,
      status: newStatus,
    });
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
