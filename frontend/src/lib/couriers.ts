import { apiFetch, postMultipart } from '@/lib/api';

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

/** Sonic (Trax) Appendix B — item_product_type_id options. */
export const TRAX_PRODUCT_TYPES: Array<{ value: string; label: string }> = [
  { value: '1', label: 'Apparel' },
  { value: '2', label: 'Automotive Parts' },
  { value: '3', label: 'Accessories' },
  { value: '4', label: 'Personal Electronics (Mobile Phones, Laptops, etc.)' },
  { value: '5', label: 'Electronics Accessories (Cases, Chargers, etc.)' },
  { value: '6', label: 'Gadgets' },
  { value: '7', label: 'Jewellery' },
  { value: '8', label: 'Cosmetics' },
  { value: '9', label: 'Stationery' },
  { value: '10', label: 'Handicrafts' },
  { value: '11', label: 'Home-made Items' },
  { value: '12', label: 'Footwear' },
  { value: '13', label: 'Watches' },
  { value: '14', label: 'Leather Items' },
  { value: '15', label: 'Organic and Health Products' },
  { value: '16', label: 'Appliances and Consumer Electronics' },
  { value: '17', label: 'Home Decor and Interior Items' },
  { value: '18', label: 'Toys' },
  { value: '19', label: 'Pet Supplies' },
  { value: '20', label: 'Athletics and Fitness Items' },
  { value: '21', label: 'Vouchers and Coupons' },
  { value: '22', label: 'Marketplace' },
  { value: '23', label: 'Documents and Letters' },
  { value: '24', label: 'Other' },
];

export type CourierFieldType = 'secret' | 'text' | 'select' | 'toggle';

export interface CourierField {
  key: string;
  label: string;
  /** Defaults to 'secret' (masked password input, blank = keep saved). */
  type?: CourierFieldType;
  /** Static options for a 'select' field. */
  options?: Array<{ value: string; label: string }>;
  /** A 'select' whose options are loaded at runtime from an API. */
  dynamic?: 'traxPickupAddresses';
  /** Not required to save. */
  optional?: boolean;
  hint?: string;
}

/** Credential field shape per courier — mirrors each backend adapter's
 *  `Credentials` interface. Keep in sync when an adapter changes. */
export const COURIER_CREDENTIAL_FIELDS: Record<CourierType, CourierField[]> = {
  trax: [
    { key: 'bearerToken', label: 'Bearer token', type: 'secret' },
    {
      key: 'pickupAddressId',
      label: 'Pickup address',
      type: 'select',
      dynamic: 'traxPickupAddresses',
      hint: 'Loaded from your Trax account — save the token first if empty.',
    },
    {
      key: 'itemProductTypeId',
      label: 'Item product type',
      type: 'select',
      options: TRAX_PRODUCT_TYPES,
    },
    { key: 'itemInsurance', label: 'Insurance', type: 'toggle' },
    {
      key: 'specialInstructions',
      label: 'Special instructions',
      type: 'text',
      optional: true,
      hint: 'Printed on the air waybill (default: “Please call before delivery”).',
    },
  ],
  leopards: [
    { key: 'apiKey', label: 'API key', type: 'secret' },
    { key: 'apiPassword', label: 'API password', type: 'secret' },
    { key: 'courierName', label: 'Courier name', type: 'text' },
    { key: 'courierCode', label: 'Courier code', type: 'text' },
    // The pickup/origin ADDRESS id created in the Leopards portal (prints the
    // tenant's brand name + address on the label) — sent as `shipment_id`.
    {
      key: 'shipmentId',
      label: 'Shipment / pickup address ID (from Leopards portal)',
      type: 'text',
    },
  ],
  postex: [
    { key: 'token', label: 'API token', type: 'secret' },
    { key: 'pickupAddressCode', label: 'Pickup address code', type: 'text' },
  ],
  rocket: [
    { key: 'clientId', label: 'Client ID', type: 'text' },
    { key: 'token', label: 'Token', type: 'secret' },
    { key: 'storeId', label: 'Store ID', type: 'text' },
    // Rocket is a multi-carrier aggregator — this routes each booking to a
    // carrier: rocket=Rocket, 1=TCS, 21=TRAX, 3=LEO, 17=POSTEX. Blank = rocket.
    {
      key: 'service',
      label: 'Default carrier service (blank=Rocket; 17=PostEx, 21=Trax, 3=Leopards, 1=TCS)',
      type: 'text',
    },
  ],
};

