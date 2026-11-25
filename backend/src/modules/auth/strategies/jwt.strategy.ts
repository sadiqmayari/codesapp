import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../prisma/prisma.service';
import { WorkHoursLockService } from '../../../common/services/work-hours-lock.service';

export interface JwtPayload {
  sub: number;
  companyId: number | null;
  role: string;
  email: string;
  /** users.token_version at issue (absent on legacy tokens = 0). */
  tv?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly workLock: WorkHoursLockService,
  ) {
    const secret = config.get<string>('JWT_SECRET');
    if (!secret) {
      // Never run with a guessable signing key — fail the boot instead.
      throw new Error('[JwtStrategy] JWT_SECRET is not set. Refusing to start.');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, status: true, role: true, company_id: true, email: true, token_version: true },
    });

    if (!user || user.status !== 'active') {
      throw new UnauthorizedException();
    }
    // Super-admin tokens are a separate login (no company) — skip the check.
    if (payload.role !== 'super_admin' && (payload.tv ?? 0) !== user.token_version) {
      throw new UnauthorizedException('Session expired');
    }
    // "Lock app after shift end" (403 WORK_HOURS_LOCKED; exempt roles skip).
    await this.workLock.assertMayUseApp(user);

    return {
      userId: user.id,
      companyId: user.company_id,
      role: user.role,
      email: user.email,
    };
  }
}
