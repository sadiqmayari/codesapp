import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

type JobHandler = (payload: unknown) => Promise<void>;

interface WorkerRegistration {
  handler: JobHandler;
  concurrency: number;
  activeSlots: number;
  leaseSeconds: number;
}

const DEFAULT_LEASE_SECONDS = 30;
const POLL_INTERVAL_MS = 2000;
const BACKOFF_SECONDS = [60, 300, 1800];
const INSTANCE_ID = uuidv4();

@Injectable()
export class JobQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobQueueService.name);
  private readonly workers = new Map<string, WorkerRegistration>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // Self-scheduling loop (NOT setInterval): each poll runs to completion, then
    // schedules the next one POLL_INTERVAL_MS later. With setInterval the async
    // poll() was never awaited, so under DB contention (connection_limit=1) a
    // slow poll let the next one start before it finished — overlapping polls
    // piled up pending queries/promises in memory until the process was OOM-
    // killed and restarted. Self-scheduling guarantees only ONE poll at a time.
    this.stopped = false;
    this.scheduleNextPoll();
    this.logger.log('Job queue poller started (every 2s, non-overlapping)');
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private scheduleNextPoll(): void {
    if (this.stopped) return;
    this.pollTimer = setTimeout(async () => {
      try {
        await this.poll();
      } catch (err) {
        this.logger.warn(
          `Job poll cycle failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } finally {
        this.scheduleNextPoll();
      }
    }, POLL_INTERVAL_MS);
  }

  async enqueue(
    queueName: string,
    payload: unknown,
    opts: {
      delayMs?: number;
      maxAttempts?: number;
      // Jobs sharing a non-null serialKey run one-at-a-time, in FIFO order
      // (per-conversation serialization). Omit for legacy parallel behavior.
      serialKey?: string;
      // Enqueue idempotency: a non-null dedupKey may exist at most once across
      // live jobs (UNIQUE). A duplicate enqueue is a no-op (returns 0).
      dedupKey?: string;
      // Lower = claimed sooner. Defaults to 5.
      priority?: number;
    } = {},
  ): Promise<number> {
    const runAt = opts.delayMs
      ? new Date(Date.now() + opts.delayMs)
      : new Date();

    try {
      const job = await this.prisma.job.create({
        data: {
          queue_name: queueName,
          payload: payload as object,
          status: 'pending',
          max_attempts: opts.maxAttempts ?? 3,
          run_at: runAt,
          serial_key: opts.serialKey ?? null,
          dedup_key: opts.dedupKey ?? null,
          priority: opts.priority ?? 5,
        },
      });
      return job.id;
    } catch (err) {
      // Duplicate dedup_key → an equivalent job is already queued; treat as a
      // successful no-op so the caller isn't forced to handle the race.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        opts.dedupKey
      ) {
        this.logger.debug(
          `enqueue deduped on dedup_key=${opts.dedupKey} (queue ${queueName})`,
        );
        return 0;
      }
      throw err;
    }
  }

  registerWorker(
    queueName: string,
    handler: JobHandler,
    concurrency = 3,
    // Lease must exceed the worker's worst-case run time, or a slow job's lease
    // expires mid-flight and another claim double-executes it. AI/Shopify
    // queues (LLM + GraphQL round-trips) should pass a higher value.
    leaseSeconds = DEFAULT_LEASE_SECONDS,
  ): void {
    this.workers.set(queueName, {
      handler,
      concurrency,
      activeSlots: 0,
      leaseSeconds,
    });
    this.logger.log(
      `Worker registered for queue: ${queueName} (concurrency: ${concurrency}, lease: ${leaseSeconds}s)`,
    );
  }

  private async poll(): Promise<void> {
    this.logger.verbose('polling jobs');

    for (const [queueName, worker] of this.workers.entries()) {
      const available = worker.concurrency - worker.activeSlots;
      if (available <= 0) continue;

      const now = new Date();
      const leaseExpiry = new Date(Date.now() + worker.leaseSeconds * 1000);

      // NOTE: per-conversation serial-key single-flight was temporarily REVERTED
      // here (was spiking the single-connection DB / causing 503s in prod). This
      // is the original known-good claim: ONE indexed query (queue_name, status,
      // run_at) per queue, then claim. serial_key/dedup_key columns + enqueue
      // params remain (harmless, ignored) so serialization can be re-introduced
      // carefully once verified with EXPLAIN against the live jobs table.
      let jobs: { id: number }[];
      try {
        jobs = await this.prisma.$queryRaw<{ id: number }[]>`
          SELECT id FROM jobs
          WHERE queue_name = ${queueName}
            AND status = 'pending'
            AND run_at <= ${now}
            AND (locked_until IS NULL OR locked_until < ${now})
          ORDER BY run_at
          LIMIT ${available}
          FOR UPDATE SKIP LOCKED
        `;
      } catch {
        continue;
      }

      if (!jobs.length) continue;

      await this.prisma.job.updateMany({
        where: { id: { in: jobs.map((j) => j.id) } },
        data: {
          status: 'processing',
          locked_until: leaseExpiry,
          locked_by: INSTANCE_ID,
        },
      });

      for (const { id } of jobs) {
        worker.activeSlots++;
        this.runJob(id, worker).finally(() => {
          worker.activeSlots--;
        });
      }
    }
  }

  private async runJob(
    jobId: number,
    worker: WorkerRegistration,
  ): Promise<void> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return;

    try {
      await worker.handler(job.payload);

      await this.prisma.job.update({
        where: { id: jobId },
        data: { status: 'completed', completed_at: new Date() },
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const attempts = job.attempts + 1;
      const failed = attempts >= job.max_attempts;
      const backoffSecs = BACKOFF_SECONDS[attempts - 1] ?? 1800;

      await this.prisma.job.update({
        where: { id: jobId },
        data: {
          attempts,
          last_error: errMsg,
          status: failed ? 'failed' : 'pending',
          locked_until: null,
          locked_by: null,
          run_at: failed
            ? job.run_at
            : new Date(Date.now() + backoffSecs * 1000),
        },
      });

      this.logger.warn(`Job ${jobId} failed (attempt ${attempts}): ${errMsg}`);
    }
  }
}
