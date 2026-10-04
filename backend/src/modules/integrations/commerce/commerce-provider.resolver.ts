import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ShopifyService } from '../shopify/shopify.service';
import { WooCommerceService } from './woocommerce.service';
import {
  CommerceProvider,
  CommerceProviderKind,
  CommerceProviderResolver,
  NormalizedOrderEvent,
} from './commerce-provider.interface';

/**
 * Resolves the right CommerceProvider for a company's store, keyed on
 * `shopify_stores.provider`. Callers (AI agent, the unified commerce controller,
 * couriers) depend on THIS, never on ShopifyService/WooCommerceService directly,
 * so adding a third provider is a new branch here and nothing else.
 *
 * ShopifyService is adapted through a thin delegate (rather than an invasive
 * `implements CommerceProvider` on the 354 KB class). WooCommerceService already
 * implements the interface directly.
 */
@Injectable()
export class CommerceResolverService implements CommerceProviderResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shopify: ShopifyService,
    private readonly woo: WooCommerceService,
  ) {}

  async kindForStore(companyId: number, storeId?: number): Promise<CommerceProviderKind> {
    // A store id pins the provider directly.
    if (storeId) {
      const store = await this.prisma.shopifyStore.findFirst({
        where: { id: storeId, company_id: companyId },
        select: { provider: true },
      });
      if (!store) throw new BadRequestException('Store not found.');
      return store.provider === 'woocommerce' ? 'woocommerce' : 'shopify';
    }
    // No id → honour a fixed-order-store lock, else the primary active store,
    // else fall back to Shopify (legacy single-store companies.shopify_* path).
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { order_fixed_store_id: true },
    });
    if (company?.order_fixed_store_id) {
      return this.kindForStore(companyId, company.order_fixed_store_id);
    }
    const primary = await this.prisma.shopifyStore.findFirst({
      where: { company_id: companyId, status: 'active' },
      orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
      select: { provider: true },
    });
    return primary?.provider === 'woocommerce' ? 'woocommerce' : 'shopify';
  }

  async forStore(companyId: number, storeId?: number): Promise<CommerceProvider> {
    const kind = await this.kindForStore(companyId, storeId);
    return kind === 'woocommerce' ? this.woo : this.shopifyAdapter();
  }

  /** Delegate that presents ShopifyService through the CommerceProvider shape. */
  private shopifyAdapter(): CommerceProvider {
    const s = this.shopify;
    return {
      kind: 'shopify',
      searchProducts: (c, q, inc, sid) => s.searchProducts(c, q, inc, sid),
      createOrder: (c, dto, uid) => s.createOrder(c, dto as any, uid),
      getShippingRates: (c, dto, sid) => s.getShippingRates(c, dto as any, sid),
      searchCustomer: (c, p, sid) => s.searchCustomer(c, p, sid),
      createCustomer: (c, dto, sid) => s.createCustomer(c, dto, sid),
      getOrderStatus: (c, n) => s.getOrderStatus(c, n),
      getCustomerOrders: (c, phone, email) => s.getCustomerOrders(c, phone, email),
      getLastOrderItems: (c, phone, email) => s.getLastOrderItems(c, phone, email),
      syncKnowledge: (c) => s.syncKnowledge(c),
      // Shopify RTO cancel/return is driven today through the existing
      // processReturn path (CouriersModule → ShopifyService), so this delegate
      // is a no-op for Shopify; Woo implements it directly.
      cancelOrder: async () => undefined,
      // Shopify keeps its own dedicated tenant-webhook controller with its own
      // HMAC verification, so these are not routed through the resolver.
      verifyWebhook: () => false,
      parseWebhook: (): NormalizedOrderEvent | null => null,
    };
  }
}
