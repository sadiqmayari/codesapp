import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { JobQueueService } from '../../../common/services/job-queue.service';
import { deltaForSet, MovementReason, StaleStockError } from './stock-math';

export interface LedgerLine {
  itemId: number;
  locationId: number;
  delta: number;
  /** the store listing that caused it (webhook / order), when known */
  variantId?: number | null;
}

export interface LedgerMeta {
  reason: MovementReason;
  ref?: string | null;
  refType?: string | null;
  note?: string | null;
  actorUserId?: number | null;
  /** exactly-once: a retry with the same key is a no-op (per line: key#n) */
  idemKey?: string | null;
}

export interface LedgerOptions {
  /** fan the new pool out to every linked store (default true) */
  push?: boolean;
  /** a listing whose store already holds this value (its own webhook) */
  skipPushVariantId?: number | null;
}

export interface LedgerResult {
  itemId: number;
  locationId: number;
  available: number;
  applied: boolean;
}

/** Queue that runs every store-facing inventory job (push, sync, webhooks…). */
export const INVENTORY_QUEUE = 'inventory';

/**
 * THE single writer of stock (inventory_levels). Every change — store
 * webhooks, returns, receiving, counts, adjustments, transfers, inline edits —
 * goes through apply(): one transaction, row-locked, atomic increments, a
 * ledger row per line, exactly-once by idem_key. Afterwards the item is
 * queued for a push to every linked store and the change is broadcast.
 *
 * Lives in the @Global CommonModule so Shopify, couriers, the inventory module
 * and the AI can all write stock without module cycles.
 */
@Injectable()
export class InventoryLedgerService {
  private readonly logger = new Logger(InventoryLedgerService.name);
  private gateway?: { emitToCompany(companyId: number, event: string, payload: unknown): void } | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobQueue: JobQueueService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async apply(
    companyId: number,
    lines: LedgerLine[],
    meta: LedgerMeta,
    opts: LedgerOptions = {},
  ): Promise<LedgerResult[]> {
    const clean = lines.filter((l) => l.itemId && l.locationId && Number.isFinite(l.delta));
    if (!clean.length) return [];

    // Bundles have no stock of their own — expand into their components.
    const expanded = await this.expandBundles(companyId, clean);

    const results: LedgerResult[] = [];
    try {
      await this.prisma.$transaction(async (tx) => {
        let n = 0;
        for (const l of expanded) {
          const key = meta.idemKey ? `${meta.idemKey}#${n++}`.slice(0, 191) : null;
          if (key) {
            const dup = await tx.inventoryMovement.findFirst({
              where: { company_id: companyId, idem_key: key },
              select: { id: true },
            });
            if (dup) {
              results.push({ itemId: l.itemId, locationId: l.locationId, available: NaN, applied: false });
              continue;
            }
          }
          await tx.$executeRaw`
            INSERT INTO inventory_levels (company_id, item_id, location_id, available, committed, incoming, version, updated_at)
            VALUES (${companyId}, ${l.itemId}, ${l.locationId}, 0, 0, 0, 0, NOW(3))
            ON DUPLICATE KEY UPDATE id = id`;
          const locked = await tx.$queryRaw<{ id: number; available: number }[]>`
            SELECT id, available FROM inventory_levels
            WHERE item_id = ${l.itemId} AND location_id = ${l.locationId} AND company_id = ${companyId}
            FOR UPDATE`;
          const row = locked[0];
          if (!row) continue;
          const after = Number(row.available) + Math.trunc(l.delta);
          if (l.delta !== 0) {
            await tx.$executeRaw`
              UPDATE inventory_levels
              SET available = available + ${Math.trunc(l.delta)}, version = version + 1, updated_at = NOW(3)
              WHERE id = ${row.id}`;
          }
          await tx.inventoryMovement.create({
            data: {
              company_id: companyId,
              item_id: l.itemId,
              location_id: l.locationId,
              variant_id: l.variantId ?? null,
              delta: Math.trunc(l.delta),
              qty_after: after,
              reason: meta.reason,
              ref: meta.ref?.slice(0, 120) ?? null,
              ref_type: meta.refType ?? null,
              note: meta.note?.slice(0, 500) ?? null,
              idem_key: key,
              actor_user_id: meta.actorUserId ?? null,
            },
          });
          results.push({ itemId: l.itemId, locationId: l.locationId, available: after, applied: true });
        }
      });
    } catch (err) {
      // A concurrent apply with the same idem key won the race — already done.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return expanded.map((l) => ({ itemId: l.itemId, locationId: l.locationId, available: NaN, applied: false }));
      }
      throw err;
    }

