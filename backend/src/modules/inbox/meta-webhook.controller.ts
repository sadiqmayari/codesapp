import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  RawBodyRequest,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Request, Response } from 'express';
import { JobQueueService } from '../../common/services/job-queue.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('webhooks/meta')
export class MetaWebhookController {
  private readonly logger = new Logger(MetaWebhookController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly jobQueue: JobQueueService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Resolve the verify token + app secret for this delivery. With a per-tenant
   * key (Option B) we use that company's own stored secrets; otherwise (and as
   * a fallback when a column is null) we use the platform META_* env values
   * (Option A / Tech-Provider / single-tenant).
   */
  private async resolveSecrets(
    key?: string,
  ): Promise<{ verifyToken?: string; appSecret?: string }> {
    const envVerify = this.config.get<string>('META_VERIFY_TOKEN');
    const envSecret = this.config.get<string>('META_APP_SECRET');
    if (!key) return { verifyToken: envVerify, appSecret: envSecret };

    const company = await this.prisma.company.findFirst({
      where: { webhook_key: key },
      select: {
        webhook_verify_token: true,
        webhook_app_secret_encrypted: true,
      },
    });
    if (!company) return {}; // unknown key → no secrets → reject

    let appSecret = envSecret;
    if (company.webhook_app_secret_encrypted) {
      try {
        appSecret = this.encryption.decrypt(
          company.webhook_app_secret_encrypted,
        );
      } catch {
        appSecret = undefined;
      }
    }
    return {
      verifyToken: company.webhook_verify_token || envVerify,
      appSecret,
    };
  }

  private handleVerify(
    expected: string | undefined,
    mode: string,
    token: string,
    challenge: string,
    res: Response,
  ): void {
    if (mode === 'subscribe' && token && expected && token === expected) {
      res.status(HttpStatus.OK).type('text/plain').send(challenge ?? '');
      return;
    }
    this.logger.warn(`Meta verify failed (mode=${mode})`);
    res.status(HttpStatus.FORBIDDEN).type('text/plain').send('forbidden');
  }

  private async handleReceive(
    appSecret: string | undefined,
    req: RawBodyRequest<Request>,
    signature: string | undefined,
    res: Response,
  ): Promise<void> {
    const rawBody = req.rawBody;
    if (!appSecret) {
      this.logger.error('No app secret resolved — rejecting webhook');
      res.status(HttpStatus.UNAUTHORIZED).json({ ok: false });
      return;
    }
    if (!rawBody || !signature) {
      res.status(HttpStatus.UNAUTHORIZED).json({ ok: false });
      return;
    }
    if (!this.verifySignature(signature, rawBody, appSecret)) {
      this.logger.warn('Meta webhook HMAC verification failed');
      res.status(HttpStatus.UNAUTHORIZED).json({ ok: false });
      return;
    }
    res.status(HttpStatus.OK).json({ ok: true });
    try {
      await this.jobQueue.enqueue('message', { rawPayload: req.body });
    } catch (err) {
      this.logger.error(
        `Failed to enqueue message job: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ---- Platform / single-tenant routes (env secrets) ----------------------

  @Get()
  async verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ): Promise<void> {
    const { verifyToken } = await this.resolveSecrets();
    this.handleVerify(verifyToken, mode, token, challenge, res);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { appSecret } = await this.resolveSecrets();
    await this.handleReceive(appSecret, req, signature, res);
  }

  // ---- Per-tenant routes (Option B): /webhooks/meta/<webhook_key> ---------

  @Get(':key')
  async verifyByKey(
    @Param('key') key: string,
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ): Promise<void> {
    const { verifyToken } = await this.resolveSecrets(key);
    this.handleVerify(verifyToken, mode, token, challenge, res);
  }

  @Post(':key')
  @HttpCode(HttpStatus.OK)
  async receiveByKey(
    @Param('key') key: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { appSecret } = await this.resolveSecrets(key);
    await this.handleReceive(appSecret, req, signature, res);
  }

  /**
   * Verify X-Hub-Signature-256 against HMAC-SHA256(rawBody, appSecret).
   */
  verifySignature(
    signatureHeader: string,
    rawBody: Buffer,
    appSecret: string,
  ): boolean {
    const expected = crypto
      .createHmac('sha256', appSecret)
      .update(rawBody)
      .digest('hex');

    const provided = signatureHeader.startsWith('sha256=')
      ? signatureHeader.slice('sha256='.length)
      : signatureHeader;

    if (provided.length !== expected.length) return false;
    try {
      return crypto.timingSafeEqual(
        Buffer.from(provided, 'hex'),
        Buffer.from(expected, 'hex'),
      );
    } catch {
      return false;
    }
  }
}
