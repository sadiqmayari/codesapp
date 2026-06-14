import { Controller, Get, UseGuards } from '@nestjs/common';
import { CronGuard } from '../../common/guards/cron.guard';
import { WorkItemService } from '../engagement/work-item.service';

/** SLA window before an unowned AI→human handoff is re-escalated. */
const HANDOFF_SLA_MS = 30 * 60 * 1000;

/**
 * Engagement-engine maintenance cron (excluded from the /api prefix, CronGuard
 * via X-Cron-Secret). Run on a schedule (e.g. every 5–10 min):
 *   GET /cron/engagement/sla-sweep
 */
@Controller('cron/engagement')
@UseGuards(CronGuard)
export class EngagementCronController {
  constructor(private readonly workItems: WorkItemService) {}

  @Get('sla-sweep')
  slaSweep() {
    return this.workItems.sweepOverdueHandoffs(HANDOFF_SLA_MS);
  }
}
