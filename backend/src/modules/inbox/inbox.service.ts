import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { UsageMeteringService } from '../usage-metering/usage-metering.service';
import { InboxGateway } from './inbox.gateway';
import { MetaClientService, MetaSendPayload } from './meta-client.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import {
  SendMessageDto,
  SendMessageType,
} from './dto/send-message.dto';
import { ListConversationsDto, ConversationListStatus } from './dto/list-conversations.dto';

const DEFAULT_PAGE_SIZE = 20;
const MAX_MESSAGES_PER_PAGE = 50;

@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metering: UsageMeteringService,
    @Inject(forwardRef(() => InboxGateway))
    private readonly gateway: InboxGateway,
    private readonly metaClient: MetaClientService,
    private readonly config: ConfigService,
    private readonly webhookDispatcher: WebhookDispatcherService,
  ) {}

  async listConversations(
    companyId: number,
    dto: ListConversationsDto,
  ) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      company_id: companyId,
      deleted_at: null,
    };
    if (dto.status && dto.status !== ConversationListStatus.all) {
      where.status = dto.status;
    }
    if (dto.assignedUserId) {
      where.assigned_user_id = dto.assignedUserId;
    }
    if (dto.label) {
      where.labels = { some: { label: dto.label } };
    }
    if (dto.search) {
      where.contact = {
        is: {
          OR: [
            { name: { contains: dto.search } },
            { phone: { contains: dto.search } },
          ],
        },
      };
    }

    const [total, rows] = await Promise.all([
      this.prisma.conversation.count({ where }),
      this.prisma.conversation.findMany({
        where,
        orderBy: [{ last_message_at: 'desc' }, { updated_at: 'desc' }],
        skip,
        take: limit,
        include: {
          contact: { select: { id: true, name: true, phone: true, email: true } },
          assigned_user: { select: { id: true, name: true, email: true } },
          labels: { select: { label: true } },
        },
      }),
    ]);

    return {
      success: true,
      data: rows,
      message: 'OK',
      meta: { page, limit, total },
    };
  }

  async getConversation(companyId: number, id: number) {
    const convo = await this.prisma.conversation.findFirst({
      where: { id, company_id: companyId, deleted_at: null },
      include: {
        contact: true,
        assigned_user: { select: { id: true, name: true, email: true } },
        labels: { select: { id: true, label: true } },
      },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    return convo;
  }

  async assign(companyId: number, id: number, userId: number) {
    await this.requireConversation(companyId, id);

    const user = await this.prisma.user.findFirst({
      where: { id: userId, company_id: companyId, status: 'active' },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found in this company');

    const updated = await this.prisma.conversation.update({
      where: { id },
      data: { assigned_user_id: userId },
    });

    this.gateway.emitToCompany(companyId, 'conversation.assigned', {
      conversationId: id,
      userId,
    });
    return updated;
  }

  async setStatus(
    companyId: number,
    id: number,
    status: 'open' | 'resolved' | 'pending',
  ) {
    await this.requireConversation(companyId, id);
    const updated = await this.prisma.conversation.update({
      where: { id },
      data: { status },
    });
    this.gateway.emitToCompany(companyId, 'conversation.updated', {
      conversationId: id,
      status,
    });
    return updated;
  }

  async addLabel(companyId: number, id: number, label: string) {
    await this.requireConversation(companyId, id);
    try {
      const row = await this.prisma.conversationLabel.create({
        data: { company_id: companyId, conversation_id: id, label },
      });
      this.gateway.emitToCompany(companyId, 'conversation.updated', {
        conversationId: id,
        addedLabel: label,
      });
      return row;
    } catch (err) {
      // unique violation (already labeled) — return existing row
      const existing = await this.prisma.conversationLabel.findFirst({
        where: { conversation_id: id, label },
      });
      if (existing) return existing;
      throw err;
    }
  }

  async removeLabel(companyId: number, id: number, label: string) {
    await this.requireConversation(companyId, id);
    await this.prisma.conversationLabel.deleteMany({
      where: { company_id: companyId, conversation_id: id, label },
    });
    this.gateway.emitToCompany(companyId, 'conversation.updated', {
      conversationId: id,
      removedLabel: label,
    });
    return { removed: true };
  }

  async addNote(companyId: number, id: number, userId: number, body: string) {
    await this.requireConversation(companyId, id);
    return this.prisma.conversationNote.create({
      data: { company_id: companyId, conversation_id: id, user_id: userId, body },
    });
  }

  async listNotes(companyId: number, id: number) {
    await this.requireConversation(companyId, id);
    return this.prisma.conversationNote.findMany({
      where: { company_id: companyId, conversation_id: id },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
  }

  async listMessages(
    companyId: number,
    id: number,
    cursor: number | undefined,
    limit: number,
  ) {
    await this.requireConversation(companyId, id);
    const take = Math.min(limit || MAX_MESSAGES_PER_PAGE, MAX_MESSAGES_PER_PAGE);

    const where: Record<string, unknown> = {
      conversation_id: id,
      company_id: companyId,
    };
    if (cursor) where.id = { lt: cursor };

    const rows = await this.prisma.message.findMany({
      where,
      orderBy: { id: 'desc' },
      take,
    });

    const nextCursor = rows.length === take ? rows[rows.length - 1].id : null;
    return { rows, nextCursor };
  }

  async markRead(companyId: number, id: number, userId: number) {
    await this.requireConversation(companyId, id);
    const now = new Date();
    await this.prisma.message.updateMany({
      where: {
        conversation_id: id,
        company_id: companyId,
        direction: 'inbound',
        read_at: null,
      },
      data: { read_at: now, read_by_user_id: userId },
    });
    await this.prisma.conversation.update({
      where: { id },
      data: { unread_count: 0 },
    });
    this.gateway.emitToCompany(companyId, 'message.read.bulk', {
      conversationId: id,
      readBy: userId,
      readAt: now.toISOString(),
    });
    return { ok: true };
  }

  /**
   * Send an outbound message. Enforces 24hr window for non-template types.
   */
  async sendMessage(
    companyId: number,
    conversationId: number,
    dto: SendMessageDto,
  ) {
    const convo = await this.requireConversation(companyId, conversationId);

    await this.metaClient.assertOnboarded(companyId);

    // 24hr customer service window
    if (dto.type !== SendMessageType.template) {
      const now = new Date();
      if (
        !convo.window_expires_at ||
        convo.window_expires_at.getTime() < now.getTime()
      ) {
        throw new ForbiddenException(
          '24-hour window closed — only template messages allowed',
        );
      }
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { phone_number_id: true },
    });
    if (!company?.phone_number_id) {
      throw new ForbiddenException('WhatsApp phone number not configured');
    }

    const contact = await this.prisma.contact.findUnique({
      where: { id: convo.contact_id },
      select: { phone: true },
    });
    if (!contact) throw new NotFoundException('Contact not found');

    // Build Meta payload
    let payload: MetaSendPayload;
    let messageType: 'text' | 'image' | 'audio' | 'video' | 'document' | 'template';
    let textContent: string | null = null;

    if (dto.type === SendMessageType.text) {
      if (!dto.content) {
        throw new ForbiddenException('content is required for text messages');
      }
      messageType = 'text';
      textContent = dto.content;
      payload = {
        messaging_product: 'whatsapp',
        to: contact.phone,
        type: 'text',
        text: { body: dto.content },
      };
    } else if (dto.type === SendMessageType.template) {
      if (!dto.templateId) {
        throw new ForbiddenException('templateId is required for template messages');
      }
      const tpl = await this.prisma.template.findFirst({
        where: { id: dto.templateId, company_id: companyId, deleted_at: null },
      });
      if (!tpl || !tpl.meta_template_id) {
        throw new NotFoundException('Template not found or not approved');
      }
      const components = this.buildTemplateComponents(dto.variables ?? {});
      messageType = 'template';
      textContent = `[template:${tpl.name}]`;
      const langCode = (tpl.content as { language?: string })?.language ?? 'en_US';
      payload = {
        messaging_product: 'whatsapp',
        to: contact.phone,
        type: 'template',
        template: {
          name: tpl.name,
          language: { code: langCode },
          components,
        },
      };
    } else {
      // media types
      if (!dto.mediaPath) {
        throw new ForbiddenException('mediaPath is required for media messages');
      }
      messageType = dto.type as 'image' | 'audio' | 'video' | 'document';
      textContent = dto.content ?? null;
      const mediaSpec: Record<string, unknown> = { link: dto.mediaPath };
      if (dto.content) mediaSpec.caption = dto.content;
      payload = {
        messaging_product: 'whatsapp',
        to: contact.phone,
        type: messageType,
        [messageType]: mediaSpec,
      } as MetaSendPayload;
    }

    const response = await this.metaClient.sendMessage(
      companyId,
      company.phone_number_id,
      payload,
    );
    const metaMessageId = response.messages?.[0]?.id ?? null;

    const message = await this.prisma.message.create({
      data: {
        conversation_id: conversationId,
        company_id: companyId,
        message_type: messageType,
        direction: 'outbound',
        content: textContent,
        status: 'sent',
        meta_message_id: metaMessageId,
        timestamp: new Date(),
      },
    });

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        last_message: textContent?.slice(0, 500) ?? `[${messageType}]`,
        last_message_at: new Date(),
      },
    });

    await this.metering.incrementMessages(companyId);

    this.gateway.emitToCompany(companyId, 'message.sent', { message });
    await this.webhookDispatcher.dispatch(companyId, 'message.sent', {
      messageId: message.id,
      conversationId,
      contactId: convo.contact_id,
      messageType,
    });
    return message;
  }

  private buildTemplateComponents(variables: Record<string, string>): unknown[] {
    const entries = Object.entries(variables);
    if (entries.length === 0) return [];
    return [
      {
        type: 'body',
        parameters: entries
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([, value]) => ({ type: 'text', text: value })),
      },
    ];
  }

  private async requireConversation(companyId: number, id: number) {
    const convo = await this.prisma.conversation.findFirst({
      where: { id, company_id: companyId, deleted_at: null },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    return convo;
  }
}
