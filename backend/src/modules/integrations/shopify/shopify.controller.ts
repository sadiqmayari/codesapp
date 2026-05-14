import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotImplementedException,
  Post,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { ShopifyService } from './shopify.service';
import { TenantGuard } from '../../../common/guards/tenant.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';

@Controller('integrations/shopify')
export class ShopifyController {
  constructor(private readonly shopifyService: ShopifyService) {}

  @Get('connect')
  @UseGuards(AuthGuard('jwt'), TenantGuard)
  connect(@CurrentUser() user: { companyId: number }) {
    return this.shopifyService.getOAuthUrl(user.companyId);
  }

  @Get('callback')
  callback(@Req() req: Request) {
    const { shop, code, state } = req.query as Record<string, string>;
    return this.shopifyService.handleCallback(shop, code, state);
  }

  // CRITICAL: raw body must be read BEFORE global body parser
  // See ERRORS.md "Shopify webhook arrives with no body"
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async webhook(@Req() req: RawBodyRequest<Request>) {
    const hmac = req.headers['x-shopify-hmac-sha256'] as string;
    const topic = req.headers['x-shopify-topic'] as string;
    const rawBody = req.rawBody;

    if (!rawBody) {
      return { received: true };
    }

    await this.shopifyService.handleWebhook(topic, hmac, rawBody);
    return { received: true };
  }

  @Get()
  @UseGuards(AuthGuard('jwt'), TenantGuard)
  getIntegration(@CurrentUser() user: { companyId: number }) {
    return this.shopifyService.getIntegration(user.companyId);
  }

  @Delete('disconnect')
  @UseGuards(AuthGuard('jwt'), TenantGuard)
  disconnect(@CurrentUser() user: { companyId: number }) {
    return this.shopifyService.disconnect(user.companyId);
  }
}
