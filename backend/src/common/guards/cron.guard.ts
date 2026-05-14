import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CronGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const secret = req.headers['x-cron-secret'];
    const expected = this.config.get<string>('CRON_SECRET');

    if (!secret || secret !== expected) {
      throw new UnauthorizedException('Invalid cron secret');
    }

    return true;
  }
}
