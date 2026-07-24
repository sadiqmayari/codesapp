import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { CourierType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ShipmentTrackingService } from './shipment-tracking.service';
import { COURIER_TYPES } from './courier-registry.service';

/**
 * Per-tenant courier webhook receiver: /webhooks/couriers/:courier/:webhookKey.
 * Public (no JWT) — the unguessable per-tenant webhookKey embedded in the URL
 * IS the auth boundary, same shape as /webhooks/shopify/:key. This is the
 * structural fix for the cross-tenant leak found in the tenant's shared n8n
 * Leopards webhook (a second, unrelated Shopify store's traffic was served
 * through the same endpoint) — routing is per-tenant by construction here,
 * there is no shared endpoint to leak across.
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
  ) {}

  @Post(':courier/:webhookKey')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param('courier') courierParam: string,
    @Param('webhookKey') webhookKey: string,
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

    const items = Array.isArray((body as any)?.data) ? (body as any).data : [body];
    for (const item of items) {
      await this.tracking.handleWebhookItem(cred.company_id, courierType, item);
    }
    return { received: true };
  }
}
