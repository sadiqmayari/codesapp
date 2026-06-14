import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from './job-queue.service';

export type OutboxKind = 'WHATSAPP_SEND' | 'SHOPIFY_CALL';

/** Job payload for the outbox delivery worker (loads the row by its unique key). */
export interface OutboxJob {
  idempotencyKey: string;
}

export interface OutboxInput {
  companyId: number;
  kind: OutboxKind;
  /**
   * Stable per-effect key. The UNIQUE constraint makes enqueue idempotent: a
   * crash-retry that re-enqueues the same effect is a no-op, so the eventual
   * sender delivers it exactly once.
   */
  idempotencyKey: string;
  payload: unknown;
}

/**
 * Transactional outbox (engagement-engine Phase 0). A command writes its state
 * change AND an outbox row in the SAME transaction, then a sender worker delivers
 * the external side-effect (WhatsApp/Shopify) keyed by idempotency_key. This
 * closes the "state changed but message never sent" / "sent twice on retry" gap
 * in the current fire-and-forget send paths.
 *
 * Phase 0 ships the durable enqueue + the model; the sender worker is wired in a
 * later phase. enqueue() accepts an optional Prisma transaction client so it can
 * be atomic with the state write.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobQueue: JobQueueService,
  ) {}

  /**
   * Durably record an external side-effect to be delivered. Idempotent on
   * idempotencyKey — a duplicate enqueue returns without creating a second row.
   * Pass `tx` to enlist in an existing transaction (recommended for atomicity
   * with the state change that triggered the effect).
   */
  async enqueue(
    input: OutboxInput,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;
    try {
      await db.outbox.create({
        data: {
          company_id: input.companyId,
          kind: input.kind,
          idempotency_key: input.idempotencyKey,
          payload: input.payload as Prisma.InputJsonValue,
          state: 'PENDING',
        },
      });
    } catch (err) {
      // Unique violation on idempotency_key = already enqueued → no-op (the
      // delivery job was already scheduled by the first enqueue).
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return;
      }
      throw err;
    }

    // Schedule delivery. The worker loads the row by idempotency_key, so it's
    // robust to a not-yet-committed tx (it retries until the row is visible).
    // dedupKey makes the job itself idempotent.
    await this.jobQueue.enqueue(
      'outbox',
      { idempotencyKey: input.idempotencyKey } as OutboxJob,
      { dedupKey: `outbox:${input.idempotencyKey}` },
    );
  }
}
