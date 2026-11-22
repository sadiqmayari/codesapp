import { api, apiFetch } from './api';
import type { ProductStatus } from './inventory';

export interface CreateProductBody {
  title: string;
  descriptionHtml?: string | null;
  productType?: string | null;
  vendor?: string | null;
  tags?: string[];
  images?: string[];
  supplierId?: number | null;
  options: Array<{ name: string; values: string[] }>;
  variants: Array<{
    optionValues: string[];
    sku?: string | null;
    barcode?: string | null;
    price: number;
    compareAt?: number | null;
    cost?: number | null;
    stock?: Record<string, number>;
  }>;
  stores: Array<{ storeId: number; status: ProductStatus; priceDelta?: number | null }>;
}

export interface PublishJob {
  id: number;
  storeId: number;
  store: string;
  status: 'pending' | 'running' | 'ok' | 'error';
  error: string | null;
  productGid: string | null;
}

export const createProduct = (body: CreateProductBody) =>
  apiFetch<{ batchKey: string; itemIds: number[] }>('/inventory/products', { method: 'POST', body });
export const getPublishJobs = (batch: string) => apiFetch<PublishJob[]>('/inventory/products/jobs', { params: { batch } });
export const retryPublishJob = (id: number) => apiFetch<{ queued: boolean }>(`/inventory/products/jobs/${id}/retry`, { method: 'POST' });

export const previewStatus = (body: { productIds?: number[]; itemIds?: number[]; storeId?: number; status: ProductStatus }) =>
  apiFetch<{ changing: number; unchanged: number; perStore: Array<{ storeId: number; store: string; count: number }>; withStock: number }>(
    '/inventory/products/status/preview',
    { method: 'POST', body },
  );
export const setProductStatus = (body: { productIds?: number[]; itemIds?: number[]; storeId?: number; status: ProductStatus }) =>
  apiFetch<{ updated: number }>('/inventory/products/status', { method: 'POST', body });

export const describeProduct = (body: { title: string; notes?: string; productType?: string; options?: string }) =>
  apiFetch<{ html: string }>('/inventory/products/describe', { method: 'POST', body });

export async function uploadProductImage(file: File): Promise<{ path: string; url: string }> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await api.post('/inventory/products/images', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
  return (res.data as { data: { path: string; url: string } }).data;
}
