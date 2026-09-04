import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobQueueService } from '../../common/services/job-queue.service';
import {
  mediaWebPathToDisk,
  MEDIA_RETENTION_MS,
  generateImageThumbnail,
} from '../../common/utils/media-path';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { UsageMeteringService } from '../usage-metering/usage-metering.service';
import { InboxGateway } from './inbox.gateway';
import { MetaClientService, MetaSendPayload } from './meta-client.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { CompanyStatusService } from '../../common/services/company-status.service';
import { AiMeteringService } from '../ai/ai-metering.service';
import {
  AudioTranscriptionService,
  WHISPER_MICROS_PER_SEC,
} from '../ai/audio-transcription.service';
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

// ── Bot fan-out media reuse ────────────────────────────────────────────────
// A `send_media` bot action re-fires across MANY chats (one per customer that
// trips the keyword). The naïve path wrote a fresh disk COPY and did a fresh
// Meta UPLOAD per chat — so one video blasted to N chats = N disk copies + N
// uploads (the disk-bloat + extra-failures the tenant reported). We instead
// reuse, per company + staged file, ONE shared outbound copy and ONE Meta media
// id across the fan-out. Per-process cache (single container); a miss just
// re-copies/re-uploads — never incorrect. TTL sits well under Meta's ~30-day
// media lifetime so a reused id is always still valid.
const BOT_MEDIA_REUSE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
interface BotMediaReuse {
  mediaId?: string;
  outWebPath?: string;
  outAbsPath?: string;
  exp: number;
}
const botMediaReuse = new Map<string, BotMediaReuse>();
function getBotMediaReuse(key: string): BotMediaReuse | null {
  const e = botMediaReuse.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) {
    botMediaReuse.delete(key);
    return null;
  }
  return e;
}
function setBotMediaReuse(
  key: string,
  patch: Partial<Omit<BotMediaReuse, 'exp'>>,
): void {
  const cur = getBotMediaReuse(key);
  botMediaReuse.set(key, {
    ...(cur ?? {}),
    ...patch,
    exp: Date.now() + BOT_MEDIA_REUSE_TTL_MS,
  });
}

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

/**
 * Queue job for the async media-send worker. The HTTP request only persists the
 * message as `sending` + enqueues this; the two slow Meta round-trips (upload +
 * send) run here off the request path.
 */
interface SendMediaJob {
  companyId: number;
  conversationId: number;
  contactId: number;
  messageId: number;
  diskPath: string;
  mime: string;
  filename: string;
  messageType: string;
  caption?: string;
  contextMessageId?: number;
  phoneNumberId: string;
  toPhone: string;
  assignedUserId?: number | null;
  // Set for BOT fan-out sends: the worker reuses one Meta media id across all
  // chats sharing this key instead of re-uploading per chat. Already namespaced
  // with the companyId. See botMediaReuse.
  mediaCacheKey?: string;
}

@Injectable()
export class InboxService implements OnModuleInit {
  private readonly logger = new Logger(InboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metering: UsageMeteringService,
    @Inject(forwardRef(() => InboxGateway))
    private readonly gateway: InboxGateway,
    private readonly metaClient: MetaClientService,
    private readonly config: ConfigService,
    private readonly webhookDispatcher: WebhookDispatcherService,
    private readonly companyStatus: CompanyStatusService,
    private readonly transcription: AudioTranscriptionService,
    private readonly aiMetering: AiMeteringService,
    private readonly jobQueue: JobQueueService,
  ) {}

  onModuleInit(): void {
    // Outbound media delivery. Concurrency 3 (shared-hosting memory budget);
    // lease 120s covers the disk read + two Meta round-trips. maxAttempts is 1
    // at enqueue time — a real WhatsApp message must never be auto-re-sent (the
    // customer would see duplicates); on failure we mark the row `failed` and
    // the agent re-sends.
    this.jobQueue.registerWorker(
      'send-media',
      (p) => this.deliverQueuedMedia(p as SendMediaJob),
      3,
      120,
    );
  }

