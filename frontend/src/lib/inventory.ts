import { api, apiFetch, apiFetchEnvelope } from './api';

// ── Inventory v2 types ──────────────────────────────────────────────────────

export type StockStatus = 'in' | 'low' | 'out';
export type ProductStatus = 'active' | 'unlisted' | 'draft' | 'archived';

export interface InventoryPushHealth {
  /** true = token has the scope; false = missing; null = couldn't check. */
  writeInventory: boolean | null;
  writeProducts: boolean | null;
  writePublications?: boolean | null;
  shopDomain: string | null;
}

export interface ItemListing {
  id: number;
  storeId: number;
  storeLabel: string;
  provider: 'shopify' | 'woocommerce' | string;
  linkSource: string | null;
  productId: number | null;
  productStatus: ProductStatus | string | null;
  productStatusPush: string | null;
  productStatusError: string | null;
  price: number | null;
  compareAtPrice: number | null;
  storeQty: number;
  qtyPushStatus: string | null;
  qtyPushError: string | null;
  pricePushStatus: string | null;
  pricePushError: string | null;
  costPushStatus: string | null;
  costPushError: string | null;
}

export interface BundlePart {
  itemId: number;
  title: string;
  sku: string | null;
  quantity: number;
  available: number;
  limiting: boolean;
}

export interface InventoryItem {
  id: number;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  barcode: string | null;
  image: string | null;
  itemCode: string | null;
  alias: string | null;
  category: string | null;
  shelfLocation: string | null;
  reorderLevel: number;
  avgCost: number | null;
  track: boolean;
  allowBackorder: boolean;
  isBundle: boolean;
  available: number;
  committed: number;
  incoming: number;
  onHand: number;
  status: StockStatus;
  components: BundlePart[] | null;
  conflict: boolean;
  sold30: number;
  daysCover: number | null;
  priceMin: number | null;
  priceMax: number | null;
  listings: ItemListing[];
}

export interface ItemLocation {
  id: number;
  name: string;
  isActive: boolean;
  isDefault: boolean;
  storeIds: number[];
  available: number;
  committed: number;
  incoming: number;
  onHand: number;
  version: number;
}

export interface ItemDetail extends InventoryItem {
  reorderQty: number | null;
  leadTimeDays: number | null;
  notes: string | null;
  supplier: { id: number; name: string } | null;
  targetCoverDays: number;
  locations: ItemLocation[];
  costHistory: Array<{ at: string; oldCost: number | null; newCost: number | null; source: string; ref: string | null }>;
}

export interface InventorySummary {
  ready: boolean;
  currency: string | null;
  skus: number;
  availableUnits: number;
  stockValue: number;
  lowCount: number;
  outCount: number;
  incomingUnits: number;
  itemsWithoutCost: number;
  pushFailed: number;
  conflicts: number;
  unlinkedListings: number;
}

export interface Movement {
  id: number;
  at: string;
  itemId: number | null;
  item: string | null;
  sku: string | null;
  location: string | null;
  delta: number;
  after: number;
  reason: string;
  ref: string | null;
  refType: string | null;
  note: string | null;
  by: string | null;
}

export interface Conflict {
  itemId: number;
  title: string;
  locationId: number;
  location: string;
  pool: number;
  stores: Array<{ storeId: number; listingId: number; qty: number }>;
}

export interface InventoryLocation {
  id: number;
  name: string;
  address: string | null;
  isActive: boolean;
  isDefault: boolean;
  links: Array<{ id: number; storeId: number; storeLabel: string; externalName: string | null; syncEnabled: boolean }>;
}

export interface InventorySettings {
  allowBackorder: boolean;
  warnOverAvailable: boolean;
  lowStockAlerts: boolean;
  dailyDigest: boolean;
  adsOutOfStockAlert: boolean;
  backInStockOffer: boolean;
  restockReturns: boolean;
  targetCoverDays: number;
  defaultLeadTimeDays: number;
  countCadenceDays: number;
  reconcileMinutes: number;
}

export interface AvailabilityHit {
  variantId: string;
  storeId: number;
  itemId: number;
  productTitle: string;
  variantTitle: string | null;
  sku: string | null;
  itemCode: string | null;
  alias: string | null;
  shelf: string | null;
  image: string | null;
  price: string | null;
  tracked: boolean;
  available: number;
  sellable: boolean;
  productStatus: string | null;
}

export interface ItemQuery {
  search?: string;
  status?: string;
  category?: string;
  storeId?: number;
  locationId?: number;
  page?: number;
  limit?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
}

