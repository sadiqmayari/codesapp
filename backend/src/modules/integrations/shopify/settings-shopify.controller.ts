import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ShopifyService } from './shopify.service';
import { TenantGuard } from '../../../common/guards/tenant.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { UpdateShopifyEventsDto } from './dto/update-events.dto';
import { SetShopifyWebhookSecretDto } from './dto/set-webhook-secret.dto';

/**
 * Authenticated Shopify management for the in-app Settings UI. Lives under
 * the global /api prefix (unlike ShopifyController which is excluded so the
 * OAuth callback + webhook keep fixed root URLs registered with Shopify).
 */
@Controller('settings/shopify')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class SettingsShopifyController {
  constructor(private readonly shopifyService: ShopifyService) {}

  @Get()
  async status(@CurrentUser() user: { companyId: number }) {
    const [integration, webhook] = await Promise.all([
      this.shopifyService.getIntegrationOrNull(user.companyId),
      this.shopifyService.getWebhookConfig(user.companyId),
    ]);
    return { integration, ...webhook };
  }

  @Patch('webhook-secret')
  setWebhookSecret(
    @CurrentUser() user: { companyId: number },
    @Body() dto: SetShopifyWebhookSecretDto,
  ) {
    return this.shopifyService.setWebhookSecret(user.companyId, dto.secret);
  }

  @Get('connect')
  connect(@CurrentUser() user: { companyId: number }) {
    return this.shopifyService.getOAuthUrl(user.companyId);
  }

  @Patch('events')
  updateEvents(
    @CurrentUser() user: { companyId: number },
    @Body() dto: UpdateShopifyEventsDto,
  ) {
    return this.shopifyService.updateEvents(user.companyId, dto.events);
  }

  @Delete()
  disconnect(@CurrentUser() user: { companyId: number }) {
    return this.shopifyService.disconnect(user.companyId);
  }
}
