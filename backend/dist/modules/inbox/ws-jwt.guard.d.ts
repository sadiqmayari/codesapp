import { CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Socket } from 'socket.io';
export declare class WsJwtGuard implements CanActivate {
    private readonly jwtService;
    private readonly config;
    private readonly logger;
    constructor(jwtService: JwtService, config: ConfigService);
    canActivate(context: ExecutionContext): boolean;
    authenticate(client: Socket): boolean;
}
