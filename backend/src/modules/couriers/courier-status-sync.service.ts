import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CourierType, ShipmentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { CacheService } from '../../common/services/cache.service';
import { CourierRegistryService } from './courier-registry.service';
import { ShopifyService } from '../integrations/shopify/shopify.service';
import { ShopifyFulfillmentClient } from './shopify-fulfillment-client.service';
import { SHIPMENT_STATUS_TO_SHOPIFY_EVENT } from './couriers.constants';
import { isReturnedToShipper } from './adapters/return-status.util';
import {
  CourierAdapter,
  UnmappedCourierStatusError,
} from './adapters/courier-adapter.interface';

const SYNC_QUEUE = 'courier-status-sync';

// Non-terminal shipment statuses — the ones worth re-checking. Delivered /
// returned / cancelled are terminal and left alone.
const NON_TERMINAL: ShipmentStatus[] = [
  'booked',
  'in_transit',
  'out_for_delivery',
  'picked_up',
  'ready_for_pickup',
  'attempted',
  'address_issue',
];

// 'failed' is re-polled too, but ONLY when recently updated: the tenant models
// return-in-motion legs as 'failed' (Failed tab) and those must keep tracking so
// they promote to 'returned' on physical arrival. A genuinely-dead parcel
// (lost / case-closed) stops churning courier APIs once it's older than this.
const FAILED_REPOLL_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

interface SyncJob {
  kind: 'sync';
  companyId: number;
}

/**
 * Keeps shipment statuses fresh by pulling the courier's OWN tracking API for
 * every non-terminal shipment — the fix for parcels that get stuck (e.g. at
 * 'booked') because the courier→Shopify tracking sync never ran. Two phases:
 *  1. Enrich missing tracking numbers from Shopify (our shipments often lack
 *     them; Shopify's fulfillment carries them). This also yields Shopify's own
 *     displayStatus as a fallback for couriers with no pull API.
 *  2. Pull the current status from the courier (Trax/PostEx) by tracking number,
 *     map it, and update the shipment (+ the orders mirror for delivered).
 * Runs as a background job (courier-status-sync queue). Never throws per-parcel.
 */
@Injectable()
export class CourierStatusSyncService implements OnModuleInit {
  private readonly logger = new Logger(CourierStatusSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobQueue: JobQueueService,
    private readonly cache: CacheService,
    private readonly registry: CourierRegistryService,
    private readonly shopify: ShopifyService,
    private readonly shopifyFulfillment: ShopifyFulfillmentClient,
  ) {}

  onModuleInit(): void {
    this.jobQueue.registerWorker(
      SYNC_QUEUE,
      (p) => this.runSync((p as SyncJob).companyId),
      1, // one sync per tenant at a time (each fans out many courier calls)
      900,
    );
    this.logger.log('Registered courier-status-sync worker (concurrency=1, lease=900s)');
  }

  /** Enqueue a status sync for a company (deduped so double-clicks coalesce). */
  async requestSync(companyId: number): Promise<{ started: true }> {
    await this.jobQueue.enqueue(
      SYNC_QUEUE,
      { kind: 'sync', companyId } satisfies SyncJob,
      { dedupKey: `courier-status-sync:${companyId}`, maxAttempts: 1 },
    );
    return { started: true };
  }

  /** Cron entrypoint — enqueue a sync for every company with active couriers. */
  async syncAllCompanies(): Promise<{ enqueued: number }> {
    const rows = await this.prisma.courierCredential.findMany({
      where: { is_active: true },
      select: { company_id: true },
      distinct: ['company_id'],
    });
    for (const r of rows) await this.requestSync(r.company_id);
    return { enqueued: rows.length };
  }

