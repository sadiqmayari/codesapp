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
var WsJwtGuard_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.WsJwtGuard = void 0;
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const config_1 = require("@nestjs/config");
let WsJwtGuard = WsJwtGuard_1 = class WsJwtGuard {
    constructor(jwtService, config) {
        this.jwtService = jwtService;
        this.config = config;
        this.logger = new common_1.Logger(WsJwtGuard_1.name);
    }
    canActivate(context) {
        const client = context.switchToWs().getClient();
        return this.authenticate(client);
    }
    authenticate(client) {
        const token = client.handshake.auth?.token ??
            client.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
        if (!token) {
            this.logger.warn(`Socket ${client.id} rejected — no auth token`);
            client.disconnect(true);
            return false;
        }
        try {
            const secret = this.config.get('JWT_SECRET') ??
                'INSECURE_PLACEHOLDER_JWT_SECRET';
            const payload = this.jwtService.verify(token, { secret });
            if (!payload.companyId) {
                client.disconnect(true);
                return false;
            }
            client.data.userId = payload.sub;
            client.data.companyId = payload.companyId;
            client.data.role = payload.role;
            return true;
        }
        catch (err) {
            this.logger.warn(`Socket ${client.id} rejected — invalid token: ${err instanceof Error ? err.message : String(err)}`);
            client.disconnect(true);
            return false;
        }
    }
};
exports.WsJwtGuard = WsJwtGuard;
exports.WsJwtGuard = WsJwtGuard = WsJwtGuard_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [jwt_1.JwtService,
        config_1.ConfigService])
], WsJwtGuard);
//# sourceMappingURL=ws-jwt.guard.js.map