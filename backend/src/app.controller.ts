import { Controller, Get, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import * as nodemailer from 'nodemailer';
import * as https from 'https';
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
    const pass = this.config.get<string>('SMTP_PASS') ?? '';
    const resendKey = this.config.get<string>('RESEND_API_KEY') ?? '';
    const provider = resendKey ? 'resend' : 'smtp';
    const passQuoted =
      (pass.startsWith('"') && pass.endsWith('"')) ||
      (pass.startsWith("'") && pass.endsWith("'"));

    const result: Record<string, unknown> = {
      provider,
      resendKeySet: resendKey.length > 0,
      config: {
        hostSet: !!host,
        host,
        port,
        secure,
        userSet: !!user,
        user,
        userHasWhitespace: user !== user.trim(),
        passSet: pass.length > 0,
        passLength: pass.length,
        passTrimmedLength: pass.trim().length,
        passHasSurroundingWhitespace: pass !== pass.trim(),
        passLooksQuoted: passQuoted,
        from,
      },
      verifyOk: false,
      verifyError: null as string | null,
      sendOk: false,
      sendError: null as string | null,
      sentTo: to ?? null,
    };

    // Resend HTTP path (preferred when RESEND_API_KEY is set).
    if (provider === 'resend') {
      if (to) {
        try {
          await new Promise<void>((resolve, reject) => {
            const payload = JSON.stringify({
              from,
              to: [to],
              subject: 'CodesApp Resend test',
              html: '<p>If you received this, Resend works.</p>',
            });
            const req = https.request(
              {
                hostname: 'api.resend.com',
                path: '/emails',
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${resendKey}`,
                  'Content-Length': Buffer.byteLength(payload),
                },
              },
              (r) => {
                let d = '';
                r.on('data', (c) => (d += c));
                r.on('end', () => {
                  const code = r.statusCode ?? 0;
                  (result as any).resendStatus = code;
                  (result as any).resendBody = d.slice(0, 500);
                  code >= 200 && code < 300
                    ? resolve()
                    : reject(new Error(`HTTP ${code}`));
                });
              },
            );
            req.on('error', reject);
            req.setTimeout(10000, () =>
              req.destroy(new Error('timeout')),
            );
            req.write(payload);
            req.end();
          });
          result.sendOk = true;
        } catch (e: any) {
          result.sendError = e?.message ?? String(e);
        }
      } else {
        (result as any).note = 'Add ?to=you@example.com to send a Resend test.';
      }
      return result;
    }

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
