import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class CronGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  private static safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    // Header first; fall back to ?secret= (UptimeRobot free tier custom-header
    // support is flaky).
    const provided: string =
      (req.headers['x-cron-secret'] as string) ||
      (req.query?.secret as string) ||
      '';
    const expected = this.config.get<string>('CRON_SECRET') ?? '';

    if (!provided || !expected || !CronGuard.safeEqual(provided, expected)) {
      throw new ForbiddenException('Invalid cron secret');
    }
    return true;
  }
}
