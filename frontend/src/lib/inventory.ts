import { apiFetch, apiFetchEnvelope } from '@/lib/api';

export type StockStatus = 'in' | 'low' | 'out';

export interface InventoryVariant {
  id: number;
  storeId: number;
  variantGid: string;
  productTitle: string;
  variantTitle: string | null;
  image: string | null;
  handle?: string | null;
  productType?: string | null;
  vendor?: string | null;
  sku: string | null;
  barcode: string | null;
  price: number | null;
  shopifyQty: number;
  localQty: number;
  reorderLevel: number;
  costPrice: number | null;
  shelfLocation: string | null;
  category: string | null;
  notes: string | null;
  itemCode: string | null;
  alias: string | null;
  status: StockStatus;
  dirty: boolean;
  qtySyncedAt: string | null;
  lastPushedAt: string | null;
}

export interface InventoryMovement {
  id: number;
  delta: number;
  qtyAfter: number;
  reason: string;
  ref: string | null;
  actorUserId: number | null;
  createdAt: string;
}

export interface InventoryVariantDetail extends InventoryVariant {
  movements: InventoryMovement[];
}

export interface InventoryStats {
  skus: number;
  units: number;
  outCount: number;
  lowCount: number;
  stockValue: number;
}

export interface InventorySyncStatus {
  products: number;
  variants: number;
  lastSyncedAt: string | null;
}

export interface InventoryLookupHit {
  variantId: string;
  productTitle: string;
  variantTitle: string | null;
  price: string | null;
  sku: string | null;
  itemCode: string | null;
  alias: string | null;
  image: string | null;
  localQty: number;
  status: StockStatus;
  available: boolean;
}

export interface UpdateVariantInput {
  item_code?: string | null;
  alias?: string | null;
  reorder_level?: number;
  cost_price?: number | null;
  shelf_location?: string | null;
  category?: string | null;
  notes?: string | null;
  local_qty?: number;
}

export interface ListInventoryParams {
  storeId?: number;
  search?: string;
  status?: string;
  category?: string;
  page?: number;
  limit?: number;
}

export async function listInventory(
  params: ListInventoryParams,
): Promise<{ rows: InventoryVariant[]; total: number }> {
  const env = await apiFetchEnvelope<InventoryVariant[]>('/inventory', {
    params: {
      storeId: params.storeId,
      search: params.search || undefined,
      status: params.status && params.status !== 'all' ? params.status : undefined,
      category: params.category || undefined,
      page: params.page,
      limit: params.limit,
    },
  });
  const meta = env.meta as { total?: number } | undefined;
  return { rows: env.data, total: meta?.total ?? env.data.length };
}

export function getInventoryStats(storeId?: number): Promise<InventoryStats> {
  return apiFetch<InventoryStats>('/inventory/stats', { params: { storeId } });
}

export function getInventoryCategories(storeId?: number): Promise<string[]> {
  return apiFetch<string[]>('/inventory/categories', { params: { storeId } });
}

export function getInventorySyncStatus(
  storeId?: number,
): Promise<InventorySyncStatus> {
  return apiFetch<InventorySyncStatus>('/inventory/sync-status', {
    params: { storeId },
  });
}

export function syncInventory(storeId?: number): Promise<{ started: boolean }> {
  return apiFetch<{ started: boolean }>('/inventory/sync', {
    method: 'POST',
    body: { storeId },
  });
}

export function pushChanged(
  storeId?: number,
): Promise<{ queued: number }> {
  return apiFetch<{ queued: number }>('/inventory/push-changed', {
    method: 'POST',
    body: { storeId },
  });
}

export function getInventoryVariant(
  id: number,
): Promise<InventoryVariantDetail> {
  return apiFetch<InventoryVariantDetail>(`/inventory/variants/${id}`);
}

export function updateInventoryVariant(
  id: number,
  input: UpdateVariantInput,
): Promise<InventoryVariantDetail> {
  return apiFetch<InventoryVariantDetail>(`/inventory/variants/${id}`, {
    method: 'PATCH',
    body: input,
  });
}

export function pushInventoryVariant(id: number): Promise<{ queued: boolean }> {
  return apiFetch<{ queued: boolean }>(`/inventory/variants/${id}/push`, {
    method: 'POST',
  });
}

export function lookupInventory(
  q: string,
  storeId?: number,
): Promise<InventoryLookupHit[]> {
  return apiFetch<InventoryLookupHit[]>('/inventory/lookup', {
    params: { q, storeId },
  });
}

export function exportInventory(
  storeId?: number,
): Promise<{ filename: string; csv: string }> {
  return apiFetch<{ filename: string; csv: string }>('/inventory/export', {
    params: { storeId },
  });
}

export const STOCK_STATUS_META: Record<
  StockStatus,
  { label: string; dot: string; chip: string }
> = {
  in: {
    label: 'In stock',
    dot: 'bg-green-500',
    chip: 'text-green-700 bg-green-50 border-green-200',
  },
  low: {
    label: 'Low',
    dot: 'bg-amber-500',
    chip: 'text-amber-700 bg-amber-50 border-amber-200',
  },
  out: {
    label: 'Out',
    dot: 'bg-red-500',
    chip: 'text-red-700 bg-red-50 border-red-200',
  },
};

export const MOVEMENT_REASON_LABEL: Record<string, string> = {
  order_sale: 'Order sale',
  order_cancel: 'Order cancel / restore',
  return_restock: 'Return restock',
  manual_adjust: 'Manual adjustment',
  sync: 'Shopify sync',
  push: 'Pushed to Shopify',
};
