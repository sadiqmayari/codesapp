import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EventStoreService } from './event-store.service';

/**
 * Order Idempotency Protection (enterprise hardening #2).
 *
 * WHY THIS EXISTS
 * ---------------
 * `ShopifyService.createOrder()` is the SINGLE chokepoint both the manual
 * Create-order modal and the autonomous AI agent pass through. In a system
 * placing real Shopify orders, four independent failure modes each cause a
 * duplicate order (= a real duplicate charge / fulfilment):
 *   1. Queue retry      — the `ai-agent`/`shopify` worker re-runs a job whose
 *                         lease expired or that threw after the order was placed.
 *   2. Worker crash     — process dies between "Shopify created the order" and
 *                         "we recorded that fact", so a replay re-creates it.
 *   3. Duplicate webhook— WhatsApp redelivers an inbound message, re-triggering
 *                         the same confirm → create.
 *   4. Shopify timeout  — the order IS created but the HTTP response times out;
 *                         a naive retry creates a second one.
 *
 * The pre-existing per-conversation `ai_last_order_signature` guard only covers
 * the AI path within ONE conversation. This service is a dedicated, deterministic,
 * cross-path, cross-conversation guard. The fingerprint is
 *   SHA256(normalizedPhone | normalizedAddress | normalizedCart | paymentMethod)
 * and the `UNIQUE(company_id, hash)` constraint on `pending_order_hashes` is the
 * ATOMIC race arbiter: two concurrent workers cannot both reserve the same
 * fingerprint — the database rejects the loser, who then returns the winner's
 * order instead of creating a second.
 *
 * FAILURE PHILOSOPHY
 * ------------------
 * - On a CONCURRENT in-flight collision we throw `ConflictException` (the caller
 *   treats it as a duplicate) — never place a second order.
 * - On an AMBIGUOUS Shopify failure (timeout that may have succeeded) we do NOT
 *   delete the reservation; we shorten its TTL (`release()`), which blocks an
 *   immediate retry from double-creating while still freeing the slot for a
 *   genuine retry after the backoff. (A full Shopify reconcile-by-key is the
 *   documented follow-up; this is the safe interim.)
 * - On an UNEXPECTED guard/DB error we FAIL OPEN (let the real order proceed).
 *   Rationale: a bug in the idempotency table must never block a paying customer's
 *   legitimate order, and the AI path still has its conversation-scoped guard as a
 *   second layer. Failing open here trades a rare, recoverable duplicate for never
 *   silently dropping a real order.
 *
 * Lives in the @Global CommonModule (only needs Prisma + the event log), so any
 * module can inject it without touching the module graph.
 */

/** Window during which an identical fingerprint is considered a duplicate. */
const DEDUP_WINDOW_MS = 25 * 60 * 1000; // 25 min (spec: 15–30)
/** After an ambiguous create failure, block re-create for this long, then free. */
const RETRY_BACKOFF_MS = 90 * 1000;
/** Statuses that block a new reservation while still fresh. */
const BLOCKING_STATUSES = new Set(['in_flight', 'failed']);

export interface OrderRef {
  orderId: string;
  orderName: string;
  adminUrl: string;
}

export interface OrderFingerprintInput {
  phone?: string | null;
  address1?: string | null;
  city?: string | null;
  countryCode?: string | null;
  lineItems: Array<{
    variantId?: string | null;
    title?: string | null;
    quantity: number;
  }>;
  prepaid?: boolean;
}

export type ReserveResult =
  | { kind: 'proceed'; reservationId: number; hash: string }
  | { kind: 'duplicate'; hash: string; order: OrderRef };

@Injectable()
export class OrderIdempotencyService {
  private readonly logger = new Logger(OrderIdempotencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventStoreService,
  ) {}

  // ── Fingerprinting (pure, deterministic) ──────────────────────────────

  /** Last-10-digit phone fingerprint (country-prefix/zero/format agnostic). */
  private static fpPhone(raw?: string | null): string {
    const d = (raw ?? '').replace(/\D/g, '');
    return d.length >= 10 ? d.slice(-10) : d;
  }