  async runSync(companyId: number): Promise<void> {
    const failedCutoff = new Date(Date.now() - FAILED_REPOLL_MAX_AGE_MS);
    const shipments = await this.prisma.shipment.findMany({
      where: {
        company_id: companyId,
        OR: [
          { status: { in: NON_TERMINAL } },
          // Return-in-motion legs live under 'failed'; keep re-polling the
          // recent ones so they promote to 'returned' when they arrive. A
          // physically-RECEIVED parcel (received_at set) is settled — stop
          // re-polling it so a later courier status can't flip it off 'failed'.
          { status: 'failed', updated_at: { gte: failedCutoff }, received_at: null },
        ],
      },
      select: {
        id: true,
        shopify_order_gid: true,
        courier_type: true,
        courier_tracking_number: true,
        status: true,
        last_courier_status_raw: true,
        shopify_fulfillment_gid: true,
      },
      take: 5000,
    });
    if (!shipments.length) {
      this.logger.log(`Status sync (company ${companyId}): nothing non-terminal.`);
      return;
    }

    // Preload decrypted creds for EVERY active courier whose adapter can pull
    // tracking (queryTracking implemented) — not a hardcoded list, so a courier
    // added in future is picked up automatically once its adapter supports it.
    const active = await this.registry.getActiveCouriers(companyId);
    const creds = new Map<CourierType, unknown>();
    for (const ct of active) {
      const adapter = this.registry.getAdapter(ct);
      // A courier can pull if it implements EITHER queryTracking or the richer
      // queryTrackingResult (Leopards uses the latter to pre-map its own pull
      // vocabulary). Skip webhook-only couriers.
      if (!adapter?.queryTracking && !adapter?.queryTrackingResult) continue;
      const c = await this.registry.getCredentials(companyId, ct).catch(() => null);
      if (c) creds.set(ct, c);
    }

    // Enrich tracking number + fulfillment GID + Shopify displayStatus for ALL
    // shipments (we need the fulfillment GID to push the corrected status back
    // to Shopify, and displayStatus as the fallback for pull-less couriers).
    let enrich = new Map<
      string,
      {
        company: string | null;
        number: string | null;
        displayStatus: string | null;
        fulfillmentGid: string | null;
      }
    >();
    enrich = await this.shopify
      .getFulfillmentTracking(
        companyId,
        shipments.map((s) => s.shopify_order_gid),
      )
      .catch(() => enrich);

    let checked = 0;
    let enriched = 0;
    let updated = 0;
    let pushed = 0;
    const byStatus: Record<string, number> = {};

    // Phase 2 — pull + apply, in small concurrent batches (courier APIs).
    const CONCURRENCY = 4;
    for (let i = 0; i < shipments.length; i += CONCURRENCY) {
      const slice = shipments.slice(i, i + CONCURRENCY);
      await Promise.all(
        slice.map(async (s) => {
          checked++;
          const enr = enrich.get(s.shopify_order_gid);
          const tracking = s.courier_tracking_number || enr?.number || null;
          if (tracking && !s.courier_tracking_number) enriched++;

          let mapped: ShipmentStatus | null = null;
          let raw: string | null = null;
          let happenedAt: Date | undefined;
          let reason: string | undefined;

          const adapter = this.registry.getAdapter(s.courier_type);
          const cred = creds.get(s.courier_type);
          let deadRef = false;
          if (adapter.queryTrackingResult && cred && tracking) {
            // Richer probe (Rocket): distinguishes a dead/rerouted ref from
            // "no new status" so we can flag it instead of re-polling forever.
            const probe = await adapter
              .queryTrackingResult(cred, tracking)
              .catch(() => ({ kind: 'none' as const }));
            if (probe.kind === 'status') {
              raw = probe.rawStatus;
              happenedAt = probe.happenedAt;
              reason = probe.reason;
              // Prefer the adapter's own resolution when it provides one
              // (Leopards pull vocabulary); else the adapter's mapStatus, then
              // the generic heuristic.
              mapped = probe.mapped ?? this.resolvePulledStatus(adapter, probe.rawStatus);
            } else if (probe.kind === 'dead') {
              deadRef = true;
            }
          } else if (adapter.queryTracking && cred && tracking) {
            const r = await adapter.queryTracking(cred, tracking).catch(() => null);
            if (r) {
              raw = r.rawStatus;
              happenedAt = r.happenedAt;
              reason = r.reason;
              mapped = this.resolvePulledStatus(adapter, r.rawStatus);
            }
          }
          // Dead ref (e.g. a Rocket parcel that was rerouted and reassigned a
          // new tracking number): the stored ref will never resolve again and
          // Rocket exposes no order→new-ref lookup, so flag it ONCE as
          // needs-attention (surfaced via last_status_reason) rather than
          // silently re-polling a dead ref every sync. Non-terminal only.
          if (deadRef && !mapped) {
            const MARKER = 'rerouted-ref-stale';
            if (s.last_courier_status_raw !== MARKER) {
              await this.prisma.shipment
                .update({
                  where: { id: s.id },
                  data: {
                    last_courier_status_raw: MARKER,
                    last_status_reason:
                      'Courier reassigned this parcel a new tracking number (rerouted); the original ref no longer tracks. Verify in the Rocket portal.',
                  },
                })
                .catch(() => undefined);
              updated++;
              byStatus['rerouted_flagged'] = (byStatus['rerouted_flagged'] || 0) + 1;
            }
            return;
          }
          // Fallback: Shopify's own delivery status (couriers with no pull API).
          if (!mapped && enr?.displayStatus) {
            mapped = this.mapShopifyDisplay(enr.displayStatus);
            if (mapped) raw = enr.displayStatus;
          }

          if (!mapped || mapped === s.status) {
            // Still store an enriched tracking number and/or fulfillment GID
            // even if the status is unchanged. Persisting the GID here backfills
            // it for the webhook path (whose real-time push is dead without it —
            // see shipment-tracking.service). Only writes when there's something
            // new to store.
            const fgid = enr?.fulfillmentGid ?? null;
            const data: {
              courier_tracking_number?: string;
              shopify_fulfillment_gid?: string;
            } = {};
            if (tracking && !s.courier_tracking_number) data.courier_tracking_number = tracking;
            if (fgid && !s.shopify_fulfillment_gid) data.shopify_fulfillment_gid = fgid;
            if (Object.keys(data).length) {
              await this.prisma.shipment
                .update({ where: { id: s.id }, data })
                .catch(() => undefined);
            }
            return;
          }

          const delivered = mapped === 'delivered';
          const attemptedOrFailed = mapped === 'attempted' || mapped === 'failed';
          await this.prisma.shipment
            .update({
              where: { id: s.id },
              data: {
                status: mapped,
                courier_tracking_number: tracking ?? undefined,
                // Backfill the GID whenever Shopify hands us one and we lack it,
                // so the real-time webhook push (which needs it) starts working.
                shopify_fulfillment_gid:
                  enr?.fulfillmentGid && !s.shopify_fulfillment_gid
                    ? enr.fulfillmentGid
                    : undefined,
                last_courier_status_raw: raw ?? undefined,
                delivered_at: delivered ? happenedAt ?? new Date() : undefined,
                // Keep a human reason for attempted/failed; clear when it moves on.
                last_status_reason: attemptedOrFailed ? reason ?? undefined : null,
              },
            })
            .catch(() => undefined);
          // Keep the orders mirror consistent for delivered (feeds performance
          // + payments). Non-throwing, targeted.
          if (delivered) {
            await this.prisma.shopifyOrder
              .updateMany({
                where: { company_id: companyId, shopify_order_gid: s.shopify_order_gid },
                data: {
                  delivery_status: 'delivered',
                  delivered_at: happenedAt ?? new Date(),
                  ...(tracking ? { tracking_number: tracking } : {}),
                },
              })
              .catch(() => undefined);
          }
          updated++;
          byStatus[mapped] = (byStatus[mapped] || 0) + 1;

          // Push the corrected status back to Shopify so it reflects reality
          // too — but SUPPRESS the customer notification first (a bulk backfill
          // must never WhatsApp weeks-old customers). Only when we have a
          // Shopify fulfillment GID and a mappable delivery-lifecycle event
          // (returned/cancelled have none — Shopify keeps its own order state).
          const shopifyEvent = SHIPMENT_STATUS_TO_SHOPIFY_EVENT[mapped];
          if (enr?.fulfillmentGid && shopifyEvent) {
            const numId = s.shopify_order_gid.split('/').pop();
            if (numId) {
              this.cache.set(`shopify-sync-suppress:${companyId}:${numId}`, 1, 1800);
            }
            await this.shopifyFulfillment
              .createFulfillmentEvent(companyId, enr.fulfillmentGid, shopifyEvent)
              .then(() => {
                pushed++;
              })
              .catch(() => undefined);
          }
        }),
      );
    }

    this.logger.log(
      `Status sync (company ${companyId}): checked=${checked} enriched=${enriched} updated=${updated} pushed=${pushed} ${JSON.stringify(byStatus)}`,
    );
  }

