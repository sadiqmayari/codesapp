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
  assignedUserId: number | null;
  assignedName: string | null;
  createdAt: string;
}

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
    source: string | null;
    createdAt: string | null;
    publicTrackingUrl: string | null;
  };
  lineItems: Array<{ title?: string; quantity?: number; variantTitle?: string; price?: string }>;
  lineItemsSummary: string | null;
  createdByAgent: { id: number; name: string } | null;
  assignedAgent: { id: number; name: string } | null;
  shipment: {
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
}

export interface OrderLiveDetail {
  ok: boolean;
  reason?: string;
  financialStatus?: string | null;
  fulfillmentStatus?: string | null;
  currency?: string | null;
  totalPrice?: number | null;
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
