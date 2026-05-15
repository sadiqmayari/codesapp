import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Socket } from 'socket.io';

interface JwtPayload {
  sub: number;
  companyId: number | null;
  role: string;
  email: string;
}

@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient<Socket>();
    return this.authenticate(client);
  }

  authenticate(client: Socket): boolean {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      (client.handshake.headers?.authorization as string | undefined)?.replace(
        /^Bearer\s+/i,
        '',
      );

    if (!token) {
      this.logger.warn(`Socket ${client.id} rejected — no auth token`);
      client.disconnect(true);
      return false;
    }

    try {
      const secret =
        this.config.get<string>('JWT_SECRET') ??
        'INSECURE_PLACEHOLDER_JWT_SECRET';
      const payload = this.jwtService.verify<JwtPayload>(token, { secret });

      if (!payload.companyId) {
        client.disconnect(true);
        return false;
      }

      client.data.userId = payload.sub;
      client.data.companyId = payload.companyId;
      client.data.role = payload.role;
      return true;
    } catch (err) {
      this.logger.warn(
        `Socket ${client.id} rejected — invalid token: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      client.disconnect(true);
      return false;
    }
  }
}
