import { apiFetch } from '@/lib/api';

/** A pending abandoned checkout (customer has not ordered today). */
export interface AbandonedCheckout {
  id: number;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  itemsSummary: string | null;
  recoveryUrl: string | null;
  totalPrice: number | null;
  currency: string | null;
  assignedUserId: number | null;
  assignedName: string | null;
  createdAt: string;
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
