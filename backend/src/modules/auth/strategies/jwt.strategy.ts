import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../prisma/prisma.service';

export interface JwtPayload {
  sub: number;
  companyId: number | null;
  role: string;
  email: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const secret = config.get<string>('JWT_SECRET');
    if (!secret) {
      console.error(
        '[JwtStrategy] JWT_SECRET not set — using insecure placeholder. Set JWT_SECRET in env vars.',
      );
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret ?? 'INSECURE_PLACEHOLDER_JWT_SECRET',
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, status: true, role: true, company_id: true, email: true },
    });

    if (!user || user.status !== 'active') {
      throw new UnauthorizedException();
    }

    return {
      userId: user.id,
      companyId: user.company_id,
      role: user.role,
      email: user.email,
    };
  }
}
