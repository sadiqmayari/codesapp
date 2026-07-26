import { apiFetch } from '@/lib/api';

export type CourierType = 'trax' | 'leopards' | 'postex' | 'rocket';

export type ShipmentStatus =
  | 'booked'
  | 'in_transit'
  | 'out_for_delivery'
  | 'picked_up'
  | 'ready_for_pickup'
  | 'delivered'
  | 'attempted'
  | 'failed'
  | 'address_issue'
  | 'cancelled'
  | 'returned';

export const COURIER_TYPES: CourierType[] = ['trax', 'leopards', 'postex', 'rocket'];

export const COURIER_LABELS: Record<CourierType, string> = {
  trax: 'Trax',
  leopards: 'Leopards',
  postex: 'PostEx',
  rocket: 'Rocket',
};

export const STATUS_LABELS: Record<ShipmentStatus, string> = {
  booked: 'Booked',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  picked_up: 'Picked up',
  ready_for_pickup: 'Ready for pickup',
  delivered: 'Delivered',
  attempted: 'Attempted',
  failed: 'Failed',
  address_issue: 'Address issue',
  cancelled: 'Cancelled',
  returned: 'Returned',
};

/** Credential field shape per courier — mirrors each backend adapter's
 *  `Credentials` interface. Keep in sync when an adapter changes. */
export const COURIER_CREDENTIAL_FIELDS: Record<
  CourierType,
  Array<{ key: string; label: string }>
> = {
  trax: [
    { key: 'bearerToken', label: 'Bearer token' },
    { key: 'pickupAddressId', label: 'Pickup address ID' },
  ],
  leopards: [
    { key: 'apiKey', label: 'API key' },
    { key: 'apiPassword', label: 'API password' },
    { key: 'courierName', label: 'Courier name' },
    { key: 'courierCode', label: 'Courier code' },
    { key: 'shipmentId', label: 'Origin city / shipment ID' },
  ],
  postex: [
    { key: 'token', label: 'API token' },
    { key: 'pickupAddressCode', label: 'Pickup address code' },
  ],
  rocket: [
    { key: 'clientId', label: 'Client ID' },
    { key: 'token', label: 'Token' },
    { key: 'storeId', label: 'Store ID' },
  ],
};

export interface Shipment {
  id: number;
  shopify_order_name: string | null;
  courier_type: CourierType;
  courier_tracking_number: string | null;
  destination_city: string | null;
  destination_address: string | null;
  status: ShipmentStatus;
  address_issue_reason: string | null;
  last_courier_status_raw: string | null;
  last_status_reason: string | null;
  courier_slip_link: string | null;
  shipper_advice_status: string | null;
  shipper_advice_remarks: string | null;
  shipper_advice_at: string | null;
  booking_error: string | null;
  loadsheet_batch_id: number | null;
  created_at: string;
}

export interface CourierStatusRow {
  courierType: CourierType;
  configured: boolean;
  isActive: boolean;
  webhookUrl: string | null;
  updatedAt: string | null;
}

export interface LoadsheetBatch {
  id: number;
  courier_type: CourierType;
  status: string;
  courier_loadsheet_id: string | null;
  pdf_media_url: string | null;
  shipment_count: number;
  error: string | null;
  created_at: string;
}

export interface CourierSuggestion {
  courierType: CourierType;
  cityCode: string;
  isDefault: boolean;
}

export interface QueueOrderItem {
  title: string | null;
  quantity: number;
  variantTitle?: string | null;
  price?: string | null;
  variantId?: string | null;
}

export interface QueueOrder {
  orderGid: string;
  orderName: string | null;
  adminUrl: string | null;
  customerName: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  address: string | null;
  totalPrice: number | null;
  totalOutstanding: number | null;
  currency: string | null;
  items: QueueOrderItem[];
  itemsSummary: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  confirmationStatus: 'confirmed' | 'pending' | 'undeliverable' | 'cancelled' | 'none';
  archived: boolean;
  createdAt: string | null;
  suggestedCourier: CourierType | null;
  suggestedCityCode: string | null;
  availableCouriers: CourierType[];
  needsCityMapping: boolean;
  shipment: {
    id: number;
    status: ShipmentStatus;
    courierType: CourierType;
    trackingNumber: string | null;
    lastStatusReason?: string | null;
    shipperAdviceStatus?: string | null;
    slipLink?: string | null;
  } | null;
  assignedUserId: number | null;
  assignedName: string | null;
}

