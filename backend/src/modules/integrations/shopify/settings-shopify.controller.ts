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
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { UpdateShopifyEventsDto } from './dto/update-events.dto';
import { SetShopifyWebhookSecretDto } from './dto/set-webhook-secret.dto';
import {
  ShopifyCredentialsDto,
  ShopifyTemplateDto,
  ShopifyTagsDto,
  ShopifyProactiveDto,
} from './dto/order-config.dto';
import { SetShopifyAdminTokenDto } from './dto/set-admin-token.dto';

/**
 * Authenticated Shopify management for the in-app Settings UI. Lives under
 * the global /api prefix (unlike ShopifyController which is excluded so the
 * OAuth callback + webhook keep fixed root URLs registered with Shopify).
 */
@Controller('settings/shopify')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard)
export class SettingsShopifyController {
  constructor(private readonly shopifyService: ShopifyService) {}

  /**
   * Lightweight readiness check for the inbox composer (agents need it to show
   * the "Create Shopify order" action). Deliberately NOT role-gated — it leaks
   * no credentials, only whether an Admin token exists. All other endpoints
   * here are owner/admin-only (@Roles below).
   */
  @Get('ready')
  async ready(@CurrentUser() user: { companyId: number }) {
    const webhook = await this.shopifyService.getWebhookConfig(user.companyId);
    return { adminTokenSet: webhook.adminTokenSet };
  }

  @Get()
  @Roles('owner', 'admin')
  async status(@CurrentUser() user: { companyId: number }) {
    const [integration, webhook] = await Promise.all([
      this.shopifyService.getIntegrationOrNull(user.companyId),
      this.shopifyService.getWebhookConfig(user.companyId),
    ]);
    return { integration, ...webhook };
  }

  @Patch('webhook-secret')
  @Roles('owner', 'admin')
  setWebhookSecret(
    @CurrentUser() user: { companyId: number },
    @Body() dto: SetShopifyWebhookSecretDto,
  ) {
    return this.shopifyService.setWebhookSecret(user.companyId, dto.secret);
  }

  @Get('connect')
  @Roles('owner', 'admin')
  connect(@CurrentUser() user: { companyId: number }) {
    return this.shopifyService.getOAuthUrl(user.companyId);
  }

  @Patch('events')
  @Roles('owner', 'admin')
  updateEvents(
    @CurrentUser() user: { companyId: number },
    @Body() dto: UpdateShopifyEventsDto,
  ) {
    return this.shopifyService.updateEvents(user.companyId, dto.events);
  }

  @Patch('admin-token')
  @Roles('owner', 'admin')
  setAdminToken(
    @CurrentUser() user: { companyId: number },
    @Body() dto: SetShopifyAdminTokenDto,
  ) {
    return this.shopifyService.setAdminToken(user.companyId, dto.token);
  }

  @Get('order-config')
  @Roles('owner', 'admin')
  getOrderConfig(@CurrentUser() user: { companyId: number }) {
    return this.shopifyService.getOrderConfig(user.companyId);
  }

  @Patch('credentials')
  @Roles('owner', 'admin')
  saveCredentials(
    @CurrentUser() user: { companyId: number },
    @Body() dto: ShopifyCredentialsDto,
  ) {
    return this.shopifyService.updateCredentials(user.companyId, dto);
  }

  @Patch('template')
  @Roles('owner', 'admin')
  saveTemplate(
    @CurrentUser() user: { companyId: number },
    @Body() dto: ShopifyTemplateDto,
  ) {
    return this.shopifyService.updateTemplate(user.companyId, {
      enabled: dto.enabled,
      templateId: dto.templateId ?? null,
      variableMap: dto.variableMap,
    });
  }

  @Patch('proactive')
  @Roles('owner', 'admin')
  saveProactive(
    @CurrentUser() user: { companyId: number },
    @Body() dto: ShopifyProactiveDto,
  ) {
    return this.shopifyService.updateProactive(user.companyId, {
      enabled: dto.enabled,
      notifications: dto.notifications ?? {},
    });
  }

  @Patch('tags')
  @Roles('owner', 'admin')
  saveTags(
    @CurrentUser() user: { companyId: number },
    @Body() dto: ShopifyTagsDto,
  ) {
    return this.shopifyService.updateTags(user.companyId, dto);
  }

  @Delete()
  @Roles('owner', 'admin')
  disconnect(@CurrentUser() user: { companyId: number }) {
    return this.shopifyService.disconnect(user.companyId);
  }
}