  /**
   * On-demand voice-note transcription (inbox chevron → Transcribe). Cached on
   * the message so each note is transcribed at most once. AI-gated (respects the
   * tenant's AI enablement + monthly cap) and metered like other AI usage.
   */
  async transcribeMessage(
    companyId: number,
    conversationId: number,
    messageId: number,
  ): Promise<{ text: string; cached: boolean }> {
    const msg = await this.prisma.message.findFirst({
      where: {
        id: messageId,
        conversation_id: conversationId,
        company_id: companyId,
      },
      select: {
        id: true,
        message_type: true,
        media_url: true,
        transcription: true,
      },
    });
    if (!msg) throw new NotFoundException('Message not found');
    if (msg.transcription) return { text: msg.transcription, cached: true };
    if (msg.message_type !== 'audio') {
      throw new BadRequestException('This message is not a voice note');
    }
    if (!this.transcription.isConfigured()) {
      throw new ServiceUnavailableException(
        'Voice transcription is not available',
      );
    }
    // Enforces AI-enabled + monthly spend cap (throws 403 when off/over cap).
    await this.aiMetering.assertAllowed(companyId);
    if (!msg.media_url) throw new BadRequestException('No audio file to transcribe');

    const rel = msg.media_url.replace(/^\/storage\/media\//, '');
    const diskPath = path.join(STORAGE_ROOT, rel);
    const result = await this.transcription.transcribe(diskPath);
    if (!result) {
      throw new ServiceUnavailableException(
        'Could not transcribe this voice note',
      );
    }
    await this.prisma.message.update({
      where: { id: msg.id },
      data: { transcription: result.text },
    });
    await this.aiMetering.recordTranscription(
      companyId,
      Math.round(result.durationSec * WHISPER_MICROS_PER_SEC),
    );
    return { text: result.text, cached: false };
  }

  async listConversations(
    companyId: number,
    dto: ListConversationsDto,
    viewer: { userId: number; role: string },
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
    // RBAC visibility (pool model): agents see ONLY chats assigned to them or
    // unassigned; owners/admins see all and may filter by assignee. The agent
    // scope is a hard boundary — an agent's assignee-filter params are ignored.
    const isPrivileged = viewer.role === 'owner' || viewer.role === 'admin';
    if (!isPrivileged) {
      // Agents: unassigned + their own only. Their "Assigned to me" filter
      // narrows to just their own; any other assignee param is ignored (the
      // pool boundary can't be widened by a crafted request). Prisma rejects
      // NULL inside `in`, so the pool is expressed as an AND'd OR (kept
      // separate from the search `OR` above).
      if (dto.assignedUserId === viewer.userId) {
        where.assigned_user_id = viewer.userId;
      } else {
        where.AND = [
          {
            OR: [
              { assigned_user_id: viewer.userId },
              { assigned_user_id: null },
            ],
          },
        ];
      }
    } else if (dto.unassigned) {
      where.assigned_user_id = null;
    } else if (dto.assignedUserId) {
      where.assigned_user_id = dto.assignedUserId;
    }
    if (dto.label) {
      // Substring match (case-insensitive via the column collation) so the
      // label-filter box narrows results as the user types, instead of needing
      // the exact full label.
      where.labels = { some: { label: { contains: dto.label } } };
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
          // Latest message (type/direction/status) so the list row can render a
          // WhatsApp-style preview — an icon + label for media (🎤 Voice, 🖼
          // Photo …) and the ✓✓ delivery tick on an outbound last message —
          // instead of the raw `[audio]`/`[video]` sentinel stored in
          // `last_message`. Index-backed single-row seek per conversation
          // (@@index conversation_id,timestamp desc); the list is paginated so
          // it's one cheap lookup per shown row. No schema change.
          messages: {
            select: { message_type: true, direction: true, status: true },
            orderBy: { timestamp: 'desc' },
            take: 1,
          },
        },
      }),
    ]);

    const data = rows.map(({ messages, ...r }) => {
      const lm = messages[0];
      return {
        ...r,
        last_message_type: lm?.message_type ?? null,
        last_message_direction: lm?.direction ?? null,
        last_message_status: lm?.status ?? null,
      };
    });

    return {
      success: true,
      data,
      message: 'OK',
      meta: { page, limit, total },
    };
  }

  /**
   * RBAC gate for a single conversation (pool model). Owners/admins may access
   * any chat in the company; agents may access ONLY chats assigned to them or
   * unassigned. Throws NotFound (not Forbidden) on a denied/absent chat so an
   * agent can't probe which conversation ids exist for other agents. Call this
   * at the top of every agent-reachable per-conversation controller handler.
   */
  async assertConversationAccess(
    companyId: number,
    id: number,
    viewer: { userId: number; role: string },
  ): Promise<void> {
    const convo = await this.prisma.conversation.findFirst({
      where: { id, company_id: companyId, deleted_at: null },
      select: { assigned_user_id: true },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    const isPrivileged = viewer.role === 'owner' || viewer.role === 'admin';
    if (isPrivileged) return;
    if (
      convo.assigned_user_id !== null &&
      convo.assigned_user_id !== viewer.userId
    ) {
      throw new NotFoundException('Conversation not found');
    }
  }

  async getConversation(
    companyId: number,
    id: number,
    viewer?: { userId: number; role: string },
  ) {
    const convo = await this.prisma.conversation.findFirst({
      where: { id, company_id: companyId, deleted_at: null },
      include: {
        contact: true,
        assigned_user: { select: { id: true, name: true, email: true } },
        labels: { select: { id: true, label: true } },
      },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    if (viewer) {
      const isPrivileged =
        viewer.role === 'owner' || viewer.role === 'admin';
      if (
        !isPrivileged &&
        convo.assigned_user_id !== null &&
        convo.assigned_user_id !== viewer.userId
      ) {
        throw new NotFoundException('Conversation not found');
      }
    }
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

  // Per-conversation AI auto-pilot override. mode 'on' = force AI auto-reply
  // on this chat (overrides the assigned-human skip), 'off' = mute it, 'default'
  // = follow the workspace setting. Reuses conversation.updated so the list +
  // open thread refresh (no new socket event).
  async setAiAutoReply(
    companyId: number,
    id: number,
    mode: 'on' | 'off' | 'default',
  ) {
    await this.requireConversation(companyId, id);
    const value = mode === 'on' ? true : mode === 'off' ? false : null;
    const updated = await this.prisma.conversation.update({
      where: { id },
      data: { ai_autoreply: value },
    });
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
    // Hard backstop: a suspended/inactive tenant sends NOTHING outbound, no
    // matter the caller (AI worker, bot, broadcast, agent). TenantGuard already
    // blocks the agent UI; this covers the queue/automation paths that bypass it.
    if (!(await this.companyStatus.isActive(companyId))) {
      throw new ForbiddenException('Company account is not active');
    }

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
      const components = this.buildTemplateComponents(dto.variables ?? {}, {
        templateContent: tpl.content,
        urlButtonUrl: dto.urlButtonUrl,
      });
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
        // Echo the optimistic client id back so the inbox reconciles by it.
        client_id: dto.clientId ?? null,
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

    // Scoped delivery (pool model): after an auto-assign the chat now belongs to
    // this agent, so the effective assignee is convo's assignee or the sender.
    this.gateway.emitToConversationScoped(
      companyId,
      convo.assigned_user_id ?? userId ?? null,
      'message.sent',
      { message },
    );
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
  /**
   * Transcode a device-native voice recording (webm/opus, mp4/aac, m4a, …) to a
   * WhatsApp-grade OGG/Opus voice note using the container's ffmpeg. Mono, 16 kHz,
   * 32 kbps, VoIP application — the clean wideband speech WhatsApp expects. This
   * replaces the in-browser WASM Opus encoder, which glitched on mobile (iOS
   * especially): the phone now records with its reliable native pipeline and the
   * server does the format conversion. Temp files (ffmpeg needs a seekable OGG
   * output); both are always cleaned up.
   */
  private async transcodeToVoiceOgg(input: Buffer): Promise<Buffer> {
    const id = uuidv4();
    const inPath = path.join(os.tmpdir(), `vn-${id}.in`);
    const outPath = path.join(os.tmpdir(), `vn-${id}.ogg`);
    await fs.promises.writeFile(inPath, input);
    try {
      await new Promise<void>((resolve, reject) => {
        const ff = spawn('ffmpeg', [
          '-y',
          '-i', inPath,
          '-ac', '1',
          '-ar', '16000',
          '-c:a', 'libopus',
          '-b:a', '32k',
          '-application', 'voip',
          '-f', 'ogg',
          outPath,
        ]);
        let err = '';
        ff.stderr.on('data', (d) => {
          err += d.toString();
          if (err.length > 4000) err = err.slice(-4000);
        });
        ff.on('error', reject); // ffmpeg not found / spawn failure
        ff.on('close', (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-500)}`)),
        );
      });
      const out = await fs.promises.readFile(outPath);
      if (!out.length) throw new Error('ffmpeg produced an empty file');
      return out;
    } finally {
      void fs.promises.unlink(inPath).catch(() => {});
      void fs.promises.unlink(outPath).catch(() => {});
    }
  }

  async sendMedia(input: {
    companyId: number;
    conversationId: number;
    // buffer is optional when `staged` is given (bot fan-out): the bytes are
    // already on disk at the staged web path, so we neither require nor re-write
    // them per chat.
    file: {
      buffer?: Buffer;
      mimetype: string;
      originalname?: string;
      size: number;
    };
    caption?: string;
    contextMessageId?: number;
    userId?: number;
    // Optimistic client id echoed back for inbox reconciliation (see sendMessage).
    clientId?: string;
    // BOT `send_media` action: the already-staged file to reuse (no fresh copy),
    // plus a stable key to share one disposable outbound copy + one Meta upload
    // across the whole fan-out. cacheKey is the bot's staged web path.
    staged?: { webPath: string; cacheKey: string };
    // A voice note recorded on the device with the browser's NATIVE recorder
    // (webm/opus on Android, mp4/aac on iPhone). We transcode it to WhatsApp
    // OGG/Opus with ffmpeg on the server, so the fragile in-browser WASM encoder
    // is gone. Non-voice audio attachments (an mp3 file) leave this false.
    voice?: boolean;
  }) {
    const { companyId, conversationId } = input;
    let file = input.file;

    // Voice note → transcode the device's native recording to OGG/Opus here.
    // The rest of the pipeline then treats it as a normal audio/ogg voice note
    // (the send-media worker flags audio.voice=true for a PTT bubble).
    if (input.voice && file.buffer) {
      try {
        const ogg = await this.transcodeToVoiceOgg(file.buffer);
        file = {
          buffer: ogg,
          mimetype: 'audio/ogg',
          originalname: `voice-note-${Date.now()}.ogg`,
          size: ogg.length,
        };
      } catch (e) {
        this.logger.error(
          `voice transcode failed (company ${companyId}): ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        throw new BadRequestException('Could not process the voice note. Please try again.');
      }
    }
    // Hard backstop: suspended/inactive tenant sends nothing outbound.
    if (!(await this.companyStatus.isActive(companyId))) {
      throw new ForbiddenException('Company account is not active');
    }

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

    // Resolve the on-disk file + web path for this send. For a normal agent
    // send we write the uploaded buffer once. For a BOT fan-out (`staged`) we
    // reuse ONE shared disposable outbound copy across all chats (see
    // botMediaReuse) — never point the bubble at the bot's persistent staged
    // asset, since the cleanup cron would then delete it out from under the bot.
    let absPath: string;
    let mediaWebPath: string;
    let mediaCacheKey: string | undefined;

    if (input.staged) {
      mediaCacheKey = `${companyId}:${input.staged.cacheKey}`;
      const reuse = getBotMediaReuse(mediaCacheKey);
      if (reuse?.outWebPath && reuse.outAbsPath && fs.existsSync(reuse.outAbsPath)) {
        // Second+ chat in the fan-out: reuse the shared copy, no new file.
        absPath = reuse.outAbsPath;
        mediaWebPath = reuse.outWebPath;
      } else {
        // First chat in this window: copy the staged file ONCE to a disposable
        // outbound file the cleanup cron may safely purge after the retention
        // window (MEDIA_RETENTION_MS).
        const src = mediaWebPathToDisk(input.staged.webPath);
        if (!src || !fs.existsSync(src)) {
          throw new BadRequestException('Staged media file is missing');
        }
        const dir = path.join(
          STORAGE_ROOT,
          String(companyId),
          String(now.getFullYear()),
          String(now.getMonth() + 1).padStart(2, '0'),
        );
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        absPath = path.join(dir, `${uuidv4()}.${MIME_EXT[mime] ?? 'bin'}`);
        // Async copy — never block the single Node event loop on a multi-MB
        // media write (that froze every other request, e.g. opening another
        // chat, while a catalog image was being sent).
        await fs.promises.copyFile(src, absPath);
        const rel = path.relative(STORAGE_ROOT, absPath).split(path.sep).join('/');
        mediaWebPath = `/storage/media/${rel}`;
        // Fire-and-forget display thumbnail (image-only, non-throwing).
        void generateImageThumbnail(absPath);
        setBotMediaReuse(mediaCacheKey, {
          outWebPath: mediaWebPath,
          outAbsPath: absPath,
        });
      }
    } else {
      // Normal agent send: persist the uploaded buffer (web path convention).
      if (!file.buffer) {
        throw new BadRequestException('Media file is required');
      }
      const dir = path.join(
        STORAGE_ROOT,
        String(companyId),
        String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, '0'),
      );
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      absPath = path.join(dir, `${uuidv4()}.${MIME_EXT[mime] ?? 'bin'}`);
      // Async write — a synchronous writeFileSync here blocked the whole Node
      // event loop for the duration of the disk write, so while a large (e.g.
      // catalog) image was being sent the agent couldn't open other chats. The
      // request still returns fast (row persisted 'sending', Meta send queued).
      await fs.promises.writeFile(absPath, file.buffer);
      const rel = path.relative(STORAGE_ROOT, absPath).split(path.sep).join('/');
      mediaWebPath = `/storage/media/${rel}`;
      // Fire-and-forget display thumbnail (image-only, non-throwing) so the
      // inbox paints a light bitmap instead of decoding the full-res original.
      void generateImageThumbnail(absPath);
    }

    // Persist the message as `sending` and return IMMEDIATELY. The two slow
    // Meta round-trips (uploadMedia → sendMessage) used to run inline here,
    // blocking the HTTP response for seconds — that was the "app halts until
    // sent" jank. They now run on the `send-media` queue; the row flips to
    // `sent` (or `failed`) via a `message.status` socket event when Meta acks.
    const message = await this.prisma.message.create({
      data: {
        conversation_id: conversationId,
        company_id: companyId,
        message_type: messageType,
        direction: 'outbound',
        content: caption ?? null,
        media_url: mediaWebPath,
        media_expires_at: new Date(Date.now() + MEDIA_RETENTION_MS),
        media_expired: false,
        status: 'sending',
        meta_message_id: null,
        context_message_id: input.contextMessageId ?? null,
        user_id: input.userId ?? null,
        // Echo the optimistic client id back so the inbox reconciles by it —
        // fixes the "sent twice" media duplicate (the POST response AND the
        // message.sent socket both carry it now).
        client_id: input.clientId ?? null,
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

    // First agent to reply owns the chat (only if it was unassigned).
    await this.autoAssignOnReply(
      companyId,
      conversationId,
      convo.assigned_user_id,
      input.userId,
    );

    // Let other agents viewing the chat see the message instantly (the sender
    // already painted an optimistic bubble). It shows `sending` until the
    // worker reports the ack.
    this.gateway.emitToConversationScoped(
      companyId,
      convo.assigned_user_id ?? input.userId ?? null,
      'message.sent',
      { message },
    );

    await this.jobQueue.enqueue(
      'send-media',
      {
        companyId,
        conversationId,
        contactId: convo.contact_id,
        messageId: message.id,
        diskPath: absPath,
        mime,
        filename,
        messageType,
        caption,
        contextMessageId: input.contextMessageId,
        phoneNumberId: company.phone_number_id,
        toPhone: contact.phone,
        assignedUserId: convo.assigned_user_id ?? input.userId ?? null,
        mediaCacheKey,
      } as SendMediaJob,
      {
        // FIFO per chat so two quick media sends keep their order; isolated
        // namespace so it never serializes against the inbound `message` queue.
        serialKey: `media:conv:${conversationId}`,
        // A given message row is delivered at most once.
        dedupKey: `send-media:${message.id}`,
        maxAttempts: 1,
      },
    );

    return message;
  }

  /**
   * `send-media` worker: does the Meta upload + send off the request path and
   * flips the persisted `sending` row to `sent` (or `failed`). Idempotent — a
   * row not still `sending` is skipped. Never re-sends automatically (maxAttempts
   * = 1) so a customer can't receive duplicates.
   */
  private async deliverQueuedMedia(job: SendMediaJob): Promise<void> {
    const row = await this.prisma.message.findFirst({
      where: { id: job.messageId, company_id: job.companyId },
      select: { id: true, status: true },
    });
    if (!row || row.status !== 'sending') return; // gone or already handled

    try {
      // Bot fan-out: reuse the Meta media id already uploaded for this staged
      // file (uploaded once, valid ~30 days) instead of re-uploading per chat.
      let mediaId: string | undefined = job.mediaCacheKey
        ? getBotMediaReuse(job.mediaCacheKey)?.mediaId
        : undefined;
      if (!mediaId) {
        let buffer: Buffer;
        try {
          buffer = fs.readFileSync(job.diskPath);
        } catch {
          await this.failQueuedMedia(job, 'media file missing on disk');
          return;
        }
        ({ mediaId } = await this.metaClient.uploadMedia(
          job.companyId,
          buffer,
          job.mime,
          job.filename,
        ));
        if (job.mediaCacheKey) setBotMediaReuse(job.mediaCacheKey, { mediaId });
      }
      const mediaSpec: Record<string, unknown> = { id: mediaId };
      // WhatsApp renders an audio message as a PTT VOICE NOTE (waveform, profile
      // pic, transcription) ONLY when the send payload sets `audio.voice = true`
      // (per the Cloud API "Audio messages" docs). Without it, an otherwise-valid
      // .ogg/opus note is a "basic audio message" → shown as a FILE. Our voice
      // notes are opus/ogg, so flag them; other audio attachments (mp3/aac/…)
      // stay basic audio.
      if (job.messageType === 'audio' && /^audio\/ogg\b/i.test(job.mime)) {
        mediaSpec.voice = true;
      }
      if (
        job.caption &&
        (job.messageType === 'image' ||
          job.messageType === 'video' ||
          job.messageType === 'document')
      ) {
        // WhatsApp Cloud API supports a caption on image/video/document (not
        // audio). Documents carry it alongside the filename.
        mediaSpec.caption = job.caption;
      }
      if (job.messageType === 'document') {
        mediaSpec.filename = job.filename;
      }
      const payload: MetaSendPayload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: job.toPhone,
        type: job.messageType,
        [job.messageType]: mediaSpec,
      } as MetaSendPayload;
      await this.resolveContext(job.companyId, job.contextMessageId, payload);

      const response = await this.metaClient.sendMessage(
        job.companyId,
        job.phoneNumberId,
        payload,
      );
      const metaMessageId = response.messages?.[0]?.id ?? null;

      await this.prisma.message.update({
        where: { id: job.messageId },
        data: { status: 'sent', meta_message_id: metaMessageId },
      });
      await this.metering.incrementMessages(job.companyId);
      this.gateway.emitToCompany(job.companyId, 'message.status', {
        messageId: job.messageId,
        status: 'sent',
      });
      await this.webhookDispatcher.dispatch(job.companyId, 'message.sent', {
        messageId: job.messageId,
        conversationId: job.conversationId,
        contactId: job.contactId,
        messageType: job.messageType,
      });
      this.logger.log(
        `send-media delivered convo=${job.conversationId} msg=${job.messageId} metaMessageId=${metaMessageId}`,
      );
    } catch (err) {
      await this.failQueuedMedia(
        job,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Mark a queued media message failed + notify clients (never throws). */
  private async failQueuedMedia(job: SendMediaJob, reason: string): Promise<void> {
    this.logger.warn(
      `send-media FAILED convo=${job.conversationId} msg=${job.messageId}: ${reason}`,
    );
    await this.prisma.message
      .update({ where: { id: job.messageId }, data: { status: 'failed' } })
      .catch(() => undefined);
    this.gateway.emitToCompany(job.companyId, 'message.status', {
      messageId: job.messageId,
      status: 'failed',
      error: 'Media could not be sent. Please try again.',
    });
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

  private buildTemplateComponents(
    variables: Record<string, string>,
    opts?: { templateContent?: unknown; urlButtonUrl?: string },
  ): unknown[] {
    const components: unknown[] = [];

    const entries = Object.entries(variables);
    if (entries.length > 0) {
      components.push({
        type: 'body',
        parameters: entries
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([, value]) => ({ type: 'text', text: value })),
      });
    }

    // Dynamic URL button. Meta requires a `button` component (sub_type url) with
    // a parameter for any URL button whose approved url contains a {{n}}
    // placeholder — otherwise the ENTIRE send is rejected with
    // "(#131008) Button at index N of type Url requires a parameter". The
    // parameter is the SUFFIX appended after the button's static prefix (the
    // part before {{n}}); we derive it from the full destination URL.
    if (opts?.templateContent && opts.urlButtonUrl) {
      const btn = this.findDynamicUrlButton(opts.templateContent);
      if (btn) {
        const full = opts.urlButtonUrl;
        let suffix: string;
        if (btn.prefix && full.startsWith(btn.prefix)) {
          suffix = full.slice(btn.prefix.length);
        } else {
          // Base mismatch (tenant's approved button prefix differs from the
          // real link origin). Best effort: send the path+query after the
          // origin so at least a relative-correct suffix flows. The tenant
          // should set the button url to "<tracking-origin>/{{1}}".
          try {
            const u = new URL(full);
            suffix = full.slice(u.origin.length + 1);
          } catch {
            suffix = full;
          }
          this.logger.warn(
            `Template URL button prefix "${btn.prefix}" does not match link "${full}" — sending best-effort suffix "${suffix}". Set the button url to "<origin>/{{1}}".`,
          );
        }
        components.push({
          type: 'button',
          sub_type: 'url',
          index: String(btn.index),
          parameters: [{ type: 'text', text: suffix || full }],
        });
      }
    }

    return components;
  }

  /**
   * Locate a dynamic URL button in an approved template's content: a button of
   * type URL whose url carries a {{n}} placeholder. Returns its 0-based index
   * within the BUTTONS array (Meta's required `index`) + the static url prefix
   * before the placeholder. null when the template has no such button.
   */
  private findDynamicUrlButton(
    content: unknown,
  ): { index: number; prefix: string } | null {
    const comps = ((content as { components?: Array<Record<string, unknown>> })
      ?.components ?? []) as Array<Record<string, unknown>>;
    const buttonsComp = comps.find(
      (c) => String(c?.type ?? '').toUpperCase() === 'BUTTONS',
    );
    const list = (buttonsComp?.buttons ?? []) as Array<Record<string, unknown>>;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const url = typeof b?.url === 'string' ? (b.url as string) : '';
      if (
        String(b?.type ?? '').toUpperCase() === 'URL' &&
        url.includes('{{')
      ) {
        return { index: i, prefix: url.split('{{')[0] };
      }
    }
    return null;
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
