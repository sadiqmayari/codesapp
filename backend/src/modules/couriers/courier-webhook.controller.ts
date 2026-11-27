import {
  Body,
  Controller,
  Get,
  Head,
  Headers,
  Logger,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  RawBodyRequest,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CourierType } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { ShipmentTrackingService } from './shipment-tracking.service';
import { COURIER_TYPES } from './courier-registry.service';
import { CacheService } from '../../common/services/cache.service';
import { verifyRapidxpkSignature } from './adapters/rapidxpk.adapter';

/**
 * Per-tenant courier webhook receiver: /webhooks/couriers/:courier/:webhookKey.
 * Public (no JWT) — the unguessable per-tenant webhookKey embedded in the URL
 * IS the primary auth boundary, same shape as /webhooks/shopify/:key. This is
 * the structural fix for the cross-tenant leak found in the tenant's shared n8n
 * Leopards webhook (a second, unrelated Shopify store's traffic was served
 * through the same endpoint) — routing is per-tenant by construction here,
 * there is no shared endpoint to leak across.
 *
 * M&P is a special case: its portal posts to a KEYLESS URL (/webhooks/couriers/
 * mnp, no path key) and authenticates with `Authorization: Bearer <token>`, a
 * token M&P provisions PER ACCOUNT. So for M&P the tenant is identified BY that
 * token (matched against each tenant's saved `webhookToken`), which both routes
 * and authenticates. The keyed route still works for M&P if a portal supports a
 * path key; both feed the same handler.
 *
 * Excluded from the /api prefix in main.ts so the URL handed to each courier
 * is stable. Leopards delivers a batch ({ data: [...] }); the others deliver
 * one event per call — both shapes are normalized to "one item at a time"
 * before reaching ShipmentTrackingService.
 */
@Controller('webhooks/couriers')
export class CourierWebhookController {
  private readonly logger = new Logger(CourierWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tracking: ShipmentTrackingService,
    private readonly encryption: EncryptionService,
    private readonly cache: CacheService,
  ) {}

  /**
   * KEYLESS M&P receiver. M&P's portal posts here with no path key; the bearer
   * token identifies + authenticates the tenant. 401 if the token matches no
   * tenant's saved M&P webhookToken.
   */
  @Post('mnp')
  @HttpCode(HttpStatus.OK)
  async receiveMnp(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const token = (authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) throw new UnauthorizedException('Missing webhook token.');

    // Find the M&P tenant whose saved webhookToken matches (token = identity + auth).
    const creds = await this.prisma.courierCredential.findMany({
      where: { courier_type: 'mnp', is_active: true },
    });
    let companyId: number | null = null;
    for (const c of creds) {
      const expected = this.readWebhookToken(c.credentials_encrypted);
      if (expected && this.tokenEq(token, expected)) {
        companyId = c.company_id;
        break;
      }
    }
    if (companyId == null) throw new UnauthorizedException('Invalid webhook token.');

    await this.dispatch(companyId, 'mnp', body);
    return { received: true };
  }

  /**
   * Verification ping. Courier portals (TCS Envio "Webhook Setup") hit the URL
   * with GET/HEAD before they let the tenant enable it — without this route the
   * ping got 404 and TCS showed "account is not webhook-verified". A valid key
   * answers 200; any challenge-style query param is echoed back as plain text.
   */
  @Get(':courier/:webhookKey')
  @Head(':courier/:webhookKey')
  async verify(
    @Param('courier') courierParam: string,
    @Param('webhookKey') webhookKey: string,
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const courierType = courierParam as CourierType;
    const cred = COURIER_TYPES.includes(courierType)
      ? await this.prisma.courierCredential.findUnique({ where: { webhook_key: webhookKey } })
      : null;
    this.logger.log(
      `verify ping ${req.method} ${courierParam} key=${webhookKey.slice(0, 6)}… ` +
        `ok=${!!cred && cred.courier_type === courierType} query=${JSON.stringify(query).slice(0, 300)} ` +
        `ua=${String(req.headers['user-agent'] ?? '').slice(0, 120)}`,
    );
    if (!cred || cred.courier_type !== courierType) {
      res.status(404).json({ success: false, message: 'Invalid webhook URL.' });
      return;
    }
    const challenge = ['challenge', 'hub.challenge', 'verify_token', 'token', 'echo']
      .map((k) => query[k])
      .find((v) => typeof v === 'string' && v.length > 0 && v.length <= 500) as string | undefined;
    if (challenge) {
      res.status(200).type('text/plain').send(challenge);
      return;
    }
    res.status(200).json({ success: true, data: { verified: true }, message: 'OK' });
  }

