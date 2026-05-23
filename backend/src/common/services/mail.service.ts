import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import * as https from 'https';

/**
 * Tiny shared mail service. Mirrors the (private) sender baked into
 * AuthService so the limit-warning + suspension paths can email without
 * cross-module DI gymnastics. Never throws — Hostinger SMTP is flaky and
 * a failed email must NOT take down the calling request.
 *
 * Uses Resend HTTP API when `RESEND_API_KEY` is set (works on hosts that
 * garble SMTP AUTH), else falls back to nodemailer SMTP.
 *
 * AuthService is deliberately NOT migrated to this service in the same
 * commit — keep the working verification-email path untouched.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly mailer: nodemailer.Transporter;

  constructor(private readonly config: ConfigService) {
    this.mailer = nodemailer.createTransport({
      host: config.get<string>('SMTP_HOST'),
      port: Number(config.get<string>('SMTP_PORT') ?? 587),
      secure: false,
      auth: {
        user: config.get<string>('SMTP_USER'),
        pass: config.get<string>('SMTP_PASS'),
      },
    });
  }

  async send(to: string, subject: string, html: string): Promise<void> {
    const from =
      this.config.get<string>('SMTP_FROM') ?? 'no-reply@codentra.pk';
    const resendKey = this.config.get<string>('RESEND_API_KEY');
    try {
      if (resendKey) {
        await this.sendViaResend(resendKey, from, to, subject, html);
      } else {
        await this.mailer.sendMail({ from, to, subject, html });
      }
    } catch (e) {
      this.logger.error(
        `Email to ${to} ("${subject}") failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  private sendViaResend(
    apiKey: string,
    from: string,
    to: string,
    subject: string,
    html: string,
  ): Promise<void> {
    const payload = JSON.stringify({ from, to: [to], subject, html });
    return new Promise<void>((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.resend.com',
          path: '/emails',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (d) => (data += d));
          res.on('end', () => {
            const code = res.statusCode ?? 0;
            if (code >= 200 && code < 300) resolve();
            else reject(new Error(`Resend HTTP ${code}: ${data}`));
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(10000, () =>
        req.destroy(new Error('Resend request timeout')),
      );
      req.write(payload);
      req.end();
    });
  }
}
