import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Observability snapshot for the engagement engine + queue/outbox health
 * (Findings: monitoring/observability + DLQ surfacing). Read-only aggregates over
 * the jobs / outbox / work_items / events tables. Exposed via the CronGuard'd
 * GET /cron/engagement/metrics so it can be scraped without a user session.
 */
@Injectable()
export class EngagementMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async snapshot() {
    const [
      jobsByQueueStatus,
      oldestPending,
      deadLetter,
      outboxByState,
      workItemsByTypeStatus,
      overdueHandoffs,
      eventsLast24h,
    ] = await Promise.all([
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
      this.prisma.outbox.groupBy({
        by: ['state'],
        _count: { _all: true },
      }),
      this.prisma.workItem.groupBy({
        by: ['type', 'status'],
        _count: { _all: true },
      }),
      this.prisma.workItem.count({
        where: {
          owner: 'HUMAN',
          status: 'OPEN',
          assigned_user_id: null,
          expires_at: { not: null, lt: new Date() },
        },
      }),
      this.prisma.event.count({
        where: { created_at: { gt: new Date(Date.now() - 86_400_000) } },
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
      outbox: Object.fromEntries(
        outboxByState.map((r) => [r.state, r._count._all]),
      ),
      workItems: workItemsByTypeStatus.map((r) => ({
        type: r.type,
        status: r.status,
        count: r._count._all,
      })),
      overdueHandoffs,
      eventsLast24h,
    };
  }
}
