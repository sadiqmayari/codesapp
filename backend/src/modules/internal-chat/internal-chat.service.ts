import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaService } from '../../common/services/media.service';
import { InboxGateway } from '../inbox/inbox.gateway';

export interface Actor {
  userId: number;
  companyId: number;
  role: string;
}

type ThreadRow = {
  id: number;
  company_id: number;
  kind: string;
  dm_key: string | null;
  name: string | null;
  last_message: string | null;
  last_message_at: Date | null;
};

type MsgRow = {
  id: number;
  thread_id: number;
  sender_user_id: number;
  message_type: string;
  content: string | null;
  media_url: string | null;
  media_mime: string | null;
  media_name: string | null;
  client_id: string | null;
  created_at: Date;
};

function mapMsg(m: MsgRow) {
  return {
    id: m.id,
    threadId: m.thread_id,
    senderId: m.sender_user_id,
    type: m.message_type,
    content: m.content,
    mediaUrl: m.media_url,
    mediaMime: m.media_mime,
    mediaName: m.media_name,
    clientId: m.client_id,
    createdAt: m.created_at,
  };
}

/**
 * Internal staff-to-staff messaging (DMs + one per-company broadcast channel).
 * Tenant-scoped on every query; delivery is over the existing socket (per-user
 * rooms) — NO Meta/WhatsApp. Media is saved to the same /storage tree.
 */
