import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * Guards the Asterisk -> app call-event webhook (POST /api/calls/events).
 * The Asterisk dialplan sends header `X-Calls-Secret` == env CALLS_WEBHOOK_SECRET.
 * Mirrors CronGuard (shared-secret, no JWT).
 */
@Injectable()
export class CallsSecretGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  private static safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const provided: string = (req.headers['x-calls-secret'] as string) || '';
    const expected = this.config.get<string>('CALLS_WEBHOOK_SECRET') ?? '';
    if (!provided || !expected || !CallsSecretGuard.safeEqual(provided, expected)) {
      throw new ForbiddenException('Invalid calls secret');
    }
    return true;
  }
}