export interface QueueResult {
  rows: QueueOrder[];
  total: number;
  page: number;
  pageSize: number;
}

// Order-state slices + any shipment status (the Orders board's status chips).
export type QueueStatusFilter =
  | 'unfulfilled'
  | 'fulfilled'
  | 'all'
  | 'archived'
  | ShipmentStatus;

export function listFulfillmentQueue(params: {
  search?: string;
  page?: number;
  pageSize?: number;
  status?: QueueStatusFilter;
  confirmation?: 'confirmed' | 'unconfirmed';
} = {}) {
  const q = new URLSearchParams();
  if (params.search) q.set('search', params.search);
  if (params.page) q.set('page', String(params.page));
  if (params.pageSize) q.set('pageSize', String(params.pageSize));
  if (params.status && params.status !== 'unfulfilled') q.set('status', params.status);
  if (params.confirmation) q.set('confirmation', params.confirmation);
  const qs = q.toString();
  return apiFetch<QueueResult>(`/shipments/queue${qs ? `?${qs}` : ''}`);
}

/** Manually flag an order's address as wrong (moves it to Address issue). */
export function markWrongAddress(orderGid: string, reason?: string) {
  return apiFetch<{ id: number }>('/shipments/mark-wrong-address', {
    method: 'POST',
    body: { orderGid, ...(reason ? { reason } : {}) },
  });
}

/** Kick off the one-time (re-runnable) import of open Shopify orders. */
export function importShopifyOrders() {
  return apiFetch<{ started: boolean }>('/shopify/import-orders', {
    method: 'POST',
  });
}

/** Reconcile open mirror orders vs Shopify (fix manual archives/cancels). */
export function reconcileShopifyOrders() {
  return apiFetch<{ started: boolean }>('/shopify/orders/reconcile', {
    method: 'POST',
  });
}

/** All order GIDs matching a queue filter — for select-all-across-pages. */
export function getQueueIds(params: { search?: string; status?: QueueStatusFilter } = {}) {
  const q = new URLSearchParams();
  if (params.search) q.set('search', params.search);
  if (params.status && params.status !== 'unfulfilled') q.set('status', params.status);
  const qs = q.toString();
  return apiFetch<string[]>(`/shipments/queue/ids${qs ? `?${qs}` : ''}`);
}

/** Archive (or unarchive) orders in Shopify + hide them from the working queue. */
export function archiveOrders(orderGids: string[], archive = true) {
  return apiFetch<{ done: number; failed: number; errors: string[] }>(
    '/shopify/orders/archive',
    { method: 'POST', body: { orderGids, archive } },
  );
}

export interface PendingPaymentCourier {
  courier: CourierType;
  // Delivered COD owed now (amount + count of parcels carrying a balance).
  receivable: number;
  receivableCount: number;
  // Still with the courier (undelivered) — not collectable yet.
  inTransitCount: number;
  inTransitExpected: number;
  currency: string | null;
}

export interface PendingPaymentsSummary {
  couriers: PendingPaymentCourier[];
  totals: {
    receivable: number;
    receivableCount: number;
    inTransitCount: number;
    inTransitExpected: number;
  };
  currency: string | null;
}

export interface PendingPaymentRow {
  shipmentId: number;
  orderName: string | null;
  courier: CourierType;
  city: string | null;
  status: ShipmentStatus;
  phone: string | null;
  receivable: number;
  currency: string | null;
  deliveredAt: string | null;
}

/** Kick off a background courier status sync (owner/admin) — pulls fresh
 *  statuses from the couriers for every non-terminal shipment. */
export function syncCourierStatuses() {
  return apiFetch<{ started: boolean }>('/shipments/sync-status', {
    method: 'POST',
  });
}

/** Per-courier receivable (delivered COD owed) + in-transit buckets. */
export function getCourierPendingPayments() {
  return apiFetch<PendingPaymentsSummary>('/shipments/pending-payments');
}

/** Drill-down list for one bucket: 'receivable' (delivered COD) or 'transit'. */
export function listPendingPayments(params: {
  courierType?: CourierType;
  bucket?: 'receivable' | 'transit';
  page?: number;
  pageSize?: number;
} = {}) {
  const q = new URLSearchParams();
  if (params.courierType) q.set('courierType', params.courierType);
  if (params.bucket) q.set('bucket', params.bucket);
  if (params.page) q.set('page', String(params.page));
  if (params.pageSize) q.set('pageSize', String(params.pageSize));
  const qs = q.toString();
  return apiFetch<{
    rows: PendingPaymentRow[];
    total: number;
    page: number;
    pageSize: number;
  }>(`/shipments/pending-payments/list${qs ? `?${qs}` : ''}`);
}