@Injectable()
export class InternalChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly gateway: InboxGateway,
  ) {}

  private isPrivileged(role: string): boolean {
    return role === 'owner' || role === 'admin';
  }

  // ── Roster (agent-accessible; excludes super_admin, suspended, self) ──
  async roster(companyId: number, meId: number) {
    const users = await this.prisma.user.findMany({
      where: {
        company_id: companyId,
        status: 'active',
        role: { not: 'super_admin' },
        id: { not: meId },
      },
      select: { id: true, name: true, role: true, last_seen_at: true },
      orderBy: { name: 'asc' },
    });
    const online = new Set(this.gateway.getOnlineUserIds(companyId));
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role,
      online: online.has(u.id),
      lastSeen: u.last_seen_at,
    }));
  }

  presence(companyId: number) {
    return { online: this.gateway.getOnlineUserIds(companyId) };
  }

  // ── Broadcast channel (one per company, lazy-created) ──
  private async ensureBroadcast(companyId: number): Promise<ThreadRow> {
    const existing = await this.prisma.internalThread.findFirst({
      where: { company_id: companyId, kind: 'broadcast' },
    });
    if (existing) return existing as ThreadRow;
    return (await this.prisma.internalThread.create({
      data: { company_id: companyId, kind: 'broadcast', name: 'Team broadcast' },
    })) as ThreadRow;
  }

  private async ensureBroadcastMembership(
    companyId: number,
    userId: number,
  ): Promise<ThreadRow> {
    const t = await this.ensureBroadcast(companyId);
    await this.prisma.internalThreadMember.upsert({
      where: { thread_id_user_id: { thread_id: t.id, user_id: userId } },
      create: { thread_id: t.id, company_id: companyId, user_id: userId },
      update: {},
    });
    return t;
  }

  /** Ensure every active user has a broadcast member row; returns their ids. */
  private async ensureAllBroadcastMembers(
    companyId: number,
    threadId: number,
  ): Promise<number[]> {
    const users = await this.prisma.user.findMany({
      where: { company_id: companyId, status: 'active', role: { not: 'super_admin' } },
      select: { id: true },
    });
    for (const u of users) {
      await this.prisma.internalThreadMember.upsert({
        where: { thread_id_user_id: { thread_id: threadId, user_id: u.id } },
        create: { thread_id: threadId, company_id: companyId, user_id: u.id },
        update: {},
      });
    }
    return users.map((u) => u.id);
  }

  // ── Thread access + membership ──
  private async requireThread(
    companyId: number,
    userId: number,
    threadId: number,
  ): Promise<ThreadRow> {
    const thread = (await this.prisma.internalThread.findFirst({
      where: { id: threadId, company_id: companyId },
    })) as ThreadRow | null;
    if (!thread) throw new NotFoundException('Conversation not found');
    if (thread.kind === 'broadcast') {
      await this.ensureBroadcastMembership(companyId, userId);
      return thread;
    }
    const member = await this.prisma.internalThreadMember.findFirst({
      where: { thread_id: threadId, user_id: userId },
      select: { id: true },
    });
    if (!member) throw new ForbiddenException('You are not part of this conversation');
    return thread;
  }

  // ── Threads list ──
  async listThreads(companyId: number, userId: number) {
    await this.ensureBroadcastMembership(companyId, userId);
    const memberships = await this.prisma.internalThreadMember.findMany({
      where: { company_id: companyId, user_id: userId },
      select: { thread_id: true, unread_count: true, thread: true },
    });
    const online = new Set(this.gateway.getOnlineUserIds(companyId));

    // Resolve the "other participant" for DM threads in one query.
    const dmThreadIds = memberships
      .filter((m) => (m.thread as ThreadRow).kind === 'dm')
      .map((m) => m.thread_id);
    const others = dmThreadIds.length
      ? await this.prisma.internalThreadMember.findMany({
          where: { thread_id: { in: dmThreadIds }, user_id: { not: userId } },
          select: { thread_id: true, user_id: true },
        })
      : [];
    const otherIdByThread = new Map(others.map((o) => [o.thread_id, o.user_id]));
    const userIds = [...new Set(others.map((o) => o.user_id))];
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds }, company_id: companyId },
          select: { id: true, name: true, role: true, last_seen_at: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    const items = memberships.map((m) => {
      const t = m.thread as ThreadRow;
      if (t.kind === 'broadcast') {
        return {
          id: t.id,
          kind: 'broadcast',
          title: t.name ?? 'Team broadcast',
          otherUserId: null as number | null,
          online: undefined as boolean | undefined,
          lastSeen: null as Date | null,
          lastMessage: t.last_message,
          lastMessageAt: t.last_message_at,
          unreadCount: m.unread_count,
        };
      }
      const otherId = otherIdByThread.get(t.id) ?? null;
      const u = otherId != null ? userById.get(otherId) : null;
      return {
        id: t.id,
        kind: 'dm',
        title: u?.name ?? 'Unknown',
        otherUserId: otherId,
        online: otherId != null ? online.has(otherId) : false,
        lastSeen: u?.last_seen_at ?? null,
        lastMessage: t.last_message,
        lastMessageAt: t.last_message_at,
        unreadCount: m.unread_count,
      };
    });

    // Broadcast pinned first, then by recent activity.
    items.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'broadcast' ? -1 : 1;
      const at = a.lastMessageAt?.getTime() ?? 0;
      const bt = b.lastMessageAt?.getTime() ?? 0;
      return bt - at;
    });
    return items;
  }

  // ── Open (find-or-create) a DM ──
  async openDm(companyId: number, meId: number, targetId: number) {
    if (!targetId || targetId === meId) {
      throw new BadRequestException('Pick a teammate to message');
    }
    const target = await this.prisma.user.findFirst({
      where: {
        id: targetId,
        company_id: companyId,
        status: 'active',
        role: { not: 'super_admin' },
      },
      select: { id: true, name: true, role: true, last_seen_at: true },
    });
    if (!target) throw new NotFoundException('User not found');
    const [a, b] = [meId, targetId].sort((x, y) => x - y);
    const dmKey = `${a}-${b}`;
    let thread = (await this.prisma.internalThread.findFirst({
      where: { company_id: companyId, dm_key: dmKey },
    })) as ThreadRow | null;
    if (!thread) {
      thread = (await this.prisma.internalThread.create({
        data: {
          company_id: companyId,
          kind: 'dm',
          dm_key: dmKey,
          members: {
            create: [
              { company_id: companyId, user_id: a },
              { company_id: companyId, user_id: b },
            ],
          },
        },
      })) as ThreadRow;
    }
    const online = new Set(this.gateway.getOnlineUserIds(companyId));
    return {
      id: thread.id,
      kind: 'dm',
      title: target.name,
      otherUserId: target.id,
      online: online.has(target.id),
      lastSeen: target.last_seen_at,
      lastMessage: thread.last_message,
      lastMessageAt: thread.last_message_at,
      unreadCount: 0,
    };
  }

  // ── Messages ──
  async getMessages(
    companyId: number,
    userId: number,
    threadId: number,
    cursor?: number,
  ) {
    await this.requireThread(companyId, userId, threadId);
    const take = 30;
    const rows = (await this.prisma.internalMessage.findMany({
      where: {
        thread_id: threadId,
        company_id: companyId,
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take,
    })) as MsgRow[];
    const nextCursor = rows.length === take ? rows[rows.length - 1].id : null;
    return { messages: rows.reverse().map(mapMsg), nextCursor };
  }

  async sendText(
    actor: Actor,
    threadId: number,
    text: string,
    clientId?: string,
  ) {
    const thread = await this.requireThread(actor.companyId, actor.userId, threadId);
    if (thread.kind === 'broadcast' && !this.isPrivileged(actor.role)) {
      throw new ForbiddenException('Only owners and admins can post to the broadcast channel');
    }
    const body = (text ?? '').trim();
    if (!body) throw new BadRequestException('Message is empty');
    const msg = (await this.prisma.internalMessage.create({
      data: {
        thread_id: threadId,
        company_id: actor.companyId,
        sender_user_id: actor.userId,
        message_type: 'text',
        content: body.slice(0, 8000),
        client_id: clientId ?? null,
      },
    })) as MsgRow;
    await this.afterSend(actor.companyId, thread, msg, actor, body);
    return mapMsg(msg);
  }

  async sendMedia(
    actor: Actor,
    threadId: number,
    file: { buffer: Buffer; mimetype: string; originalname?: string } | undefined,
    kind: string | undefined,
    clientId?: string,
  ) {
    const thread = await this.requireThread(actor.companyId, actor.userId, threadId);
    if (thread.kind === 'broadcast' && !this.isPrivileged(actor.role)) {
      throw new ForbiddenException('Only owners and admins can post to the broadcast channel');
    }
    if (!file || !file.buffer?.length) throw new BadRequestException('No file uploaded');
    const mime = file.mimetype || 'application/octet-stream';
    const messageType =
      kind === 'audio' || mime.startsWith('audio/')
        ? 'audio'
        : mime.startsWith('image/')
          ? 'image'
          : 'file';
    const now = new Date();
    const { filename } = this.media.saveBuffer(file.buffer, mime, actor.companyId);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const webPath = `/storage/media/${actor.companyId}/${now.getFullYear()}/${mm}/${filename}`;
    const msg = (await this.prisma.internalMessage.create({
      data: {
        thread_id: threadId,
        company_id: actor.companyId,
        sender_user_id: actor.userId,
        message_type: messageType,
        media_url: webPath,
        media_mime: mime,
        media_name: file.originalname ?? null,
        client_id: clientId ?? null,
      },
    })) as MsgRow;
    const preview =
      messageType === 'audio'
        ? '🎤 Voice message'
        : messageType === 'image'
          ? '📷 Photo'
          : `📎 ${file.originalname ?? 'File'}`;
    await this.afterSend(actor.companyId, thread, msg, actor, preview);
    return mapMsg(msg);
  }

  async markRead(companyId: number, userId: number, threadId: number) {
    await this.requireThread(companyId, userId, threadId);
    await this.prisma.internalThreadMember.updateMany({
      where: { thread_id: threadId, user_id: userId },
      data: { unread_count: 0, last_read_at: new Date() },
    });
    // Sync the caller's other tabs so the badge clears everywhere.
    this.gateway.emitToUsers([userId], 'dm.read', { threadId });
    return { ok: true };
  }

  async unreadTotal(companyId: number, userId: number) {
    const agg = await this.prisma.internalThreadMember.aggregate({
      where: { company_id: companyId, user_id: userId },
      _sum: { unread_count: true },
    });
    return { unread: agg._sum.unread_count ?? 0 };
  }

  // ── Shared post-send side effects ──
  private async memberUserIds(
    companyId: number,
    thread: ThreadRow,
  ): Promise<number[]> {
    if (thread.kind === 'broadcast') {
      return this.ensureAllBroadcastMembers(companyId, thread.id);
    }
    const members = await this.prisma.internalThreadMember.findMany({
      where: { thread_id: thread.id },
      select: { user_id: true },
    });
    return members.map((m) => m.user_id);
  }

  private async afterSend(
    companyId: number,
    thread: ThreadRow,
    msg: MsgRow,
    actor: Actor,
    preview: string,
  ) {
    const senderId = actor.userId;
    await this.prisma.internalThread.update({
      where: { id: thread.id },
      data: { last_message: preview.slice(0, 280), last_message_at: msg.created_at },
    });
    // Ensure broadcast has member rows for everyone before bumping unread.
    const recipientIds = await this.memberUserIds(companyId, thread);
    await this.prisma.internalThreadMember.updateMany({
      where: { thread_id: thread.id, user_id: { not: senderId } },
      data: { unread_count: { increment: 1 } },
    });
    // Sender name for the recipient-side in-app drawer (agents see who pinged
    // them without opening the thread). One tiny lookup — team-chat volume is low.
    const sender = await this.prisma.user.findUnique({
      where: { id: senderId },
      select: { name: true },
    });
    this.gateway.emitToUsers(recipientIds, 'dm.message', {
      threadId: thread.id,
      threadKind: thread.kind,
      senderName: sender?.name ?? null,
      senderRole: actor.role,
      message: mapMsg(msg),
    });
  }
}
