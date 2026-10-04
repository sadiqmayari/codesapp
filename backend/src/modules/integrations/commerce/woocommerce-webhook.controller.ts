import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { WooCommerceService } from './woocommerce.service';

/**
 * Per-tenant WooCommerce webhook receiver. The client configures this exact URL
 * (`/webhooks/woocommerce/{their key}`) in THEIR WooCommerce store. Public (no
 * JWT) — authenticity is the per-store HMAC in `x-wc-webhook-signature`, verified
 * in the service with that store's stored signing secret. Excluded from the /api
 * prefix in main.ts so the URL handed to the client is stable.
 *
 * Raw body must be available for HMAC — NestFactory is created with rawBody:true.
 */
@Controller('webhooks/woocommerce')
export class WooCommerceWebhookController {
  constructor(private readonly woo: WooCommerceService) {}

  @Post(':key')
  @HttpCode(HttpStatus.OK)
  async receive(@Param('key') key: string, @Req() req: RawBodyRequest<Request>) {
    const signature = (req.headers['x-wc-webhook-signature'] as string) || '';
    const topic = (req.headers['x-wc-webhook-topic'] as string) || '';
    const rawBody = req.rawBody ?? Buffer.from('');
    return this.woo.handleWebhook(key, topic, signature, rawBody);
  }
}
