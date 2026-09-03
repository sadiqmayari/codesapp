import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Job-queue health snapshot: per-queue depth by status, the oldest pending job,
 * and the dead-letter (failed) tail. Read-only aggregates over the `jobs` table.
 *
 * Exposed via the CronGuard'd `GET /cron/health/metrics` so it can be scraped
 * without a user session. The `jobs` table is global (no company_id) — this is
 * PLATFORM health, not a tenant metric; per-tenant AI/business metrics live in
 * ObservabilityService.
 */
@Injectable()
export class QueueHealthService {
  constructor(private readonly prisma: PrismaService) {}

  async snapshot() {
    const [jobsByQueueStatus, oldestPending, deadLetter] = await Promise.all([
      this.prisma.job.groupBy({
        by: ['queue_name', 'status'],
        _count: { _all: true },
      }),
      this.prisma.job.findFirst({
        where: { status: 'pending' },
        orderBy: { run_at: 'asc' },
        select: { run_at: true, queue_name: true },
      }),
      this.prisma.job.findMany({
        where: { status: 'failed' },
        orderBy: { run_at: 'desc' },
        take: 20,
        select: {
          id: true,
          queue_name: true,
          attempts: true,
          last_error: true,
          run_at: true,
        },
      }),
    ]);

    const queues: Record<string, Record<string, number>> = {};
    for (const r of jobsByQueueStatus) {
      (queues[r.queue_name] ??= {})[r.status] = r._count._all;
    }

    return {
      timestamp: new Date().toISOString(),
      queues,
      oldestPendingJob: oldestPending
        ? {
            queue: oldestPending.queue_name,
            ageSec: Math.round(
              (Date.now() - new Date(oldestPending.run_at).getTime()) / 1000,
            ),
          }
        : null,
      deadLetter: { count: deadLetter.length, recent: deadLetter },
    };
  }
}
