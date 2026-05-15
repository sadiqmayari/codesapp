"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var InboxGateway_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.InboxGateway = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const websockets_1 = require("@nestjs/websockets");
const socket_io_1 = require("socket.io");
const ws_jwt_guard_1 = require("./ws-jwt.guard");
const prisma_service_1 = require("../../prisma/prisma.service");
let InboxGateway = InboxGateway_1 = class InboxGateway {
    constructor(wsJwtGuard, prisma, config) {
        this.wsJwtGuard = wsJwtGuard;
        this.prisma = prisma;
        this.config = config;
        this.logger = new common_1.Logger(InboxGateway_1.name);
    }
    handleConnection(client) {
        const authed = this.wsJwtGuard.authenticate(client);
        if (!authed)
            return;
        const companyId = client.data.companyId;
        const userId = client.data.userId;
        client.join(this.companyRoom(companyId));
        this.logger.log(`Socket ${client.id} connected (companyId=${companyId} userId=${userId})`);
        this.server.to(this.companyRoom(companyId)).emit('agent.online', { userId });
    }
    handleDisconnect(client) {
        const companyId = client.data.companyId;
        const userId = client.data.userId;
        if (companyId && userId) {
            this.server.to(this.companyRoom(companyId)).emit('agent.offline', { userId });
            this.logger.log(`Socket ${client.id} disconnected (userId=${userId})`);
        }
    }
    onTypingStart(client, body) {
        this.server.to(this.companyRoom(client.data.companyId)).emit('typing.start', {
            conversationId: body.conversationId,
            userId: client.data.userId,
        });
    }
    onTypingStop(client, body) {
        this.server.to(this.companyRoom(client.data.companyId)).emit('typing.stop', {
            conversationId: body.conversationId,
            userId: client.data.userId,
        });
    }
    onAgentViewing(client, body) {
        this.server.to(this.companyRoom(client.data.companyId)).emit('agent.viewing', {
            conversationId: body.conversationId,
            userId: client.data.userId,
        });
    }
    onAgentLeft(client, body) {
        this.server.to(this.companyRoom(client.data.companyId)).emit('agent.left', {
            conversationId: body.conversationId,
            userId: client.data.userId,
        });
    }
    async onMarkRead(client, body) {
        const companyId = client.data.companyId;
        const userId = client.data.userId;
        const convo = await this.prisma.conversation.findFirst({
            where: { id: body.conversationId, company_id: companyId },
            select: { id: true },
        });
        if (!convo)
            return;
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
    emitToCompany(companyId, event, payload) {
        this.server?.to(this.companyRoom(companyId)).emit(event, payload);
    }
    companyRoom(companyId) {
        return `company:${companyId}`;
    }
};
exports.InboxGateway = InboxGateway;
__decorate([
    (0, websockets_1.WebSocketServer)(),
    __metadata("design:type", socket_io_1.Server)
], InboxGateway.prototype, "server", void 0);
__decorate([
    (0, common_1.UseGuards)(ws_jwt_guard_1.WsJwtGuard),
    (0, websockets_1.SubscribeMessage)('typing.start'),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [socket_io_1.Socket, Object]),
    __metadata("design:returntype", void 0)
], InboxGateway.prototype, "onTypingStart", null);
__decorate([
    (0, common_1.UseGuards)(ws_jwt_guard_1.WsJwtGuard),
    (0, websockets_1.SubscribeMessage)('typing.stop'),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [socket_io_1.Socket, Object]),
    __metadata("design:returntype", void 0)
], InboxGateway.prototype, "onTypingStop", null);
__decorate([
    (0, common_1.UseGuards)(ws_jwt_guard_1.WsJwtGuard),
    (0, websockets_1.SubscribeMessage)('agent.viewing'),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [socket_io_1.Socket, Object]),
    __metadata("design:returntype", void 0)
], InboxGateway.prototype, "onAgentViewing", null);
__decorate([
    (0, common_1.UseGuards)(ws_jwt_guard_1.WsJwtGuard),
    (0, websockets_1.SubscribeMessage)('agent.left'),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [socket_io_1.Socket, Object]),
    __metadata("design:returntype", void 0)
], InboxGateway.prototype, "onAgentLeft", null);
__decorate([
    (0, common_1.UseGuards)(ws_jwt_guard_1.WsJwtGuard),
    (0, websockets_1.SubscribeMessage)('mark.read'),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [socket_io_1.Socket, Object]),
    __metadata("design:returntype", Promise)
], InboxGateway.prototype, "onMarkRead", null);
exports.InboxGateway = InboxGateway = InboxGateway_1 = __decorate([
    (0, websockets_1.WebSocketGateway)({
        cors: {
            origin: process.env.APP_URL,
            credentials: true,
        },
    }),
    __metadata("design:paramtypes", [ws_jwt_guard_1.WsJwtGuard,
        prisma_service_1.PrismaService,
        config_1.ConfigService])
], InboxGateway);
//# sourceMappingURL=inbox.gateway.js.map