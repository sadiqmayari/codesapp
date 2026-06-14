import { Controller, Get, UseGuards } from '@nestjs/common';
import { CronGuard } from '../../common/guards/cron.guard';
import { WorkItemService } from '../engagement/work-item.service';
import { EngagementMetricsService } from '../engagement/engagement-metrics.service';

/** SLA window before an unowned AI→human handoff is re-escalated. */
const HANDOFF_SLA_MS = 30 * 60 * 1000;

/**
 * Engagement-engine maintenance + observability cron (excluded from the /api
 * prefix, CronGuard via X-Cron-Secret). Schedule:
 *   GET /cron/engagement/sla-sweep   — every 5–10 min (re-escalate stale handoffs)
 *   GET /cron/engagement/metrics     — scrape on demand (queue/outbox/DLQ/work-item health)
 */
@Controller('cron/engagement')
@UseGuards(CronGuard)
export class EngagementCronController {
  constructor(
    private readonly workItems: WorkItemService,
    private readonly metrics: EngagementMetricsService,
  ) {}

  @Get('sla-sweep')
  slaSweep() {
    return this.workItems.sweepOverdueHandoffs(HANDOFF_SLA_MS);
  }

  @Get('metrics')
  getMetrics() {
    return this.metrics.snapshot();
  }
}
