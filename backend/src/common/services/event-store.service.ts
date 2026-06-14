import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export type AggregateType = 'CONVERSATION' | 'WORK_ITEM' | 'ORDER' | 'TICKET';
export type ActorType =
  | 'CUSTOMER'
  | 'AI'
  | 'AGENT'
  | 'SYSTEM'
  | 'SHOPIFY'
  | 'META';

export interface EventInput {
  companyId: number;
  aggregateType: AggregateType;
  aggregateId: number | bigint;
  type: string;
  actorType: ActorType;
  actorId?: string | null;
  payload?: unknown;
  /**
   * When set, the event is recorded at most once per (company, key). A repeat
   * append with the same key is a no-op — this is the idempotency ledger that
   * makes at-least-once jobs/webhooks safe to replay.
   */
  idempotencyKey?: string | null;
}

/**
 * Append-only event log (engagement-engine Phase 0). The current-state tables
 * remain the system-of-record; events are written ALONGSIDE them (shadow at
 * first) to provide an audit trail, an idempotency ledger, and a recovery/replay
 * foundation.
 *
 * append() is intentionally BEST-EFFORT / never-throws: a failed shadow write
 * must never break a live message/order/ticket flow. Per-aggregate `seq` is
 * computed in a single atomic INSERT (a read-then-insert would race because
 * concurrent awaits interleave even on the single Prisma connection).
 */
@Injectable()
export class EventStoreService {
  private readonly logger = new Logger(EventStoreService.name);

  constructor(private readonly prisma: PrismaService) {}

  async append(e: EventInput): Promise<void> {
    try {
      // Fast idempotency short-circuit (avoids a doomed INSERT for the common
      // replay case). The UNIQUE(company_id, idempotency_key) is the real guard.
      if (e.idempotencyKey) {
        const existing = await this.prisma.event.findFirst({
          where: { company_id: e.companyId, idempotency_key: e.idempotencyKey },
          select: { id: true },
        });
        if (existing) return;
      }

      const aggregateId =
        typeof e.aggregateId === 'bigint' ? e.aggregateId : BigInt(e.aggregateId);
      const payloadJson =
        e.payload === undefined || e.payload === null
          ? null
          : JSON.stringify(e.payload);

      // Single-statement next-seq: the derived table `t` lets us read MAX(seq)
      // for this aggregate while inserting into the same table (plain
      // INSERT...SELECT FROM events would be rejected by MySQL).
      await this.prisma.$executeRaw`
        INSERT INTO events
          (company_id, aggregate_type, aggregate_id, seq, type, actor_type,
           actor_id, payload, idempotency_key, created_at)
        SELECT ${e.companyId}, ${e.aggregateType}, ${aggregateId},
               (SELECT COALESCE(MAX(t.seq), 0) + 1
                  FROM (SELECT seq FROM events
                         WHERE aggregate_type = ${e.aggregateType}
                           AND aggregate_id = ${aggregateId}) t),
               ${e.type}, ${e.actorType}, ${e.actorId ?? null},
               ${payloadJson}, ${e.idempotencyKey ?? null}, NOW(3)
      `;
    } catch (err) {
      // Duplicate idempotency_key (concurrent winner already recorded it) or a
      // transient seq collision — neither should disrupt the caller.
      this.logger.debug(
        `event append skipped (${e.aggregateType}#${String(e.aggregateId)} ${e.type}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
