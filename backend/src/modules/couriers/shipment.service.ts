import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { CourierType, ShipmentStatus, Prisma, Shipment } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { CourierRegistryService } from './courier-registry.service';
import { CityMappingService } from './city-mapping.service';
import { CityCanonicalizerService } from './city-canonicalizer.service';
import { ShopifyFulfillmentClient } from './shopify-fulfillment-client.service';
import { ShopifyService } from '../integrations/shopify/shopify.service';
import { AddressQualityService } from './address-quality.service';
import { AddressIssueNotifier } from './address-issue-notifier.service';
import {
  COURIER_BOOKING_QUEUE,
  COURIER_BULK_BOOK_QUEUE,
  COURIER_BULK_CANCEL_QUEUE,
  COURIER_RTO_RECEIVE_QUEUE,
  COURIER_DISPLAY_NAME,
  SHIPMENT_STATUS_TO_SHOPIFY_EVENT,
  courierTrackingUrl,
} from './couriers.constants';
import { CourierOpsService } from './courier-ops.service';
import {
  formatLineItemsSummary,
  SummaryLineItem,
} from '../../common/utils/line-items-summary';

// Local contact tag added when a parcel is returned (RTO) — a visible marker in
// the inbox + contacts that this customer didn't receive the package and it
// came back. Same literal the Shopify CUSTOMER gets (CUSTOMER_BLACKLIST_TAG).
const RETURN_BLACKLIST_TAG = 'black list';

interface BookJobPayload {
  shipmentId: number;
  /** Intra-lane pacing: after this booking completes, hold the (per-courier
   *  serial-keyed) worker slot for this long so the NEXT booking on the SAME
   *  courier can't start yet. Bulk lanes set 10s; single manual bookings omit it. */
  throttleMs?: number;
}

interface RtoReceiveJobPayload {
  companyId: number;
  trackingNumbers: string[];
  userId?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Per-courier lane pacing for bulk booking: consecutive bookings on the SAME
// courier are spaced by this so a batch never hammers one courier's API.
// Different couriers run in parallel (different serial keys) and are unaffected.
const LANE_THROTTLE_MS = 6_000;

// How many parallel lanes each courier gets. A courier's bookings are sharded
// across this many serial keys, so up to LANE_PARALLELISM of them book at once
// (each shard still serial + throttled internally). This is what turns a big
// single-courier batch from a strict single file into N-wide — the dominant fix
// for "170 bookings took ~45 min to get tracking IDs". Keep ≤ the booking
// worker's concurrency (6) so one courier can't starve the others.
const LANE_PARALLELISM = 3;

// The serial key for the booking queue. Jobs sharing a key run one-at-a-time
// (a lane); different keys run in parallel. Sharded PER COURIER (by shipment id)
// so each courier runs LANE_PARALLELISM lanes concurrently instead of one.
function bookLaneKey(
  companyId: number,
  courier: CourierType,
  shipmentId: number,
): string {
  const shard = Math.abs(shipmentId) % LANE_PARALLELISM;
  return `book-lane:${companyId}:${courier}:${shard}`;
}

/**
 * PERMANENT = a data/state problem the tenant must fix (bad city/address/phone,
 * no courier for the city, order already fulfilled/cancelled). Retrying just
 * fails again, so we surface it immediately and do NOT retry. Everything else
 * (network blip, courier/Shopify 5xx/429/timeout, or an unrecognized error) is
 * treated as TRANSIENT and retried with backoff — never silently drop a booking.
 */
function isPermanentBookingError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /incomplete shipping|need name|no courier configured|no courier serves|city .*(not|unmapped|unknown|unserviceable|serviceable)|unmapped city|no open fulfillment|already has an active|already fulfilled|has no shipping address|not found|invalid (phone|address|city|number)|out of (service|delivery) area|no active .*credential|not configured|missing credential|invalid (api )?(key|token)|unauthor|authentication failed/.test(
    m,
  );
}

/** Pull a per-parcel label URL out of a courier's booking response (Leopards
 *  returns `slip_link`, top-level or inside packet_list). Best-effort. */
function extractSlipLink(raw: unknown): string | null {
  const r = raw as any;
  const link = r?.slip_link ?? r?.packet_list?.[0]?.slip_link ?? null;
  return typeof link === 'string' && /^https?:\/\//i.test(link) ? link : null;
}

interface BulkBookJobPayload {
  companyId: number;
  orderGids: string[];
  courierType?: CourierType;
  // Per-order courier overrides (orderGid → courier); used only when the
  // batch-wide `courierType` is absent (the per-row picker on the board).
  courierByGid?: Record<string, CourierType>;
  createdByUserId?: number;
  overrideAddressIssue?: boolean;
}

// Two flavours of bulk cancel:
//  - 'unbook'  = undo the booking (cancel at courier + unfulfill in Shopify +
//                free the order back to To-book). The Shopify ORDER stays alive.
//                Operates on shipment ids (only booked orders have one).
//  - 'cancel'  = fully cancel the ORDER (cancel courier booking if any, then
//                orderCancel + archive in Shopify + archive locally). Operates
//                on order GIDs so it works whether or not the order was booked.
type BulkCancelMode = 'unbook' | 'cancel';

interface BulkCancelJobPayload {
  companyId: number;
  batchId: string;
  mode: BulkCancelMode;
  orderGids: string[];
}

export interface BulkCancelProgress {
  batchId: string;
  mode: BulkCancelMode;
  total: number;
  processed: number;
  succeeded: number;
  // 'unbook' only: selected orders that had no cancellable booking (not an error).
  skipped: number;
  failed: number;
  finished: boolean;
  startedAt: number;
  finishedAt: number | null;
  errors: string[];
}

// Order-state slices + any shipment status (the Orders board's status chips).
export type QueueStatus =
  | 'unfulfilled'
  | 'fulfilled'
  | 'all'
  | 'archived'
  | ShipmentStatus;

// Statuses that count toward courier payments: delivered (receivable) + still
// in the pipeline (with courier). Returned/cancelled are excluded (dead).
const PAYMENT_ACTIVE_STATUSES: ShipmentStatus[] = [
  'delivered',
  'booked',
  'in_transit',
  'out_for_delivery',
  'picked_up',
  'ready_for_pickup',
  'attempted',
  'failed',
  'address_issue',
];

// Prepaid classification (Bank Deposit vs Card Payments) is GATEWAY-first and
// tenant-agnostic — never a hardcoded provider name. A gateway whose name matches
// this pattern is an OFFLINE method (cash/manual/bank deposit/COD): the money is
// settled out-of-band (already in the bank for a paid order). Anything NOT matching
// is treated as a REAL online payment gateway (PayFast, Stripe, etc.) whose payout
// settles later and needs reconciliation.
//
// IMPORTANT: match the offline *phrases*, not the bare word "bank". Online
// gateways describe their funding sources in the gateway name — e.g. PayFast is
// stored as "PAYFAST(Pay via Debit/Credit/Wallet/Bank Account)". A bare "bank"
// token matched the "Bank Account" in that label and wrongly dumped every PayFast
// order into the Bank Deposit card. "bank deposit"/"bank transfer" are still
// caught (via `deposit`/`transfer`), so real offline methods are unaffected.
const OFFLINE_GATEWAY_REGEXP =
  'cod|cash on delivery|manual|bank deposit|bank transfer|deposit|money order|offline|transfer|cheque';

// The ShipmentStatus values the board filters by (orders whose shipment has it).
const SHIPMENT_STATUS_VALUES: readonly string[] = [
  'booked',
  'in_transit',
  'out_for_delivery',
  'picked_up',
  'ready_for_pickup',
  'delivered',
  'attempted',
  'failed',
  'address_issue',
  'returned',
  'cancelled',
];

export interface BookShipmentParams {
  companyId: number;
  shopifyOrderName: string;
  courierType?: CourierType;
  createdByUserId?: number;
  /** Agent explicitly accepted an address-issue warning and wants to book anyway. */
  overrideAddressIssue?: boolean;
  /** Bulk lanes pass 10s so consecutive same-courier bookings are throttled;
   *  single manual bookings omit it (book immediately). */
  throttleMs?: number;
}

@Injectable()
export class ShipmentService implements OnModuleInit {
  private readonly logger = new Logger(ShipmentService.name);

  // Per-order bulk-book PRE-FLIGHT failures (order not found / already fulfilled
  // or cancelled / no shipping address / no courier for city). These throw INSIDE
  // `bookShipment` BEFORE any shipment row is created, so the live progress modal
  // — which polls shipment rows — would otherwise show them "Queued…" forever.
  // Keyed `${companyId}:${gid}`, kept in memory (the app is single-process; the
  // whole job poller / node-cache / sockets already assume that) and merged into
  // `bookingProgress` so the modal can resolve them to a real failure + reason.
  // Cleared when the order later books successfully; pruned by age on write.
  private readonly bulkPreflightErrors = new Map<
    string,
    { error: string; at: number }
  >();
  private static readonly PREFLIGHT_TTL_MS = 30 * 60 * 1000;

  private preflightKey(companyId: number, gid: string): string {
    return `${companyId}:${gid}`;
  }

  private prunePreflightErrors(): void {
    const cutoff = Date.now() - ShipmentService.PREFLIGHT_TTL_MS;
    for (const [k, v] of this.bulkPreflightErrors) {
      if (v.at < cutoff) this.bulkPreflightErrors.delete(k);
    }
  }

  // Live progress for a bulk-cancel batch, keyed by a server-issued batchId.
  // In-memory (single-process) like the pre-flight map; the modal polls it and
  // it's pruned by age on write. `errors` keeps a short sample for the UI.
  private readonly bulkCancelBatches = new Map<string, BulkCancelProgress>();
  private static readonly BULK_CANCEL_TTL_MS = 30 * 60 * 1000;

  private pruneBulkCancelBatches(): void {
    const cutoff = Date.now() - ShipmentService.BULK_CANCEL_TTL_MS;
    for (const [k, v] of this.bulkCancelBatches) {
      if ((v.finishedAt ?? v.startedAt) < cutoff) this.bulkCancelBatches.delete(k);
    }
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobQueue: JobQueueService,
    private readonly registry: CourierRegistryService,
    private readonly cityMapping: CityMappingService,
    private readonly cityCanonicalizer: CityCanonicalizerService,
    private readonly shopify: ShopifyFulfillmentClient,
    private readonly shopifyService: ShopifyService,
    private readonly addressQuality: AddressQualityService,
    private readonly addressIssueNotifier: AddressIssueNotifier,
    private readonly ops: CourierOpsService,
  ) {}

  onModuleInit(): void {
    // Courier booking = an external API call + a Shopify fulfillment write;
    // give it the same generous lease Shopify's own worker uses.
    // Concurrency 6 so a single courier's LANE_PARALLELISM(=3) lanes can all run
    // at once with headroom for a second courier / manual bookings. Per-courier
    // pacing (LANE_PARALLELISM lanes + the 6s intra-lane throttle) comes from the
    // job's serial_key + throttleMs, NOT this number. Lease 180s comfortably
    // exceeds one booking's pipeline (~15s) + the throttle it holds its slot for.
    this.jobQueue.registerWorker(
      COURIER_BOOKING_QUEUE,
      (p) => this.processBookingJob(p as BookJobPayload),
      6,
      180,
    );
    this.logger.log('Registered courier-booking worker (concurrency=6, lease=180s)');

    // Bulk booking = a fan-out orchestrator: it turns one "book these N orders"
    // request into N individual bookShipment calls (each of which either books
    // or flags an address issue), on its own queue so a big batch never starves
    // the single-order booking worker. Concurrency 1 per tenant keeps a bulk run
    // from hammering the Shopify Admin API.
    this.jobQueue.registerWorker(
      COURIER_BULK_BOOK_QUEUE,
      (p) => this.processBulkBookJob(p as BulkBookJobPayload),
      1,
      600,
    );
    this.logger.log('Registered courier-bulk-book worker (concurrency=1, lease=600s)');

    // Bulk cancel (unbook / full cancel) = another fan-out orchestrator; each
    // order hits the courier + Shopify Admin API, so keep it to one run per
    // tenant (concurrency 1) with a long lease for large selections.
    this.jobQueue.registerWorker(
      COURIER_BULK_CANCEL_QUEUE,
      (p) => this.processBulkCancelJob(p as BulkCancelJobPayload),
      1,
      600,
    );
    this.logger.log('Registered courier-bulk-cancel worker (concurrency=1, lease=600s)');

    // RTO receive (barcode scan) = a fan-out of confirmReceived over scanned
    // tracking numbers; each parcel hits the courier + Shopify Admin API, so keep
    // it to one run per tenant (concurrency 1) with a long lease. The scanner UI
    // is fire-and-forget — it enqueues here and the board updates as this drains.
    this.jobQueue.registerWorker(
      COURIER_RTO_RECEIVE_QUEUE,
      (p) => this.processRtoReceiveJob(p as RtoReceiveJobPayload),
      1,
      600,
    );
    this.logger.log('Registered courier-rto-receive worker (concurrency=1, lease=600s)');
  }

