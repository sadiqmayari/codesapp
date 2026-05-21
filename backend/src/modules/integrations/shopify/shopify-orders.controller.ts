import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ShopifyService } from './shopify.service';
import { TenantGuard } from '../../../common/guards/tenant.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { CreateShopifyOrderDto } from './dto/create-order.dto';

/**
 * Agent-driven Shopify order creation from the inbox (chat popup). Under the
 * global /api prefix (unlike the root ShopifyController which is excluded so
 * OAuth/webhook URLs stay fixed). Tenant-scoped via the company's own Admin
 * API token stored in Settings → Shopify.
 */
@Controller('shopify')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class ShopifyOrdersController {
  constructor(private readonly shopifyService: ShopifyService) {}

  @Post('orders')
  createOrder(
    @CurrentUser() user: { companyId: number },
    @Body() dto: CreateShopifyOrderDto,
  ) {
    return this.shopifyService.createOrder(user.companyId, dto);
  }
}
