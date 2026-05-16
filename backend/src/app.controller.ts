import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
   * TEMP diagnostic — BOOLEANS/lengths only, no secret values. Detects the
   * common "copied password has quotes/whitespace" case and confirms the
   * env↔DB hash sync. REMOVE once super-admin login is confirmed working.
   */
  @Get('_debug/superadmin')
  async superAdminStatus() {
    const email = this.config.get<string>('SUPER_ADMIN_EMAIL') ?? '';
    const password = this.config.get<string>('SUPER_ADMIN_PASSWORD') ?? '';

    const pwTrimmed = password.trim();
    const surroundingWhitespace = password !== pwTrimmed;
    const quoted =
      (password.startsWith('"') && password.endsWith('"')) ||
      (password.startsWith("'") && password.endsWith("'"));

    let dbReachable = true;
    let rowExistsForEnvEmail = false;
    let role: string | null = null;
    let status: string | null = null;
    let passwordMatchesEnv = false;
    let passwordMatchesTrimmed = false;
    let superAdminRowCount = 0;
    let error: string | null = null;

    try {
      superAdminRowCount = await this.prisma.user.count({
        where: { role: 'super_admin' },
      });
      if (email) {
        const row = await this.prisma.user.findUnique({ where: { email } });
        if (row) {
          rowExistsForEnvEmail = true;
          role = row.role;
          status = row.status;
          if (password) {
            passwordMatchesEnv = await bcrypt.compare(
              password,
              row.password_hash,
            );
            passwordMatchesTrimmed = await bcrypt.compare(
              pwTrimmed,
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
      envEmailSet: email.length > 0,
      envEmailLength: email.length,
      emailHasSurroundingWhitespace: email !== email.trim(),
      envPasswordLength: password.length,
      envPasswordTrimmedLength: pwTrimmed.length,
      passwordHasSurroundingWhitespace: surroundingWhitespace,
      passwordLooksQuoted: quoted,
      dbReachable,
      superAdminRowCount,
      rowExistsForEnvEmail,
      role,
      status,
      passwordMatchesEnv,
      passwordMatchesTrimmed,
      error,
    };
  }
}