  /**
   * Tolerant map of a courier's PULLED status text → our ShipmentStatus. The
   * pull vocabulary is richer/messier than the webhook vocabulary the adapters'
   * strict mapStatus handles, so this uses substring heuristics. Returns null
   * to mean "no confident mapping / no change" (e.g. still just 'booked').
   */
  /**
   * Resolve a PULLED raw courier status. The courier adapter's `mapStatus` is
   * AUTHORITATIVE for its own vocabulary — e.g. PostEx "At {Merchant} Warehouse"
   * means the parcel is still at the merchant's origin warehouse awaiting pickup
   * (ready_for_pickup), NOT the generic "warehouse → in_transit" the heuristic
   * assumes. So try mapStatus first and fall back to the generic `normalize()`
   * ONLY for strings the adapter doesn't recognize. This makes the pull classify
   * identically to the webhook path (which already uses mapStatus) — the disagreement
   * was marking booked-but-unpicked PostEx parcels as in_transit.
   */
  private resolvePulledStatus(
    adapter: CourierAdapter,
    raw: string,
  ): ShipmentStatus | null {
    try {
      return adapter.mapStatus(raw);
    } catch (err) {
      if (err instanceof UnmappedCourierStatusError) return this.normalize(raw);
      throw err;
    }
  }

