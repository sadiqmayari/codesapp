import { api, apiFetch } from './api';

// ── Counts ──────────────────────────────────────────────────────────────────

export interface CountSummary {
  id: number;
  number: string;
  status: 'draft' | 'applied' | 'cancelled';
  location: string;
  scope: string | null;
  blind: boolean;
  lines: number;
  counted: number;
  variance: number;
  createdAt: string;
  appliedAt: string | null;
}

export interface CountDetail {
  id: number;
  number: string;
  status: 'draft' | 'applied' | 'cancelled';
  blind: boolean;
  scope: string | null;
  locationId: number;
  location: string;
  appliedAt: string | null;
  lines: Array<{
    itemId: number;
    title: string;
    sku: string | null;
    shelf: string | null;
    image: string | null;
    unitCost: number | null;
    expected: number | null;
    counted: number | null;
    variance: number | null;
    reason: string | null;
  }>;
}

export const listCounts = () => apiFetch<CountSummary[]>('/inventory/counts');
export const createCount = (body: { locationId: number; blind?: boolean; scope?: string; itemIds?: number[] }) =>
  apiFetch<CountDetail>('/inventory/counts', { method: 'POST', body });
export const getCount = (id: number) => apiFetch<CountDetail>(`/inventory/counts/${id}`);
export const scanCount = (id: number, body: { code?: string; itemId?: number; qty?: number }) =>
  apiFetch<CountDetail>(`/inventory/counts/${id}/scan`, { method: 'POST', body });
export const setCountLine = (id: number, itemId: number, body: { counted: number | null; reason?: string | null }) =>
  apiFetch<CountDetail>(`/inventory/counts/${id}/lines/${itemId}`, { method: 'PATCH', body });
export const applyCount = (id: number) => apiFetch<{ applied: number }>(`/inventory/counts/${id}/apply`, { method: 'POST' });
export const cancelCount = (id: number) => apiFetch<{ ok: boolean }>(`/inventory/counts/${id}/cancel`, { method: 'POST' });

// ── Transfers ───────────────────────────────────────────────────────────────

export interface TransferSummary {
  id: number;
  number: string;
  status: 'draft' | 'in_transit' | 'received' | 'cancelled';
  from: string;
  to: string;
  units: number;
  lines: number;
  note: string | null;
  createdAt: string;
  sentAt: string | null;
  receivedAt: string | null;
}

export interface TransferDetail extends Omit<TransferSummary, 'units' | 'lines' | 'createdAt'> {
  fromLocationId: number;
  toLocationId: number;
  lines: Array<{ itemId: number; qty: number; title: string; sku: string | null }>;
}

export const listTransfers = () => apiFetch<TransferSummary[]>('/inventory/transfers');
export const createTransfer = (body: { fromLocationId: number; toLocationId: number; note?: string; lines: Array<{ itemId: number; qty: number }> }) =>
  apiFetch<TransferDetail>('/inventory/transfers', { method: 'POST', body });
export const transferAction = (id: number, action: 'send' | 'receive' | 'cancel') =>
  apiFetch<TransferDetail>(`/inventory/transfers/${id}/${action}`, { method: 'POST' });

// ── Import ──────────────────────────────────────────────────────────────────

export interface ImportPreview {
  token: string;
  mode: 'set' | 'adjust';
  total: number;
  changes: number;
  errors: number;
  rows: Array<{ row: number; code: string; itemId: number | null; title: string | null; current: number | null; value: number | null; delta: number | null; cost: number | null; error: string | null }>;
}

export async function previewImport(file: File, locationId: number, mode: 'set' | 'adjust'): Promise<ImportPreview> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('locationId', String(locationId));
  fd.append('mode', mode);
  const res = await api.post('/inventory/import/preview', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
  return (res.data as { data: ImportPreview }).data;
}
export const applyImport = (token: string) =>
  apiFetch<{ stockChanges: number; costChanges: number }>('/inventory/import/apply', { method: 'POST', body: { token } });

// ── Suppliers ───────────────────────────────────────────────────────────────

export interface Supplier {
  id: number;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  leadTimeDays: number | null;
  items: number;
  openOrders: number;
  balance: number;
}