// ── Labels ─────────────────────────────────────────────────────────────────

export const STOCK_STATUS_META: Record<StockStatus, { label: string; tone: 'success' | 'warn' | 'danger' }> = {
  in: { label: 'In stock', tone: 'success' },
  low: { label: 'Low', tone: 'warn' },
  out: { label: 'Out', tone: 'danger' },
};

export const PRODUCT_STATUS_META: Record<ProductStatus, { label: string; hint: string; tone: 'success' | 'neutral' | 'warn' | 'danger' }> = {
  active: { label: 'Active', hint: 'Sold + visible', tone: 'success' },
  unlisted: { label: 'Unlisted', hint: 'Sold by link, hidden', tone: 'neutral' },
  draft: { label: 'Draft', hint: 'Not for sale yet', tone: 'warn' },
  archived: { label: 'Archived', hint: 'Retired, kept for history', tone: 'danger' },
};

export const MOVEMENT_REASON_LABEL: Record<string, string> = {
  sale: 'Order sale',
  cancel: 'Order cancelled',
  external: 'Changed in store',
  return: 'Return received',
  return_damaged: 'Return written off',
  po_receive: 'PO received',
  count: 'Stock count',
  adjust_damaged: 'Damaged',
  adjust_lost: 'Lost',
  adjust_found: 'Found',
  adjust_recount: 'Recount',
  adjust_gift: 'Gift / PR',
  adjust_other: 'Other',
  transfer_out: 'Transfer out',
  transfer_in: 'Transfer in',
  replacement_out: 'Replacement sent',
  set: 'Set by hand',
  import: 'CSV import',
  bootstrap: 'Starting stock',
  // legacy
  order_sale: 'Order sale',
  order_cancel: 'Order cancelled',
  return_restock: 'Return received',
  manual_adjust: 'Set by hand',
};

export const ADJUST_REASONS: Array<{ value: string; label: string }> = [
  { value: 'adjust_damaged', label: 'Damaged' },
  { value: 'adjust_lost', label: 'Lost' },
  { value: 'adjust_found', label: 'Found' },
  { value: 'adjust_recount', label: 'Recount' },
  { value: 'adjust_gift', label: 'Gift / PR' },
  { value: 'adjust_other', label: 'Other' },
];

// ── API ────────────────────────────────────────────────────────────────────

const qp = (q: ItemQuery) => ({
  search: q.search || undefined,
  status: q.status || undefined,
  category: q.category || undefined,
  storeId: q.storeId || undefined,
  locationId: q.locationId || undefined,
  page: q.page,
  limit: q.limit,
  sort: q.sort,
  dir: q.dir,
});

export async function listItems(q: ItemQuery, signal?: AbortSignal) {
  const env = await apiFetchEnvelope<InventoryItem[]>('/inventory/items', { params: qp(q), signal });
  return { rows: env.data ?? [], total: Number((env.meta as { total?: number } | undefined)?.total ?? 0) };
}

export const getSummary = (storeId?: number, locationId?: number, signal?: AbortSignal) =>
  apiFetch<InventorySummary>('/inventory/summary', { params: { storeId, locationId }, signal });

export const getCategories = () => apiFetch<string[]>('/inventory/categories');

export const getItem = (id: number) => apiFetch<ItemDetail>(`/inventory/items/${id}`);

export const itemForVariant = (variantId: number) =>
  apiFetch<{ itemId: number }>(`/inventory/variants/${variantId}/item`);

export const updateItem = (id: number, patch: Record<string, unknown>) =>
  apiFetch<ItemDetail>(`/inventory/items/${id}`, { method: 'PATCH', body: patch });

export const adjustItem = (id: number, body: { locationId: number; delta: number; reason: string; note?: string }) =>
  apiFetch<ItemDetail>(`/inventory/items/${id}/adjust`, { method: 'POST', body });

export const setItemAvailable = (id: number, body: { locationId?: number; available: number; seen?: number | null }) =>
  apiFetch<ItemDetail>(`/inventory/items/${id}/set`, { method: 'POST', body });

export const pushItem = (id: number) => apiFetch<{ queued: boolean }>(`/inventory/items/${id}/push`, { method: 'POST' });

export const updateListing = (id: number, body: { price?: number; compare_at_price?: number | null }) =>
  apiFetch<{ queued: boolean }>(`/inventory/listings/${id}`, { method: 'PATCH', body });

export const unlinkListing = (id: number) =>
  apiFetch<{ itemId: number }>(`/inventory/listings/${id}/link`, { method: 'DELETE' });

