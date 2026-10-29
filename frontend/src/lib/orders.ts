import { apiFetch } from '@/lib/api';

/** A pending abandoned checkout (customer has not ordered today). */
export interface AbandonedCheckout {
  id: number;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  itemsSummary: string | null;
  /** Structured cart lines (variant GID + price) — used to pre-fill an order. */
  items?: AbandonedCartItem[];
  recoveryUrl: string | null;
  totalPrice: number | null;
  currency: string | null;
  /** Which connected store this cart came from (null = single-store / unstamped). */
  storeId: number | null;
  storeLabel: string | null;
  assignedUserId: number | null;
  assignedName: string | null;
  /** Agent disposition: 'contacted' | 'not_interested' | 'no_response' | null. */
  agentOutcome: AbandonedOutcome | null;
  /** Shipping details Shopify sent with the checkout (null when not provided). */
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  countryCode: string | null;
  createdAt: string;
}

export type AbandonedOutcome = 'contacted' | 'not_interested' | 'no_response';

export interface AbandonedCartItem {
  /** Null for custom/deleted products — displayable but not pre-fillable. */
  variantId: string | null;
  title: string;
  variantTitle: string | null;
  price: string | null;
  quantity: number;
}

/** Abandoned-cart KPIs for the dashboard tile. */
export interface AbandonedStats {
  pending: number;
  valueAtRisk: number;
  recordedRecent: number;
  recovered: number;
  recoveredRevenue: number;
  recoveryRate: number;
  currency: string | null;
  everRecorded: number;
  webhookPath: string;
}

export interface OrderTracking {
  number: string | null;
  url: string | null;
  company: string | null;
}

/** One line item, enriched for the Shopify-style items popover. */
export interface OrderLineItem {
  title: string;
  quantity: number;
  variantTitle: string | null;
  productTitle: string | null;
  image: string | null;
}

/** An app-created Shopify order, attribution (local) + detail (Shopify). */
export interface CreatedOrderRow {
  orderGid: string;
  adminUrl: string | null;
  orderNo: string | null;
  dateCreated: string | null;
  items: OrderLineItem[];
  city: string | null;
  customerName: string | null;
  contactEmail: string | null;
  agentName: string | null;
  adHeadline: string | null;
  adSourceType: string | null;
  localStatus: string;
  orderValue: number | null;
  currency: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  tracking: OrderTracking[];
  /** Cancelled/voided on Shopify — kept as a record, excluded from all totals. */
  cancelledAt: string | null;
  cancelReason: string | null;
  /** This cancelled order is actually a RETURN (shipped, then came back). */
  returned: boolean;
}

export interface OrdersResult {
  rows: CreatedOrderRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: {
    totalOrders: number;
    totalValue: number;
    currency: string | null;
    byAgent: Array<{ name: string; orders: number; value: number }>;
  };
}

export type OrdersScope = 'agent' | 'ad';

export function listAbandonedCheckouts() {
  return apiFetch<AbandonedCheckout[]>('/shopify/abandoned-checkouts');
}

export function getAbandonedStats() {
  return apiFetch<AbandonedStats>('/shopify/abandoned-stats');
}

export function dismissAbandonedCheckout(id: number) {
  return apiFetch<{ dismissed: boolean }>(
    `/shopify/abandoned-checkouts/${id}/dismiss`,
    { method: 'POST' },
  );
}

/** Set (or clear) the agent disposition on one or many carts. null → New lane. */
export function setAbandonedOutcome(
  ids: number[],
  outcome: AbandonedOutcome | null,
) {
  return apiFetch<{ updated: number }>('/shopify/abandoned-checkouts/outcome', {
    method: 'POST',
    body: { ids, outcome },
  });
}

/** Manually WhatsApp the configured abandoned-cart template to one cart. */
export function sendAbandonedMessage(id: number) {
  return apiFetch<{ sent: boolean }>(
    `/shopify/abandoned-checkouts/${id}/send-message`,
    { method: 'POST' },
  );
}

export function assignAbandonedCheckout(id: number, userId: number | null) {
  return apiFetch<{ ok: boolean }>(
    `/shopify/abandoned-checkouts/${id}/assign`,
    { method: 'POST', body: { userId } },
  );
}

export function listCreatedOrders(
  scope: OrdersScope,
  opts: {
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
    search?: string;
  } = {},
) {
  return apiFetch<OrdersResult>('/shopify/orders/list', {
    params: {
      scope,
      from: opts.from,
      to: opts.to,
      page: opts.page,
      pageSize: opts.pageSize,
      search: opts.search || undefined,
    },
  });
}

// ── Native order-detail view (drawer + /orders/[no] page) ────────────────

export type OrderKey = { gid?: string; number?: string };

