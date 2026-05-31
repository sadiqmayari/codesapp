import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
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

// Outbound media root mirrors the inbound convention in MetaWebhookService:
// files on disk under <cwd>/../storage/media/<companyId>/<yyyy>/<mm>/<uuid>.<ext>;
// messages.media_url stores the WEB path /storage/media/... (served by the
// /storage static mount), NOT the absolute fs path (FE-2c regression guard).
const STORAGE_ROOT = path.join(process.cwd(), '..', 'storage', 'media');

type MediaKind = 'image' | 'audio' | 'video' | 'document';

interface MediaTypeRule {
  kind: MediaKind;
  maxBytes: number;
  mimes: string[];
}

const MEDIA_RULES: MediaTypeRule[] = [
  {
    kind: 'image',
    maxBytes: 5 * 1024 * 1024,
    // Meta WhatsApp Cloud API accepts ONLY jpeg/png for image messages —
    // webp is sticker-only and Meta rejects it with (#131053).
    mimes: ['image/jpeg', 'image/png'],
  },
  {
    kind: 'video',
    maxBytes: 16 * 1024 * 1024,
    mimes: ['video/mp4', 'video/3gpp'],
  },
  {
    kind: 'audio',
    maxBytes: 10 * 1024 * 1024,
    mimes: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'],
  },
  {
    kind: 'document',
    maxBytes: 10 * 1024 * 1024,
    mimes: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
    ],
  },
];

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/amr': 'amr',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'pptx',
  'text/plain': 'txt',
};

// One-level-deep hydration of the quoted (replied-to) message. NEVER nest
// context_message recursively — only these scalar fields.
const CONTEXT_SELECT = {
  id: true,
  direction: true,
  message_type: true,
  content: true,
  media_url: true,
} as const;

