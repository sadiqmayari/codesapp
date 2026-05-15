import { ConfigService } from '@nestjs/config';
import { OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { WsJwtGuard } from './ws-jwt.guard';
import { PrismaService } from '../../prisma/prisma.service';
export declare class InboxGateway implements OnGatewayConnection, OnGatewayDisconnect {
    private readonly wsJwtGuard;
    private readonly prisma;
    private readonly config;
    server: Server;
    private readonly logger;
    constructor(wsJwtGuard: WsJwtGuard, prisma: PrismaService, config: ConfigService);
    handleConnection(client: Socket): void;
    handleDisconnect(client: Socket): void;
    onTypingStart(client: Socket, body: {
        conversationId: number;
    }): void;
    onTypingStop(client: Socket, body: {
        conversationId: number;
    }): void;
    onAgentViewing(client: Socket, body: {
        conversationId: number;
    }): void;
    onAgentLeft(client: Socket, body: {
        conversationId: number;
    }): void;
    onMarkRead(client: Socket, body: {
        conversationId: number;
    }): Promise<void>;
    emitToCompany(companyId: number, event: string, payload: unknown): void;
    private companyRoom;
}