/** Mark courier COD as remitted (by shipment ids, or a whole courier's batch). */
export function settlePayments(body: {
  shipmentIds?: number[];
  courierType?: CourierType;
}) {
  return apiFetch<{ settled: number }>('/shipments/pending-payments/settle', {
    method: 'POST',
    body,
  });
}

/** Manually mark an order confirmed (no-WhatsApp / never answered the template). */
export function markOrderConfirmed(orderGid: string) {
  return apiFetch<{ ok: true }>('/shopify/orders/mark-confirmed', {
    method: 'POST',
    body: { orderGid },
  });
}

/** Manually (re)send the configured confirmation template to the customer. */
export function resendConfirmation(orderGid: string) {
  return apiFetch<{ sent: boolean }>('/shopify/orders/resend-confirmation', {
    method: 'POST',
    body: { orderGid },
  });
}

export interface EditableLineItem {
  lineItemId: string;
  variantId: string | null;
  title: string;
  variantTitle: string | null;
  quantity: number;
  price: string | null;
  image: string | null;
}

/** Fetch an order's current line items for the in-app editor. */
export function getOrderEditable(orderGid: string) {
  return apiFetch<{
    fulfillmentStatus: string;
    editable: boolean;
    items: EditableLineItem[];
  }>('/shopify/orders/editable', { params: { orderGid } });
}

/** Commit item changes (qty/remove/add) to the Shopify order + mirror. */
export function editOrderItems(
  orderGid: string,
  body: {
    updates?: Array<{ variantId?: string | null; title?: string | null; quantity: number }>;
    adds?: Array<{ variantId: string; quantity: number }>;
  },
) {
  return apiFetch<{ ok: true }>('/shopify/orders/edit-items', {
    method: 'POST',
    body: { orderGid, ...body },
  });
}

/** Bulk-book the selected orders (each uses its city-suggested courier). */
export function bulkBookShipments(orderGids: string[], courierType?: CourierType) {
  return apiFetch<{ queued: number }>('/shipments/bulk-book', {
    method: 'POST',
    body: { orderGids, ...(courierType ? { courierType } : {}) },
  });
}

/** Edit an order's shipping address — writes to Shopify AND the local mirror. */
export function updateOrderAddress(body: {
  orderGid: string;
  name?: string;
  phone?: string;
  address1?: string;
  address2?: string;
  city?: string;
  countryCode?: string;
  zip?: string;
}) {
  return apiFetch<{ ok: true }>('/shopify/orders/update-address', {
    method: 'POST',
    body,
  });
}

export function listShipments(params: {
  status?: ShipmentStatus;
  courierType?: CourierType;
  needsAttention?: boolean;
  loadsheetPending?: boolean;
  page?: number;
  pageSize?: number;
} = {}) {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.courierType) q.set('courierType', params.courierType);
  if (params.needsAttention) q.set('needsAttention', 'true');
  if (params.loadsheetPending) q.set('loadsheetPending', 'true');
  if (params.page) q.set('page', String(params.page));
  if (params.pageSize) q.set('pageSize', String(params.pageSize));
  const qs = q.toString();
  return apiFetch<{
    rows: Shipment[];
    total: number;
    page: number;
    pageSize: number;
  }>(`/shipments${qs ? `?${qs}` : ''}`);
}

export function bookShipment(body: {
  shopifyOrderName: string;
  courierType?: CourierType;
  overrideAddressIssue?: boolean;
}) {
  return apiFetch<Shipment>('/shipments', {
    method: 'POST',
    body,
  });
}

export function suggestCourier(city: string) {
  return apiFetch<CourierSuggestion[]>(
    `/shipments/suggest-courier?city=${encodeURIComponent(city)}`,
  );
}

export function resolveAddressIssue(id: number) {
  return apiFetch<void>(`/shipments/${id}/resolve-address-issue`, { method: 'POST' });
}

export function redeliverShipment(id: number) {
  return apiFetch<void>(`/shipments/${id}/redeliver`, { method: 'POST' });
}

/** Send shipper advice on an attempted parcel: request a re-attempt or a return
 *  (works for PostEx/Trax/Leopards). */
export function sendShipperAdvice(
  id: number,
  action: 'reattempt' | 'return',
  remarks: string,
) {
  return apiFetch<{ ok: boolean }>(`/shipments/${id}/shipper-advice`, {
    method: 'POST',
    body: { action, remarks },
  });
}

