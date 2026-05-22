import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ShopifyService } from './shopify.service';
import { TenantGuard } from '../../../common/guards/tenant.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import {
  CreateShopifyOrderDto,
  CreateCustomerDto,
  ShippingRatesDto,
} from './dto/create-order.dto';

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

  @Get('products')
  searchProducts(
    @CurrentUser() user: { companyId: number },
    @Query('query') query?: string,
  ) {
    return this.shopifyService.searchProducts(user.companyId, query ?? '');
  }

  @Post('shipping-rates')
  shippingRates(
    @CurrentUser() user: { companyId: number },
    @Body() dto: ShippingRatesDto,
  ) {
    return this.shopifyService.getShippingRates(user.companyId, dto);
  }

  @Get('customers')
  searchCustomer(
    @CurrentUser() user: { companyId: number },
    @Query('phone') phone?: string,
    @Query('email') email?: string,
  ) {
    return this.shopifyService.searchCustomer(user.companyId, { phone, email });
  }

  @Post('customers')
  createCustomer(
    @CurrentUser() user: { companyId: number },
    @Body() dto: CreateCustomerDto,
  ) {
    return this.shopifyService.createCustomer(user.companyId, dto);
  }

  @Post('orders')
  createOrder(
    @CurrentUser() user: { companyId: number },
    @Body() dto: CreateShopifyOrderDto,
  ) {
    return this.shopifyService.createOrder(user.companyId, dto);
  }
}
