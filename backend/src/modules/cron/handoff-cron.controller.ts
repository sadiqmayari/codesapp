import { Controller, Get, UseGuards } from '@nestjs/common';
import { CronGuard } from '../../common/guards/cron.guard';
import { HandoffSlaService } from '../../common/services/handoff-sla.service';

/**
 * Handoff SLA sweep cron (#increment 8, spec #10). Excluded from the /api prefix,
 * guarded by CronGuard (X-Cron-Secret). Schedule every ~5 min:
 *   GET /cron/handoffs/sla-sweep — resolve picked-up handoffs, alert on breaches.
 */
@Controller('cron/handoffs')
@UseGuards(CronGuard)
export class HandoffCronController {
  constructor(private readonly handoffSla: HandoffSlaService) {}

  @Get('sla-sweep')
  slaSweep() {
    return this.handoffSla.sweepOverdue();
  }
}