/** Cancel/undo a booking: cancels at the courier, unfulfills the Shopify order,
 *  strips the courier tag, and returns the order to the To-book queue. */
export function cancelBooking(id: number) {
  return apiFetch<{ cancelledAtCourier: boolean; unfulfilled: boolean; freed: boolean }>(
    `/shipments/${id}/cancel-booking`,
    { method: 'POST' },
  );
}

export interface GeneratedLabel {
  shipmentId: number;
  trackingNumber: string;
  url: string;
}

/** Fetch printable shipping labels for the selected parcels (single courier). */
export function generateLabels(shipmentIds: number[]) {
  return apiFetch<{ courier: string; labels: GeneratedLabel[] }>('/shipments/labels', {
    method: 'POST',
    body: { shipmentIds },
  });
}

/**
 * A returned parcel was received back (RTO): blacklists the customer + cancels
 * & archives the order in Shopify. Destructive — confirm in the UI first.
 */
export function markShipmentReceived(id: number) {
  return apiFetch<{
    blacklisted: boolean;
    cancelled: boolean;
    archived: boolean;
    alreadyProcessed: boolean;
  }>(`/shipments/${id}/mark-received`, { method: 'POST' });
}

/** Bulk RTO "mark received" — by shipment ids or by order numbers (with/without #). */
export function bulkReceiveShipments(body: {
  shipmentIds?: number[];
  orderNames?: string[];
}) {
  return apiFetch<{ received: number; skipped: number; notFound: string[] }>(
    '/shipments/bulk-receive',
    { method: 'POST', body },
  );
}

export function listLoadsheets() {
  return apiFetch<LoadsheetBatch[]>('/shipments/loadsheets/list');
}

export function generateLoadsheet(courierType: CourierType) {
  return apiFetch<LoadsheetBatch>('/shipments/loadsheets/generate', {
    method: 'POST',
    body: { courierType },
  });
}

export interface CityCourierCell {
  courierType: CourierType;
  serves: boolean;
  cityCode: string | null;
  isDefault: boolean;
  active: boolean;
}

export interface CityCoverageRow {
  city: string;
  cityName: string;
  orders: number;
  defaultCourier: CourierType | null;
  couriers: CityCourierCell[];
}

export function getCityCoverage() {
  return apiFetch<CityCoverageRow[]>('/settings/couriers/city-coverage');
}

/** Make a courier the default for many cities at once. */
export function bulkSetDefaultCourier(courierType: CourierType, cities: string[]) {
  return apiFetch<{ set: number; skipped: string[] }>(
    '/settings/couriers/city-mappings/bulk-default',
    { method: 'PUT', body: { courierType, cities } },
  );
}

/** Clear the default-courier choice for many cities. */
export function clearDefaultCourier(cities: string[]) {
  return apiFetch<{ cleared: number }>(
    '/settings/couriers/city-mappings/clear-default',
    { method: 'PUT', body: { cities } },
  );
}

export interface CourierPerfRow {
  courier: string;
  total: number;
  delivered: number;
  returned: number;
  failed: number;
  inProgress: number;
  deliveryRate: number | null;
  returnRate: number | null;
  avgLeadDays: number | null;
}

export interface CourierPerfCity {
  city: string;
  total: number;
  couriers: Array<{
    courier: string;
    total: number;
    delivered: number;
    returned: number;
    failed: number;
    deliveryRate: number | null;
  }>;
}

export interface CourierPerformance {
  couriers: CourierPerfRow[];
  cities: CourierPerfCity[];
}

export function getCourierPerformance(params: { from?: string; to?: string } = {}) {
  const q = new URLSearchParams();
  if (params.from) q.set('from', params.from);
  if (params.to) q.set('to', params.to);
  const qs = q.toString();
  return apiFetch<CourierPerformance>(`/shipments/performance${qs ? `?${qs}` : ''}`);
}

export function getCourierSettings() {
  return apiFetch<CourierStatusRow[]>('/settings/couriers');
}

export function setCourierCredentials(
  courierType: CourierType,
  credentials: Record<string, string>,
) {
  return apiFetch<{ courierType: CourierType; webhookUrl: string }>(
    `/settings/couriers/${courierType}`,
    { method: 'PUT', body: { credentials } },
  );
}

export function deleteCourierCredentials(courierType: CourierType) {
  return apiFetch<void>(`/settings/couriers/${courierType}`, { method: 'DELETE' });
}
