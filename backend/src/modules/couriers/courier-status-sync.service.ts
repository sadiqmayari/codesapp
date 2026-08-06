import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CourierType, ShipmentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { CacheService } from '../../common/services/cache.service';
import { CourierRegistryService } from './courier-registry.service';
import { ShopifyService } from '../integrations/shopify/shopify.service';
import { ShopifyFulfillmentClient } from './shopify-fulfillment-client.service';
import { SHIPMENT_STATUS_TO_SHOPIFY_EVENT } from './couriers.constants';

const SYNC_QUEUE = 'courier-status-sync';

// Non-terminal shipment statuses — the ones worth re-checking. Delivered /
// returned / cancelled are terminal and left alone.
// NOTE: 'failed' is intentionally EXCLUDED — it is now terminal (see
// TERMINAL_SHIPMENT_STATUSES). Once a parcel has failed we stop re-pulling it,
// matching the webhook path's "no update after failed" rule. 'attempted' stays
// (it can still progress to delivered/returned).
const NON_TERMINAL: ShipmentStatus[] = [
  'booked',
  'in_transit',
  'out_for_delivery',
  'picked_up',
  'ready_for_pickup',
  'attempted',
  'address_issue',
];

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
    const shipments = await this.prisma.shipment.findMany({
      where: { company_id: companyId, status: { in: NON_TERMINAL } },
      select: {
        id: true,
        shopify_order_gid: true,
        courier_type: true,
        courier_tracking_number: true,
        status: true,
        last_courier_status_raw: true,
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
      if (!this.registry.getAdapter(ct)?.queryTracking) continue;
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
              mapped = this.normalize(probe.rawStatus);
            } else if (probe.kind === 'dead') {
              deadRef = true;
            }
          } else if (adapter.queryTracking && cred && tracking) {
            const r = await adapter.queryTracking(cred, tracking).catch(() => null);
            if (r) {
              raw = r.rawStatus;
              happenedAt = r.happenedAt;
              reason = r.reason;
              mapped = this.normalize(r.rawStatus);
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
            // Still store an enriched tracking number even if status unchanged.
            if (tracking && !s.courier_tracking_number) {
              await this.prisma.shipment
                .update({ where: { id: s.id }, data: { courier_tracking_number: tracking } })
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
  private normalize(raw: string): ShipmentStatus | null {
    const s = (raw || '').toLowerCase();
    // Failure/return phrasings are checked BEFORE the positive /deliver/ match:
    // several couriers word a FAILED delivery with "deliver" in it — PostEx uses
    // "Un-Delivered", "Delivery Un-Successful", "Delivery Under Review" — which
    // otherwise trip the delivered branch below and get pushed to Shopify as
    // DELIVERED. Match them first so the word "deliver" inside them can't win.
    if (/return|rto/.test(s)) return 'returned';
    if (/cancel/.test(s)) return 'cancelled';
    if (
      /un-?deliver|not delivered|non[-\s]?delivery|delivery (un-?success|unsuccess|failed|under review)|attempt|consignee|on hold|hcr|re-?attempt|un-?success|unsuccess|not attempted|shipper advise/.test(
        s,
      )
    )
      return 'attempted';
    if (/\blost\b|damaged|case closed|expired/.test(s)) return 'failed';
    // Genuine delivery: contains "deliver" and none of the failure/out-for guards.
    // (The failure branch above already returned for the tricky "…delivered"
    //  failure texts; this inline guard is belt-and-suspenders.)
    if (
      /deliver/.test(s) &&
      !/out for|unable|un-?success|unsuccess|un-?deliver|attempt|enroute|not deliver|under review|failed/.test(
        s,
      )
    )
      return 'delivered';
    if (/out for delivery|enroute for delivery|en-route to|dispatched for delivery/.test(s))
      return 'out_for_delivery';
    if (/rider picked|picked up|received from shipper|picked by/.test(s)) return 'picked_up';
    if (/warehouse|transit|arrived|departed|received at|misroute|hub|waiting for delivery/.test(s))
      return 'in_transit';
    return null; // "booked"/unknown → leave as-is
  }

  private mapShopifyDisplay(disp: string | null): ShipmentStatus | null {
    switch ((disp || '').toUpperCase()) {
      case 'DELIVERED':
        return 'delivered';
      case 'IN_TRANSIT':
        return 'in_transit';
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
