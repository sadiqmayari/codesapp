import { apiFetch } from '@/lib/api';

/** A pending abandoned checkout (customer has not ordered today). */
export interface AbandonedCheckout {
  id: number;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  itemsSummary: string | null;
  recoveryUrl: string | null;
  createdAt: string;
}

/** An app-created Shopify order, attribution (local) + detail (Shopify). */
export interface CreatedOrderRow {
  orderGid: string;
  adminUrl: string | null;
  orderNo: string | null;
  dateCreated: string | null;
  items: Array<{ title: string; quantity: number }>;
  city: string | null;
  customerName: string | null;
  contactEmail: string | null;
  agentName: string | null;
  adHeadline: string | null;
  adSourceType: string | null;
  localStatus: string;
}

export type OrdersScope = 'agent' | 'ad';

export function listAbandonedCheckouts() {
  return apiFetch<AbandonedCheckout[]>('/shopify/abandoned-checkouts');
}

export function dismissAbandonedCheckout(id: number) {
  return apiFetch<{ dismissed: boolean }>(
    `/shopify/abandoned-checkouts/${id}/dismiss`,
    { method: 'POST' },
  );
}

export function listCreatedOrders(
  scope: OrdersScope,
  from?: string,
  to?: string,
) {
  return apiFetch<CreatedOrderRow[]>('/shopify/orders/list', {
    params: { scope, from, to },
  });
}
