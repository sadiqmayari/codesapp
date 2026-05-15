import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
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

@Controller('webhooks/meta')
export class MetaWebhookController {
  private readonly logger = new Logger(MetaWebhookController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly jobQueue: JobQueueService,
  ) {}

  /**
   * Meta verification handshake. Must respond with hub.challenge as plain text
   * within 3 seconds — see ERRORS.md.
   */
  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ): void {
    const expected = this.config.get<string>('META_VERIFY_TOKEN');
    if (mode === 'subscribe' && token && expected && token === expected) {
      res.status(HttpStatus.OK).type('text/plain').send(challenge ?? '');
      return;
    }
    this.logger.warn(`Meta verify failed (mode=${mode})`);
    res.status(HttpStatus.FORBIDDEN).type('text/plain').send('forbidden');
  }

  /**
   * Inbound webhook delivery. Verify HMAC against raw body using
   * timingSafeEqual, respond 200 immediately, and enqueue async processing.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const appSecret = this.config.get<string>('META_APP_SECRET');
    const rawBody = req.rawBody;

    if (!appSecret) {
      this.logger.error('META_APP_SECRET not configured — rejecting webhook');
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

    // Respond 200 immediately, enqueue the rest.
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

  /**
   * Verify X-Hub-Signature-256 against HMAC-SHA256(rawBody, appSecret).
   * Exposed as static-like helper for unit testing.
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
