import { Controller, Get, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from './prisma/prisma.service';

@Controller()
export class AppController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * Unauthenticated diagnostic: client IP the server resolves (after
   * `trust proxy`). Used to set SUPER_ADMIN_IP_WHITELIST exactly.
   */
  @Get('_debug/ip')
  clientIp(@Req() req: Request) {
    return {
      ip: req.ip,
      ips: req.ips,
      xForwardedFor: req.headers['x-forwarded-for'] ?? null,
      remoteAddress: req.socket?.remoteAddress ?? null,
    };
  }

  /**
   * Unauthenticated diagnostic — BOOLEANS ONLY, no secrets. Confirms
   * whether the super-admin bootstrap synced the row to the current env
   * credentials. Remove after the login issue is resolved.
   */
  @Get('_debug/superadmin')
  async superAdminStatus() {
    const email = this.config.get<string>('SUPER_ADMIN_EMAIL') ?? '';
    const password = this.config.get<string>('SUPER_ADMIN_PASSWORD') ?? '';
    const envEmailSet = email.length > 0;
    const envPasswordSet = password.length > 0;

    let rowExistsForEnvEmail = false;
    let role: string | null = null;
    let status: string | null = null;
    let passwordMatchesEnv = false;
    let superAdminRowCount = 0;
    let dbReachable = true;
    let error: string | null = null;

    try {
      superAdminRowCount = await this.prisma.user.count({
        where: { role: 'super_admin' },
      });
      if (envEmailSet) {
        const row = await this.prisma.user.findUnique({
          where: { email },
        });
        if (row) {
          rowExistsForEnvEmail = true;
          role = row.role;
          status = row.status;
          if (envPasswordSet) {
            passwordMatchesEnv = await bcrypt.compare(
              password,
              row.password_hash,
            );
          }
        }
      }
    } catch (e) {
      dbReachable = false;
      error = e instanceof Error ? e.message : String(e);
    }

    return {
      envEmailSet,
      envPasswordSet,
      envEmailLength: email.length,
      envPasswordLength: password.length,
      dbReachable,
      superAdminRowCount,
      rowExistsForEnvEmail,
      role,
      status,
      passwordMatchesEnv,
      error,
    };
  }
}