  /**
   * Enqueue a bulk booking. Returns immediately; each order is booked on the
   * worker and its outcome shows up as that order's shipment status in the
   * fulfilment queue (booked / address_issue / a booking_error) — so partial
   * failures surface per-order instead of failing the whole batch.
   */
  async bulkBook(
    companyId: number,
    orderGids: string[],
    opts: {
      courierType?: CourierType;
      courierByGid?: Record<string, CourierType>;
      createdByUserId?: number;
    } = {},
  ): Promise<{ queued: number }> {
    const unique = Array.from(new Set(orderGids.filter(Boolean))).slice(0, 500);
    if (!unique.length) {
      throw new BadRequestException('No orders selected.');
    }
    await this.jobQueue.enqueue(
      COURIER_BULK_BOOK_QUEUE,
      {
        companyId,
        orderGids: unique,
        courierType: opts.courierType,
        courierByGid: opts.courierByGid,
        createdByUserId: opts.createdByUserId,
      } satisfies BulkBookJobPayload,
      { maxAttempts: 1 }, // per-order errors are captured; no whole-batch retry
    );
    return { queued: unique.length };
  }

  /**
   * Live progress for a bulk-book batch: given the order GIDs the client
   * submitted, return each one's current shipment state so the UI can show a
   * per-order ticker (queued → booking → booked ✓ / failed ✗). A GID with no
   * shipment row yet is still being created (queued). Tenant-scoped.
   */
  async bookingProgress(companyId: number, orderGids: string[]) {
    const gids = Array.from(new Set(orderGids.filter(Boolean))).slice(0, 500);
    if (!gids.length) return { rows: [] as unknown[] };
    const ships = await this.prisma.shipment.findMany({
      where: { company_id: companyId, shopify_order_gid: { in: gids } },
      select: {
        id: true,
        shopify_order_gid: true,
        shopify_order_name: true,
        courier_type: true,
        status: true,
        courier_tracking_number: true,
        booking_error: true,
        address_issue_reason: true,
      },
    });
    const rows = ships.map((s) => ({
      shipmentId: s.id as number | null,
      orderGid: s.shopify_order_gid,
      orderName: s.shopify_order_name as string | null,
      courier: s.courier_type as CourierType | null,
      status: s.status as ShipmentStatus | null,
      trackingNumber: s.courier_tracking_number as string | null,
      error:
        s.booking_error ??
        (s.status === 'address_issue' ? s.address_issue_reason : null),
    }));

    // Merge PRE-FLIGHT failures for any requested order that produced NO shipment
    // row (e.g. already fulfilled/cancelled, no address). Without this the modal
    // shows them "Queued…" forever because there's nothing in `shipments` to poll.
    const haveRow = new Set(rows.map((r) => r.orderGid));
    for (const gid of gids) {
      if (haveRow.has(gid)) continue;
      const pf = this.bulkPreflightErrors.get(this.preflightKey(companyId, gid));
      if (!pf) continue;
      rows.push({
        shipmentId: null,
        orderGid: gid,
        orderName: null,
        courier: null,
        // No real shipment status — flag it failed via `error`; the frontend
        // classifies any row carrying an `error` (and no tracking) as failed.
        status: null,
        trackingNumber: null,
        error: pf.error,
      });
    }
    return { rows };
  }

  private async processBulkBookJob(payload: BulkBookJobPayload): Promise<void> {
    let booked = 0;
    let issues = 0;
    let failed = 0;
    for (const gid of payload.orderGids) {
      const order = await this.prisma.shopifyOrder.findUnique({
        where: {
          company_id_shopify_order_gid: {
            company_id: payload.companyId,
            shopify_order_gid: gid,
          },
        },
        select: { order_name: true },
      });
      const key = this.preflightKey(payload.companyId, gid);
      if (!order?.order_name) {
        failed++;
        this.prunePreflightErrors();
        this.bulkPreflightErrors.set(key, {
          error: 'Order not found in the local mirror — try Refresh, then re-book.',
          at: Date.now(),
        });
        continue;
      }
      // Courier precedence: batch-wide override → per-row override → let
      // bookShipment resolve the city-suggested courier (undefined).
      const courierType = payload.courierType ?? payload.courierByGid?.[gid];
      try {
        const shipment = await this.bookShipment({
          companyId: payload.companyId,
          shopifyOrderName: order.order_name,
          courierType,
          createdByUserId: payload.createdByUserId,
          overrideAddressIssue: payload.overrideAddressIssue,
          // Bulk = per-courier lanes: throttle consecutive same-courier bookings.
          throttleMs: LANE_THROTTLE_MS,
        });
        // A shipment row now exists → the progress modal reads it directly;
        // drop any stale pre-flight failure recorded for this order.
        this.bulkPreflightErrors.delete(key);
        if (shipment.status === 'address_issue') issues++;
        else booked++;
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        // A pre-flight throw means NO shipment row was created — stash the reason
        // so `bookingProgress` can surface it (else the modal spins forever).
        this.prunePreflightErrors();
        this.bulkPreflightErrors.set(key, { error: message, at: Date.now() });
        this.logger.warn(
          `Bulk book: order ${order.order_name} (company ${payload.companyId}) failed: ${message}`,
        );
      }
    }
    this.logger.log(
      `Bulk book complete (company ${payload.companyId}): booked=${booked} addressIssues=${issues} failed=${failed} of ${payload.orderGids.length}`,
    );
  }

