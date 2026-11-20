import { Logger, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { WsJwtGuard } from './ws-jwt.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { isPrivileged as isPrivilegedRole } from '../../common/auth/roles';

@WebSocketGateway({
  cors: {
    origin: process.env.APP_URL,
    credentials: true,
  },
})
export class InboxGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(InboxGateway.name);

  // Per-process presence registry: companyId -> (userId -> open connection count).
  // getOnlineUserIds() unions it with fetchSockets() across nodes (Redis adapter).
  private readonly online = new Map<number, Map<number, number>>();

  // Per-company debounce timers for the coalesced `orders.changed` ping.
  private readonly ordersChangedTimers = new Map<
    number,
    ReturnType<typeof setTimeout>
  >();

  // Process-lifetime userId -> display name cache for presence labels
  // (e.g. the "<name> is also viewing this conversation" collision banner).
  // Names change rarely; a redeploy clears this.
  private readonly userNameCache = new Map<number, string>();

  /** Resolve a user's display name, cached per process. Falls back to null. */
  private async resolveUserName(userId: number): Promise<string | null> {
    const cached = this.userNameCache.get(userId);
    if (cached !== undefined) return cached;
    try {
      const u = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });
      const name = u?.name?.trim() || null;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch {
      return null;
    }
  }

  constructor(
    private readonly wsJwtGuard: WsJwtGuard,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  handleConnection(client: Socket): void {
    // Run guard manually on connect because @UseGuards on @SubscribeMessage
    // runs per-event; we want to reject unauthenticated sockets at handshake.
    const authed = this.wsJwtGuard.authenticate(client);
    if (!authed) return;

    const companyId: number = client.data.companyId;
    const userId: number = client.data.userId;
    const role: string = client.data.role;

    void client.join(this.companyRoom(companyId));
    // Per-user + privileged rooms drive the pool-model RBAC for realtime:
    // message-content events go only to the assigned agent + owners/admins
    // (see emitToConversationScoped), so an agent never receives the content
    // of another agent's chat over the socket.
    void client.join(this.userRoom(userId));
    if (role === 'owner' || role === 'admin') {
      void client.join(this.privilegedRoom(companyId));
    }
    // Team-admin room (owner/admin/hr_manager): attendance + leave events.
    if (role === 'owner' || role === 'admin' || role === 'hr_manager') {
      void client.join(this.hrRoom(companyId));
    }
    this.logger.log(
      `Socket ${client.id} connected (companyId=${companyId} userId=${userId} role=${role})`,
    );
    this.server.to(this.companyRoom(companyId)).emit('agent.online', { userId });
    if (this.trackConnect(companyId, userId)) {
      this.emitToCompany(companyId, 'presence.update', { userId, online: true });
    }
  }

  handleDisconnect(client: Socket): void {
    const companyId: number | undefined = client.data.companyId;
    const userId: number | undefined = client.data.userId;
    if (companyId && userId) {
      this.server.to(this.companyRoom(companyId)).emit('agent.offline', { userId });
      this.logger.log(`Socket ${client.id} disconnected (userId=${userId})`);
      if (this.trackDisconnect(companyId, userId)) {
        // Last socket on THIS node — only offline if no other node has one.
        void this.stillOnline(userId).then((still) => {
          if (still) return;
          this.emitToCompany(companyId, 'presence.update', { userId, online: false });
          // Record last-seen only when the user's LAST socket closes.
          this.prisma.user
            .update({ where: { id: userId }, data: { last_seen_at: new Date() } })
            .catch(() => undefined);
        });
      }
    }
  }

  /** Increment the connection count; returns true when the user just came online (0→1). */
  private trackConnect(companyId: number, userId: number): boolean {
    let byUser = this.online.get(companyId);
    if (!byUser) {
      byUser = new Map();
      this.online.set(companyId, byUser);
    }
    const next = (byUser.get(userId) ?? 0) + 1;
    byUser.set(userId, next);
    return next === 1;
  }

  /** Decrement; returns true when the user's last socket closed (now offline). */
  private trackDisconnect(companyId: number, userId: number): boolean {
    const byUser = this.online.get(companyId);
    if (!byUser) return false;
    const next = (byUser.get(userId) ?? 0) - 1;
    if (next <= 0) {
      byUser.delete(userId);
      if (byUser.size === 0) this.online.delete(companyId);
      return true;
    }
    byUser.set(userId, next);
    return false;
  }

  /** Currently-online user ids for a company (Team-chat roster). Asks every
   *  node through the Redis adapter (fetchSockets), so it stays right with more
   *  than one web container; falls back to this process's own registry. */
  async getOnlineUserIds(companyId: number): Promise<number[]> {
    const local = Array.from(this.online.get(companyId)?.keys() ?? []);
    if (!this.server) return local;
    try {
      const sockets = await Promise.race([
        this.server.in(this.companyRoom(companyId)).fetchSockets(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
      ]);
      const ids = new Set<number>(local);
      for (const so of sockets) {
        const uid = Number((so.data as { userId?: number })?.userId);
        if (uid) ids.add(uid);
      }
      return Array.from(ids);
    } catch {
      return local;
    }
  }

  /** True when the user still has a socket on ANY node. */
  private async stillOnline(userId: number): Promise<boolean> {
    try {
      const sockets = await Promise.race([
        this.server.in(this.userRoom(userId)).fetchSockets(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
      ]);
      return sockets.length > 0;
    } catch {
      return false;
    }
  }

  /** Emit an event to a set of specific users' rooms (Team-chat DM/broadcast delivery). */
  emitToUsers(userIds: number[], event: string, payload: unknown): void {
    if (!this.server) return;
    for (const id of new Set(userIds)) {
      this.server.to(this.userRoom(id)).emit(event, payload);
    }
  }

  /** Emit to the company's team admins (owner/admin/hr_manager). */
  emitToHrAdmins(companyId: number, event: string, payload: unknown): void {
    if (!this.server) return;
    this.server.to(this.hrRoom(companyId)).emit(event, payload);
  }

  /**
   * Force-disconnect every socket of a user (all nodes, via the Redis adapter).
   * Called on suspend / delete / role change / password change so a revoked
   * session stops receiving realtime events at once. Never throws.
   */
  async disconnectUser(userId: number): Promise<void> {
    try {
      if (!this.server) return;
      this.server.in(this.userRoom(userId)).disconnectSockets(true);
    } catch (e) {
      this.logger.warn(`disconnectUser(${userId}) failed: ${(e as Error).message}`);
    }
  }

  /** Emit to the company's owners/admins only (the privileged room). */
  emitToPrivileged(companyId: number, event: string, payload: unknown): void {
    if (!this.server) return;
    this.server.to(this.privilegedRoom(companyId)).emit(event, payload);
  }

  /** Team-chat typing indicator — routed to the one recipient's room (DM). */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('dm.typing')
  async onDmTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { threadId: number; toUserId: number },
  ): Promise<void> {
    const to = Number(body?.toUserId);
    const threadId = Number(body?.threadId);
    if (!to || !threadId) return;
    // Only forward to a member of the same thread (it used to forward to any
    // user id, including other tenants'). Membership is memoised per process.
    const key = `${threadId}:${client.data.userId}:${to}`;
    let ok = this.typingMemo.get(key);
    if (ok === undefined) {
      const rows = await this.prisma.internalThreadMember
        .findMany({
          where: { thread_id: threadId, company_id: client.data.companyId, user_id: { in: [client.data.userId, to] } },
          select: { user_id: true },
        })
        .catch(() => []);
      ok = rows.length === 2;
      if (this.typingMemo.size > 5000) this.typingMemo.clear();
      this.typingMemo.set(key, ok);
    }
    if (!ok) return;
    this.server.to(this.userRoom(to)).emit('dm.typing', {
      threadId,
      userId: client.data.userId,
    });
  }
  private typingMemo = new Map<string, boolean>();

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('typing.start')
  async onTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: number },
  ): Promise<void> {
    const userId: number = client.data.userId;
    const userName = await this.resolveUserName(userId);
    this.server.to(this.companyRoom(client.data.companyId)).emit('typing.start', {
      conversationId: body.conversationId,
      userId,
      userName,
    });
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('typing.stop')
  onTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: number },
  ): void {
    this.server.to(this.companyRoom(client.data.companyId)).emit('typing.stop', {
      conversationId: body.conversationId,
      userId: client.data.userId,
    });
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('agent.viewing')
  async onAgentViewing(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: number },
  ): Promise<void> {
    const userId: number = client.data.userId;
    const userName = await this.resolveUserName(userId);
    this.server.to(this.companyRoom(client.data.companyId)).emit('agent.viewing', {
      conversationId: body.conversationId,
      userId,
      userName,
    });
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('agent.left')
  onAgentLeft(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: number },
  ): void {
    this.server.to(this.companyRoom(client.data.companyId)).emit('agent.left', {
      conversationId: body.conversationId,
      userId: client.data.userId,
    });
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('mark.read')
  async onMarkRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: number },
  ): Promise<void> {
    const companyId: number = client.data.companyId;
    const userId: number = client.data.userId;
    const role: string = client.data.role;

    // Verify the conversation belongs to the company AND the caller may see it
    // (pool model: agents only for their own / unassigned chats).
    const convo = await this.prisma.conversation.findFirst({
      where: { id: body.conversationId, company_id: companyId },
      select: { id: true, assigned_user_id: true },
    });
    if (!convo) return;
    const privileged = isPrivilegedRole(role);
    if (
      !privileged &&
      convo.assigned_user_id !== null &&
      convo.assigned_user_id !== userId
    ) {
      return;
    }

    const now = new Date();
    await this.prisma.message.updateMany({
      where: {
        conversation_id: body.conversationId,
        company_id: companyId,
        direction: 'inbound',
        read_at: null,
      },
      data: { read_at: now, read_by_user_id: userId },
    });

    await this.prisma.conversation.update({
      where: { id: body.conversationId },
      data: { unread_count: 0 },
    });

    this.server.to(this.companyRoom(companyId)).emit('message.read.bulk', {
      conversationId: body.conversationId,
      readBy: userId,
      readAt: now.toISOString(),
    });
  }

  /**
   * Public helper for other services (worker, controllers, bot engine) to
   * broadcast events to all agents in a company room. Use for company-wide or
   * id-only events (presence, `conversation.updated` which only carries an id
   * and triggers a RBAC-scoped REST refetch). For events that carry message
   * CONTENT, use emitToConversationScoped so it doesn't leak across agents.
   */
  emitToCompany(companyId: number, event: string, payload: unknown): void {
    this.server?.to(this.companyRoom(companyId)).emit(event, payload);
  }

  /**
   * Coalesced "the fulfillment board changed" ping for the Orders screen. A
   * burst of order/shipment webhooks (a Shopify import, a courier status sweep)
   * would otherwise fire dozens of events; debounce per company so each open
   * Orders screen re-pulls its lane counts + KPI strip at most ~once per window.
   * Carries no data on purpose — the client refetches the authoritative figures.
   */
  emitOrdersChanged(companyId: number): void {
    if (!this.server) return;
    const existing = this.ordersChangedTimers.get(companyId);
    if (existing) clearTimeout(existing);
    this.ordersChangedTimers.set(
      companyId,
      setTimeout(() => {
        this.ordersChangedTimers.delete(companyId);
        this.server?.to(this.companyRoom(companyId)).emit('orders.changed', {});
      }, 1500),
    );
  }

  /**
   * Pool-model delivery for content-bearing events (message.received /
   * message.sent). An UNASSIGNED chat is in the shared pool → every agent may
   * see it, so emit company-wide. An ASSIGNED chat goes ONLY to the assigned
   * agent + owners/admins (privileged room) — other agents never receive it.
   */
  emitToConversationScoped(
    companyId: number,
    assignedUserId: number | null | undefined,
    event: string,
    payload: unknown,
  ): void {
    if (!this.server) return;
    if (assignedUserId == null) {
      this.server.to(this.companyRoom(companyId)).emit(event, payload);
      return;
    }
    this.server.to(this.privilegedRoom(companyId)).emit(event, payload);
    this.server.to(this.userRoom(assignedUserId)).emit(event, payload);
  }

  private companyRoom(companyId: number): string {
    return `company:${companyId}`;
  }

  private hrRoom(companyId: number): string {
    return `company:${companyId}:hr`;
  }

  private privilegedRoom(companyId: number): string {
    return `company:${companyId}:priv`;
  }

  private userRoom(userId: number): string {
    return `user:${userId}`;
  }
}