export const listSuppliers = (q?: string) => apiFetch<Supplier[]>('/inventory/suppliers', { params: { q } });
export const saveSupplier = (id: number | null, body: Partial<Omit<Supplier, 'id' | 'items' | 'openOrders' | 'balance'>> & { archived?: boolean }) =>
  apiFetch<Supplier[]>(id ? `/inventory/suppliers/${id}` : '/inventory/suppliers', { method: id ? 'PATCH' : 'POST', body });

// ── Purchase orders ─────────────────────────────────────────────────────────

export type PoStatus = 'draft' | 'sent' | 'partial' | 'received' | 'closed' | 'cancelled';

export interface PoSummary {
  id: number;
  number: string;
  status: PoStatus;
  supplier: string | null;
  location: string;
  units: number;
  received: number;
  total: number;
  expectedAt: string | null;
  createdAt: string;
}

export interface PoDetail {
  id: number;
  number: string;
  status: PoStatus;
  supplier: { id: number; name: string; phone: string | null; email: string | null } | null;
  locationId: number;
  location: string;
  expectedAt: string | null;
  sentAt: string | null;
  notes: string | null;
  freight: number;
  paid: number;
  itemsTotal: number;
  balance: number;
  createdAt: string;
  lines: Array<{ itemId: number; title: string; sku: string | null; image: string | null; currentCost: number | null; ordered: number; received: number; unitCost: number }>;
  receipts: Array<{ id: number; number: string; at: string; units: number; note: string | null }>;
}

export interface ReorderSuggestion {
  itemId: number;
  title: string;
  sku: string | null;
  image: string | null;
  supplierId: number | null;
  supplier: string | null;
  available: number;
  incoming: number;
  soldPerDay: number;
  leadTimeDays: number;
  daysCover: number | null;
  suggested: number;
  unitCost: number | null;
}

export const PO_STATUS_META: Record<PoStatus, { label: string; tone: 'neutral' | 'info' | 'warn' | 'success' | 'danger' }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  sent: { label: 'Sent', tone: 'info' },
  partial: { label: 'Partly received', tone: 'warn' },
  received: { label: 'Received', tone: 'success' },
  closed: { label: 'Closed', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
};

export const listPOs = (q: { status?: string; q?: string }) => apiFetch<PoSummary[]>('/inventory/purchase-orders', { params: q });
export const getPO = (id: number) => apiFetch<PoDetail>(`/inventory/purchase-orders/${id}`);
export const createPO = (body: {
  supplierId?: number | null;
  locationId: number;
  expectedAt?: string | null;
  notes?: string | null;
  freight?: number;
  lines: Array<{ itemId: number; qty: number; unitCost?: number | null }>;
}) => apiFetch<PoDetail>('/inventory/purchase-orders', { method: 'POST', body });
export const updatePO = (id: number, body: Record<string, unknown>) =>
  apiFetch<PoDetail>(`/inventory/purchase-orders/${id}`, { method: 'PATCH', body });
export const poAction = (id: number, action: 'send' | 'cancel') =>
  apiFetch<PoDetail>(`/inventory/purchase-orders/${id}/${action}`, { method: 'POST' });
export const receivePO = (id: number, body: { lines: Array<{ itemId: number; qty: number; unitCost?: number | null }>; freight?: number; note?: string }) =>
  apiFetch<PoDetail>(`/inventory/purchase-orders/${id}/receive`, { method: 'POST', body });
export const recordPoPayment = (id: number, amount: number) =>
  apiFetch<PoDetail>(`/inventory/purchase-orders/${id}/payment`, { method: 'POST', body: { amount } });
export const getReorderSuggestions = (q: { supplierId?: number; locationId?: number }) =>
  apiFetch<ReorderSuggestion[]>('/inventory/reorder-suggestions', { params: q });

// ── Warehouse item search (no cost / prices) ───────────────────────────────

export interface StockHit {
  id: number;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  image: string | null;
  shelfLocation: string | null;
  isBundle: boolean;
  available: number;
}
export const stockSearch = (q: string) => apiFetch<StockHit[]>('/inventory/stock-search', { params: { q } });
