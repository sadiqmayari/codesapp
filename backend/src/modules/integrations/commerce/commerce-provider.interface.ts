/**
 * CommerceProvider — the provider-agnostic contract for a connected storefront
 * (Shopify or WooCommerce). The return shapes below are EXACTLY what the AI
 * agent (`ai-agent.service.ts`) and the create-order modal already consume from
 * `ShopifyService`, so adopting the interface is a no-behavior-change adaptation
 * for Shopify and the single surface a `WooCommerceService` must satisfy.
 *
 * Every method is tenant-scoped by `companyId` and store-scoped by an optional
 * `storeId` (omitted → the company's primary store, resolved by the provider).
 * The caller never branches on provider — `CommerceProviderResolver.forStore`
 * hands back the right implementation keyed on `shopify_stores.provider`.
 */

export const COMMERCE_PROVIDER_RESOLVER = 'COMMERCE_PROVIDER_RESOLVER';

export type CommerceProviderKind = 'shopify' | 'woocommerce';

/** One sellable unit (a Shopify variant / a Woo product or variation). */
export interface ProductHit {
  /** Shopify variant GID, or a Woo product/variation id as a string. */
  variantId: string;
  productTitle: string;
  /** '' when the variant has no distinguishing title ("Default Title"). */
  variantTitle: string;
  description: string | null;
  price: string;
  compareAtPrice: string | null;
  /** Server-computed so the AI relays it verbatim (grounding rule). */
  discountPercent: number | null;
  sku: string | null;
  image: string | null;
  productUrl: string | null;
  available: boolean;
}

export interface OrderLineItemInput {
  variantId?: string;
  title?: string;
  quantity: number;
  price?: number;
  discount?: { type: 'percentage' | 'fixed'; value: number };
}

export interface CreateOrderInput {
  lineItems: OrderLineItemInput[];
  customerName?: string;
  phone?: string;
  email?: string;
  address1?: string;
  city?: string;
  countryCode?: string;
  note?: string;
  tags?: string[];
  prepaid?: boolean;
  shippingLine?: { title: string; price: number };
  orderDiscount?: { type: 'percentage' | 'fixed'; value: number };
  customerId?: string;
  conversationId?: number;
  source?: 'abandoned_cart' | 'inbox';
  storeId?: number;
}

export interface CreateOrderResult {
  orderId: string;
  orderName: string;
  adminUrl: string;
}

export interface ShippingRateInput {
  lineItems: Array<{
    variantId?: string;
    title?: string;
    quantity: number;
    price?: number;
  }>;
  customerName?: string;
  phone?: string;
  address1?: string;
  city?: string;
  countryCode?: string;
}

export interface ShippingRate {
  handle: string;
  title: string;
  amount: string;
  currencyCode: string;
}

export interface CustomerHit {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
}

export interface CreateCustomerInput {
  customerName?: string;
  phone?: string;
  email?: string;
  address1?: string;
  city?: string;
  countryCode?: string;
}

export interface OrderStatusResult {
  found: boolean;
  error?: boolean;
  name?: string;
  orderId?: string;
  adminUrl?: string;
  fulfillmentStatus?: string;
  shipmentStatus?: string;
  financialStatus?: string;
  statusUpdatedAt?: string | null;
  tracking?: Array<{ url: string | null; number: string | null; company: string | null }>;
  customerPhone?: string | null;
  customerEmail?: string | null;
  shippingPhone?: string | null;
}

export interface CustomerOrdersResult {
  found: boolean;
  name?: string | null;
  email?: string | null;
  defaultAddress?: string | null;
  orders: Array<{
    name: string;
    createdAt: string;
    fulfillment?: string | null;
    financial?: string | null;
    total?: string | null;
  }>;
}

export interface LastOrderItemsResult {
  found: boolean;
  name?: string;
  shipping?: {
    name?: string;
    phone?: string;
    address1?: string;
    city?: string;
    countryCode?: string;
  };
  items: Array<{ title: string; quantity: number; variantId?: string }>;
}

export interface SyncKnowledgeResult {
  products: number;
  policies: number;
  mode: 'rag' | 'keyword';
}

/**
 * A provider webhook reduced to a provider-agnostic order event, so the orders
 * mirror can upsert without knowing the source. `nativeId` is the provider's own
 * order id (Shopify numeric id / Woo order id); the mirror turns it into the
 * identity key (`gid://...` for Shopify, `woo://{storeId}/{id}` for Woo).
 */
export interface NormalizedOrderEvent {
  type: 'created' | 'updated' | 'cancelled' | 'fulfilled';
  nativeId: string;
  raw: unknown;
}

export interface CommerceProvider {
  readonly kind: CommerceProviderKind;

  searchProducts(
    companyId: number,
    query: string,
    includeUnlisted?: boolean,
    storeId?: number,
  ): Promise<ProductHit[]>;

  createOrder(
    companyId: number,
    dto: CreateOrderInput,
    createdByUserId?: number,
  ): Promise<CreateOrderResult>;

  getShippingRates(
    companyId: number,
    dto: ShippingRateInput,
    storeId?: number,
  ): Promise<ShippingRate[]>;

  searchCustomer(
    companyId: number,
    params: { phone?: string; email?: string },
    storeId?: number,
  ): Promise<CustomerHit[]>;

  createCustomer(
    companyId: number,
    dto: CreateCustomerInput,
    storeId?: number,
  ): Promise<CustomerHit>;

  getOrderStatus(companyId: number, orderNumber: string): Promise<OrderStatusResult>;

  getCustomerOrders(
    companyId: number,
    phone: string,
    email?: string,
  ): Promise<CustomerOrdersResult>;

  getLastOrderItems(
    companyId: number,
    phone: string,
    email?: string,
  ): Promise<LastOrderItemsResult>;

  syncKnowledge(companyId: number, storeId?: number): Promise<SyncKnowledgeResult>;

  /** Cancel an order provider-side (RTO / return flow). */
  cancelOrder(companyId: number, orderGid: string, storeId?: number): Promise<void>;

  /** Verify an inbound webhook's signature against the store's secret. */
  verifyWebhook(rawBody: Buffer | string, signature: string, secret: string): boolean;

  /** Reduce a provider webhook (topic + parsed body) to a normalized event. */
  parseWebhook(topic: string, body: unknown): NormalizedOrderEvent | null;
}

/** Resolves the right CommerceProvider for a company's store. */
export interface CommerceProviderResolver {
  forStore(companyId: number, storeId?: number): Promise<CommerceProvider>;
  /** The provider kind for a store, without building the full provider. */
  kindForStore(companyId: number, storeId?: number): Promise<CommerceProviderKind>;
}
