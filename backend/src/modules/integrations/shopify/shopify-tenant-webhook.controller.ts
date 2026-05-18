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
import { ShopifyService } from './shopify.service';

/**
 * Per-tenant Shopify webhook receiver. The client configures this exact URL
 * (`/webhooks/shopify/{their key}`) in THEIR own Shopify app. Public (no JWT)
 * — authenticity is the per-company HMAC, verified in the service with that
 * company's stored signing secret. Excluded from the /api prefix in main.ts
 * so the URL we hand the client is stable.
 *
 * CRITICAL: raw body must be available for HMAC — NestFactory is created
 * with rawBody:true (see ERRORS.md "Shopify webhook arrives with no body").
 */
@Controller('webhooks/shopify')
export class ShopifyTenantWebhookController {
  constructor(private readonly shopifyService: ShopifyService) {}

  @Post(':key')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param('key') key: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const hmac = (req.headers['x-shopify-hmac-sha256'] as string) || '';
    const topic = (req.headers['x-shopify-topic'] as string) || '';
    const rawBody = req.rawBody ?? Buffer.from('');
    return this.shopifyService.handleTenantOrderWebhook(
      key,
      topic,
      hmac,
      rawBody,
    );
  }
}