  private normalize(raw: string): ShipmentStatus | null {
    const s = (raw || '').toLowerCase();
    // Failure/return phrasings are checked BEFORE the positive /deliver/ match:
    // several couriers word a FAILED delivery with "deliver" in it — PostEx uses
    // "Un-Delivered", "Delivery Un-Successful", "Delivery Under Review" — which
    // otherwise trip the delivered branch below and get pushed to Shopify as
    // DELIVERED. Match them first so the word "deliver" inside them can't win.
    // Only a COMPLETED hand-back is a true return; any other return leg is the
    // parcel still moving back = a failed delivery in motion → 'attempted'
    // (non-terminal) so the pull keeps checking until it physically arrives and
    // promotes to 'returned'. (isReturnedToShipper takes the RAW text so its
    // word-boundary checks aren't disturbed by the lowercasing above.)
    if (isReturnedToShipper(raw)) return 'returned';
    // "Ready for Return" = the parcel is only QUEUED to be returned (still with
    // the courier, a decision can still flip it) → 'attempted'. Checked BEFORE
    // the generic return→failed rule below.
    if (/ready for return/.test(s)) return 'attempted';
    // Any other return leg — the parcel is ON ITS WAY BACK to the merchant after
    // a failed delivery (incl. "En Route to Merchant Warehouse", "Returning to
    // shipper") → 'failed' (the Failed tab). 'failed' is re-polled so it still
    // promotes to 'returned' when it physically arrives.
    if (/return|rto|reverse/.test(s)) return 'failed';
    if (
      /en[\s-]?route to\s+(the\s+)?(merchant|shipper|seller|consignor|origin)|(returning|back) to\s+(the\s+)?(merchant|shipper|seller|origin)/.test(
        s,
      )
    )
      return 'failed';
    // Failed-delivery reasons phrased without "attempt"/"deliver" — a delivery
    // was tried and failed, parcel still in play → 'attempted'.
    if (/customer not available|consignee not available|address closed|premises closed/.test(s))
      return 'attempted';
    if (/cancel/.test(s)) return 'cancelled';
    // A genuine re-attempt / re-delivery (parcel going out for another try) is
    // movement → in_transit, NOT a failed attempt. A mere re-attempt *request /
    // advice / call* isn't moving yet, so it falls through to the 'attempted'
    // match below (which still catches the bare word "attempt").
    if (/re-?attempt|re-?deliver/.test(s) && !/request|advis|call/.test(s))
      return 'in_transit';
    if (
      /un-?deliver|not delivered|non[-\s]?delivery|delivery (un-?success|unsuccess|failed|under review)|attempt|consignee|on hold|hcr|un-?success|unsuccess|not attempted|shipper advise/.test(
        s,
      )
    )
      return 'attempted';
    if (/\blost\b|damaged|case closed|expired/.test(s)) return 'failed';
    // Genuine delivery: contains "deliver" and none of the failure/out-for/
    // in-transit guards. NOTE `waiting` is guarded: PostEx's "Waiting for
    // Delivery" is an IN-TRANSIT hub status (parcel waiting to go out for
    // delivery), NOT a completed delivery — but it contains "Delivery", so
    // without this guard it tripped the delivered branch and got pushed to
    // Shopify as DELIVERED (427 PostEx parcels were wrongly marked delivered).
    // It now falls through to the `waiting for delivery` → in_transit branch.
    if (
      /deliver/.test(s) &&
      !/out for|unable|un-?success|unsuccess|un-?deliver|attempt|enroute|not deliver|under review|failed|waiting/.test(
        s,
      )
    )
      return 'delivered';
    if (/out for delivery|enroute for delivery|en-route to|dispatched for delivery/.test(s))
      return 'out_for_delivery';
    // A picked parcel is treated as in-transit (picked_up is retired from the
    // tab/Shopify model — a pick is just the first in-transit hop).
    if (/rider picked|picked up|received from shipper|picked by/.test(s)) return 'in_transit';
    if (/warehouse|transit|arrived|departed|received at|misroute|hub|waiting for delivery/.test(s))
      return 'in_transit';
    return null; // "booked"/unknown → leave as-is
  }