    const touched = [...new Set(results.filter((r) => r.applied).map((r) => r.itemId))];
    if (touched.length && opts.push !== false) {
      for (const itemId of touched) await this.queuePush(companyId, itemId);
    }
    if (touched.length) this.emit(companyId, 'inventory.changed', { itemIds: touched, reason: meta.reason });
    return results;
  }

  /**
   * Inline "Available = N" / count result: converts to a delta against what
   * the person saw. 409 when the stock moved since (a sale is never lost).
   */
  async setAvailable(
    companyId: number,
    itemId: number,
    locationId: number,
    target: number,
    seen: number | null | undefined,
    meta: LedgerMeta,
  ): Promise<LedgerResult> {
    const lvl = await this.prisma.inventoryLevel.findUnique({
      where: { item_id_location_id: { item_id: itemId, location_id: locationId } },
      select: { available: true },
    });
    const current = lvl?.available ?? 0;
    let delta: number;
    try {
      delta = deltaForSet({ current, seen, target: Math.max(0, Math.trunc(target)) });
    } catch (e) {
      if (e instanceof StaleStockError) {
        throw new ConflictException({ message: e.message, current: e.current });
      }
      throw e;
    }
    if (delta === 0) return { itemId, locationId, available: current, applied: false };
    const [r] = await this.apply(companyId, [{ itemId, locationId, delta }], meta);
    return r ?? { itemId, locationId, available: current, applied: false };
  }

  /** Mirror committed / incoming (informational, not ledgered). */
  async setCounters(
    companyId: number,
    itemId: number,
    locationId: number,
    patch: { committed?: number; incomingDelta?: number },
  ): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO inventory_levels (company_id, item_id, location_id, available, committed, incoming, version, updated_at)
      VALUES (${companyId}, ${itemId}, ${locationId}, 0, ${Math.max(0, patch.committed ?? 0)}, ${Math.max(0, patch.incomingDelta ?? 0)}, 0, NOW(3))
      ON DUPLICATE KEY UPDATE
        committed = ${patch.committed != null ? Prisma.sql`${Math.max(0, patch.committed)}` : Prisma.sql`committed`},
        incoming = GREATEST(0, incoming + ${Math.trunc(patch.incomingDelta ?? 0)}),
        updated_at = NOW(3)`;
  }

  /** Queue one coalesced store push for an item (dedup per item). */
  async queuePush(companyId: number, itemId: number): Promise<void> {
    await this.jobQueue
      .enqueue(
        INVENTORY_QUEUE,
        { kind: 'pushItem', companyId, itemId },
        { dedupKey: `inv2-push:${itemId}`, maxAttempts: 3 },
      )
      .catch((e) => this.logger.warn(`queuePush ${itemId}: ${e instanceof Error ? e.message : e}`));
  }

  emit(companyId: number, event: string, payload: unknown): void {
    try {
      if (this.gateway === undefined) {
        const { InboxGateway } = require('../../inbox/inbox.gateway');
        this.gateway = this.moduleRef.get(InboxGateway, { strict: false }) ?? null;
      }
      this.gateway?.emitToCompany(companyId, event, payload);
    } catch {
      this.gateway = null;
    }
  }

  private async expandBundles(companyId: number, lines: LedgerLine[]): Promise<LedgerLine[]> {
    const ids = [...new Set(lines.map((l) => l.itemId))];
    const items = await this.prisma.inventoryItem.findMany({
      where: { company_id: companyId, id: { in: ids }, is_bundle: true },
      select: { id: true, bundle_components: true },
    });
    if (!items.length) return lines;
    const comps = new Map<number, Array<{ itemId: number; quantity: number }>>();
    for (const it of items) {
      const arr = Array.isArray(it.bundle_components)
        ? (it.bundle_components as Array<{ itemId?: number; quantity?: number }>)
        : [];
      comps.set(
        it.id,
        arr
          .filter((c) => Number(c?.itemId) > 0)
          .map((c) => ({ itemId: Number(c.itemId), quantity: Math.max(1, Number(c.quantity) || 1) })),
      );
    }
    const out: LedgerLine[] = [];
    for (const l of lines) {
      const c = comps.get(l.itemId);
      if (!c) {
        out.push(l);
        continue;
      }
      for (const x of c) out.push({ itemId: x.itemId, locationId: l.locationId, delta: l.delta * x.quantity, variantId: null });
    }
    return out;
  }
}
