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

    client.join(this.companyRoom(companyId));
    this.logger.log(
      `Socket ${client.id} connected (companyId=${companyId} userId=${userId})`,
    );
    this.server.to(this.companyRoom(companyId)).emit('agent.online', { userId });
  }

  handleDisconnect(client: Socket): void {
    const companyId: number | undefined = client.data.companyId;
    const userId: number | undefined = client.data.userId;
    if (companyId && userId) {
      this.server.to(this.companyRoom(companyId)).emit('agent.offline', { userId });
      this.logger.log(`Socket ${client.id} disconnected (userId=${userId})`);
    }
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

    // Verify conversation belongs to company
    const convo = await this.prisma.conversation.findFirst({
      where: { id: body.conversationId, company_id: companyId },
      select: { id: true },
    });
    if (!convo) return;

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
   * broadcast events to all agents in a company room.
   */
  emitToCompany(companyId: number, event: string, payload: unknown): void {
    this.server?.to(this.companyRoom(companyId)).emit(event, payload);
  }

  private companyRoom(companyId: number): string {
    return `company:${companyId}`;
  }
}