  private mapShopifyDisplay(disp: string | null): ShipmentStatus | null {
    switch ((disp || '').toUpperCase()) {
      case 'DELIVERED':
        return 'delivered';
      // IN_TRANSIT is deliberately NOT trusted: Shopify sets a fulfillment's
      // displayStatus to IN_TRANSIT BY DEFAULT the moment it carries a tracking
      // number — before any real courier scan. Trusting it here promoted booked-
      // but-unpicked parcels to in_transit (and looped back as a pushed IN_TRANSIT
      // event). The courier's own pull/webhook is the authority for movement; a
      // real hub scan still arrives via mapStatus. So treat Shopify IN_TRANSIT as
      // "no info" and leave the parcel at its booked/ready_for_pickup state.
      case 'IN_TRANSIT':
        return null;
      case 'OUT_FOR_DELIVERY':
        return 'out_for_delivery';
      case 'ATTEMPTED_DELIVERY':
        return 'attempted';
      case 'NOT_DELIVERED':
      case 'FAILURE':
        return 'failed';
      case 'PICKED_UP':
        return 'picked_up';
      case 'READY_FOR_PICKUP':
        return 'ready_for_pickup';
      case 'CANCELED':
        return 'cancelled';
      default:
        return null; // FULFILLED / CONFIRMED / LABEL_* carry no delivery info
    }
  }
}