  @Post(':courier/:webhookKey')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param('courier') courierParam: string,
    @Param('webhookKey') webhookKey: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const courierType = courierParam as CourierType;
    if (!COURIER_TYPES.includes(courierType)) {
      throw new NotFoundException('Unknown courier.');
    }
    const cred = await this.prisma.courierCredential.findUnique({
      where: { webhook_key: webhookKey },
    });
    if (!cred || cred.courier_type !== courierType) {
      throw new NotFoundException('Invalid webhook URL.');
    }

    // RapidXpk signs every delivery (HMAC over the RAW body) and needs a 2xx
    // within 12s — verify, de-dup, ACK, then process in the background.
    if (courierType === 'rapidxpk') {
      return this.receiveRapidxpk(
        cred.company_id,
        cred.webhook_secret_encrypted,
        cred.credentials_encrypted,
        body,
        req,
      );
    }

    // Bearer-token check: enforced only when this tenant has a `webhookToken`
    // saved in its courier credentials. Absent token = accept (URL key remains
    // the guard) so pushes work before it's set.
    const expected = this.readWebhookToken(cred.credentials_encrypted);
    if (expected) {
      const got = (authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (!this.tokenEq(got, expected)) throw new UnauthorizedException('Invalid webhook token.');
    }

    if (courierType === 'tcs') {
      this.logger.log(`tcs push company=${cred.company_id} body=${JSON.stringify(body ?? null).slice(0, 800)}`);
    }
    await this.dispatch(cred.company_id, courierType, body);
    return { received: true };
  }

  /**
   * RapidXpk delivery. Signature = "sha256=" + HMAC(secret, `${ts}.${rawBody}`),
   * timestamp within 5 min. `X-RapidXpk-Delivery` is stable across retries, so a
   * repeat is acknowledged and dropped. Processing runs AFTER the 200 so a slow
   * Shopify push can never blow RapidXpk's 12s budget; a lost event is caught up
   * by the change-feed sync (CourierStatusSyncService).
   */
  private async receiveRapidxpk(
    companyId: number,
    secretEncrypted: string | null,
    credentialsEncrypted: string | null,
    body: unknown,
    req: RawBodyRequest<Request>,
  ) {
    // Two possible secrets: the one CodesApp got when it registered the URL
    // (webhook_secret_encrypted) and one pasted from the RapidXpk portal
    // (credentials.webhookSecret). A delivery signed with either is accepted.
    const secrets: string[] = [];
    if (secretEncrypted) {
      try {
        secrets.push(this.encryption.decrypt(secretEncrypted));
      } catch {
        /* rotated key */
      }
    }
    if (credentialsEncrypted) {
      try {
        const c = JSON.parse(this.encryption.decrypt(credentialsEncrypted));
        if (typeof c?.webhookSecret === 'string' && c.webhookSecret.trim()) {
          secrets.push(c.webhookSecret.trim());
        }
      } catch {
        /* ignore */
      }
    }
    if (!secrets.length) {
      throw new UnauthorizedException('RapidXpk webhook not registered for this account.');
    }
    const header = (n: string) => {
      const v = req.headers[n];
      return Array.isArray(v) ? v[0] : v;
    };
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(body ?? {}));
    const ts = header('x-rapidxpk-timestamp');
    const sig = header('x-rapidxpk-signature');
    if (!secrets.some((secret) => verifyRapidxpkSignature(secret, ts, sig, raw))) {
      throw new UnauthorizedException('Invalid RapidXpk signature.');
    }

    const deliveryId = header('x-rapidxpk-delivery');
    if (deliveryId) {
      const key = `rapidxpk:delivery:${companyId}:${deliveryId}`;
      if (this.cache.get<boolean>(key)) return { received: true, duplicate: true };
      this.cache.set(key, true, 24 * 3600);
    }

    void this.tracking.handleWebhookItem(companyId, 'rapidxpk', body).catch((err) =>
      this.logger.error(
        `RapidXpk webhook processing failed (company ${companyId}, delivery ${deliveryId ?? '?'}): ${
          (err as Error)?.message ?? err
        }`,
      ),
    );
    return { received: true };
  }

  /** Fan out a batch ({data:[...]}) or single item to the tracking service. */
  private async dispatch(companyId: number, courierType: CourierType, body: unknown) {
    const items = Array.isArray((body as any)?.data) ? (body as any).data : [body];
    for (const item of items) {
      await this.tracking.handleWebhookItem(companyId, courierType, item);
    }
  }

  /** Constant-time token compare (length-guarded so timingSafeEqual never throws). */
  private tokenEq(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  }

  /** Decrypt the stored credentials and return the tenant's `webhookToken`, if any. */
  private readWebhookToken(encrypted: string | null): string {
    if (!encrypted) return '';
    try {
      const creds = JSON.parse(this.encryption.decrypt(encrypted));
      return typeof creds?.webhookToken === 'string' ? creds.webhookToken.trim() : '';
    } catch {
      return '';
    }
  }
}
