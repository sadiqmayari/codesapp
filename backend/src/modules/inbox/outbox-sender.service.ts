import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { OutboxJob } from '../../common/services/outbox.service';
import { InboxService } from './inbox.service';
import { SendMessageType } from './dto/send-message.dto';

/**
 * Delivers transactional-outbox rows (engagement engine, failure-recovery
 * foundation). A producer writes an `outbox` row + state change in one
 * transaction, then this worker delivers the external side-effect exactly once:
 * it claims the row, performs the send, and marks it SENT with the provider ref.
 * A crash/retry can't double-deliver — a row already SENT is skipped.
 *
 * Phase 4: WHATSAPP_SEND is implemented (the order/command handlers are its
 * producers). SHOPIFY_CALL is reserved for the order command path.
 */
@Injectable()
export class OutboxSenderService implements OnModuleInit {
  private readonly logger = new Logger(OutboxSenderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobQueue: JobQueueService,
    private readonly inbox: InboxService,
  ) {}

  onModuleInit(): void {
    this.jobQueue.registerWorker('outbox', (p) => this.process(p as OutboxJob), 2, 60);
  }

  private async process(job: OutboxJob): Promise<void> {
    const row = await this.prisma.outbox.findFirst({
      where: { idempotency_key: job.idempotencyKey },
    });
    // Not visible yet (producer tx not committed) → throw so the job retries.
    if (!row) {
      throw new Error(`outbox row not found yet for ${job.idempotencyKey}`);
    }
    if (row.state === 'SENT') return; // already delivered — exactly-once

    if (row.kind === 'WHATSAPP_SEND') {
      const payload = row.payload as { conversationId?: number; text?: string };
      if (!payload?.conversationId || !payload.text) {
        await this.markFailed(row.id, 'malformed WHATSAPP_SEND payload');
        return;
      }
      const sent = (await this.inbox.sendMessage(row.company_id, payload.conversationId, {
        type: SendMessageType.text,
        content: payload.text,
      })) as { id?: number };
      await this.prisma.outbox.update({
        where: { id: row.id },
        data: {
          state: 'SENT',
          sent_at: new Date(),
          provider_ref: sent?.id != null ? String(sent.id) : null,
        },
      });
      return;
    }

    // SHOPIFY_CALL and any unknown kind are not yet handled here.
    await this.markFailed(row.id, `unhandled outbox kind: ${row.kind}`);
  }

  private async markFailed(id: bigint, reason: string): Promise<void> {
    await this.prisma.outbox
      .update({
        where: { id },
        data: { state: 'FAILED', last_error: reason },
      })
      .catch(() => undefined);
    this.logger.warn(`outbox row ${String(id)} FAILED: ${reason}`);
  }
}
