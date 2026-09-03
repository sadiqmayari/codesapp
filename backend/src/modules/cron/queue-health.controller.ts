import { Controller, Get, UseGuards } from '@nestjs/common';
import { CronGuard } from '../../common/guards/cron.guard';
import { QueueHealthService } from './queue-health.service';

/**
 * Platform health cron (excluded from the /api prefix, CronGuard via
 * X-Cron-Secret):
 *   GET /cron/health/metrics — job-queue depth / oldest pending / dead letter.
 */
@Controller('cron/health')
@UseGuards(CronGuard)
export class QueueHealthController {
  constructor(private readonly queueHealth: QueueHealthService) {}

  @Get('metrics')
  getMetrics() {
    return this.queueHealth.snapshot();
  }
}
