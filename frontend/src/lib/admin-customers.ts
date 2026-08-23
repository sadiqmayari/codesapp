import { apiFetch, api } from '@/lib/api';

/** A row from the CodesApp-owned customer registry (super-admin only). */
export interface AdminCustomer {
  id: number;
  phone: string;
  name: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  tags: unknown;
  origin_company_id: number;
  origin_company_name: string;
  origin_company_deleted_at: string | null;
  orders_count: number;
  total_order_value: number; // LTV (numified)
  avg_order_value: number; // AOV (numified)
  last_order_at: string | null;
  last_order_name: string | null;
  currency: string | null;
  first_seen_at: string;
  last_seen_at: string | null;
}

export interface AdminCustomersPage {
  items: AdminCustomer[];
  meta: { page: number; limit: number; total: number };
}

export type CustomerSort = 'ltv' | 'orders' | 'recent' | 'name';

export async function listAdminCustomers(params: {
  q?: string;
  sort?: CustomerSort;
  page?: number;
  limit?: number;
}): Promise<AdminCustomersPage> {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.sort) qs.set('sort', params.sort);
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiFetch<AdminCustomersPage>(`/super-admin/customers${suffix}`, {
    noOnboardingRedirect: true,
  });
}

/** Fetch the CSV (auth header attached by the axios instance) and save it. */
export async function downloadAdminCustomersCsv(params: {
  q?: string;
  sort?: CustomerSort;
}): Promise<void> {
  const res = await api.get('/super-admin/customers/export', {
    params,
    responseType: 'blob',
  });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'codesapp-customers.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