  /**
   * Enqueue a bulk cancel. `mode` picks the flavour:
   *  - 'unbook' cancels the BOOKING for the given shipment ids (order stays alive,
   *    drops back to To-book).
   *  - 'cancel' fully cancels + archives the ORDER for the given order GIDs.
   * Returns a batchId the client polls via `getBulkCancelProgress`.
   */
  async bulkCancel(
    companyId: number,
    mode: BulkCancelMode,
    ids: { orderGids?: string[] },
  ): Promise<{ batchId: string; queued: number }> {
    const orderGids = Array.from(new Set((ids.orderGids ?? []).filter(Boolean))).slice(0, 500);
    if (!orderGids.length) throw new BadRequestException('No orders selected.');

    const batchId = `bulkcancel-${companyId}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    this.pruneBulkCancelBatches();
    this.bulkCancelBatches.set(batchId, {
      batchId,
      mode,
      total: orderGids.length,
      processed: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      finished: false,
      startedAt: Date.now(),
      finishedAt: null,
      errors: [],
    });

    await this.jobQueue.enqueue(
      COURIER_BULK_CANCEL_QUEUE,
      { companyId, batchId, mode, orderGids } satisfies BulkCancelJobPayload,
      { maxAttempts: 1 }, // per-order outcomes are recorded; no whole-batch retry
    );
    return { batchId, queued: orderGids.length };
  }

  /** Live counters for a bulk-cancel batch (polled by the client). */
  getBulkCancelProgress(companyId: number, batchId: string): BulkCancelProgress {
    const b = this.bulkCancelBatches.get(batchId);
    // batchId embeds the company; guard against cross-tenant polling.
    if (!b || !batchId.startsWith(`bulkcancel-${companyId}-`)) {
      throw new NotFoundException('Unknown or expired batch.');
    }
    return b;
  }

  private async processBulkCancelJob(payload: BulkCancelJobPayload): Promise<void> {
    const batch = this.bulkCancelBatches.get(payload.batchId);
    const done = (outcome: 'ok' | 'skip' | 'fail', err?: string) => {
      if (!batch) return;
      batch.processed++;
      if (outcome === 'ok') batch.succeeded++;
      else if (outcome === 'skip') batch.skipped++;
      else {
        batch.failed++;
        if (err && batch.errors.length < 20) batch.errors.push(err);
      }
    };

    for (const gid of payload.orderGids) {
      try {
        if (payload.mode === 'unbook') {
          const shipment = await this.prisma.shipment.findFirst({
            where: { company_id: payload.companyId, shopify_order_gid: gid },
            select: { id: true, status: true, shopify_order_name: true },
          });
          // Nothing booked (or already in a terminal state) → nothing to unbook.
          if (
            !shipment ||
            ['delivered', 'returned', 'cancelled'].includes(shipment.status)
          ) {
            done('skip');
            continue;
          }
          await this.ops.cancelBooking(payload.companyId, shipment.id);
          done('ok');
        } else {
          await this.cancelOrderFully(payload.companyId, gid);
          done('ok');
        }
      } catch (err) {
        done('fail', `${gid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (batch) {
      batch.finished = true;
      batch.finishedAt = Date.now();
    }
    this.logger.log(
      `Bulk cancel (${payload.mode}) complete (company ${payload.companyId}): ` +
        `succeeded=${batch?.succeeded ?? '?'} skipped=${batch?.skipped ?? '?'} ` +
        `failed=${batch?.failed ?? '?'} of ${batch?.total ?? '?'}`,
    );
  }

  /**
   * Fully cancel an ORDER: if it was booked, cancel the parcel at the courier
   * and mark the shipment cancelled; then cancel + archive the Shopify order
   * (and the local mirror). Deliberately does NOT blacklist the customer — this
   * is a plain cancellation, not an RTO/return. Every step is best-effort.
   */
  private async cancelOrderFully(companyId: number, orderGid: string): Promise<void> {
    const shipment = await this.prisma.shipment.findFirst({
      where: { company_id: companyId, shopify_order_gid: orderGid },
    });

    // Cancel the parcel at the courier while it's still cancellable.
    if (
      shipment &&
      !['delivered', 'returned', 'cancelled'].includes(shipment.status) &&
      shipment.courier_tracking_number
    ) {
      const adapter = this.registry.getAdapter(shipment.courier_type);
      if (adapter.cancelShipment) {
        const creds = await this.registry
          .requireCredentials(companyId, shipment.courier_type)
          .then((c) => c.creds)
          .catch(() => null);
        if (creds) {
          await adapter
            .cancelShipment(creds, shipment.courier_tracking_number)
            .catch((e) =>
              this.logger.warn(
                `cancelOrderFully: courier cancel failed for shipment ${shipment.id}: ${
                  e instanceof Error ? e.message : String(e)
                }`,
              ),
            );
        }
      }
    }

    // Mark our shipment cancelled (kept as a record, not deleted).
    if (shipment && shipment.status !== 'cancelled') {
      await this.prisma.shipment
        .update({
          where: { id: shipment.id },
          data: { status: 'cancelled', cancelled_at: shipment.cancelled_at ?? new Date() },
        })
        .catch(() => undefined);
    }

    // Cancel + archive the Shopify order and the local mirror (no blacklist).
    await this.shopifyService.processOrderReturn(companyId, orderGid);
  }

  async listCouriersForCity(
    companyId: number,
    city: string,
  ): Promise<{ courierType: CourierType; cityCode: string; isDefault: boolean }[]> {
    const active = await this.registry.getActiveCouriers(companyId);
    return this.cityMapping.suggestCourier(companyId, city, active);
  }

  /**
   * Full tracking checkpoint history for a shipment — powers the in-app tracking
   * timeline where the courier's public page can't be embedded in an iframe
   * (Leopards). `supported:false` tells the UI to fall back to the embedded
   * portal page / "open in new tab" link (couriers whose page embeds fine).
   */
  async getTrackingHistory(companyId: number, shipmentId: number) {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id: shipmentId, company_id: companyId },
      select: { courier_type: true, courier_tracking_number: true, status: true },
    });
    if (!shipment) throw new NotFoundException('Shipment not found.');
    const base = {
      courier: shipment.courier_type,
      trackingNumber: shipment.courier_tracking_number,
      status: shipment.status,
    };
    const adapter = this.registry.getAdapter(shipment.courier_type);
    if (!adapter?.queryTrackingHistory || !shipment.courier_tracking_number) {
      return { ...base, supported: false, checkpoints: [] };
    }
    const creds = await this.registry
      .getCredentials(companyId, shipment.courier_type)
      .catch(() => null);
    if (!creds) return { ...base, supported: false, checkpoints: [] };
    const checkpoints = await adapter
      .queryTrackingHistory(creds, shipment.courier_tracking_number)
      .catch(() => []);
    return { ...base, supported: true, checkpoints };
  }

  /**
   * Shared WHERE for the Orders board (queue list + select-all ids). Order-state
   * slices filter the mirror directly; a shipment-state (ShipmentStatus) resolves
   * to the orders whose CodesApp shipment has that status. Shipment-state views
   * do NOT force cancelled_at/archived_at null — a 'returned' order IS cancelled
   * + archived, yet must still appear under the Returned chip.
   */
  private async buildQueueWhere(
    companyId: number,
    search: string,
    status: QueueStatus,
    confirmation?: 'confirmed' | 'unconfirmed',
    courier?: CourierType,
    dateRange?: { from?: Date; to?: Date },
  ): Promise<Prisma.ShopifyOrderWhereInput> {
    const searchClause: Prisma.ShopifyOrderWhereInput = search
      ? {
          OR: [
            { order_name: { contains: search } },
            { customer_name: { contains: search } },
            { phone: { contains: search } },
            { city: { contains: search } },
          ],
        }
      : {};

    // Optional order-date window (the time-period selector). Filters the ORDERS
    // by shopify_created_at, applied on both the order-state and shipment-state
    // branches below.
    const dateClause: Prisma.ShopifyOrderWhereInput =
      dateRange && (dateRange.from || dateRange.to)
        ? {
            shopify_created_at: {
              ...(dateRange.from ? { gte: dateRange.from } : {}),
              ...(dateRange.to ? { lte: dateRange.to } : {}),
            },
          }
        : {};

    // Optional confirmation slice (To-book sub-tabs). Confirmed = the order was
    // manually confirmed OR the customer's confirmation-template reply was
    // 'confirmed'; unconfirmed = everything else (awaiting / no WhatsApp / none).
    const confirmationClause = await this.buildConfirmationClause(companyId, confirmation);

    if (SHIPMENT_STATUS_VALUES.includes(status)) {
      // A couple of tabs group two internal statuses: the Booked tab shows both
      // freshly-booked ('booked') and courier-confirmed ('ready_for_pickup')
      // parcels; the In transit tab absorbs the retired 'picked_up' (a pick is
      // just the first in-transit hop). Everything else is a 1:1 status match.
      const statusGroup: Partial<Record<string, ShipmentStatus[]>> = {
        booked: ['booked', 'ready_for_pickup'],
        in_transit: ['in_transit', 'picked_up'],
      };
      const statuses = statusGroup[status] ?? [status as ShipmentStatus];
      const ships = await this.prisma.shipment.findMany({
        where: {
          company_id: companyId,
          status: { in: statuses },
          ...(courier ? { courier_type: courier } : {}),
        },
        select: { shopify_order_gid: true },
        take: 20000,
      });
      const gids = ships.map((s) => s.shopify_order_gid);
      // Terminal-outcome tabs are actionable worklists: once the order is
      // closed (archived) the parcel's lifecycle is done and it belongs under
      // the Archived tab, not still cluttering these. Delivered is terminal too
      // — a delivered order whose Shopify order is archived is fully closed, so
      // it lives in Archived only (leaving Delivered = still-open delivered).
      // (Returned had 1493 rows of which ~1167 were already archived/received;
      // Delivered had ~8.3k archived of ~9.1k.)  Only the IN-FLIGHT tabs
      // (booked/in_transit/out_for_delivery/picked_up/ready_for_pickup) stay a
      // full record — those are open by definition anyway.
      const hideArchived = ['delivered', 'returned', 'failed', 'attempted'].includes(status);
      return {
        company_id: companyId,
        // A Shopify-cancelled order is closed — it shouldn't clutter ANY parcel
        // worklist (the order-state tabs already exclude it; the shipment-status
        // branch previously missed this, so cancelled returns/fails lingered).
        cancelled_at: null,
        ...(hideArchived ? { archived_at: null } : {}),
        // No matches → an impossible filter (empty result), not "all".
        shopify_order_gid: gids.length ? { in: gids } : { in: ['__none__'] },
        ...searchClause,
        ...confirmationClause,
        ...dateClause,
      };
    }

    const statusFilter: Prisma.ShopifyOrderWhereInput =
      status === 'archived'
        ? { archived_at: { not: null } }
        : status === 'unfulfilled'
          ? { fulfillment_status: 'unfulfilled', archived_at: null }
          : status === 'fulfilled'
            ? { fulfillment_status: { not: 'unfulfilled' }, archived_at: null }
            : { archived_at: null };

    // Courier filter on order-state tabs: the queue reads ORDERS (not shipments),
    // so resolve the orders that have a shipment on this courier and restrict to
    // them. An order with no shipment can't match a courier filter (by design).
    const courierClause: Prisma.ShopifyOrderWhereInput = {};
    if (courier) {
      const cs = await this.prisma.shipment.findMany({
        where: { company_id: companyId, courier_type: courier },
        select: { shopify_order_gid: true },
        take: 50000,
      });
      const cgids = cs.map((s) => s.shopify_order_gid);
      courierClause.shopify_order_gid = cgids.length ? { in: cgids } : { in: ['__none__'] };
    }

    // An order with an OPEN address_issue shipment belongs to the Address issue
    // tab ONLY — exclude it from To-book so a flagged wrong-address order stops
    // double-listing under Unfulfilled (all / confirmed / awaiting sub-tabs)
    // until it's resolved. Resolution releases it automatically: Resolve & book
    // flips the shipment to 'booked' (drops out of this set), Revert deletes the
    // shipment row. Top-level NOT so it never collides with the courier/
    // confirmation clauses, which both key on `shopify_order_gid`. Scoped to
    // 'unfulfilled' only — other tabs are unaffected.
    const addressIssueExclusion: Prisma.ShopifyOrderWhereInput = {};
    if (status === 'unfulfilled') {
      const flagged = await this.prisma.shipment.findMany({
        where: { company_id: companyId, status: 'address_issue' },
        select: { shopify_order_gid: true },
        take: 50000,
      });
      if (flagged.length) {
        addressIssueExclusion.NOT = {
          shopify_order_gid: { in: flagged.map((s) => s.shopify_order_gid) },
        };
      }
    }

    return {
      company_id: companyId,
      cancelled_at: null,
      ...statusFilter,
      ...courierClause,
      ...addressIssueExclusion,
      ...searchClause,
      ...confirmationClause,
      ...dateClause,
    };
  }

  /** gid IN/NOT-IN the set of confirmed orders (manual_confirmed_at set OR a
   *  'confirmed' confirmation message). Empty clause when no confirmation slice. */
  private async buildConfirmationClause(
    companyId: number,
    confirmation?: 'confirmed' | 'unconfirmed',
  ): Promise<Prisma.ShopifyOrderWhereInput> {
    if (!confirmation) return {};
    const [manual, replied, paid] = await Promise.all([
      this.prisma.shopifyOrder.findMany({
        where: { company_id: companyId, manual_confirmed_at: { not: null } },
        select: { shopify_order_gid: true },
        take: 50000,
      }),
      this.prisma.shopifyOrderMessage.findMany({
        where: { company_id: companyId, status: 'confirmed' },
        select: { shopify_order_gid: true },
        take: 50000,
      }),
      // Prepaid (paid) orders are confirmed-by-default — nothing to confirm.
      // The row badge already treats them as 'confirmed'; the sub-tab filter
      // must agree or a paid order shows a Confirmed badge under Awaiting.
      this.prisma.shopifyOrder.findMany({
        where: { company_id: companyId, financial_status: 'paid' },
        select: { shopify_order_gid: true },
        take: 50000,
      }),
    ]);
    const confirmedGids = Array.from(
      new Set([
        ...manual.map((r) => r.shopify_order_gid),
        ...replied.map((r) => r.shopify_order_gid).filter((g): g is string => !!g),
        ...paid.map((r) => r.shopify_order_gid),
      ]),
    );
    if (confirmation === 'confirmed') {
      return { shopify_order_gid: confirmedGids.length ? { in: confirmedGids } : { in: ['__none__'] } };
    }
    return confirmedGids.length ? { shopify_order_gid: { notIn: confirmedGids } } : {};
  }

  /**
   * The fulfilment QUEUE — unfulfilled Shopify orders from the local mirror,
   * enriched with a suggested courier (per city, memoized so 50 rows don't fan
   * out to hundreds of queries) and any shipment already booked for the order.
   * Reads the mirror only; no Shopify call. Feeds Phase C bulk fulfilment.
   */
  async listFulfillmentQueue(
    companyId: number,
    opts: {
      search?: string;
      page?: number;
      pageSize?: number;
      // Which slice to show. Order-state: 'unfulfilled' (default) = to book;
      // 'fulfilled' = shipped/record; 'all' = every open order; 'archived'.
      // Shipment-state (a ShipmentStatus, e.g. 'booked'/'in_transit'/'delivered'
      // /'returned'): orders whose CodesApp shipment has that status — the
      // Orders board's status chips. `includeFulfilled` is a back-compat alias.
      status?: QueueStatus;
      includeFulfilled?: boolean;
      // To-book sub-tab: only confirmed / only unconfirmed orders.
      confirmation?: 'confirmed' | 'unconfirmed';
      // Restrict to orders booked with a specific courier (Orders-board filter).
      courier?: CourierType;
      // Order-date window (time-period selector).
      from?: Date;
      to?: Date;
      // Restrict to exactly these order GIDs (the "Show selected" view) — ANDed
      // with every other filter above, so a selected row that no longer matches
      // the active tab/filters simply drops out rather than showing stale data.
      gids?: string[];
    } = {},
  ) {
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.floor(opts.pageSize ?? 50)));
    const search = (opts.search ?? '').trim();
    const status = opts.status ?? (opts.includeFulfilled ? 'all' : 'unfulfilled');
    const baseWhere = await this.buildQueueWhere(
      companyId,
      search,
      status,
      opts.confirmation,
      opts.courier,
      { from: opts.from, to: opts.to },
    );
    const where: Prisma.ShopifyOrderWhereInput =
      opts.gids && opts.gids.length
        ? { AND: [baseWhere, { shopify_order_gid: { in: opts.gids } }] }
        : opts.gids && opts.gids.length === 0
          ? { ...baseWhere, shopify_order_gid: { in: ['__none__'] } }
          : baseWhere;

    // Shop domain (once) for building a clickable Shopify-admin order link.
    const shopDomain = (
      await this.prisma.shopifyOrderConfig
        .findFirst({ where: { company_id: companyId }, select: { shop_domain: true } })
        .catch(() => null)
    )?.shop_domain?.replace(/^https?:\/\//, '').replace(/\/+$/, '') || null;

    const [total, rows] = await Promise.all([
      this.prisma.shopifyOrder.count({ where }),
      this.prisma.shopifyOrder.findMany({
        where,
        orderBy: { shopify_created_at: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    // Existing shipments for this page's orders (so the UI shows "already
    // booked" and disables re-selection).
    const gids = rows.map((r) => r.shopify_order_gid);
    const shipments = gids.length
      ? await this.prisma.shipment.findMany({
          where: { company_id: companyId, shopify_order_gid: { in: gids } },
          select: {
            id: true,
            shopify_order_gid: true,
            status: true,
            courier_type: true,
            courier_tracking_number: true,
            last_status_reason: true,
            shipper_advice_status: true,
            courier_slip_link: true,
          },
        })
      : [];
    const shipmentByGid = new Map(shipments.map((s) => [s.shopify_order_gid, s]));

    // Confirmation state per order (for the soft "not confirmed" flag). Truth =
    // the customer's own reply to the WhatsApp confirmation template
    // (shopify_order_messages.status: confirmed|pending|undeliverable|cancelled),
    // overridden to 'confirmed' when an agent manually confirmed the order.
    const orderMsgs = gids.length
      ? await this.prisma.shopifyOrderMessage.findMany({
          where: { company_id: companyId, shopify_order_gid: { in: gids } },
          select: { shopify_order_gid: true, status: true, updated_at: true },
          orderBy: { updated_at: 'desc' },
        })
      : [];
    const msgStatusByGid = new Map<string, string>();
    for (const m of orderMsgs) {
      // findMany is newest-first; keep the first (latest) per gid.
      if (!msgStatusByGid.has(m.shopify_order_gid)) {
        msgStatusByGid.set(m.shopify_order_gid, m.status);
      }
    }

    // Lifetime order count per customer phone (for the Customer popover's
    // "N orders"). One grouped count over this page's distinct phones.
    const phones = Array.from(
      new Set(rows.map((r) => r.phone).filter((p): p is string => !!p)),
    );
    const phoneCounts = phones.length
      ? await this.prisma.shopifyOrder.groupBy({
          by: ['phone'],
          where: { company_id: companyId, phone: { in: phones } },
          _count: { _all: true },
        })
      : [];
    const ordersByPhone = new Map(
      phoneCounts.map((c) => [c.phone, c._count._all]),
    );

    // Assigned agent names for this page.
    const userIds = Array.from(
      new Set(rows.map((r) => r.assigned_user_id).filter((v): v is number => v != null)),
    );
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds }, company_id: companyId },
          select: { id: true, name: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u.name]));

    // Suggested courier, memoized per distinct city (suggestCourier is
    // query-heavy; the queue commonly repeats cities).
    const active = await this.registry.getActiveCouriers(companyId);
    const suggestionCache = new Map<
      string,
      { courierType: CourierType; cityCode: string }[]
    >();
    // Full ranked list of couriers serving the city (default first). Top = the
    // suggestion; the rest let the UI offer a per-row/bulk courier override.
    const suggestFor = async (city: string | null) => {
      const key = (city ?? '').toLowerCase().trim();
      if (!key) return [];
      if (suggestionCache.has(key)) return suggestionCache.get(key)!;
      const s = await this.cityMapping.suggestCourier(companyId, city ?? '', active);
      const list = s.map((x) => ({ courierType: x.courierType, cityCode: x.cityCode }));
      suggestionCache.set(key, list);
      return list;
    };

    const out = [];
    for (const r of rows) {
      const serving = await suggestFor(r.city);
      const suggestion = serving[0] ?? null;
      const ship = shipmentByGid.get(r.shopify_order_gid) ?? null;
      const numericOrderId = r.shopify_order_gid.split('/').pop();
      out.push({
        orderGid: r.shopify_order_gid,
        orderName: r.order_name,
        // Clickable deep-link to the order in Shopify admin (null if no domain).
        adminUrl:
          shopDomain && numericOrderId
            ? `https://${shopDomain}/admin/orders/${numericOrderId}`
            : null,
        customerName: r.customer_name,
        phone: r.phone,
        email: r.email,
        // Lifetime orders this customer (by phone) has placed — Customer popover.
        customerOrdersCount: r.phone ? ordersByPhone.get(r.phone) ?? 1 : null,
        city: r.city,
        address: [r.address1, r.address2].filter(Boolean).join(', ') || null,
        totalPrice: r.total_price == null ? null : Number(r.total_price),
        totalOutstanding: r.total_outstanding == null ? null : Number(r.total_outstanding),
        currency: r.currency,
        items: (r.line_items as unknown) ?? [],
        itemsSummary: r.line_items_summary,
        financialStatus: r.financial_status,
        fulfillmentStatus: r.fulfillment_status,
        // 'confirmed' | 'no_response' | 'pending' | 'undeliverable' |
        // 'cancelled' | 'none'. Manual confirm wins; then the agent's
        // "no response" marker; then PREPAID orders are confirmed by default
        // (paid up front → nothing to confirm); else the customer's
        // confirmation-template reply; else 'none' (never attempted).
        confirmationStatus: r.manual_confirmed_at
          ? 'confirmed'
          : r.no_response_at
          ? 'no_response'
          : (r.financial_status ?? '').toLowerCase() === 'paid'
          ? 'confirmed'
          : (msgStatusByGid.get(r.shopify_order_gid) ?? 'none'),
        archived: r.archived_at != null,
        createdAt: r.shopify_created_at,
        suggestedCourier: suggestion?.courierType ?? null,
        suggestedCityCode: suggestion?.cityCode ?? null,
        // Every courier serving this city (default first) — the UI's per-row and
        // bulk courier override picks from here.
        availableCouriers: serving.map((s) => s.courierType),
        // No mapping for this city on any active courier → booking will refuse;
        // surface it so the agent can add a mapping or pick manually.
        needsCityMapping: !suggestion,
        shipment: ship
          ? {
              id: ship.id,
              status: ship.status,
              courierType: ship.courier_type,
              trackingNumber: ship.courier_tracking_number,
              // Public courier-portal tracking page for this parcel (so the
              // board can open it in a popup). Null when there's no tracking
              // number yet or the courier has no public tracking URL.
              trackingUrl: ship.courier_tracking_number
                ? courierTrackingUrl(ship.courier_type, ship.courier_tracking_number) ?? null
                : null,
              // Why the parcel is attempted/failed (courier reason) + the advice
              // already sent, so the board can show it and gate the advice action.
              lastStatusReason: ship.last_status_reason,
              shipperAdviceStatus: ship.shipper_advice_status,
              slipLink: ship.courier_slip_link,
            }
          : null,
        assignedUserId: r.assigned_user_id,
        assignedName: r.assigned_user_id ? userById.get(r.assigned_user_id) ?? null : null,
      });
    }
    return { rows: out, total, page, pageSize };
  }

  /**
   * All order GIDs matching a queue filter (for "select all N across pages").
   * Lean — GIDs only, capped. The caller's bulk action validates eligibility.
   */
  async listQueueIds(
    companyId: number,
    opts: {
      search?: string;
      status?: QueueStatus;
      courier?: CourierType;
      from?: Date;
      to?: Date;
    } = {},
  ): Promise<string[]> {
    const search = (opts.search ?? '').trim();
    const status = opts.status ?? 'unfulfilled';
    const where = await this.buildQueueWhere(companyId, search, status, undefined, opts.courier, {
      from: opts.from,
      to: opts.to,
    });
    const rows = await this.prisma.shopifyOrder.findMany({
      where,
      select: { shopify_order_gid: true },
      take: 5000,
    });
    return rows.map((r) => r.shopify_order_gid);
  }

  /**
   * Per-courier delivery performance over a date range (by order date). Reads
   * the ORDERS mirror — the `tracking_company` + `delivery_status` captured
   * from Shopify fulfillments/* webhooks — so it covers EVERY order (including
   * ones fulfilled outside CodesApp), not just app-booked shipments. Courier =
   * the store's `tracking_company` label. Also a per-city breakdown so the
   * tenant can see which courier delivers best where.
   */
  async courierPerformance(companyId: number, from: Date, to: Date) {
    const n = (v: bigint | number | null): number => (v == null ? 0 : Number(v));
    // Performance reads the SHIPMENTS table — the SAME authoritative source as
    // the Courier-payments tab (kept current by the courier status-sync +
    // webhooks) — so the two never disagree. (It used to read the orders mirror's
    // delivery_status, which the status-sync can't refresh for parcels with no
    // Shopify fulfilment link, making performance lag payments.) Joined to the
    // orders mirror only for the order date + destination city. Cancelled parcels
    // are excluded; a RETURN is the shipment reaching 'returned' (courier RTO),
    // a FAILED is a failed/attempted delivery, everything else in-flight is
    // in-progress. Grouped by the real courier, so Rocket bookings routed to a
    // sub-carrier still count under the courier the shipment was booked with.
    const DELIVERED = `(s.status = 'delivered')`;
    const RETURNED = `(s.status = 'returned')`;
    const FAILED = `(s.status IN ('failed','attempted','address_issue'))`;
    const INPROG = `(s.status IN ('booked','in_transit','out_for_delivery','picked_up','ready_for_pickup'))`;
    const POP = Prisma.raw(`s.status <> 'cancelled'`);
    const label = (courier: string) =>
      COURIER_DISPLAY_NAME[courier as CourierType] ?? courier;

    type Agg = {
      courier: string;
      total: bigint | number;
      delivered: bigint | number;
      returned: bigint | number;
      failed: bigint | number;
      in_progress: bigint | number;
      avg_lead_hours: number | null;
    };
    const rows = await this.prisma.$queryRaw<Agg[]>(Prisma.sql`
      SELECT s.courier_type AS courier,
        COUNT(*) AS total,
        SUM(${Prisma.raw(DELIVERED)}) AS delivered,
        SUM(${Prisma.raw(RETURNED)}) AS returned,
        SUM(${Prisma.raw(FAILED)}) AS failed,
        SUM(${Prisma.raw(INPROG)}) AS in_progress,
        AVG(CASE WHEN ${Prisma.raw(DELIVERED)} AND s.delivered_at IS NOT NULL AND o.shopify_created_at IS NOT NULL
              THEN TIMESTAMPDIFF(HOUR, o.shopify_created_at, s.delivered_at) END) AS avg_lead_hours
      FROM shipments s
      JOIN shopify_orders o
        ON o.company_id = s.company_id AND o.shopify_order_gid = s.shopify_order_gid
      WHERE s.company_id = ${companyId} AND ${POP}
        AND o.shopify_created_at BETWEEN ${from} AND ${to}
      GROUP BY s.courier_type
    `);

    const couriers = rows.map((r) => {
      const delivered = n(r.delivered);
      const returned = n(r.returned);
      const failed = n(r.failed);
      const resolved = delivered + returned + failed;
      return {
        courier: label(r.courier),
        total: n(r.total),
        delivered,
        returned,
        failed,
        inProgress: n(r.in_progress),
        // Rates over RESOLVED shipments only (in-progress excluded).
        deliveryRate: resolved ? delivered / resolved : null,
        returnRate: delivered + returned ? returned / (delivered + returned) : null,
        avgLeadDays: r.avg_lead_hours != null ? Number(r.avg_lead_hours) / 24 : null,
      };
    });

    type CityAgg = {
      city: string | null;
      courier: string;
      total: bigint | number;
      delivered: bigint | number;
      returned: bigint | number;
      failed: bigint | number;
    };
    const cityRows = await this.prisma.$queryRaw<CityAgg[]>(Prisma.sql`
      SELECT o.city AS city, s.courier_type AS courier,
        COUNT(*) AS total,
        SUM(${Prisma.raw(DELIVERED)}) AS delivered,
        SUM(${Prisma.raw(RETURNED)}) AS returned,
        SUM(${Prisma.raw(FAILED)}) AS failed
      FROM shipments s
      JOIN shopify_orders o
        ON o.company_id = s.company_id AND o.shopify_order_gid = s.shopify_order_gid
      WHERE s.company_id = ${companyId} AND ${POP}
        AND o.city IS NOT NULL AND o.city <> ''
        AND o.shopify_created_at BETWEEN ${from} AND ${to}
      GROUP BY o.city, s.courier_type
    `);
    // City is customer-typed free text ("North Karachi", "karachi pakistan",
    // "saddar karachi", typos, mixed casing), so grouping by the raw string
    // splinters one real city into dozens of near-duplicate rows. Resolve every
    // raw city onto a CANONICAL Pakistani city (the seeded courier city list)
    // via CityCanonicalizerService, then group by that — the display label is
    // the canonical Title-cased name. Unresolved cities keep their cleaned text.
    const canon = await this.cityCanonicalizer.canonicalizeMany(
      cityRows.map((c) => (c.city as string).trim()),
    );
    const byCity = new Map<
      string,
      {
        city: string;
        total: number;
        couriers: Map<
          string,
          { courier: string; total: number; delivered: number; returned: number; failed: number }
        >;
      }
    >();
    for (const c of cityRows) {
      const raw = (c.city as string).trim();
      const resolved = canon.get(raw);
      const key = resolved?.key || raw.toLowerCase();
      if (!key) continue;
      let entry = byCity.get(key);
      if (!entry) {
        entry = { city: resolved?.display || raw, total: 0, couriers: new Map() };
        byCity.set(key, entry);
      }
      const delivered = n(c.delivered);
      const returned = n(c.returned);
      const failed = n(c.failed);
      const total = n(c.total);
      entry.total += total;
      const cl = label(c.courier);
      const cur = entry.couriers.get(cl);
      if (cur) {
        cur.total += total;
        cur.delivered += delivered;
        cur.returned += returned;
        cur.failed += failed;
      } else {
        entry.couriers.set(cl, { courier: cl, total, delivered, returned, failed });
      }
    }
    const cities = Array.from(byCity.values())
      .map((e) => ({
        city: e.city,
        total: e.total,
        couriers: Array.from(e.couriers.values()).map((c) => {
          const res = c.delivered + c.returned + c.failed;
          return {
            courier: c.courier,
            total: c.total,
            delivered: c.delivered,
            returned: c.returned,
            failed: c.failed,
            deliveryRate: res ? c.delivered / res : null,
          };
        }),
      }))
      .sort((a, b) => b.total - a.total);

    return { couriers, cities };
  }

  /**
   * The Shipments list — server-side filtered + paginated. Was previously a
   * flat `take: 200` with the status tabs filtered client-side; with thousands
   * of shipments that meant the tabs (and Refresh) only ever saw the 200
   * newest-by-created_at rows, so most statuses looked empty. Filtering +
   * paging on the server fixes that. `needsAttention` = an unmappable courier
   * status on a still-booked row, or a booking error.
   */
  async listShipments(
    companyId: number,
    filters: {
      status?: ShipmentStatus;
      courierType?: CourierType;
      needsAttention?: boolean;
      // Only booked shipments not yet on a loadsheet — the Shipments tab's
      // worklist ("generate a loadsheet for these").
      loadsheetPending?: boolean;
      // Shipment-date window (time-period selector).
      from?: Date;
      to?: Date;
      page?: number;
      pageSize?: number;
    } = {},
  ) {
    const page = Math.max(1, Math.floor(filters.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.floor(filters.pageSize ?? 50)));
    const where: Prisma.ShipmentWhereInput = {
      company_id: companyId,
      ...(filters.courierType ? { courier_type: filters.courierType } : {}),
      ...(filters.from || filters.to
        ? {
            created_at: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
      ...(filters.loadsheetPending
        ? // Loadsheet worklist: booked OR ready_for_pickup (both are still
          // pre-dispatch and manifestable), not yet on a loadsheet.
          { status: { in: ['booked', 'ready_for_pickup'] }, loadsheet_batch_id: null }
        : filters.needsAttention
        ? {
            OR: [
              { booking_error: { not: null } },
              {
                AND: [
                  { last_courier_status_raw: { not: null } },
                  { status: 'booked' },
                ],
              },
            ],
          }
        : filters.status
          ? { status: filters.status }
          : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.shipment.count({ where }),
      this.prisma.shipment.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    // Enrich with order-mirror fields (customer name + items summary + a city
    // fallback) so the Shipments table can show the same columns as the Orders
    // board. One extra query keyed by this page's order gids.
    const gids = rows.map((r) => r.shopify_order_gid);
    const orders = gids.length
      ? await this.prisma.shopifyOrder.findMany({
          where: { company_id: companyId, shopify_order_gid: { in: gids } },
          select: {
            shopify_order_gid: true,
            customer_name: true,
            phone: true,
            city: true,
            line_items_summary: true,
            total_price: true,
            total_outstanding: true,
            currency: true,
          },
        })
      : [];
    const byGid = new Map(orders.map((o) => [o.shopify_order_gid, o]));
    const enriched = rows.map((r) => {
      const o = byGid.get(r.shopify_order_gid);
      return {
        ...r,
        customer_name: o?.customer_name ?? null,
        phone: o?.phone ?? null,
        order_city: o?.city ?? r.destination_city ?? null,
        items_summary: o?.line_items_summary ?? null,
        total_price: o?.total_price == null ? null : Number(o.total_price),
        total_outstanding: o?.total_outstanding == null ? null : Number(o.total_outstanding),
        currency: o?.currency ?? null,
      };
    });
    return { rows: enriched, total, page, pageSize };
  }

  async getShipment(companyId: number, id: number) {
    const row = await this.prisma.shipment.findFirst({
      where: { id, company_id: companyId },
    });
    if (!row) throw new NotFoundException('Shipment not found');
    return row;
  }

  /**
   * Courier pending payments, split into two buckets per courier:
   *  - RECEIVABLE: COD owed NOW = delivered, unsettled parcels that still carry
   *    an outstanding balance (>0). Count matches the amount (already-settled /
   *    prepaid delivered parcels have 0 balance and drop out).
   *  - WITH COURIER (in transit): parcels still out (booked/in_transit/out for
   *    delivery/attempted/failed/…) — not collectable yet; shown as a count +
   *    the COD expected once they deliver. Returned/cancelled are excluded.
   * Everything is scoped to `courier_settled_at IS NULL` (unreconciled).
   */
  async courierPendingPayments(companyId: number) {
    const n = (v: bigint | number | string | null): number =>
      v == null ? 0 : Number(v);
    const rows = await this.prisma.$queryRaw<
      Array<{
        courier: CourierType;
        receivable: string | number | null;
        receivable_count: bigint | number;
        in_transit_count: bigint | number;
        in_transit_expected: string | number | null;
        currency: string | null;
      }>
    >(Prisma.sql`
      SELECT s.courier_type AS courier,
        SUM(CASE WHEN s.status = 'delivered' AND COALESCE(o.total_outstanding,0) > 0
              THEN o.total_outstanding ELSE 0 END) AS receivable,
        SUM(CASE WHEN s.status = 'delivered' AND COALESCE(o.total_outstanding,0) > 0
              THEN 1 ELSE 0 END) AS receivable_count,
        SUM(CASE WHEN s.status <> 'delivered' THEN 1 ELSE 0 END) AS in_transit_count,
        SUM(CASE WHEN s.status <> 'delivered' THEN COALESCE(o.total_outstanding,0) ELSE 0 END) AS in_transit_expected,
        MAX(o.currency) AS currency
      FROM shipments s
      LEFT JOIN shopify_orders o
        ON o.company_id = s.company_id AND o.shopify_order_gid = s.shopify_order_gid
      WHERE s.company_id = ${companyId}
        AND s.courier_settled_at IS NULL
        AND s.status IN (${Prisma.join(PAYMENT_ACTIVE_STATUSES)})
      GROUP BY s.courier_type
    `);
    const couriers = rows
      .map((r) => ({
        courier: r.courier,
        receivable: n(r.receivable),
        receivableCount: n(r.receivable_count),
        inTransitCount: n(r.in_transit_count),
        inTransitExpected: n(r.in_transit_expected),
        currency: r.currency,
      }))
      // Drop couriers with nothing outstanding and nothing in transit.
      .filter((c) => c.receivableCount > 0 || c.inTransitCount > 0);
    const currency = couriers.find((c) => c.currency)?.currency ?? null;
    return {
      couriers,
      totals: {
        receivable: couriers.reduce((s, c) => s + c.receivable, 0),
        receivableCount: couriers.reduce((s, c) => s + c.receivableCount, 0),
        inTransitCount: couriers.reduce((s, c) => s + c.inTransitCount, 0),
        inTransitExpected: couriers.reduce((s, c) => s + c.inTransitExpected, 0),
      },
      currency,
    };
  }

  /**
   * Drill-down list for one courier, per bucket:
   *  - 'receivable': delivered + unsettled + outstanding COD > 0 (money owed
   *    now), biggest first — these carry the Mark-paid checkboxes.
   *  - 'transit': still with the courier (non-delivered active statuses),
   *    most-recent first — a read-only tracking list with expected COD.
   * Joined to the mirror for the order's outstanding balance, tenant-scoped.
   */
  async listPendingPayments(
    companyId: number,
    opts: {
      courierType?: CourierType;
      bucket?: 'receivable' | 'transit';
      page?: number;
      pageSize?: number;
    } = {},
  ) {
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.floor(opts.pageSize ?? 50)));
    const bucket = opts.bucket ?? 'receivable';
    const n = (v: bigint | number | string | null): number =>
      v == null ? 0 : Number(v);

    const bucketClause =
      bucket === 'receivable'
        ? Prisma.sql`s.status = 'delivered' AND COALESCE(o.total_outstanding,0) > 0`
        : Prisma.sql`s.status <> 'delivered' AND s.status IN (${Prisma.join(
            PAYMENT_ACTIVE_STATUSES,
          )})`;
    const courierClause = opts.courierType
      ? Prisma.sql`AND s.courier_type = ${opts.courierType}`
      : Prisma.empty;
    const orderBy =
      bucket === 'receivable'
        ? Prisma.sql`o.total_outstanding DESC`
        : Prisma.sql`s.updated_at DESC`;

    const where = Prisma.sql`
      FROM shipments s
      LEFT JOIN shopify_orders o
        ON o.company_id = s.company_id AND o.shopify_order_gid = s.shopify_order_gid
      WHERE s.company_id = ${companyId}
        AND s.courier_settled_at IS NULL
        ${courierClause}
        AND (${bucketClause})
    `;

    const countRows = await this.prisma.$queryRaw<Array<{ c: bigint | number }>>(
      Prisma.sql`SELECT COUNT(*) AS c ${where}`,
    );
    const total = n(countRows[0]?.c ?? 0);

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: number;
        shopify_order_name: string | null;
        courier_type: CourierType;
        destination_city: string | null;
        status: ShipmentStatus;
        delivered_at: Date | null;
        phone: string | null;
        total_outstanding: string | number | null;
        currency: string | null;
      }>
    >(Prisma.sql`
      SELECT s.id, s.shopify_order_name, s.courier_type, s.destination_city,
        s.status, s.delivered_at, o.phone, o.total_outstanding, o.currency
      ${where}
      ORDER BY ${orderBy}
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `);

    const out = rows.map((r) => ({
      shipmentId: r.id,
      orderName: r.shopify_order_name,
      courier: r.courier_type,
      city: r.destination_city,
      status: r.status,
      phone: r.phone,
      receivable: n(r.total_outstanding),
      currency: r.currency,
      deliveredAt: r.delivered_at,
    }));
    return { rows: out, total, page, pageSize };
  }

  /**
   * Mark courier COD as remitted/reconciled — clears the shipments from pending
   * payments. Either an explicit set of shipment ids, or "all delivered
   * unsettled for a courier" (batch reconciliation). Tenant-scoped.
   */
  async settlePayments(
    companyId: number,
    opts: { shipmentIds?: number[]; courierType?: CourierType },
  ): Promise<{ settled: number }> {
    const ids = (opts.shipmentIds ?? []).filter((v) => Number.isFinite(v));
    if (!ids.length && !opts.courierType) {
      throw new BadRequestException(
        'Provide shipmentIds or a courierType to settle.',
      );
    }
    const res = await this.prisma.shipment.updateMany({
      where: {
        company_id: companyId,
        status: 'delivered',
        courier_settled_at: null,
        ...(ids.length ? { id: { in: ids } } : {}),
        ...(opts.courierType ? { courier_type: opts.courierType } : {}),
      },
      data: { courier_settled_at: new Date() },
    });
    return { settled: res.count };
  }

  /**
   * Prepaid (non-COD) payment summary, split into two informational cards. Both
   * count only orders that already carry a captured `payment_gateway` (post-deploy
   * — pre-deploy rows are null and deliberately excluded, so no tenant sees wrong
   * data), are marked PAID in Shopify, and have a live shipment.
   *
   *  - BANK DEPOSIT: an OFFLINE gateway (manual/bank/cash/COD name) that's already
   *    paid → the money is in the bank; purely informational (no settle action).
   *    Bounded to still-open orders (archived_at null) so delivered ones age out.
   *  - CARD PAYMENTS: a REAL online gateway (PayFast/Stripe/…) that's paid but
   *    whose payout hasn't been reconciled yet (`gateway_reconciled_at` null).
   *    Needs the tenant to confirm the gateway paid out → then it drops off.
   *
   * Each returns a delivered vs with-courier (in-transit) split + order-value
   * totals. Deterministic + tenant-agnostic (gateway-regex, never a provider name).
   */
  async prepaidPaymentSummary(companyId: number) {
    const n = (v: bigint | number | string | null): number =>
      v == null ? 0 : Number(v);
    const bucketSql = (extra: Prisma.Sql) => Prisma.sql`
      SELECT
        SUM(CASE WHEN s.status = 'delivered' THEN 1 ELSE 0 END) AS delivered_count,
        SUM(CASE WHEN s.status = 'delivered' THEN COALESCE(o.total_price,0) ELSE 0 END) AS delivered_value,
        SUM(CASE WHEN s.status <> 'delivered' THEN 1 ELSE 0 END) AS transit_count,
        SUM(CASE WHEN s.status <> 'delivered' THEN COALESCE(o.total_price,0) ELSE 0 END) AS transit_value,
        MAX(o.currency) AS currency
      FROM shipments s
      JOIN shopify_orders o
        ON o.company_id = s.company_id AND o.shopify_order_gid = s.shopify_order_gid
      WHERE s.company_id = ${companyId}
        AND s.status IN (${Prisma.join(PAYMENT_ACTIVE_STATUSES)})
        AND o.payment_gateway IS NOT NULL
        AND LOWER(o.financial_status) = 'paid'
        ${extra}
    `;
    type Row = {
      delivered_count: bigint | number | null;
      delivered_value: string | number | null;
      transit_count: bigint | number | null;
      transit_value: string | number | null;
      currency: string | null;
    };
    const [bankRows, cardRows] = await Promise.all([
      this.prisma.$queryRaw<Row[]>(
        bucketSql(Prisma.sql`
          AND LOWER(o.payment_gateway) REGEXP ${OFFLINE_GATEWAY_REGEXP}
          AND o.archived_at IS NULL`),
      ),
      this.prisma.$queryRaw<Row[]>(
        bucketSql(Prisma.sql`
          AND LOWER(o.payment_gateway) NOT REGEXP ${OFFLINE_GATEWAY_REGEXP}
          AND o.gateway_reconciled_at IS NULL`),
      ),
    ]);
    const shape = (r: Row | undefined) => ({
      deliveredCount: n(r?.delivered_count ?? 0),
      deliveredValue: n(r?.delivered_value ?? 0),
      inTransitCount: n(r?.transit_count ?? 0),
      inTransitValue: n(r?.transit_value ?? 0),
      currency: r?.currency ?? null,
    });
    return { bankDeposit: shape(bankRows[0]), cardPayments: shape(cardRows[0]) };
  }

  /**
   * Drill-down list for one prepaid card (bank | card). Same paid-prepaid + live-
   * shipment scope as the summary; card rows carry the order name so the tenant can
   * pick / paste order numbers to reconcile. Delivered first, then newest.
   */
  async listPrepaidPayments(
    companyId: number,
    opts: {
      bucket: 'bank' | 'card';
      page?: number;
      pageSize?: number;
    },
  ) {
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.floor(opts.pageSize ?? 50)));
    const n = (v: bigint | number | string | null): number =>
      v == null ? 0 : Number(v);
    const gatewayClause =
      opts.bucket === 'bank'
        ? Prisma.sql`AND LOWER(o.payment_gateway) REGEXP ${OFFLINE_GATEWAY_REGEXP} AND o.archived_at IS NULL`
        : Prisma.sql`AND LOWER(o.payment_gateway) NOT REGEXP ${OFFLINE_GATEWAY_REGEXP} AND o.gateway_reconciled_at IS NULL`;
    const where = Prisma.sql`
      FROM shipments s
      JOIN shopify_orders o
        ON o.company_id = s.company_id AND o.shopify_order_gid = s.shopify_order_gid
      WHERE s.company_id = ${companyId}
        AND s.status IN (${Prisma.join(PAYMENT_ACTIVE_STATUSES)})
        AND o.payment_gateway IS NOT NULL
        AND LOWER(o.financial_status) = 'paid'
        ${gatewayClause}
    `;
    const countRows = await this.prisma.$queryRaw<Array<{ c: bigint | number }>>(
      Prisma.sql`SELECT COUNT(*) AS c ${where}`,
    );
    const total = n(countRows[0]?.c ?? 0);
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: number;
        shopify_order_name: string | null;
        order_number: string | null;
        courier_type: CourierType;
        destination_city: string | null;
        status: ShipmentStatus;
        delivered_at: Date | null;
        phone: string | null;
        payment_gateway: string | null;
        total_price: string | number | null;
        currency: string | null;
      }>
    >(Prisma.sql`
      SELECT s.id, s.shopify_order_name, o.order_number, s.courier_type,
        s.destination_city, s.status, s.delivered_at, o.phone,
        o.payment_gateway, o.total_price, o.currency
      ${where}
      ORDER BY (s.status = 'delivered') DESC, s.updated_at DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `);
    const out = rows.map((r) => ({
      shipmentId: r.id,
      orderName: r.shopify_order_name,
      orderNumber: r.order_number,
      courier: r.courier_type,
      city: r.destination_city,
      status: r.status,
      phone: r.phone,
      gateway: r.payment_gateway,
      value: n(r.total_price),
      currency: r.currency,
      deliveredAt: r.delivered_at,
    }));
    return { rows: out, total, page, pageSize };
  }

  /**
   * Reconcile Card-Payments orders — mark that the gateway's payout has landed, so
   * they drop off the Card Payments card. Targets orders either by their shipment
   * ids (checkbox selection) OR by order name/number (comma-separated paste). Only
   * touches CARD (non-offline, unreconciled, paid) orders — a stray COD/bank number
   * can never be flipped. Sets `gateway_reconciled_at`. Tenant-scoped.
   */
  async reconcileCardPayments(
    companyId: number,
    opts: { shipmentIds?: number[]; orderNumbers?: string[] },
  ): Promise<{ reconciled: number }> {
    const ids = (opts.shipmentIds ?? []).filter((v) => Number.isFinite(v));
    // Normalize pasted order refs: strip a leading '#' and surrounding space; drop
    // blanks. Match against BOTH order_name (e.g. '#33409') and order_number ('33409').
    const refs = (opts.orderNumbers ?? [])
      .map((r) => String(r).trim().replace(/^#/, ''))
      .filter(Boolean);
    if (!ids.length && !refs.length) {
      throw new BadRequestException(
        'Select orders or paste order numbers to reconcile.',
      );
    }

    // Resolve the target order gids from the two selectors, constrained to the
    // reconcilable Card-Payments set (never a COD/bank or already-reconciled order).
    const gidRows = await this.prisma.$queryRaw<Array<{ gid: string }>>(Prisma.sql`
      SELECT DISTINCT o.shopify_order_gid AS gid
      FROM shopify_orders o
      JOIN shipments s
        ON s.company_id = o.company_id AND s.shopify_order_gid = o.shopify_order_gid
      WHERE o.company_id = ${companyId}
        AND o.payment_gateway IS NOT NULL
        AND LOWER(o.financial_status) = 'paid'
        AND LOWER(o.payment_gateway) NOT REGEXP ${OFFLINE_GATEWAY_REGEXP}
        AND o.gateway_reconciled_at IS NULL
        AND s.status IN (${Prisma.join(PAYMENT_ACTIVE_STATUSES)})
        AND (
          ${ids.length ? Prisma.sql`s.id IN (${Prisma.join(ids)})` : Prisma.sql`FALSE`}
          OR ${
            refs.length
              ? Prisma.sql`REPLACE(o.order_name,'#','') IN (${Prisma.join(refs)}) OR o.order_number IN (${Prisma.join(refs)})`
              : Prisma.sql`FALSE`
          }
        )
    `);
    const gids = gidRows.map((r) => r.gid);
    if (!gids.length) return { reconciled: 0 };
    const res = await this.prisma.shopifyOrder.updateMany({
      where: {
        company_id: companyId,
        shopify_order_gid: { in: gids },
        gateway_reconciled_at: null,
      },
      data: { gateway_reconciled_at: new Date() },
    });
    return { reconciled: res.count };
  }

  /**
   * Creates the Shipment row and queues the booking job. Runs
   * AddressQualityService first: an address-issue finding is advisory — it
   * sets the row to `address_issue` (customer reconfirm sent) UNLESS the
   * agent already overrode it, mirroring the fact that the tenant's own
   * manual "Wrong Address" judgment call wasn't a strict formula either.
   */
  async bookShipment(params: BookShipmentParams) {
    const order = await this.shopify.getOrderForBooking(
      params.companyId,
      params.shopifyOrderName,
    );
    if (!order) {
      throw new BadRequestException(
        `Shopify order ${params.shopifyOrderName} not found.`,
      );
    }
    if (!order.shipping) {
      throw new BadRequestException('Order has no shipping address.');
    }
    if (!order.fulfillmentOrderId) {
      throw new BadRequestException(
        'Order has no open fulfillment order (already fulfilled or cancelled?).',
      );
    }

    const existing = await this.prisma.shipment.findUnique({
      where: {
        company_id_shopify_order_gid: {
          company_id: params.companyId,
          shopify_order_gid: order.orderGid,
        },
      },
    });
    if (existing && !['cancelled', 'returned'].includes(existing.status)) {
      throw new BadRequestException(
        `Order ${order.orderName} already has an active shipment (status: ${existing.status}).`,
      );
    }

    // CodesApp's `shopify_orders` mirror is the SOURCE OF TRUTH for the address:
    // it holds the webhook-captured details and any agent correction (which also
    // writes back to Shopify). Shopify's PII gating means its live shipping
    // address is often empty, and a stale live value must never win over a
    // correction made here. So the mirror wins; live Shopify is only a fallback.
    const mirror = await this.prisma.shopifyOrder.findUnique({
      where: {
        company_id_shopify_order_gid: {
          company_id: params.companyId,
          shopify_order_gid: order.orderGid,
        },
      },
      select: { city: true, address1: true, address2: true },
    });
    const shipCity = mirror?.city || order.shipping.city || '';
    const shipAddress1 = mirror?.address1 || order.shipping.address1 || '';
    const shipAddress2 = mirror?.address2 || order.shipping.address2 || undefined;

    let courierType = params.courierType;
    if (!courierType) {
      const suggestions = await this.listCouriersForCity(
        params.companyId,
        shipCity,
      );
      courierType = suggestions[0]?.courierType;
      if (!courierType) {
        throw new BadRequestException(
          `No courier configured for city "${shipCity}". Choose one manually or add a city mapping in Settings > Courier.`,
        );
      }
    }

    let addressIssueReason: string | null = null;
    if (!params.overrideAddressIssue) {
      const assessment = await this.addressQuality.assess(
        params.companyId,
        shipAddress1,
        shipCity,
      );
      if (!assessment.ok) addressIssueReason = assessment.reason;
    }

    const shipment = await this.prisma.shipment.upsert({
      where: {
        company_id_shopify_order_gid: {
          company_id: params.companyId,
          shopify_order_gid: order.orderGid,
        },
      },
      create: {
        company_id: params.companyId,
        shopify_order_gid: order.orderGid,
        shopify_order_name: order.orderName,
        courier_type: courierType,
        destination_city: shipCity,
        destination_address: [shipAddress1, shipAddress2]
          .filter(Boolean)
          .join(', '),
        status: addressIssueReason ? 'address_issue' : 'booked',
        address_issue_reason: addressIssueReason,
        address_issue_notified_at: addressIssueReason ? new Date() : null,
        created_by_user_id: params.createdByUserId,
      },
      update: {
        courier_type: courierType,
        status: addressIssueReason ? 'address_issue' : 'booked',
        address_issue_reason: addressIssueReason,
        address_issue_notified_at: addressIssueReason ? new Date() : null,
        booking_error: null,
      },
    });

    if (addressIssueReason) {
      // Advisory stop — the agent sees the reason in the UI and can either
      // resolve it or override. No booking job is queued; booking resumes
      // via `resolveAddressIssue`. Meanwhile ask the customer to confirm
      // their address (non-blocking, never throws).
      void this.addressIssueNotifier.notify(shipment.id);
      return shipment;
    }

    await this.jobQueue.enqueue(
      COURIER_BOOKING_QUEUE,
      {
        shipmentId: shipment.id,
        throttleMs: params.throttleMs,
      } satisfies BookJobPayload,
      {
        maxAttempts: 3,
        // LANE_PARALLELISM serial lanes per courier (sharded by shipment id):
        // same-courier bookings run a few at a time, different couriers in
        // parallel. The per-lane throttle still paces each shard's API calls.
        serialKey: bookLaneKey(params.companyId, courierType, shipment.id),
      },
    );
    return shipment;
  }

  /**
   * Clear an address_issue WITHOUT booking — returns the order to "To book" so
   * the agent re-books deliberately (pick courier + Book), the safe flow.
   * The address_issue bucket holds both genuine bad-address flags AND reverted
   * booking FAILURES (e.g. a courier rejected the phone number); auto-re-booking
   * with the same stuck courier would just fail again, so we drop the shipment
   * row entirely. Safe: an address_issue parcel never reached the courier (no
   * tracking) and was never fulfilled in Shopify, so there's nothing to undo.
   */
  async revertAddressIssue(companyId: number, shipmentId: number) {
    const shipment = await this.getShipment(companyId, shipmentId);
    if (shipment.status !== 'address_issue') {
      throw new BadRequestException('Shipment is not in an address_issue state.');
    }
    if (shipment.courier_tracking_number) {
      throw new BadRequestException(
        'This parcel is already booked with the courier — cancel the booking instead.',
      );
    }
    await this.prisma.shipment.delete({ where: { id: shipment.id } });
    return { reverted: true };
  }

  /** Agent resolves an address_issue row — either the customer confirmed
   *  the address, or the agent is overriding the flag — and booking proceeds. */
  async resolveAddressIssue(companyId: number, shipmentId: number) {
    const shipment = await this.getShipment(companyId, shipmentId);
    if (shipment.status !== 'address_issue') {
      throw new BadRequestException('Shipment is not in an address_issue state.');
    }
    await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: { status: 'booked', address_confirmed_at: new Date() },
    });
    await this.jobQueue.enqueue(
      COURIER_BOOKING_QUEUE,
      { shipmentId: shipment.id } satisfies BookJobPayload,
      {
        maxAttempts: 3,
        serialKey: bookLaneKey(companyId, shipment.courier_type, shipment.id),
      },
    );
  }

  /**
   * Agent manually flags an order's address as wrong. Creates/updates the
   * shipment in `address_issue` (so it leaves To-book, shows the reason, and the
   * customer gets the address-confirm template) WITHOUT booking. The agent then
   * corrects the address (Edit address) and clicks Resolve & book. Never books a
   * parcel; refuses if the order is already actively booked/in-flight.
   */
  async markWrongAddress(
    companyId: number,
    orderGid: string,
    reason?: string,
    courierType?: CourierType,
  ) {
    const orderRow = await this.prisma.shopifyOrder.findUnique({
      where: {
        company_id_shopify_order_gid: { company_id: companyId, shopify_order_gid: orderGid },
      },
      select: { order_name: true, city: true },
    });
    if (!orderRow) throw new NotFoundException('Order not found.');

    const existing = await this.prisma.shipment.findUnique({
      where: {
        company_id_shopify_order_gid: { company_id: companyId, shopify_order_gid: orderGid },
      },
    });
    if (
      existing &&
      ['booked', 'in_transit', 'out_for_delivery', 'picked_up', 'ready_for_pickup', 'delivered'].includes(
        existing.status,
      )
    ) {
      throw new BadRequestException(
        `Order ${orderRow.order_name ?? orderGid} is already booked (${existing.status}). Cancel the booking first.`,
      );
    }

    // Need a courier for the shipment row; the real one is picked at Resolve
    // time. Prefer an explicit choice → the city's suggestion → any active courier.
    let ct = courierType ?? existing?.courier_type ?? undefined;
    if (!ct) {
      const suggestions = await this.listCouriersForCity(companyId, orderRow.city ?? '');
      ct = suggestions[0]?.courierType;
    }
    if (!ct) {
      const active = await this.registry.getActiveCouriers(companyId);
      ct = active[0];
    }
    if (!ct) {
      throw new BadRequestException('Configure a courier first (Settings → Courier).');
    }

    const reasonText = (reason && reason.trim()) || 'Address flagged as incorrect by agent.';
    const shipment = await this.prisma.shipment.upsert({
      where: {
        company_id_shopify_order_gid: { company_id: companyId, shopify_order_gid: orderGid },
      },
      create: {
        company_id: companyId,
        shopify_order_gid: orderGid,
        shopify_order_name: orderRow.order_name,
        courier_type: ct,
        status: 'address_issue',
        address_issue_reason: reasonText,
        address_issue_notified_at: new Date(),
      },
      update: {
        status: 'address_issue',
        address_issue_reason: reasonText,
        address_issue_notified_at: new Date(),
        booking_error: null,
      },
    });
    void this.addressIssueNotifier.notify(shipment.id);
    return shipment;
  }

  /**
   * A parcel came back (RTO). The tenant's return handling: mark the shipment
   * returned, BLACKLIST the customer (`contacts.status='blocked'`), and CANCEL +
   * ARCHIVE the order in Shopify. Runs from the manual "Mark received" action
   * and from the auto path (a courier webhook mapping to `returned`). Idempotent:
   * a shipment already `returned` skips the Shopify cancel/archive re-run (auto
   * webhook redeliveries are harmless) but still ensures the blacklist applied.
   * All destructive steps are best-effort/non-throwing so one failing step
   * (e.g. Shopify already-cancelled) never blocks the others.
   */
  async processReturn(
    companyId: number,
    shipmentId: number,
    source: 'manual' | 'auto',
    userId?: number,
  ): Promise<{
    blacklisted: boolean;
    cancelled: boolean;
    archived: boolean;
    alreadyProcessed: boolean;
  }> {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id: shipmentId, company_id: companyId },
    });
    if (!shipment) throw new NotFoundException('Shipment not found.');

    const alreadyProcessed =
      (shipment.status === 'failed' || shipment.status === 'returned') &&
      shipment.cancelled_at != null;

    // Mark the shipment FAILED (failed delivery) and record when we processed the
    // receipt. A MANUAL receipt (per-row button / bulk box / barcode scan) also
    // stamps the human-confirmed `received_at` — the physical "it's back in our
    // hands" fact, distinct from a courier status. The AUTO path (a courier
    // status promoting to returned) never stamps it: nothing was physically
    // confirmed. ('returned' rows from before this change stay valid; nothing new
    // is written to 'returned' from here.)
    await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        status: 'failed',
        cancelled_at: shipment.cancelled_at ?? new Date(),
        ...(source === 'manual'
          ? {
              received_at: shipment.received_at ?? new Date(),
              received_by_user_id:
                shipment.received_by_user_id ?? userId ?? null,
            }
          : {}),
      },
    });

    // Blacklist the customer — by linked contact, else matched on the mirror
    // order's phone (last 10 digits, tolerant of +country-code formatting).
    // Locally: set contacts.status='blocked' AND add the "black list" tag (so
    // agents see the returned/not-received customer at a glance in the inbox +
    // contacts). Remotely: push the same "black list" tag onto the Shopify
    // CUSTOMER (best-effort). Both are idempotent.
    let blacklisted = false;
    // Resolved from the linked contact or the mirror order — also used to find
    // the Shopify customer to tag.
    let identPhone: string | null = null;
    let identEmail: string | null = null;
    try {
      const order = await this.prisma.shopifyOrder.findUnique({
        where: {
          company_id_shopify_order_gid: {
            company_id: companyId,
            shopify_order_gid: shipment.shopify_order_gid,
          },
        },
        select: { phone: true, email: true },
      });
      identPhone = order?.phone ?? null;
      identEmail = order?.email ?? null;

      let contactId = shipment.contact_id ?? null;
      if (!contactId) {
        const digits = (identPhone ?? '').replace(/\D/g, '');
        const last10 = digits.slice(-10);
        if (last10.length >= 7) {
          const contact = await this.prisma.contact.findFirst({
            where: { company_id: companyId, phone: { contains: last10 } },
            select: { id: true },
          });
          contactId = contact?.id ?? null;
        }
      }
      if (contactId) {
        const c = await this.prisma.contact.findUnique({
          where: { id: contactId },
          select: { tags: true, phone: true, email: true },
        });
        if (!identPhone) identPhone = c?.phone ?? null;
        if (!identEmail) identEmail = c?.email ?? null;
        const existing = Array.isArray(c?.tags)
          ? (c!.tags as unknown[]).map((t) => String(t))
          : [];
        const tags = existing.some(
          (t) => t.toLowerCase() === RETURN_BLACKLIST_TAG.toLowerCase(),
        )
          ? existing
          : [...existing, RETURN_BLACKLIST_TAG];
        await this.prisma.contact.update({
          where: { id: contactId },
          data: { status: 'blocked', tags },
        });
        blacklisted = true;
      }
    } catch (err) {
      this.logger.warn(
        `processReturn: blacklist failed for shipment ${shipment.id} (company ${companyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Push the "black list" tag to the Shopify customer (best-effort, matched by
    // phone/email). Never blocks the return handling.
    void this.shopifyService
      .blacklistShopifyCustomer(companyId, {
        phone: identPhone,
        email: identEmail,
      })
      .catch(() => undefined);

    // Cancel + archive the Shopify order (skip the heavy re-run if already done).
    let cancelled = false;
    let archived = false;
    if (!alreadyProcessed) {
      // BEFORE cancelling, mark the delivery FAILED in Shopify too — push a
      // FAILURE fulfillment event so the order's fulfillment reflects the failed
      // delivery, matching the shipment's 'failed' status here. Best-effort and
      // non-throwing: a missing/closed fulfillment must not block the cancel.
      await this.pushFailedToShopify(companyId, shipment).catch(() => undefined);
      try {
        const r = await this.shopifyService.processOrderReturn(
          companyId,
          shipment.shopify_order_gid,
        );
        cancelled = r.cancelled;
        archived = r.archived;
      } catch (err) {
        this.logger.warn(
          `processReturn: Shopify cancel/archive failed for ${shipment.shopify_order_gid} (company ${companyId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    this.logger.log(
      `Return processed (${source}) shipment ${shipment.id} order ${shipment.shopify_order_name ?? shipment.shopify_order_gid}: blacklisted=${blacklisted} cancelled=${cancelled} archived=${archived}${alreadyProcessed ? ' (already processed)' : ''}`,
    );
    return { blacklisted, cancelled, archived, alreadyProcessed };
  }

  /**
   * Push a FAILURE fulfillment event to Shopify for a returned/undelivered
   * parcel, so the order's fulfillment shows the failed delivery — mirrors the
   * status-sync's own event push (and the invoice service's delivered push).
   * Resolves the fulfillment GID (backfilling it if missing) and is entirely
   * best-effort: an order with no fulfillment simply has nothing to attach to.
   */
  private async pushFailedToShopify(
    companyId: number,
    shipment: {
      id: number;
      shopify_order_gid: string;
      shopify_fulfillment_gid: string | null;
    },
  ): Promise<void> {
    const event = SHIPMENT_STATUS_TO_SHOPIFY_EVENT['failed'];
    if (!event) return;
    let gid = shipment.shopify_fulfillment_gid;
    if (!gid) {
      gid = await this.shopify
        .getFulfillmentGid(companyId, shipment.shopify_order_gid)
        .catch(() => null);
      if (gid) {
        await this.prisma.shipment
          .update({ where: { id: shipment.id }, data: { shopify_fulfillment_gid: gid } })
          .catch(() => undefined);
      }
    }
    if (!gid) return; // no fulfillment on the order — nothing to attach an event to
    await this.shopify
      .createFulfillmentEvent(companyId, gid, event)
      .catch(() => undefined);
  }

  /**
   * Bulk "mark received" (RTO) for many parcels at once — by shipment ids OR by
   * order numbers (with or without a leading '#'). Only failed/attempted/returned
   * shipments are received; anything else is skipped, and order numbers with no
   * matching shipment are reported as not-found. Each parcel runs the full return
   * automation (blacklist + Shopify cancel/archive) via processReturn.
   */
  async bulkReceive(
    companyId: number,
    params: { shipmentIds?: number[]; orderNames?: string[]; userId?: number },
  ): Promise<{ received: number; skipped: number; notFound: string[] }> {
    const RECEIVABLE: ShipmentStatus[] = ['failed', 'attempted', 'returned'];

    let shipments: { id: number; status: ShipmentStatus; shopify_order_name: string | null }[] = [];
    let requested: string[] = [];

    if (params.shipmentIds?.length) {
      const ids = [...new Set(params.shipmentIds.filter((n) => Number.isFinite(n)))];
      shipments = await this.prisma.shipment.findMany({
        where: { company_id: companyId, id: { in: ids } },
        select: { id: true, status: true, shopify_order_name: true },
      });
    } else if (params.orderNames?.length) {
      // Normalize to Shopify's stored "#NNNN" form.
      requested = [
        ...new Set(
          params.orderNames
            .map((n) => (n || '').trim())
            .filter(Boolean)
            .map((n) => `#${n.replace(/^#+/, '')}`),
        ),
      ];
      shipments = await this.prisma.shipment.findMany({
        where: { company_id: companyId, shopify_order_name: { in: requested } },
        select: { id: true, status: true, shopify_order_name: true },
      });
    }

    const foundNames = new Set(shipments.map((s) => s.shopify_order_name));
    const notFound = requested.filter((n) => !foundNames.has(n));

    let received = 0;
    let skipped = 0;
    for (const s of shipments) {
      if (!RECEIVABLE.includes(s.status)) {
        skipped++;
        continue;
      }
      try {
        await this.processReturn(companyId, s.id, 'manual', params.userId);
        received++;
      } catch {
        skipped++;
      }
    }
    return { received, skipped, notFound };
  }

  /**
   * Look up a shipment by its courier tracking (AWB/CN) number, tenant-scoped —
   * the barcode-scan receive flow calls this on each decode to resolve a scanned
   * label to an order before it's added to the pileup list. Returns null when no
   * shipment carries that tracking number (the UI flags it "not found — verify").
   */
  async lookupByTracking(
    companyId: number,
    trackingNumber: string,
  ): Promise<{
    shipmentId: number;
    orderName: string | null;
    courier: CourierType;
    status: ShipmentStatus;
    customerName: string | null;
    receivedAt: Date | null;
  } | null> {
    const tn = (trackingNumber || '').trim();
    if (!tn) return null;
    const shipment = await this.prisma.shipment.findFirst({
      where: { company_id: companyId, courier_tracking_number: tn },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        shopify_order_gid: true,
        shopify_order_name: true,
        courier_type: true,
        status: true,
        received_at: true,
      },
    });
    if (!shipment) return null;
    const order = await this.prisma.shopifyOrder.findUnique({
      where: {
        company_id_shopify_order_gid: {
          company_id: companyId,
          shopify_order_gid: shipment.shopify_order_gid,
        },
      },
      select: { customer_name: true },
    });
    return {
      shipmentId: shipment.id,
      orderName: shipment.shopify_order_name,
      courier: shipment.courier_type,
      status: shipment.status,
      customerName: order?.customer_name ?? null,
      receivedAt: shipment.received_at,
    };
  }

  /**
   * Unified RTO receive — the ONE receiving implementation behind the per-row
   * "Mark received" button, the bulk-receive box, and the barcode scanner.
   * Resolves parcels by shipment id OR tracking (AWB/CN) number, tenant-scoped,
   * then runs the full return automation per parcel (mark returned + stamp the
   * human-confirmed received_at + blacklist + Shopify cancel/archive) via
   * processReturn. Idempotent (a re-scan of an already-received parcel is a
   * cheap no-op). Tracking numbers that resolve to no shipment are reported.
   */
  async confirmReceived(
    companyId: number,
    params: { shipmentIds?: number[]; trackingNumbers?: string[]; userId?: number },
  ): Promise<{ received: number; failed: number; notFound: string[] }> {
    const ids = new Set<number>(
      (params.shipmentIds ?? []).filter((n) => Number.isFinite(n)),
    );
    const notFound: string[] = [];

    const trackings = [
      ...new Set((params.trackingNumbers ?? []).map((t) => (t || '').trim()).filter(Boolean)),
    ];
    if (trackings.length) {
      const found = await this.prisma.shipment.findMany({
        where: { company_id: companyId, courier_tracking_number: { in: trackings } },
        select: { id: true, courier_tracking_number: true },
      });
      const foundTns = new Set(found.map((s) => s.courier_tracking_number));
      for (const s of found) ids.add(s.id);
      for (const t of trackings) if (!foundTns.has(t)) notFound.push(t);
    }

    let received = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await this.processReturn(companyId, id, 'manual', params.userId);
        received++;
      } catch (err) {
        failed++;
        this.logger.warn(
          `confirmReceived: shipment ${id} (company ${companyId}) failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return { received, failed, notFound };
  }

  /**
   * Enqueue a barcode-scan RTO receive batch. The scanner UI is fire-and-forget:
   * it returns immediately and this drains on the courier-rto-receive queue,
   * running confirmReceived (courier cancel + Shopify cancel/archive per parcel)
   * off the request path. Returns the count queued.
   */
  async enqueueRtoReceive(
    companyId: number,
    trackingNumbers: string[],
    userId?: number,
  ): Promise<{ queued: number }> {
    const tns = [
      ...new Set((trackingNumbers ?? []).map((t) => (t || '').trim()).filter(Boolean)),
    ].slice(0, 500);
    if (!tns.length) throw new BadRequestException('No tracking numbers scanned.');
    await this.jobQueue.enqueue(
      COURIER_RTO_RECEIVE_QUEUE,
      { companyId, trackingNumbers: tns, userId } satisfies RtoReceiveJobPayload,
      { maxAttempts: 1 }, // per-parcel outcomes captured in confirmReceived; no whole-batch retry
    );
    return { queued: tns.length };
  }

  private async processRtoReceiveJob(payload: RtoReceiveJobPayload): Promise<void> {
    const res = await this.confirmReceived(payload.companyId, {
      trackingNumbers: payload.trackingNumbers,
      userId: payload.userId,
    });
    this.logger.log(
      `RTO scan receive (company ${payload.companyId}): received=${res.received} failed=${res.failed} notFound=${res.notFound.length} of ${payload.trackingNumbers.length}`,
    );
  }

  private async processBookingJob(payload: BookJobPayload): Promise<void> {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: payload.shipmentId },
    });
    if (!shipment) return;
    // A late webhook may already have advanced the parcel to a terminal state —
    // don't (re)book a cancelled/returned order.
    if (['cancelled', 'returned'].includes(shipment.status)) return;

    try {
      await this.runBookingPipeline(shipment);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const permanent = isPermanentBookingError(err);
      // Re-read the tracking number: if the courier step succeeded (tracking
      // persisted) but a LATER step failed, the parcel IS real — keep it 'booked'
      // and only record the error. Only a booking that never reached the courier
      // (no tracking number) reverts to address_issue so it resurfaces in the
      // needs-attention worklist.
      const fresh = await this.prisma.shipment.findUnique({
        where: { id: shipment.id },
        select: { status: true, courier_tracking_number: true },
      });
      const gotTracking = !!fresh?.courier_tracking_number;
      const revert =
        !gotTracking && fresh?.status === 'booked'
          ? { status: 'address_issue' as const }
          : {};
      await this.prisma.shipment.update({
        where: { id: shipment.id },
        data: {
          ...revert,
          booking_error: message,
          address_issue_reason:
            shipment.address_issue_reason ??
            (gotTracking ? undefined : 'Booking failed — see booking error.'),
        },
      });
      // Permanent (bad data / already-fulfilled) → surface now, do NOT retry.
      // Transient (network / courier / Shopify hiccup) → rethrow so the queue
      // backs off and retries (maxAttempts).
      if (!permanent) throw err;
    } finally {
      // Per-courier lane pacing: hold this (serial-keyed) slot for throttleMs so
      // the NEXT booking on the SAME courier can't start yet. Different couriers
      // use different serial keys and book in parallel — unaffected.
      if (payload.throttleMs && payload.throttleMs > 0) {
        await sleep(payload.throttleMs);
      }
    }
  }

  /**
   * The book → fulfill → tag pipeline, made IDEMPOTENT so any retry / re-claim
   * never double-books:
   *  - Phase A (book at courier) runs only if we have no tracking number yet, and
   *    persists the tracking number IMMEDIATELY (before Shopify) so a later
   *    failure + retry resumes from Phase B instead of booking a second parcel.
   *  - Phase B (Shopify fulfill) runs only if we have no fulfillment GID yet.
   *  - Phase C (tag) is best-effort (tag-add is idempotent) and never fails the job.
   */
  private async runBookingPipeline(shipment: Shipment): Promise<void> {
    const order = await this.shopify.getOrderForBooking(
      shipment.company_id,
      shipment.shopify_order_name || '',
    );

    let trackingNumber = shipment.courier_tracking_number ?? null;
    let cityCode = shipment.courier_city_code ?? null;

    // ---- Phase A: book at the courier (skip if already booked) ----
    if (!trackingNumber) {
      // Fall back to the local mirror for any shipping field the LIVE Shopify
      // order leaves empty. Mirror is the source of truth (agent corrections +
      // webhook data) and the COD-amount source; live Shopify is only a fallback.
      const mirror = await this.prisma.shopifyOrder.findUnique({
        where: {
          company_id_shopify_order_gid: {
            company_id: shipment.company_id,
            shopify_order_gid: shipment.shopify_order_gid,
          },
        },
        select: {
          total_outstanding: true,
          total_price: true,
          email: true,
          line_items: true,
          customer_name: true,
          phone: true,
          city: true,
          address1: true,
          address2: true,
        },
      });
      const live = order?.shipping;
      const dest = {
        name: (mirror?.customer_name || live?.name || '').trim(),
        phone: (mirror?.phone || live?.phone || '').trim(),
        city: (mirror?.city || live?.city || '').trim(),
        address1: (mirror?.address1 || live?.address1 || '').trim(),
        address2: (mirror?.address2 || live?.address2 || undefined) ?? undefined,
      };
      if (!dest.name || !dest.phone || !dest.city || !dest.address1) {
        throw new Error(
          `Incomplete shipping details for booking — need name, phone, city and street address. ` +
            `Missing: ${[
              !dest.name && 'name',
              !dest.phone && 'phone',
              !dest.city && 'city',
              !dest.address1 && 'address',
            ]
              .filter(Boolean)
              .join(', ')}.`,
        );
      }

      cityCode = await this.cityMapping.requireCode(
        shipment.company_id,
        shipment.courier_type,
        dest.city,
      );
      const { credentialId, creds } = await this.registry.requireCredentials(
        shipment.company_id,
        shipment.courier_type,
      );
      const adapter = this.registry.getAdapter(shipment.courier_type);
      const codAmount = mirror?.total_outstanding
        ? Number(mirror.total_outstanding)
        : 0;
      const totalPrice =
        mirror?.total_price != null ? Number(mirror.total_price) : undefined;
      // Total units across the order's line items (mirror stores the raw JSON —
      // Prisma may hand it back already-parsed or as a string).
      let totalQuantity: number | undefined;
      // Build the courier's item description from the line_items JSON (which
      // carries variantTitle) rather than the stored summary string — so even
      // orders synced before the variant fix still send "2x Serum - 120ml".
      // Falls back to the stored summary, then to empty. Sent UNCAPPED — only
      // Trax documents a field limit (190 chars), which its adapter enforces;
      // PostEx/Leopards/Rocket document none, so they get the full description.
      let itemsDescription = order?.lineItemsSummary ?? '';
      try {
        const rawLi: unknown =
          typeof mirror?.line_items === 'string'
            ? JSON.parse(mirror.line_items)
            : mirror?.line_items;
        if (Array.isArray(rawLi)) {
          const sum = (rawLi as Array<{ quantity?: number }>).reduce(
            (s, li) => s + (Number(li?.quantity) || 0),
            0,
          );
          if (sum > 0) totalQuantity = sum;
          const desc = formatLineItemsSummary(rawLi as SummaryLineItem[]);
          if (desc) itemsDescription = desc;
        }
      } catch {
        // Malformed line_items JSON → fall back to the stored summary + default (1).
      }

      const result = await adapter.bookShipment(creds, {
        companyId: shipment.company_id,
        shopifyOrderName: order?.orderName || shipment.shopify_order_name || '',
        destination: {
          name: dest.name,
          phone: dest.phone,
          city: dest.city,
          cityCode,
          address1: dest.address1,
          address2: dest.address2,
        },
        codAmount,
        itemsDescription,
        pieces: 1,
        email: mirror?.email ?? undefined,
        totalPrice,
        totalQuantity,
      });

      trackingNumber = result.trackingNumber;
      const slipLink = extractSlipLink(result.raw);
      // PERSIST THE TRACKING NUMBER NOW — before Shopify. This is the double-book
      // guard: if Shopify (or the process) dies next, the retry sees this tracking
      // number and skips Phase A instead of booking a second parcel.
      await this.prisma.shipment.update({
        where: { id: shipment.id },
        data: {
          status: 'booked',
          courier_credential_id: credentialId,
          courier_tracking_number: trackingNumber,
          courier_city_code: cityCode,
          courier_slip_link: slipLink ?? undefined,
          booked_at: new Date(),
        },
      });
    }

    // ---- Phase B: fulfill in Shopify (skip if already fulfilled) ----
    const courierName = COURIER_DISPLAY_NAME[shipment.courier_type];
    if (!shipment.shopify_fulfillment_gid) {
      if (!order?.fulfillmentOrderId) {
        // Parcel IS booked at the courier, but Shopify has no open fulfillment
        // order (already fulfilled/closed elsewhere). Not a courier failure —
        // record it and stop; the status-sync keeps Shopify's tracking in step.
        await this.prisma.shipment.update({
          where: { id: shipment.id },
          data: {
            booking_error:
              'Booked at courier; Shopify had no open fulfillment to attach (already fulfilled/closed).',
          },
        });
        return;
      }
      const trackingUrl =
        courierTrackingUrl(shipment.courier_type, trackingNumber || '') || undefined;
      const { fulfillmentId, errors } = await this.shopify.createFulfillment(
        shipment.company_id,
        order.fulfillmentOrderId,
        trackingNumber || '',
        courierName,
        trackingUrl,
      );
      if (errors.length) {
        this.logger.warn(
          `fulfillmentCreate userErrors (shipment ${shipment.id}): ${errors.join('; ')}`,
        );
      }
      if (fulfillmentId) {
        await this.prisma.shipment.update({
          where: { id: shipment.id },
          data: { shopify_fulfillment_gid: fulfillmentId },
        });
      }
    }

    // ---- Phase C: tag the order (best-effort; tag-add is idempotent) ----
    if (order?.orderGid) {
      await this.shopify
        .tagOrder(shipment.company_id, order.orderGid, [courierName], [shipment.courier_type])
        .catch((e: unknown) =>
          this.logger.warn(
            `tagOrder failed (shipment ${shipment.id}): ${
              e instanceof Error ? e.message : String(e)
            }`,
          ),
        );
    }

    // Full success → clear any prior booking error AND the stale
    // 'Booking failed — see booking error.' reason a failed earlier attempt
    // wrote to address_issue_reason (else the now-booked parcel keeps showing the
    // ⚠ "Booking failed" warning even though it has a tracking number). Guard the
    // status write so a late retry can't regress a parcel a webhook already
    // advanced (in_transit/delivered/…): only a still-pre-transit row is
    // (re)affirmed 'booked'.
    await this.prisma.shipment.updateMany({
      where: { id: shipment.id, status: { in: ['booked', 'address_issue'] } },
      data: {
        status: 'booked',
        booking_error: null,
        address_issue_reason: null,
      },
    });
  }
}
