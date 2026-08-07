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
  // Used for the Team-chat online dots. NOTE: per-process — accurate on the
  // single prod app container; a multi-container scale-out would need a
  // Redis-backed online-set (message rooms already fan out via the Redis adapter).
  private readonly online = new Map<number, Map<number, number>>();

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

    client.join(this.companyRoom(companyId));
    // Per-user + privileged rooms drive the pool-model RBAC for realtime:
    // message-content events go only to the assigned agent + owners/admins
    // (see emitToConversationScoped), so an agent never receives the content
    // of another agent's chat over the socket.
    client.join(this.userRoom(userId));
    if (role === 'owner' || role === 'admin') {
      client.join(this.privilegedRoom(companyId));
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
        this.emitToCompany(companyId, 'presence.update', { userId, online: false });
        // Record last-seen only when the user's LAST socket closes.
        this.prisma.user
          .update({ where: { id: userId }, data: { last_seen_at: new Date() } })
          .catch(() => undefined);
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

  /** Snapshot of currently-online user ids for a company (Team-chat roster). */
  getOnlineUserIds(companyId: number): number[] {
    return Array.from(this.online.get(companyId)?.keys() ?? []);
  }

  /** Emit an event to a set of specific users' rooms (Team-chat DM/broadcast delivery). */
  emitToUsers(userIds: number[], event: string, payload: unknown): void {
    if (!this.server) return;
    for (const id of new Set(userIds)) {
      this.server.to(this.userRoom(id)).emit(event, payload);
    }
  }

  /** Team-chat typing indicator — routed to the one recipient's room (DM). */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('dm.typing')
  onDmTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { threadId: number; toUserId: number },
  ): void {
    if (!body?.toUserId) return;
    this.server.to(this.userRoom(body.toUserId)).emit('dm.typing', {
      threadId: body.threadId,
      userId: client.data.userId,
    });
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('typing.start')
  onTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: number },
  ): void {
    this.server.to(this.companyRoom(client.data.companyId)).emit('typing.start', {
      conversationId: body.conversationId,
      userId: client.data.userId,
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
  onAgentViewing(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: number },
  ): void {
    this.server.to(this.companyRoom(client.data.companyId)).emit('agent.viewing', {
      conversationId: body.conversationId,
      userId: client.data.userId,
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
    const privileged = role === 'owner' || role === 'admin';
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

  private privilegedRoom(companyId: number): string {
    return `company:${companyId}:priv`;
  }

  private userRoom(userId: number): string {
    return `user:${userId}`;
  }
}