const MESSAGE_INCLUDE = {
  context_message: { select: CONTEXT_SELECT },
} as const;

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
    if (dto.status === ConversationListStatus.unread) {
      where.unread_count = { gt: 0 };
    } else if (dto.status === ConversationListStatus.open) {
      // "Open" = the 24-hour WhatsApp service window is still active (free-form
      // replies allowed), NOT the workflow `status` column. This matches the
      // agent's mental model of an "open" chat they can still message.
      where.window_expires_at = { gt: new Date() };
    } else if (dto.status && dto.status !== ConversationListStatus.all) {
      where.status = dto.status;
    }
    if (dto.assignedUserId) {
      where.assigned_user_id = dto.assignedUserId;
    }
    if (dto.label) {
      where.labels = { some: { label: dto.label } };
    }
    if (dto.search) {
      // Match the contact (name / phone) OR any message text inside the
      // conversation — so an agent can find a chat by something that was said
      // in it, not just by who it's with.
      where.OR = [
        {
          contact: {
            is: {
              OR: [
                { name: { contains: dto.search } },
                { phone: { contains: dto.search } },
              ],
            },
          },
        },
        { messages: { some: { content: { contains: dto.search } } } },
      ];
    }

    const [total, rows] = await Promise.all([
      this.prisma.conversation.count({ where }),
      this.prisma.conversation.findMany({
        where,
        // Shell-Polish-B: pinned conversations stick to the top. MySQL sorts
        // NULL last in DESC, so non-null pinned_at (pinned) precedes NULL
        // (unpinned); most-recently-pinned first among pins.
        orderBy: [
          { pinned_at: 'desc' },
          { last_message_at: 'desc' },
          { updated_at: 'desc' },
        ],
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

  async assign(companyId: number, id: number, userId: number | null) {
    await this.requireConversation(companyId, id);

    if (userId !== null) {
      const user = await this.prisma.user.findFirst({
        where: { id: userId, company_id: companyId, status: 'active' },
        select: { id: true },
      });
      if (!user)
        throw new NotFoundException('User not found in this company');
    }

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

  // Shell-Polish-B: company-wide pin (sticky-top in the inbox list).
  async setPinned(companyId: number, id: number, pinned: boolean) {
    await this.requireConversation(companyId, id);
    const updated = await this.prisma.conversation.update({
      where: { id },
      data: { pinned_at: pinned ? new Date() : null },
    });
    // Existing event + existing shape ({ conversationId }) — the list
    // handler refetches on conversation.updated and re-sorts pinned-first.
    this.gateway.emitToCompany(companyId, 'conversation.updated', {
      conversationId: id,
    });
    return updated;
  }

  // Shell-Polish-B: "clear chat" soft marker. No row deletes — the thread
  // fetch hides messages at/before this timestamp; new inbound still shows.
  async clearHistory(companyId: number, id: number) {
    await this.requireConversation(companyId, id);
    const updated = await this.prisma.conversation.update({
      where: { id },
      data: { cleared_before: new Date() },
    });
    this.gateway.emitToCompany(companyId, 'conversation.updated', {
      conversationId: id,
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
    const convo = await this.requireConversation(companyId, id);
    const take = Math.min(limit || MAX_MESSAGES_PER_PAGE, MAX_MESSAGES_PER_PAGE);

    const where: Record<string, unknown> = {
      conversation_id: id,
      company_id: companyId,
    };
    if (cursor) where.id = { lt: cursor };
    // Shell-Polish-B: respect the "clear chat" soft marker.
    if (convo.cleared_before) {
      where.timestamp = { gt: convo.cleared_before };
    }

    const rows = await this.prisma.message.findMany({
      where,
      orderBy: { id: 'desc' },
      take,
      include: MESSAGE_INCLUDE,
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
  /**
   * Auto-assign a conversation to the agent who just replied — but ONLY if it
   * is currently unassigned. Once assigned (auto or manual) it stays put; a
   * different agent replying later never steals it. Best-effort: a failure
   * here must not fail the send.
   */
  private async autoAssignOnReply(
    companyId: number,
    conversationId: number,
    currentAssignedUserId: number | null | undefined,
    userId: number | undefined,
  ) {
    if (!userId || currentAssignedUserId != null) return;
    try {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { assigned_user_id: userId },
      });
      this.gateway.emitToCompany(companyId, 'conversation.assigned', {
        conversationId,
        userId,
      });
    } catch {
      /* non-fatal — the message already sent */
    }
  }

  async sendMessage(
    companyId: number,
    conversationId: number,
    dto: SendMessageDto,
    userId?: number,
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
        text: { body: dto.content, preview_url: true },
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
      textContent = this.renderTemplateText(tpl.content, dto.variables ?? {});
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

    // Reply-with-context (best effort): attach the quoted message's wamid.
    const contextMessageId = await this.resolveContext(
      companyId,
      dto.contextMessageId,
      payload,
    );

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
        context_message_id: contextMessageId,
        user_id: userId ?? null,
        timestamp: new Date(),
      },
      include: MESSAGE_INCLUDE,
    });

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        last_message: textContent?.slice(0, 500) ?? `[${messageType}]`,
        last_message_at: new Date(),
      },
    });

    await this.metering.incrementMessages(companyId);

    // First agent to reply owns the chat (only if it was unassigned).
    await this.autoAssignOnReply(
      companyId,
      conversationId,
      convo.assigned_user_id,
      userId,
    );

    this.gateway.emitToCompany(companyId, 'message.sent', { message });
    await this.webhookDispatcher.dispatch(companyId, 'message.sent', {
      messageId: message.id,
      conversationId,
      contactId: convo.contact_id,
      messageType,
    });
    return message;
  }

  /**
   * Send an outbound media message (image/audio/video/document). New path —
   * deliberately NOT folded into sendMessage. Pre-uploads the file to Meta,
   * then sends by media id. Enforces onboarding (412), the 24hr window
   * (403), and per-type mime/size validation (400).
   */
  async sendMedia(input: {
    companyId: number;
    conversationId: number;
    file: { buffer: Buffer; mimetype: string; originalname?: string; size: number };
    caption?: string;
    contextMessageId?: number;
    userId?: number;
  }) {
    const { companyId, conversationId, file } = input;
    const convo = await this.requireConversation(companyId, conversationId);

    await this.metaClient.assertOnboarded(companyId);

    const now = new Date();
    if (
      !convo.window_expires_at ||
      convo.window_expires_at.getTime() < now.getTime()
    ) {
      throw new ForbiddenException(
        '24-hour window closed — only template messages allowed',
      );
    }

    const mime = (file.mimetype || '').toLowerCase();
    const rule = MEDIA_RULES.find((r) => r.mimes.includes(mime));
    if (!rule) {
      throw new BadRequestException(`Unsupported media type: ${mime || 'unknown'}`);
    }
    if (file.size > rule.maxBytes) {
      throw new BadRequestException(
        `${rule.kind} exceeds the ${Math.round(
          rule.maxBytes / (1024 * 1024),
        )}MB limit`,
      );
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

    const messageType = rule.kind;
    const caption = input.caption?.trim() || undefined;
    const filename = (file.originalname || `file.${MIME_EXT[mime] ?? 'bin'}`)
      .replace(/[\r\n"]/g, '')
      .slice(0, 240);

    // Save locally first (web path, same convention as inbound media).
    const dir = path.join(
      STORAGE_ROOT,
      String(companyId),
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
    );
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const diskName = `${uuidv4()}.${MIME_EXT[mime] ?? 'bin'}`;
    fs.writeFileSync(path.join(dir, diskName), file.buffer);
    const rel = path
      .relative(STORAGE_ROOT, path.join(dir, diskName))
      .split(path.sep)
      .join('/');
    const mediaWebPath = `/storage/media/${rel}`;

    // Pre-upload to Meta → media id.
    const { mediaId } = await this.metaClient.uploadMedia(
      companyId,
      file.buffer,
      mime,
      filename,
    );

    const mediaSpec: Record<string, unknown> = { id: mediaId };
    if (caption && (messageType === 'image' || messageType === 'video')) {
      mediaSpec.caption = caption;
    }
    if (messageType === 'document') {
      mediaSpec.filename = filename;
    }

    const payload: MetaSendPayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: contact.phone,
      type: messageType,
      [messageType]: mediaSpec,
    } as MetaSendPayload;

    const contextMessageId = await this.resolveContext(
      companyId,
      input.contextMessageId,
      payload,
    );

    this.logger.log(
      `sendMedia company=${companyId} convo=${conversationId} type=${messageType} mime=${mime} bytes=${file.size} mediaId=${mediaId}`,
    );

    const response = await this.metaClient.sendMessage(
      companyId,
      company.phone_number_id,
      payload,
    );
    const metaMessageId = response.messages?.[0]?.id ?? null;
    this.logger.log(
      `sendMedia Meta accepted convo=${conversationId} metaMessageId=${metaMessageId}`,
    );

    const message = await this.prisma.message.create({
      data: {
        conversation_id: conversationId,
        company_id: companyId,
        message_type: messageType,
        direction: 'outbound',
        content: caption ?? null,
        media_url: mediaWebPath,
        media_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        media_expired: false,
        status: 'sent',
        meta_message_id: metaMessageId,
        context_message_id: contextMessageId,
        user_id: input.userId ?? null,
        timestamp: new Date(),
      },
      include: MESSAGE_INCLUDE,
    });

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        last_message: (caption ?? `[${messageType}]`).slice(0, 500),
        last_message_at: new Date(),
      },
    });

    await this.metering.incrementMessages(companyId);

    // First agent to reply owns the chat (only if it was unassigned).
    await this.autoAssignOnReply(
      companyId,
      conversationId,
      convo.assigned_user_id,
      input.userId,
    );

    this.gateway.emitToCompany(companyId, 'message.sent', { message });
    await this.webhookDispatcher.dispatch(companyId, 'message.sent', {
      messageId: message.id,
      conversationId,
      contactId: convo.contact_id,
      messageType,
    });
    return message;
  }

  /**
   * Best-effort: look up the quoted message (scoped to company), and if it
   * has a Meta wamid, mutate `payload.context`. Returns the internal id to
   * persist as context_message_id (or null). NEVER throws — a missing
   * message or null wamid just sends without context (+ warn log).
   */
  private async resolveContext(
    companyId: number,
    contextMessageId: number | undefined,
    payload: MetaSendPayload,
  ): Promise<number | null> {
    if (!contextMessageId) return null;
    try {
      const ref = await this.prisma.message.findFirst({
        where: { id: contextMessageId, company_id: companyId },
        select: { id: true, meta_message_id: true },
      });
      if (!ref) {
        this.logger.warn(
          `Reply context ${contextMessageId} not found for company ${companyId} — sending without context`,
        );
        return null;
      }
      if (ref.meta_message_id) {
        (payload as { context?: { message_id: string } }).context = {
          message_id: ref.meta_message_id,
        };
      } else {
        this.logger.warn(
          `Reply context ${contextMessageId} has no meta_message_id — sending without context`,
        );
      }
      return ref.id;
    } catch (err) {
      this.logger.warn(
        `resolveContext failed for ${contextMessageId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
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

  /**
   * Build a readable text rendition of a template (header + body with
   * {{n}} filled + footer + buttons) so the chat shows the real content
   * instead of "[template:name]".
   */
  private renderTemplateText(
    content: unknown,
    variables: Record<string, string>,
  ): string {
    const comps =
      ((content as { components?: Array<Record<string, unknown>> })
        ?.components ?? []) as Array<Record<string, unknown>>;
    const find = (t: string) =>
      comps.find(
        (c) => String(c.type ?? '').toUpperCase() === t,
      );
    const fill = (s: string) =>
      s.replace(/\{\{(\d+)\}\}/g, (_, n) => variables[n] ?? `{{${n}}}`);

    const out: string[] = [];
    const header = find('HEADER');
    if (header && typeof header.text === 'string') {
      out.push(fill(header.text));
    }
    const body = find('BODY');
    if (body && typeof body.text === 'string') {
      out.push(fill(body.text));
    }
    const footer = find('FOOTER');
    if (footer && typeof footer.text === 'string') {
      out.push(fill(footer.text));
    }
    const buttons = find('BUTTONS');
    const btns = (buttons?.buttons ?? []) as Array<{ text?: string }>;
    if (btns.length) {
      out.push(btns.map((b) => `[ ${b.text ?? 'Button'} ]`).join('  '));
    }
    const text = out.filter(Boolean).join('\n\n').trim();
    return text || '[template message]';
  }

  private async requireConversation(companyId: number, id: number) {
    const convo = await this.prisma.conversation.findFirst({
      where: { id, company_id: companyId, deleted_at: null },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    return convo;
  }
}
