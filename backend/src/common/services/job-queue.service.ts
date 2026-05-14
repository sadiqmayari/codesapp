import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';

type JobHandler = (payload: unknown) => Promise<void>;

interface WorkerRegistration {
  handler: JobHandler;
  concurrency: number;
  activeSlots: number;
}

const LEASE_SECONDS = 30;
const POLL_INTERVAL_MS = 2000;
const BACKOFF_SECONDS = [60, 300, 1800];
const INSTANCE_ID = uuidv4();

@Injectable()
export class JobQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobQueueService.name);
  private readonly workers = new Map<string, WorkerRegistration>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.logger.log('Job queue poller started (every 2s)');
  }

  onModuleDestroy() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async enqueue(
    queueName: string,
    payload: unknown,
    opts: { delayMs?: number; maxAttempts?: number } = {},
  ): Promise<number> {
    const runAt = opts.delayMs
      ? new Date(Date.now() + opts.delayMs)
      : new Date();

    const job = await this.prisma.job.create({
      data: {
        queue_name: queueName,
        payload: payload as object,
        status: 'pending',
        max_attempts: opts.maxAttempts ?? 3,
        run_at: runAt,
      },
    });

    return job.id;
  }

  registerWorker(
    queueName: string,
    handler: JobHandler,
    concurrency = 3,
  ): void {
    this.workers.set(queueName, { handler, concurrency, activeSlots: 0 });
    this.logger.log(`Worker registered for queue: ${queueName} (concurrency: ${concurrency})`);
  }

  private async poll(): Promise<void> {
    this.logger.verbose('polling jobs');

    for (const [queueName, worker] of this.workers.entries()) {
      const available = worker.concurrency - worker.activeSlots;
      if (available <= 0) continue;

      const now = new Date();
      const leaseExpiry = new Date(Date.now() + LEASE_SECONDS * 1000);

      // Fetch claimable jobs using raw query for FOR UPDATE SKIP LOCKED
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

      // Claim jobs
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
