import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { CourierType } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { ShipmentTrackingService } from './shipment-tracking.service';
import { COURIER_TYPES } from './courier-registry.service';

/**
 * Per-tenant courier webhook receiver: /webhooks/couriers/:courier/:webhookKey.
 * Public (no JWT) — the unguessable per-tenant webhookKey embedded in the URL
 * IS the primary auth boundary, same shape as /webhooks/shopify/:key. This is
 * the structural fix for the cross-tenant leak found in the tenant's shared n8n
 * Leopards webhook (a second, unrelated Shopify store's traffic was served
 * through the same endpoint) — routing is per-tenant by construction here,
 * there is no shared endpoint to leak across.
 *
 * M&P additionally requires bearer-token auth: it sends `Authorization: Bearer
 * <token>` and expects us to validate it. The token is provisioned by M&P PER
 * ACCOUNT, so the tenant saves it in Settings → Courier → M&P ("Webhook token").
 * When a tenant has a webhook token stored we enforce it (401 on mismatch) as a
 * second layer on top of the URL key; when none is stored we accept (the URL key
 * still guards the endpoint), so pushes keep flowing until the token is entered.
 *
 * Excluded from the /api prefix in main.ts so the URL handed to each courier
 * is stable. Leopards delivers a batch ({ data: [...] }); the others deliver
 * one event per call — both shapes are normalized to "one item at a time"
 * before reaching ShipmentTrackingService.
 */
@Controller('webhooks/couriers')
export class CourierWebhookController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tracking: ShipmentTrackingService,
    private readonly encryption: EncryptionService,
  ) {}

  @Post(':courier/:webhookKey')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param('courier') courierParam: string,
    @Param('webhookKey') webhookKey: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
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

    // Bearer-token check: enforced only when this tenant has a `webhookToken`
    // saved in its courier credentials (M&P provisions one per account). Absent
    // token = accept (URL key remains the guard) so pushes work before it's set.
    const expected = this.readWebhookToken(cred.credentials_encrypted);
    if (expected) {
      const got = (authorization || '').replace(/^Bearer\s+/i, '').trim();
      const a = Buffer.from(got);
      const b = Buffer.from(expected);
      const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!ok) throw new UnauthorizedException('Invalid webhook token.');
    }

    const items = Array.isArray((body as any)?.data) ? (body as any).data : [body];
    for (const item of items) {
      await this.tracking.handleWebhookItem(cred.company_id, courierType, item);
    }
    return { received: true };
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