export interface Shipment {
  id: number;
  shopify_order_gid: string;
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
  // Enriched from the order mirror (Shipments table shows Orders-style columns).
  customer_name?: string | null;
  phone?: string | null;
  order_city?: string | null;
  items_summary?: string | null;
  total_price?: number | null;
  total_outstanding?: number | null;
  currency?: string | null;
}

export interface CourierStatusRow {
  courierType: CourierType;
  configured: boolean;
  isActive: boolean;
  webhookUrl: string | null;
  updatedAt: string | null;
  /** Non-secret saved credential values, so the settings form pre-fills. */
  savedValues?: Record<string, string>;
  /** Which secret fields currently have a stored value. */
  secretSet?: Record<string, boolean>;
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
  /** Lifetime orders this customer (by phone) has placed. */
  customerOrdersCount: number | null;
  city: string | null;
  address: string | null;
  totalPrice: number | null;
  totalOutstanding: number | null;
  currency: string | null;
  items: QueueOrderItem[];
  itemsSummary: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  confirmationStatus:
    | 'confirmed'
    | 'no_response'
    | 'pending'
    | 'undeliverable'
    | 'cancelled'
    | 'none';
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
    trackingUrl?: string | null;
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

// Order-state slices, workload lanes, or any single shipment status.
export type QueueStatusFilter =
  | 'unfulfilled'
  | 'fulfilled'
  | 'all'
  | 'archived'
  | 'in_flight'
  | 'needs_attention'
  | ShipmentStatus;

/** Row ordering. 'oldest' is the board default — longest-waiting first. */
export type QueueSort = 'oldest' | 'newest' | 'value';

/** The four workload lanes the Orders board opens on. */
export type QueueLane = 'tobook' | 'inflight' | 'attention' | 'delivered';

export interface LaneCounts {
  toBook: { total: number; confirmed: number; awaiting: number };
  inFlight: { total: number; outForDelivery: number };
  needsAttention: {
    total: number;
    addressIssue: number;
    returned: number;
    failed: number;
  };
  delivered: { total: number };
}

/** Live counts for the four lanes, under the board's own filters. */
export function fulfillmentLaneCounts(params: {
  search?: string;
  courier?: CourierType;
  from?: string;
  to?: string;
} = {}) {
  const q = new URLSearchParams();
  if (params.search) q.set('search', params.search);
  if (params.courier) q.set('courier', params.courier);
  if (params.from) q.set('from', params.from);
  if (params.to) q.set('to', params.to);
  const qs = q.toString();
  return apiFetch<LaneCounts>(`/shipments/queue/lane-counts${qs ? `?${qs}` : ''}`);
}

export function listFulfillmentQueue(params: {
  search?: string;
  page?: number;
  pageSize?: number;
  status?: QueueStatusFilter;
  confirmation?: 'confirmed' | 'unconfirmed';
  courier?: CourierType;
  from?: string;
  to?: string;
  sort?: QueueSort;
} = {}) {
  const q = new URLSearchParams();
  if (params.search) q.set('search', params.search);
  if (params.page) q.set('page', String(params.page));
  if (params.pageSize) q.set('pageSize', String(params.pageSize));
  if (params.status && params.status !== 'unfulfilled') q.set('status', params.status);
  if (params.sort) q.set('sort', params.sort);
  if (params.confirmation) q.set('confirmation', params.confirmation);
  if (params.courier) q.set('courier', params.courier);
  if (params.from) q.set('from', params.from);
  if (params.to) q.set('to', params.to);
  const qs = q.toString();
  return apiFetch<QueueResult>(`/shipments/queue${qs ? `?${qs}` : ''}`);
}

/** Same as listFulfillmentQueue but restricted to a specific set of order GIDs
 *  (the "Show selected" view) — POST since the gid list can be large. */
export function listFulfillmentQueueByGids(params: {
  gids: string[];
  search?: string;
  page?: number;
  pageSize?: number;
  status?: QueueStatusFilter;
  confirmation?: 'confirmed' | 'unconfirmed';
  courier?: CourierType;
  from?: string;
  to?: string;
}) {
  return apiFetch<QueueResult>('/shipments/queue/by-gids', {
    method: 'POST',
    body: params,
  });
}

/** Batch-resolve ProductVariant gids → CDN image URLs for the Orders item
 *  popover. Best-effort — returns {} on any error / missing Shopify token. */
export function fetchVariantImages(
  variantIds: string[],
): Promise<Record<string, string>> {
  if (!variantIds.length) return Promise.resolve({});
  return apiFetch<Record<string, string>>('/shopify/variant-images', {
    method: 'POST',
    body: { variantIds },
  });
}

/** Manually flag an order's address as wrong (moves it to Address issue). */
export function markWrongAddress(orderGid: string, reason?: string) {
  return apiFetch<{ id: number }>('/shipments/mark-wrong-address', {
    method: 'POST',
    body: { orderGid, ...(reason ? { reason } : {}) },
  });
}

/**
 * Type-ahead city suggestions from the known courier cities (platform seed +
 * tenant overrides). Tenant-agnostic; free text is still allowed on the form.
 */
export function searchCities(query: string) {
  const q = query.trim();
  if (q.length < 2) return Promise.resolve<string[]>([]);
  return apiFetch<string[]>(`/shipments/cities?query=${encodeURIComponent(q)}`);
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
export function getQueueIds(
  params: {
    search?: string;
    status?: QueueStatusFilter;
    courier?: CourierType;
    from?: string;
    to?: string;
  } = {},
) {
  const q = new URLSearchParams();
  if (params.search) q.set('search', params.search);
  if (params.status && params.status !== 'unfulfilled') q.set('status', params.status);
  if (params.courier) q.set('courier', params.courier);
  if (params.from) q.set('from', params.from);
  if (params.to) q.set('to', params.to);
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
  /** Receivable split by age (see ReceivableAging). */
  aging: ReceivableAging;
  /** Days since the oldest still-unpaid delivery, or null when nothing is owed. */
  oldestDays: number | null;
  currency: string | null;
}

/** Receivable split by how long it has been owed. */
export interface ReceivableAging {
  d0_15: number;
  d16_30: number;
  d31_60: number;
  d60plus: number;
}

export interface PendingPaymentsSummary {
  couriers: PendingPaymentCourier[];
  totals: {
    receivable: number;
    receivableCount: number;
    inTransitCount: number;
    inTransitExpected: number;
    aging: ReceivableAging;
    oldestDays: number | null;
  };
  /** Delivered parcels owing nothing that were never stamped settled. */
  unstampedCount: number;
  currency: string | null;
}

export interface CourierShortfall {
  invoiceId: number;
  courier: CourierType;
  invoiceNumber: string | null;
  statementDate: string | null;
  orderName: string | null;
  trackingNumber: string | null;
  expectedCod: number;
  paidCod: number;
  shortfall: number;
  currency: string | null;
}

export interface ShortfallsResult {
  items: CourierShortfall[];
  truncated: boolean;
  couriers: Array<{ courier: CourierType; count: number; total: number }>;
  totals: { count: number; total: number };
  currency: string | null;
}

/** Parcels a courier's own statement short-paid, across applied statements. */
export function getCourierShortfalls() {
  return apiFetch<ShortfallsResult>('/shipments/pending-payments/shortfalls');
}

/** Stamp every delivered parcel that owes nothing as settled (housekeeping). */
export function stampZeroValueDelivered() {
  return apiFetch<{ settled: number }>(
    '/shipments/pending-payments/stamp-zero-value',
    { method: 'POST' },
  );
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

// Prepaid (non-COD) payment cards. delivered vs with-courier (in-transit) split.
export interface PrepaidBucket {
  deliveredCount: number;
  deliveredValue: number;
  inTransitCount: number;
  inTransitValue: number;
  currency: string | null;
}
export interface PrepaidPaymentsSummary {
  bankDeposit: PrepaidBucket;
  cardPayments: PrepaidBucket;
}
export interface PrepaidPaymentRow {
  shipmentId: number;
  orderName: string | null;
  orderNumber: string | null;
  courier: CourierType;
  city: string | null;
  status: ShipmentStatus;
  phone: string | null;
  gateway: string | null;
  value: number;
  currency: string | null;
  deliveredAt: string | null;
}

/** Bank Deposit + Card Payments summary cards (prepaid orders). */
export function getPrepaidPayments() {
  return apiFetch<PrepaidPaymentsSummary>('/shipments/prepaid-payments');
}

/** Drill-down list for a prepaid card: 'bank' | 'card'. */
export function listPrepaidPayments(params: {
  bucket: 'bank' | 'card';
  page?: number;
  pageSize?: number;
}) {
  const q = new URLSearchParams();
  q.set('bucket', params.bucket);
  if (params.page) q.set('page', String(params.page));
  if (params.pageSize) q.set('pageSize', String(params.pageSize));
  return apiFetch<{
    rows: PrepaidPaymentRow[];
    total: number;
    page: number;
    pageSize: number;
  }>(`/shipments/prepaid-payments/list?${q.toString()}`);
}

/** Mark Card-Payments orders reconciled (gateway payout landed). */
export function reconcileCardPayments(body: {
  shipmentIds?: number[];
  orderNumbers?: string[];
}) {
  return apiFetch<{ reconciled: number }>(
    '/shipments/prepaid-payments/reconcile',
    { method: 'POST', body },
  );
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
  sort?: 'value' | 'oldest';
} = {}) {
  const q = new URLSearchParams();
  if (params.courierType) q.set('courierType', params.courierType);
  if (params.bucket) q.set('bucket', params.bucket);
  if (params.page) q.set('page', String(params.page));
  if (params.pageSize) q.set('pageSize', String(params.pageSize));
  if (params.sort) q.set('sort', params.sort);
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

// ── Courier settlement invoices (upload → reconcile → apply) ───────────────

/** One parcel row on the courier's statement, plus how it matched CodesApp. */
export interface CourierInvoiceLine {
  trackingNumber: string;
  clientOrderId: string | null;
  status: string | null;
  paid: boolean;
  codAmount: number;
  shippingCharge: number;
  fuelSurcharge: number;
  gst: number;
  sst: number;
  wht: number;
  netTotal: number;
  city: string | null;
  customerName: string | null;
  qty: number | null;
  createdAt: string | null;
  matchedBy: 'tracking' | 'order' | 'none';
  shipmentId: number | null;
  orderName: string | null;
  ourStatus: string | null;
  expectedCod: number | null;
  codMismatch: boolean;
  willPromote: boolean;
  willSettle: boolean;
  alreadySettled: boolean;
}

export interface CourierInvoiceSummary {
  totalRows: number;
  paidRows: number;
  matched: number;
  unmatched: number;
  toPromote: number;
  toSettle: number;
  alreadySettled: number;
  codMismatches: number;
  unmatchedTracking: string[];
  codMismatchSamples: Array<{
    trackingNumber: string;
    orderName: string | null;
    invoiceCod: number;
    expectedCod: number | null;
  }>;
  promoteSamples: Array<{
    trackingNumber: string;
    orderName: string | null;
    ourStatus: string | null;
  }>;
  progress?: {
    processed: number;
    total: number;
    promoted: number;
    settled: number;
    /** COD orders marked PAID in Shopify. */
    markedPaid: number;
    /** Orders archived in Shopify. */
    archived: number;
    failed: number;
    finished: boolean;
    errors: string[];
  };
}

/** One deduction/charge component for the tax cards + breakup (mirrors backend). */
export interface CourierDeductionComponent {
  label: string;
  sublabel?: string;
  amount: number;
  /** false = show in the breakup only, not as a card. */
  card?: boolean;
}

export interface CourierInvoice {
  id: number;
  courierType: CourierType;
  courierName: string;
  invoiceNumber: string | null;
  chequeNumber?: string | null;
  reportDate: string | null;
  currency: string | null;
  sourceFileUrl: string | null;
  pdfUrl: string | null;
  status: 'parsed' | 'applying' | 'applied' | 'failed';
  totalRows: number;
  paidRows: number;
  codCollected: number | null;
  deductions: number | null;
  netPayable: number | null;
  appliedAt: string | null;
  createdAt: string;
}

export interface CourierInvoicePreview extends CourierInvoice {
  totals: {
    rows: number;
    paidRows: number;
    codCollected: number;
    shipping: number;
    fuel: number;
    tax: number;
    deductions: number;
    netPayable: number;
  };
  summary: CourierInvoiceSummary;
}

/** Which couriers have a statement parser today. */
export function supportedInvoiceCouriers() {
  return apiFetch<{ couriers: CourierType[] }>('/shipments/courier-invoices/supported');
}

/** Upload a courier statement → parsed + reconciled PREVIEW (no writes yet).
 *  `invoiceNumber` is only used when the file itself carries none (e.g. PostEx's
 *  CSV export has no CPR number) — the tenant can type it, else the server hashes
 *  the file for the dedup key. */
export function uploadCourierInvoice(
  courierType: CourierType,
  file: File,
  invoiceNumber?: string,
) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('courierType', courierType);
  if (invoiceNumber?.trim()) fd.append('invoiceNumber', invoiceNumber.trim());
  return postMultipart<CourierInvoicePreview>('/shipments/courier-invoices/upload', fd);
}

/** Apply a parsed statement — marks paid parcels delivered + settled (background). */
export function applyCourierInvoice(id: number) {
  return apiFetch<{ started: boolean; invoiceId: number; total: number }>(
    `/shipments/courier-invoices/${id}/apply`,
    { method: 'POST' },
  );
}

/** A manual settlement adjustment forcing net payable to match the courier's
 *  own portal total. `amount` is a SIGNED delta to net payable (negative reduces
 *  it). */
export interface CourierInvoiceAdjustment {
  label: string;
  amount: number;
}

/** Set / edit / clear the manual net-payable adjustment on an invoice. `amount`
 *  is the signed delta (0 clears it). Returns the refreshed invoice detail. */
export function setCourierInvoiceAdjustment(
  id: number,
  amount: number,
  label?: string,
) {
  return apiFetch<CourierInvoiceDetail>(
    `/shipments/courier-invoices/${id}/adjustment`,
    { method: 'POST', body: { amount, ...(label ? { label } : {}) } },
  );
}

export interface CourierInvoiceTotals {
  rows: number;
  paidRows: number;
  codCollected: number;
  shipping: number;
  fuel: number;
  tax: number;
  deductions: number;
  netPayable: number;
}

/** One invoice + its reconciliation (also the apply-progress poll). Carries the
 *  summary view (`totals` + `taxBreakdown` + `adjustment`) for the in-app View. */
export interface CourierInvoiceDetail extends CourierInvoice {
  summary: CourierInvoiceSummary;
  lines: CourierInvoiceLine[];
  totals: CourierInvoiceTotals;
  taxBreakdown: CourierDeductionComponent[] | null;
  adjustment: CourierInvoiceAdjustment | null;
}

export function getCourierInvoice(id: number) {
  return apiFetch<CourierInvoiceDetail>(`/shipments/courier-invoices/${id}`);
}

export function listCourierInvoices() {
  return apiFetch<CourierInvoice[]>('/shipments/courier-invoices');
}

/** Re-generate the branded statement PDF. */
export function courierInvoicePdf(id: number) {
  return apiFetch<{ url: string }>(`/shipments/courier-invoices/${id}/pdf`, {
    method: 'POST',
  });
}

/** Manually mark an order confirmed (no-WhatsApp / never answered the template). */
export function markOrderConfirmed(orderGid: string) {
  return apiFetch<{ ok: true }>('/shopify/orders/mark-confirmed', {
    method: 'POST',
    body: { orderGid },
  });
}

/** Mark an order "no response" (called an Awaiting / No-WhatsApp customer, no
 *  answer). Applies the "❌ NO RESPONSE" Shopify tag + the CodesApp badge. */
export function markOrderNoResponse(orderGid: string) {
  return apiFetch<{ ok: true }>('/shopify/orders/mark-no-response', {
    method: 'POST',
    body: { orderGid },
  });
}

/**
 * Manually (re)send the configured confirmation template. Pass `phone` to send
 * to an alternate number (the "Send to another number" action on No-WhatsApp
 * orders) — the order's own phone/address stay unchanged.
 */
export function resendConfirmation(orderGid: string, phone?: string) {
  return apiFetch<{ sent: boolean }>('/shopify/orders/resend-confirmation', {
    method: 'POST',
    body: phone ? { orderGid, phone } : { orderGid },
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
export type LineDiscount = { type: 'percentage' | 'fixed'; value: number } | null;
export function editOrderItems(
  orderGid: string,
  body: {
    updates?: Array<{
      variantId?: string | null;
      title?: string | null;
      quantity: number;
      discount?: LineDiscount;
    }>;
    adds?: Array<{ variantId: string; quantity: number; discount?: LineDiscount }>;
  },
) {
  return apiFetch<{ ok: true }>('/shopify/orders/edit-items', {
    method: 'POST',
    body: { orderGid, ...body },
  });
}

/** Bulk-book the selected orders (each uses its city-suggested courier). */
export function bulkBookShipments(
  orderGids: string[],
  courierType?: CourierType,
  courierByGid?: Record<string, CourierType>,
) {
  return apiFetch<{ queued: number }>('/shipments/bulk-book', {
    method: 'POST',
    body: {
      orderGids,
      ...(courierType ? { courierType } : {}),
      ...(courierByGid && Object.keys(courierByGid).length ? { courierByGid } : {}),
    },
  });
}

export interface BookingProgressRow {
  // null for a synthetic pre-flight-failure row (order never produced a shipment).
  shipmentId: number | null;
  orderGid: string;
  orderName: string | null;
  courier: CourierType | null;
  status: string | null;
  trackingNumber: string | null;
  error: string | null;
}

/** Poll the live state of a bulk-book batch by the order GIDs submitted. */
export function bookingProgress(orderGids: string[]) {
  return apiFetch<{ rows: BookingProgressRow[] }>('/shipments/booking-progress', {
    method: 'POST',
    body: { orderGids },
  });
}

// --- Bulk cancel (unbook / full cancel) -----------------------------------
export type BulkCancelMode = 'unbook' | 'cancel';

/**
 * Start a bulk cancel over the given order GIDs. `unbook` cancels the BOOKING
 * (courier + Shopify unfulfill) so each order returns to To-book — orders with
 * no active booking are skipped. `cancel` fully cancels + archives the ORDER.
 * Returns a batchId to poll via `bulkCancelProgress`.
 */
export function bulkCancelShipments(body: {
  mode: BulkCancelMode;
  orderGids: string[];
}) {
  return apiFetch<{ batchId: string; queued: number }>('/shipments/bulk-cancel', {
    method: 'POST',
    body,
  });
}

export interface BulkCancelProgress {
  batchId: string;
  mode: BulkCancelMode;
  total: number;
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  finished: boolean;
  errors: string[];
}

/** Poll a bulk-cancel batch's live counters. */
export function bulkCancelProgress(batchId: string) {
  return apiFetch<BulkCancelProgress>('/shipments/bulk-cancel/progress', {
    method: 'POST',
    body: { batchId },
  });
}

/** Edit an order's shipping address — writes to Shopify AND the local mirror. */
export function updateOrderAddress(body: {
  orderGid: string;
  name?: string;
  phone?: string;
  email?: string;
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
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
} = {}) {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.courierType) q.set('courierType', params.courierType);
  if (params.needsAttention) q.set('needsAttention', 'true');
  if (params.loadsheetPending) q.set('loadsheetPending', 'true');
  if (params.from) q.set('from', params.from);
  if (params.to) q.set('to', params.to);
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

export interface TrackingCheckpoint {
  status: string;
  detail?: string;
  at?: string;
}
export interface TrackingHistory {
  courier: CourierType;
  trackingNumber: string | null;
  status: ShipmentStatus;
  supported: boolean;
  checkpoints: TrackingCheckpoint[];
}
/** Native tracking checkpoint history for a shipment (couriers whose portal
 *  can't be embedded — Leopards). `supported:false` → use the iframe. */
export function getTrackingHistory(shipmentId: number) {
  return apiFetch<TrackingHistory>(`/shipments/${shipmentId}/tracking`);
}

export function suggestCourier(city: string) {
  return apiFetch<CourierSuggestion[]>(
    `/shipments/suggest-courier?city=${encodeURIComponent(city)}`,
  );
}

export function resolveAddressIssue(id: number) {
  return apiFetch<void>(`/shipments/${id}/resolve-address-issue`, { method: 'POST' });
}

/** Clear an address_issue WITHOUT booking — returns the order to "To book"
 *  (drops the shipment row) so the agent re-books deliberately. */
export function revertAddressIssue(id: number) {
  return apiFetch<{ reverted: boolean }>(`/shipments/${id}/revert-address-issue`, {
    method: 'POST',
  });
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

/** Build ONE downloadable PDF of the courier's slips, 2 per A4 page (single
 *  courier; Trax/PostEx/Rocket only — Leopards uses its own combined file). */
export function downloadSlips(shipmentIds: number[]) {
  return apiFetch<{ courier: string; url: string; parcels: number }>('/shipments/slips', {
    method: 'POST',
    body: { shipmentIds },
  });
}

/** Downloadable product pick sheet (aggregated quantities) for one loadsheet. */
export function loadsheetPicklist(batchId: number) {
  return apiFetch<{ url: string; skus: number; totalUnits: number; parcels: number }>(
    `/shipments/loadsheets/${batchId}/picklist`,
  );
}

/** Downloadable dispatch/invoice list (one row per order) for one loadsheet. */
export function loadsheetDispatchList(batchId: number) {
  return apiFetch<{ url: string; orders: number }>(
    `/shipments/loadsheets/${batchId}/dispatch-list`,
  );
}

/** 2-up slip PDF for every parcel on one loadsheet batch (byte-label couriers). */
export function loadsheetSlips(batchId: number) {
  return apiFetch<{ courier: string; url: string; parcels: number }>(
    `/shipments/loadsheets/${batchId}/slips`,
    { method: 'POST' },
  );
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

export interface StagingCourier {
  courier: CourierType;
  total: number;
  withTracking: number;
  oldestDays: number | null;
}

export interface StagingSummary {
  couriers: StagingCourier[];
  totals: { total: number; withTracking: number };
}

/** Per-courier "ready to manifest" counts + oldest-waiting age (Dispatch lane). */
export function loadsheetStaging() {
  return apiFetch<StagingSummary>('/shipments/loadsheets/staging');
}

export function listLoadsheets(params?: {
  courier?: CourierType;
  from?: string;
  to?: string;
}) {
  const q = new URLSearchParams();
  if (params?.courier) q.set('courier', params.courier);
  if (params?.from) q.set('from', params.from);
  if (params?.to) q.set('to', params.to);
  const qs = q.toString();
  return apiFetch<LoadsheetBatch[]>(
    `/shipments/loadsheets/list${qs ? `?${qs}` : ''}`,
  );
}

export function generateLoadsheet(courierType: CourierType) {
  return apiFetch<LoadsheetBatch>('/shipments/loadsheets/generate', {
    method: 'POST',
    body: { courierType },
  });
}

export interface TrackingLookup {
  shipmentId: number;
  orderName: string | null;
  courier: CourierType;
  status: ShipmentStatus;
  customerName: string | null;
  receivedAt: string | null;
}

/** Resolve a scanned AWB/CN barcode to an order (barcode-scan receive flow).
 *  Returns null when no shipment carries that tracking number. */
export function lookupByTracking(tn: string) {
  return apiFetch<TrackingLookup | null>(
    `/shipments/lookup-by-tracking?tn=${encodeURIComponent(tn)}`,
  );
}

/** Confirm a batch of scanned returns — enqueues the receive automation
 *  (mark returned + received + blacklist + Shopify cancel/archive per parcel). */
export function confirmScannedReturns(trackingNumbers: string[]) {
  return apiFetch<{ queued: number }>('/shipments/rto-receive/scan', {
    method: 'POST',
    body: { trackingNumbers },
  });
}

/**
 * How many parcels in a loadsheet scope are ready vs still booking (no tracking
 * yet). Call before generating so the user is warned about parcels that would be
 * silently left off the manifest. Scope = a courier OR a parcel selection.
 */
export function loadsheetReadiness(scope: {
  courierType?: CourierType;
  shipmentIds?: number[];
}) {
  return apiFetch<{ ready: number; pending: number; pendingNames: string[] }>(
    '/shipments/loadsheets/readiness',
    { method: 'POST', body: scope },
  );
}

/** One action → a loadsheet per courier for the selected parcels (parallel). */
export function generateLoadsheetsForSelection(shipmentIds: number[]) {
  return apiFetch<{
    batches: { id: number; courier: CourierType; count: number }[];
  }>('/shipments/loadsheets/generate-selection', {
    method: 'POST',
    body: { shipmentIds },
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

/** Trax pickup addresses for the dropdown (requires the token to be saved). */
export function getTraxPickupAddresses() {
  return apiFetch<Array<{ id: string; label: string }>>(
    '/settings/couriers/trax/pickup-addresses',
  );
}
