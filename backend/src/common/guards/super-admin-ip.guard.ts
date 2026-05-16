import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class SuperAdminIpGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const nodeEnv = this.config.get<string>('NODE_ENV');
    if (nodeEnv === 'development') return true;

    const req = context.switchToHttp().getRequest();
    const ip: string =
      req.ip ?? req.connection?.remoteAddress ?? '';

    const whitelist = (
      this.config.get<string>('SUPER_ADMIN_IP_WHITELIST') ?? ''
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (!whitelist.includes(ip)) {
      throw new ForbiddenException(
        `Access denied: IP not whitelisted. Detected IP: "${ip}". ` +
          `Add this exact value to SUPER_ADMIN_IP_WHITELIST and restart.`,
      );
    }

    return true;
  }
}
