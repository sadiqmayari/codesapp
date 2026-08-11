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
// After a job is enqueued we poll almost immediately (instead of waiting up to
// POLL_INTERVAL_MS) so inbound messages / media sends are picked up in ~ms, not
// seconds. Small floor so a burst of enqueues coalesces instead of busy-looping.
const WAKE_DELAY_MS = 25;
const BACKOFF_SECONDS = [60, 300, 1800];
const INSTANCE_ID = uuidv4();
// How often the orphan reaper actually hits the DB (see reapOrphans()).
const REAP_INTERVAL_MS = 30_000;
// Scan a few extra candidates past `available` so same-serial rows can be skipped
// to reach runnable ones. Bounded small to keep the (EXPLAIN-validated, indexed)
// claim query cheap on the single shared connection.
const SERIAL_SCAN_MULTIPLIER = 3;
const SERIAL_SCAN_CAP = 20;

@Injectable()
export class JobQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobQueueService.name);
  private readonly workers = new Map<string, WorkerRegistration>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  // Throttle the orphan reaper: it's a recovery sweep, not hot-path work, so it
  // runs at most once per REAP_INTERVAL_MS rather than on every (sub-second) poll
  // — keeps it off the single shared DB connection during wake-on-enqueue bursts.
  private lastReapAt = 0;
  // Wake-on-enqueue coordination (keeps the strict non-overlapping guarantee).
  private polling = false;
  private wakeRequested = false;

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

  private scheduleNextPoll(delayMs: number = POLL_INTERVAL_MS): void {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      this.polling = true;
      try {
        await this.poll();
      } catch (err) {
        this.logger.warn(
          `Job poll cycle failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } finally {
        this.polling = false;
        // If work arrived mid-poll, poll again right away (drain fast); else
        // fall back to the idle 2s cadence.
        const again = this.wakeRequested;
        this.wakeRequested = false;
        this.scheduleNextPoll(again ? WAKE_DELAY_MS : POLL_INTERVAL_MS);
      }
    }, delayMs);
  }

  /**
   * Poll almost immediately (WAKE_DELAY_MS) after a job is enqueued, instead of
   * waiting up to POLL_INTERVAL_MS. Never overlaps polls: if one is running we
   * just flag it to re-poll on completion. This is what makes inbound messages
   * and media sends feel instant on the MySQL queue (no Redis needed).
   */
  wake(): void {
    if (this.stopped) return;
    if (this.polling) {
      this.wakeRequested = true;
      return;
    }
    this.scheduleNextPoll(WAKE_DELAY_MS);
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
      // Immediate jobs → poll ASAP (near-zero pickup latency). Delayed jobs run
      // on their own schedule, so the idle cadence will catch them.
      if (!opts.delayMs) this.wake();
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

  /**
   * Recover ORPHANED jobs — rows stuck in `processing` with an expired lease that
   * belong to a PREVIOUS process incarnation (different `locked_by`). This is the
   * normal aftermath of a deploy/restart/OOM-kill: a job that was mid-flight when
   * the old process died would otherwise sit in `processing` forever, permanently
   * holding its serial lane (same-key jobs are skipped while a `processing`
   * sibling exists) and never completing. Resetting it to `pending` lets it be
   * re-claimed and retried.
   *
   * SAFETY: we only touch jobs whose `locked_by` is NOT this live instance, so a
   * job the CURRENT process is still running (it keeps its in-memory slot and may
   * legitimately outlive its lease) is never reset out from under itself — that
   * would double-execute it. A hang on THIS instance is instead bounded by the
   * callers' own HTTP timeouts, which turn a hang into a normal rejection+backoff.
   */
  private async reapOrphans(): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - this.lastReapAt < REAP_INTERVAL_MS) return;
    this.lastReapAt = nowMs;
    const now = new Date();
    try {
      const reaped = await this.prisma.job.updateMany({
        where: {
          status: 'processing',
          locked_until: { lt: now },
          NOT: { locked_by: INSTANCE_ID },
        },
        data: { status: 'pending', locked_by: null, locked_until: null },
      });
      if (reaped.count > 0) {
        this.logger.warn(
          `Reaped ${reaped.count} orphaned processing job(s) from a prior process incarnation → re-queued`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Orphan reap failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async poll(): Promise<void> {
    // No per-cycle log here: with wake-on-enqueue the poller runs often, and a
    // line per cycle was ~100% of prod log volume (drowning real signal + churning
    // the size-capped container logs). Nothing actionable in "polling" anyway.
    // First, recover any lane stranded by a prior process incarnation (deploy/crash).
    await this.reapOrphans();
    for (const [queueName, worker] of this.workers.entries()) {
      const available = worker.concurrency - worker.activeSlots;
      if (available <= 0) continue;

      const now = new Date();
      const leaseExpiry = new Date(Date.now() + worker.leaseSeconds * 1000);

      // Per-conversation serial-key single-flight (EXPLAIN-validated on the live
      // jobs table: outer = range on jobs_queue_name_status_run_at_idx, the
      // NOT EXISTS subquery = range on jobs_serial_key_status_idx — no full scan,
      // no filesort). This is the SAFE form: ONE query/queue, ORDER BY run_at
      // (the original index — NOT `priority`, which needed a different index and
      // caused the prior spike). A job whose serial_key already has an ACTIVE
      // processing sibling is skipped. NULL serial_key short-circuits the subquery
      // (IS NULL evaluated first) → NULL-keyed queues are exactly the legacy plan.
      const scanLimit = Math.min(
        available * SERIAL_SCAN_MULTIPLIER,
        SERIAL_SCAN_CAP,
      );
      let candidates: { id: number; serial_key: string | null }[];
      try {
        candidates = await this.prisma.$queryRaw<
          { id: number; serial_key: string | null }[]
        >`
          SELECT j.id, j.serial_key FROM jobs j
          WHERE j.queue_name = ${queueName}
            AND j.status = 'pending'
            AND j.run_at <= ${now}
            AND (j.locked_until IS NULL OR j.locked_until < ${now})
            AND (j.serial_key IS NULL OR NOT EXISTS (
              SELECT 1 FROM jobs p
              WHERE p.serial_key = j.serial_key
                AND p.status = 'processing'
                AND p.locked_until > ${now}))
          ORDER BY j.run_at
          LIMIT ${scanLimit}
          FOR UPDATE SKIP LOCKED
        `;
      } catch {
        continue;
      }

      if (!candidates.length) continue;

      // Within-batch dedup: at most one job per serial_key per batch (the SQL only
      // guards against ALREADY-processing siblings, not two pending same-key rows
      // claimed together). Single non-overlapping poller → race-free.
      const chosen: number[] = [];
      const batchSerials = new Set<string>();
      for (const c of candidates) {
        if (chosen.length >= available) break;
        if (c.serial_key !== null) {
          if (batchSerials.has(c.serial_key)) continue;
          batchSerials.add(c.serial_key);
        }
        chosen.push(c.id);
      }

      if (!chosen.length) continue;

      await this.prisma.job.updateMany({
        where: { id: { in: chosen } },
        data: {
          status: 'processing',
          locked_until: leaseExpiry,
          locked_by: INSTANCE_ID,
        },
      });

      for (const id of chosen) {
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
        // Clear dedup_key on the terminal state: the UNIQUE on dedup_key is
        // meant to bar TWO LIVE jobs sharing a key, not to bar a fresh enqueue
        // after the previous one finished. Leaving it set made re-clickable
        // background jobs (reconcile/import) P2002 → silent no-op forever.
        data: { status: 'completed', completed_at: new Date(), dedup_key: null },
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
          // Terminal failure clears dedup_key too, so a later retry-enqueue of
          // the same logical job isn't blocked by a dead row (see completed).
          dedup_key: failed ? null : undefined,
          run_at: failed
            ? job.run_at
            : new Date(Date.now() + backoffSecs * 1000),
        },
      });

      this.logger.warn(`Job ${jobId} failed (attempt ${attempts}): ${errMsg}`);
    }
  }
}