export const linkCandidates = (itemId: number, q?: string) =>
  apiFetch<Array<{ listingId: number; storeId: number; title: string; variantTitle: string | null; sku: string | null; image: string | null; itemId: number | null }>>(
    `/inventory/items/${itemId}/link-candidates`,
    { params: { q } },
  );

export const linkListing = (itemId: number, listingId: number) =>
  apiFetch<ItemDetail>(`/inventory/items/${itemId}/link`, { method: 'POST', body: { listingId } });

export const getConflicts = () => apiFetch<Conflict[]>('/inventory/conflicts');

export const resolveConflict = (body: { itemId: number; locationId: number; available: number }) =>
  apiFetch<{ ok: boolean }>('/inventory/conflicts/resolve', { method: 'POST', body });

export const bulkInventory = (body: {
  itemIds: number[];
  action: 'adjust' | 'category' | 'reorder' | 'track' | 'push';
  locationId?: number;
  delta?: number;
  reason?: string;
  note?: string;
  category?: string | null;
  reorderLevel?: number;
  track?: boolean;
}) => apiFetch<{ updated: number }>('/inventory/bulk', { method: 'POST', body });

export async function listMovements(
  q: { itemId?: number; locationId?: number; reason?: string; from?: string; to?: string; page?: number; limit?: number },
  signal?: AbortSignal,
) {
  const env = await apiFetchEnvelope<Movement[]>('/inventory/ledger', { params: q, signal });
  return { rows: env.data ?? [], total: Number((env.meta as { total?: number } | undefined)?.total ?? 0) };
}

export const getLocations = () => apiFetch<InventoryLocation[]>('/inventory/locations');
export const createLocation = (body: { name: string; address?: string | null }) =>
  apiFetch<InventoryLocation[]>('/inventory/locations', { method: 'POST', body });
export const updateLocation = (id: number, body: { name?: string; address?: string | null; isActive?: boolean; isDefault?: boolean }) =>
  apiFetch<InventoryLocation[]>(`/inventory/locations/${id}`, { method: 'PATCH', body });
export const updateLocationLink = (id: number, body: { locationId?: number; syncEnabled?: boolean }) =>
  apiFetch<InventoryLocation[]>(`/inventory/location-links/${id}`, { method: 'PATCH', body });

export const requestInventorySync = (storeId?: number) =>
  apiFetch<{ started: boolean; bootstrap?: boolean }>('/inventory/sync', { method: 'POST', body: storeId ? { storeId } : {} });

export const getSyncStatus = () =>
  apiFetch<{ ready: boolean; running: boolean; stores: Array<{ storeId: number; lastSyncedAt: string | null }> }>('/inventory/sync-status');

export const getInventorySettings = () => apiFetch<InventorySettings>('/inventory/settings');
export const saveInventorySettings = (patch: Partial<InventorySettings>) =>
  apiFetch<InventorySettings>('/inventory/settings', { method: 'PATCH', body: patch });

export const getAvailability = (body: { variantGids?: string[]; storeId?: number; q?: string }) =>
  apiFetch<{ allowBackorder: boolean; items: AvailabilityHit[] }>('/inventory/availability', { method: 'POST', body });

export function getInventoryPushHealth(storeId?: number): Promise<InventoryPushHealth> {
  return apiFetch<InventoryPushHealth>('/settings/shopify/inventory-push-health', { params: { storeId } });
}

async function download(path: string, params: Record<string, unknown>, name: string) {
  const res = await api.get(path, { params, responseType: 'blob' });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const downloadInventoryCsv = (q: ItemQuery) =>
  download('/inventory/export', qp(q), `inventory-${new Date().toISOString().slice(0, 10)}.csv`);

export const downloadLedgerCsv = (q: { itemId?: number; locationId?: number; reason?: string; from?: string; to?: string }) =>
  download('/inventory/ledger/export', q, `stock-ledger-${new Date().toISOString().slice(0, 10)}.csv`);

// ── Back-in-stock waitlist ─────────────────────────────────────────────────

export const addToWaitlist = (body: { variantGid?: string; itemId?: number; conversationId?: number; contactId?: number }) =>
  apiFetch<{ ok: boolean; itemId: number }>('/inventory/waitlist', { method: 'POST', body });
export const getWaitlist = (itemId: number) =>
  apiFetch<Array<{ contactId: number; name: string | null; phone: string | null; since: string }>>(`/inventory/items/${itemId}/waitlist`);
export const markWaitlistNotified = (itemId: number) =>
  apiFetch<{ cleared: number }>(`/inventory/items/${itemId}/waitlist/notified`, { method: 'POST' });