  /** Lowercased, whitespace/punctuation-collapsed address fingerprint. */
  private static fpAddress(parts: Array<string | null | undefined>): string {
    return parts
      .map((p) => (p ?? '').toString())
      .join(' ')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /** Order-independent cart fingerprint (variant|title × qty, sorted). */
  private static fpCart(
    items: OrderFingerprintInput['lineItems'],
  ): string {
    return (items ?? [])
      .map((i) => {
        const ref = (i.variantId || i.title || '')
          .toString()
          .trim()
          .toLowerCase();
        const qty = Number.isFinite(i.quantity) ? Math.max(0, Math.floor(i.quantity)) : 0;
        return `${ref}x${qty}`;
      })
      .filter((s) => !s.startsWith('x'))
      .sort()
      .join(';');
  }

  /**
   * Deterministic SHA-256 fingerprint. Returns null when the input is too sparse
   * to identify a customer (no phone AND no address) — in that case dedup is
   * SKIPPED to avoid false-positives (e.g. two different walk-in manual orders
   * with the same cart and no contact details).
   */
  static computeHash(input: OrderFingerprintInput): string | null {
    const phone = OrderIdempotencyService.fpPhone(input.phone);
    const address = OrderIdempotencyService.fpAddress([
      input.address1,
      input.city,
      input.countryCode,
    ]);
    const cart = OrderIdempotencyService.fpCart(input.lineItems);
    if (!cart) return null; // nothing to order → nothing to dedup
    if (!phone && !address) return null; // too sparse to be a customer key
    const payment = input.prepaid ? 'prepaid' : 'cod';
    return createHash('sha256')
      .update([phone, address, cart, payment].join('|'))
      .digest('hex');
  }

  // ── Reservation lifecycle ─────────────────────────────────────────────

  /**
   * Reserve the right to create this order, or short-circuit to an existing one.
   * Caller contract:
   *   const r = await reserve(...);
   *   if (r.kind === 'duplicate') return r.order;     // do NOT create
   *   try { const o = await create(); await finalize(r.reservationId, o); return o; }
   *   catch (e) { await release(r.reservationId); throw e; }
   */
  async reserve(
    companyId: number,
    conversationId: number | null,
    hash: string,
  ): Promise<ReserveResult> {
    const now = new Date();
    try {
      const existing = await this.prisma.pendingOrderHash.findUnique({
        where: { company_id_hash: { company_id: companyId, hash } },
      });

      if (existing) {
        const fresh = existing.expires_at.getTime() > now.getTime();

        // A real, completed order with this fingerprint within the window.
        if (existing.status === 'created' && existing.order_gid && fresh) {
          await this.recordDuplicatePrevented(companyId, conversationId, existing);
          return {
            kind: 'duplicate',
            hash,
            order: {
              orderId: existing.order_gid,
              orderName: existing.order_name ?? existing.order_gid,
              adminUrl: existing.admin_url ?? '',
            },
          };
        }

        // A create is in progress (or just failed) and still fresh → another
        // worker owns this fingerprint. Never place a second order.
        if (BLOCKING_STATUSES.has(existing.status) && fresh) {
          throw new ConflictException(
            'An order with the same details is already being created.',
          );
        }

        // Stale row: an expired in-flight (crashed worker) OR a created row past
        // the dedup window (legitimate reorder). Reclaim the slot.
        await this.prisma.pendingOrderHash
          .delete({ where: { id: existing.id } })
          .catch(() => undefined);
      }

      // Atomically claim the fingerprint. UNIQUE(company_id, hash) arbitrates the
      // race between our find() above and a concurrent worker's create().
      const row = await this.prisma.pendingOrderHash.create({
        data: {
          company_id: companyId,
          conversation_id: conversationId,
          hash,
          status: 'in_flight',
          expires_at: new Date(now.getTime() + DEDUP_WINDOW_MS),
        },
      });
      return { kind: 'proceed', reservationId: row.id, hash };
    } catch (e) {
      if (e instanceof ConflictException) throw e;

      // Lost the insert race: a concurrent worker reserved/created between our
      // find and our create. Re-resolve against the winner.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const winner = await this.prisma.pendingOrderHash
          .findUnique({
            where: { company_id_hash: { company_id: companyId, hash } },
          })
          .catch(() => null);
        if (winner?.status === 'created' && winner.order_gid) {
          await this.recordDuplicatePrevented(companyId, conversationId, winner);
          return {
            kind: 'duplicate',
            hash,
            order: {
              orderId: winner.order_gid,
              orderName: winner.order_name ?? winner.order_gid,
              adminUrl: winner.admin_url ?? '',
            },
          };
        }
        throw new ConflictException(
          'An order with the same details is already being created.',
        );
      }

      // Unexpected DB error → FAIL OPEN (see class doc). reservationId<0 makes
      // finalize/release no-ops, so the real order still proceeds unguarded.
      this.logger.warn(
        `order idempotency reserve failed open (company ${companyId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return { kind: 'proceed', reservationId: -1, hash };
    }
  }

  /** Mark the reservation as a real, completed order (stores the refs to return). */
  async finalize(reservationId: number, order: OrderRef): Promise<void> {
    if (reservationId < 0) return; // fail-open reservation
    await this.prisma.pendingOrderHash
      .update({
        where: { id: reservationId },
        data: {
          status: 'created',
          order_gid: order.orderId,
          order_name: order.orderName,
          admin_url: order.adminUrl,
          expires_at: new Date(Date.now() + DEDUP_WINDOW_MS),
        },
      })
      .catch((e) =>
        this.logger.warn(
          `order idempotency finalize failed (res ${reservationId}): ${
            e instanceof Error ? e.message : String(e)
          }`,
        ),
      );
  }

  /**
   * Release after a FAILED create. We do NOT delete the row — the Shopify call
   * may have actually succeeded before timing out. Instead we mark it 'failed'
   * with a short TTL: an immediate retry is blocked (no double-create), but the
   * slot frees after the backoff so a genuine later retry can proceed.
   */
  async release(reservationId: number): Promise<void> {
    if (reservationId < 0) return;
    await this.prisma.pendingOrderHash
      .update({
        where: { id: reservationId },
        data: {
          status: 'failed',
          expires_at: new Date(Date.now() + RETRY_BACKOFF_MS),
        },
      })
      .catch(() => undefined);
  }

  private async recordDuplicatePrevented(
    companyId: number,
    conversationId: number | null,
    row: { id: number; order_gid: string | null; order_name: string | null },
  ): Promise<void> {
    // Idempotency-keyed so repeated duplicate hits log a single audit event.
    await this.events.append({
      companyId,
      aggregateType: 'ORDER',
      aggregateId: row.id,
      type: 'order.duplicate_prevented',
      actorType: 'SYSTEM',
      payload: {
        conversationId,
        orderName: row.order_name,
        orderGid: row.order_gid,
      },
      idempotencyKey: `order.duplicate_prevented:${row.id}`,
    });
  }
}
