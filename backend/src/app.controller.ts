import { Controller, Get, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import * as nodemailer from 'nodemailer';
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

  /**
   * TEMP diagnostic — verifies the SMTP connection and (if ?to= given)
   * sends a real test email, returning the EXACT SMTP error. No secrets
   * returned (password omitted). REMOVE once email is confirmed working.
   * e.g. /api/_debug/mail?to=you@example.com
   */
  @Get('_debug/mail')
  async mailTest(@Query('to') to?: string) {
    const host = this.config.get<string>('SMTP_HOST') ?? '';
    const port = Number(this.config.get('SMTP_PORT') ?? 587);
    const secureEnv = (
      this.config.get<string>('SMTP_SECURE') ?? ''
    ).toLowerCase();
    const secure =
      secureEnv === 'true'
        ? true
        : secureEnv === 'false'
          ? false
          : port === 465;
    const user = this.config.get<string>('SMTP_USER') ?? '';
    const from = this.config.get<string>('SMTP_FROM') ?? '';

    const result: Record<string, unknown> = {
      config: {
        hostSet: !!host,
        host,
        port,
        secure,
        userSet: !!user,
        user,
        passSet: !!this.config.get('SMTP_PASS'),
        from,
      },
      verifyOk: false,
      verifyError: null as string | null,
      sendOk: false,
      sendError: null as string | null,
      sentTo: to ?? null,
    };

    const transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass: this.config.get<string>('SMTP_PASS'),
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
    });

    try {
      await transport.verify();
      result.verifyOk = true;
    } catch (e: any) {
      result.verifyError = `${e?.code ?? ''} ${e?.message ?? String(e)}`.trim();
    }

    if (to) {
      try {
        const info = await transport.sendMail({
          from,
          to,
          subject: 'CodesApp SMTP test',
          text: 'If you received this, SMTP works.',
        });
        result.sendOk = true;
        result.messageId = (info as { messageId?: string }).messageId ?? null;
        result.response = (info as { response?: string }).response ?? null;
      } catch (e: any) {
        result.sendError = `${e?.code ?? ''} ${
          e?.message ?? String(e)
        }`.trim();
      }
    }

    return result;
  }
}