export interface OrderDetail {
  order: {
    orderGid: string;
    orderName: string | null;
    orderNumber: string | null;
    numericId: string | null;
    adminUrl: string | null;
    storeId: number | null;
    storeLabel: string | null;
    storeIsPrimary: boolean | null;
    customerName: string | null;
    phone: string | null;
    email: string | null;
    city: string | null;
    address1: string | null;
    address2: string | null;
    countryCode: string | null;
    totalPrice: number | null;
    totalOutstanding: number | null;
    currency: string | null;
    financialStatus: string | null;
    paymentGateway: string | null;
    gatewayReconciledAt: string | null;
    fulfillmentStatus: string | null;
    deliveryStatus: string | null;
    trackingCompany: string | null;
    trackingNumber: string | null;
    deliveredAt: string | null;
    cancelledAt: string | null;
    archivedAt: string | null;
    manualConfirmedAt: string | null;
    internalNote: string | null;
    courierInvoiceNumber: string | null;
    source: string | null;
    createdAt: string | null;
    publicTrackingUrl: string | null;
  };
  lineItems: Array<{ title?: string; quantity?: number; variantTitle?: string; price?: string }>;
  lineItemsSummary: string | null;
  /** Call logs on this order (agent + timestamp), newest first. */
  callLogs: Array<{ agent: string | null; at: string }>;
  createdByAgent: { id: number; name: string } | null;
  assignedAgent: { id: number; name: string } | null;
  shipment: {
    id: number;
    courierType: string;
    status: string;
    trackingNumber: string | null;
    trackingUrl: string | null;
    city: string | null;
    bookedAt: string | null;
    deliveredAt: string | null;
    cancelledAt: string | null;
    settledAt: string | null;
    invoiceId: number | null;
    loadsheetBatchId: number | null;
    lastStatusRaw: string | null;
    shipperAdvice: string | null;
  } | null;
  confirmation: { status: string; sentAt: string | null; updatedAt: string | null } | null;
  conversationId: number | null;
  /** True when the tenant has more than one connected store (gates store pills). */
  multiStore?: boolean;
}

export interface OrderLiveDetail {
  ok: boolean;
  reason?: string;
  tags?: string[];
  financialStatus?: string | null;
  fulfillmentStatus?: string | null;
  currency?: string | null;
  totalPrice?: number | null;
  subtotalPrice?: number | null;
  /** Order-level discount total + the codes/titles applied. */
  totalDiscounts?: number | null;
  discountApplications?: Array<{
    label: string | null;
    type: string | null;
    percentage: number | null;
    amount: number | null;
  }>;
  totalRefunded?: number | null;
  netPayment?: number | null;
  totalOutstanding?: number | null;
  transactions?: Array<{
    id: string;
    kind: string | null;
    status: string | null;
    gateway: string | null;
    processedAt: string | null;
    amount: number | null;
  }>;
  refunds?: Array<{ id: string; createdAt: string | null; note: string | null; amount: number | null }>;
  lineItems?: Array<{
    title: string;
    quantity: number;
    variantTitle: string | null;
    unitPrice: number | null;
    /** Pre-discount unit price; struck through when it differs from unitPrice. */
    originalUnitPrice?: number | null;
    /** Total discount allocated to this line (line + order-level), or null. */
    lineDiscount?: number | null;
    lineTotal: number | null;
    image: string | null;
  }>;
  timeline?: Array<{ at: string | null; message: string }>;
}

/** Instant mirror assembly of one order (customer, items, shipment, confirmation). */
export function getOrderDetail(key: OrderKey) {
  return apiFetch<OrderDetail>('/shopify/orders/detail', { params: key });
}

/** Live hydrate from Shopify — transactions, refunds, timeline, current items. */
export function getOrderDetailLive(key: OrderKey) {
  return apiFetch<OrderLiveDetail>('/shopify/orders/detail/live', { params: key });
}

export interface AssignableUser {
  id: number;
  name: string;
  role: string;
}

/** Teammates for the order assign dropdown. */
export function listAssignableUsers() {
  return apiFetch<AssignableUser[]>('/shopify/orders/assignable-users');
}

/** Current Shopify customer tags for a phone/email (inbox contact-drawer sync). */
export function getShopifyCustomerTags(params: { phone?: string; email?: string }) {
  return apiFetch<{ customerId: string | null; tags: string[] }>(
    '/shopify/customers/tags',
    { params },
  );
}

/** Set the Shopify customer's tags to exactly `tags` (adds new, removes dropped). */
export function setShopifyCustomerTags(body: {
  phone?: string;
  email?: string;
  tags: string[];
}) {
  return apiFetch<{ customerId: string | null; tags: string[] }>(
    '/shopify/customers/tags',
    { method: 'POST', body },
  );
}

/** Set/clear an order's assigned agent. */
export function assignOrder(orderGid: string, userId: number | null) {
  return apiFetch<{ ok: boolean; assignedUserId: number | null }>('/shopify/orders/assign', {
    method: 'POST',
    body: { orderGid, userId },
  });
}

/** Save the internal note (CodesApp-only, never synced to Shopify). */
export function updateOrderNote(orderGid: string, note: string) {
  return apiFetch<{ ok: boolean; internalNote: string | null }>('/shopify/orders/internal-note', {
    method: 'POST',
    body: { orderGid, note },
  });
}

/** Add / remove manual Shopify tags (other tags on the order are left intact). */
export function setOrderTags(orderGid: string, add: string[], remove: string[]) {
  return apiFetch<{ ok: boolean; changed: boolean }>('/shopify/orders/tags', {
    method: 'POST',
    body: { orderGid, add, remove },
  });
}
