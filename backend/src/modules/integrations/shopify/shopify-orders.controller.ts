import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ShopifyService } from './shopify.service';
import { ShopifyOrderSyncService } from './shopify-order-sync.service';
import { TenantGuard } from '../../../common/guards/tenant.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import {
  CreateShopifyOrderDto,
  CreateCustomerDto,
  ShippingRatesDto,
  UpdateOrderAddressDto,
  ArchiveOrdersDto,
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
  constructor(
    private readonly shopifyService: ShopifyService,
    private readonly orderSync: ShopifyOrderSyncService,
  ) {}

  /**
   * One-time (re-runnable) import of the store's open orders into the local
   * mirror. Background job — paging full order history exceeds the HTTP budget.
   * Owner/admin only.
   */
  @Post('import-orders')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  importOrders(@CurrentUser() user: { companyId: number }) {
    return this.orderSync.requestImport(user.companyId);
  }

  /** Reconcile the mirror's open orders vs Shopify (fixes manual archives/cancels
   *  done directly in Shopify that no webhook told us about). */
  @Post('orders/reconcile')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  reconcileOrders(@CurrentUser() user: { companyId: number }) {
    return this.orderSync.requestReconcile(user.companyId);
  }

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
    @CurrentUser() user: { companyId: number; userId: number },
    @Body() dto: CreateShopifyOrderDto,
  ) {
    return this.shopifyService.createOrder(user.companyId, dto, user.userId);
  }

  /** Edit an order's shipping address (writes to Shopify + the local mirror). */
  @Post('orders/update-address')
  updateOrderAddress(
    @CurrentUser() user: { companyId: number },
    @Body() dto: UpdateOrderAddressDto,
  ) {
    return this.shopifyService.updateOrderAddress(user.companyId, dto);
  }

  /**
   * Manually mark an order confirmed (for orders with no WhatsApp / that never
   * answered the confirmation template). Sets the mirror override + applies the
   * confirm tag in Shopify. Any agent may confirm.
   */
  @Post('orders/mark-confirmed')
  markOrderConfirmed(
    @CurrentUser() user: { companyId: number },
    @Body() body: { orderGid: string },
  ) {
    return this.shopifyService.markOrderConfirmed(user.companyId, body.orderGid);
  }

  /** Manually (re)send the configured confirmation template to the customer. */
  @Post('orders/resend-confirmation')
  resendConfirmation(
    @CurrentUser() user: { companyId: number },
    @Body() body: { orderGid: string },
  ) {
    return this.shopifyService.resendConfirmation(user.companyId, body.orderGid);
  }

  /** Current line items of an order, for the in-app item editor. */
  @Get('orders/editable')
  orderEditable(
    @CurrentUser() user: { companyId: number },
    @Query('orderGid') orderGid: string,
  ) {
    return this.shopifyService.getOrderEditableItems(user.companyId, orderGid);
  }

  /** Edit an order's items (qty/remove/add) and commit the change to Shopify. */
  @Post('orders/edit-items')
  editOrderItems(
    @CurrentUser() user: { companyId: number },
    @Body()
    body: {
      orderGid: string;
      updates?: Array<{ variantId?: string | null; title?: string | null; quantity: number }>;
      adds?: Array<{ variantId: string; quantity: number }>;
    },
  ) {
    return this.shopifyService.editOrderItems(user.companyId, body.orderGid, {
      updates: body?.updates,
      adds: body?.adds,
    });
  }

  /** Archive (or unarchive) orders in Shopify + mirror the state locally. */
  @Post('orders/archive')
  archiveOrders(
    @CurrentUser() user: { companyId: number },
    @Body() dto: ArchiveOrdersDto,
  ) {
    return this.shopifyService.archiveOrders(
      user.companyId,
      dto.orderGids,
      dto.archive !== false,
    );
  }

  /**
   * Abandoned-checkout dashboard — pending checkouts whose customer has NOT
   * ordered today (the "ordered today" ones are filtered out server-side).
   */
  @Get('abandoned-checkouts')
  listAbandonedCheckouts(@CurrentUser() user: { companyId: number }) {
    return this.shopifyService.listAbandonedCheckouts(user.companyId);
  }

  /** Abandoned-cart KPIs for the dashboard tile (carts, value at risk, recovery). */
  @Get('abandoned-stats')
  abandonedStats(@CurrentUser() user: { companyId: number }) {
    return this.shopifyService.abandonedStats(user.companyId);
  }

  /** Dismiss an abandoned checkout (agent created an order for it). */
  @Post('abandoned-checkouts/:id/dismiss')
  dismissAbandonedCheckout(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.shopifyService.dismissAbandonedCheckout(user.companyId, id);
  }

  /**
   * Manually WhatsApp the configured abandoned-cart template to one cart.
   * Any agent may send (it's a normal outreach action); the template itself is
   * chosen by owner/admin in Settings → Shopify.
   */
  @Post('abandoned-checkouts/:id/send-message')
  sendAbandonedMessage(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.shopifyService.sendAbandonedMessage(user.companyId, id);
  }

  /** Assign (or clear, userId=null) the agent responsible for a cart. */
  @Post('abandoned-checkouts/:id/assign')
  assignAbandonedCheckout(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { userId?: number | null },
  ) {
    return this.shopifyService.assignAbandonedCheckout(
      user.companyId,
      id,
      body?.userId ?? null,
    );
  }

  /**
   * Orders dashboard — app-created orders with attribution + Shopify-hydrated
   * detail. scope=agent (created by an agent) | ad (from a Meta ad/post).
   * Optional from/to ISO dates (default: last 30 days).
   */
  @Get('orders/list')
  listCreatedOrders(
    @CurrentUser() user: { companyId: number },
    @Query('scope') scope?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
  ) {
    const parse = (v: string | undefined, fallback: Date) => {
      const d = v ? new Date(v) : null;
      return d && !Number.isNaN(d.getTime()) ? d : fallback;
    };
    const int = (v: string | undefined) => {
      const nnum = v ? parseInt(v, 10) : NaN;
      return Number.isFinite(nnum) ? nnum : undefined;
    };
    const now = new Date();
    const defFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return this.shopifyService.listCreatedOrders(user.companyId, {
      scope: scope === 'ad' ? 'ad' : 'agent',
      from: parse(from, defFrom),
      to: parse(to, now),
      page: int(page),
      pageSize: int(pageSize),
      search: search ?? undefined,
    });
  }

  /**
   * Track-order lookup for the composer's "+" menu — any agent can look up any
   * order number in the tenant's store (tenant-wide, not scoped to the current
   * chat's contact; consistent with product search/customer search above).
   */
  @Get('order-status')
  getOrderStatus(
    @CurrentUser() user: { companyId: number },
    @Query('orderNumber') orderNumber: string,
  ) {
    return this.shopifyService.getOrderStatus(user.companyId, orderNumber ?? '');
  }

  /** A contact's orders from the local mirror — inbox contact panel + header chip. */
  @Get('orders/by-contact')
  ordersByContact(
    @CurrentUser() user: { companyId: number },
    @Query('phone') phone?: string,
  ) {
    return this.shopifyService.listContactOrders(user.companyId, phone ?? '');
  }

  /**
   * Sync the store's products into the tenant's AI knowledge base. Owner/admin
   * only (writes KB + hits the Shopify Admin API).
   */
  @Post('sync-knowledge')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  syncKnowledge(@CurrentUser() user: { companyId: number }) {
    // Runs in the background (job queue) — a full catalogue sync (fetch +
    // embeddings + inserts) exceeds the platform's HTTP request timeout.
    return this.shopifyService.requestKnowledgeSync(user.companyId);
  }

  /** Indexed-knowledge status for the tenant (counts + last sync time). */
  @Get('knowledge-status')
  knowledgeStatus(@CurrentUser() user: { companyId: number }) {
    return this.shopifyService.knowledgeStatus(user.companyId);
  }

  /**
   * Reconcile cancelled/voided state for existing orders so ones cancelled
   * before cancellation accounting shipped stop counting. Owner/admin only
   * (hits the Shopify Admin API + rewrites order accounting). Background job.
   */
  @Post('sync-cancellations')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  syncCancellations(@CurrentUser() user: { companyId: number }) {
    return this.shopifyService.requestCancellationSync(user.companyId);
  }

  /**
   * Backfill order origin (abandoned-cart vs inbox) from the Shopify
   * "Abandoned Checkout" tag so historical recovery counts are correct.
   * Owner/admin only. Background job.
   */
  @Post('sync-order-sources')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  syncOrderSources(@CurrentUser() user: { companyId: number }) {
    return this.shopifyService.requestOrderSourceSync(user.companyId);
  }

  /**
   * Which Admin API scopes the store token holds. Diagnoses orders created
   * without a linked Shopify customer (needs read_customers + write_customers).
   */
  @Get('scopes')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  checkScopes(@CurrentUser() user: { companyId: number }) {
    return this.shopifyService.checkScopes(user.companyId);
  }
}
