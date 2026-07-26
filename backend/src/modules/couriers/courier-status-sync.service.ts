import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CourierType, ShipmentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { CourierRegistryService } from './courier-registry.service';
import { ShopifyService } from '../integrations/shopify/shopify.service';

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
  'failed',
  'address_issue',
];

// Couriers with a working pull-tracking API (queryTracking implemented).
const PULL_COURIERS: CourierType[] = ['trax', 'postex'];

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
    private readonly registry: CourierRegistryService,
    private readonly shopify: ShopifyService,
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
      },
      take: 5000,
    });
    if (!shipments.length) {
      this.logger.log(`Status sync (company ${companyId}): nothing non-terminal.`);
      return;
    }

    // Preload decrypted creds for the couriers that support pull.
    const active = await this.registry.getActiveCouriers(companyId);
    const creds = new Map<CourierType, unknown>();
    for (const ct of PULL_COURIERS) {
      if (active.includes(ct)) {
        const c = await this.registry.getCredentials(companyId, ct).catch(() => null);
        if (c) creds.set(ct, c);
      }
    }

    // Phase 1 — enrich tracking numbers (+ get Shopify displayStatus) for the
    // shipments that don't have a tracking number yet.
    const needTracking = shipments
      .filter((s) => !s.courier_tracking_number)
      .map((s) => s.shopify_order_gid);
    let enrich = new Map<
      string,
      { company: string | null; number: string | null; displayStatus: string | null }
    >();
    if (needTracking.length) {
      enrich = await this.shopify
        .getFulfillmentTracking(companyId, needTracking)
        .catch(() => enrich);
    }

    let checked = 0;
    let enriched = 0;
    let updated = 0;
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

          const adapter = this.registry.getAdapter(s.courier_type);
          const cred = creds.get(s.courier_type);
          if (adapter.queryTracking && cred && tracking) {
            const r = await adapter.queryTracking(cred, tracking).catch(() => null);
            if (r) {
              raw = r.rawStatus;
              happenedAt = r.happenedAt;
              mapped = this.normalize(r.rawStatus);
            }
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
          await this.prisma.shipment
            .update({
              where: { id: s.id },
              data: {
                status: mapped,
                courier_tracking_number: tracking ?? undefined,
                last_courier_status_raw: raw ?? undefined,
                delivered_at: delivered ? happenedAt ?? new Date() : undefined,
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
        }),
      );
    }

    this.logger.log(
      `Status sync (company ${companyId}): checked=${checked} enriched=${enriched} updated=${updated} ${JSON.stringify(byStatus)}`,
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
    if (/deliver/.test(s) && !/out for|unable|unsuccess|attempt|enroute|not deliver|failed/.test(s))
      return 'delivered';
    if (/return|rto/.test(s)) return 'returned';
    if (/cancel/.test(s)) return 'cancelled';
    if (/out for delivery|enroute for delivery|en-route to|dispatched for delivery/.test(s))
      return 'out_for_delivery';
    if (/attempt|consignee|on hold|hcr|re-?attempt|unsuccess|not attempted|shipper advise/.test(s))
      return 'attempted';
    if (/\blost\b|damaged|case closed/.test(s)) return 'failed';
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
