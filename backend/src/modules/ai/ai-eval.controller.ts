import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CronGuard } from '../../common/guards/cron.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AiEvalService } from './ai-eval.service';

/**
 * Tenant-triggered retrieval eval (owner/admin). Runs the auto-generated
 * retrieval quality check against THIS tenant's own catalogue and returns the
 * hit-rate + any missed products — so an admin can see, on demand, whether the
 * AI's knowledge retrieval is finding the right products.
 */
@Controller('ai/eval')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard)
@Roles('owner', 'admin')
export class AiEvalController {
  constructor(private readonly evalService: AiEvalService) {}

  @Post('run')
  run(
    @CurrentUser() user: { companyId: number },
    @Body() body: { limit?: number },
  ) {
    return this.evalService.runRetrievalEval(user.companyId, body?.limit ?? 20);
  }
}

/**
 * Scheduled retrieval eval across all tenants (excluded from the /api prefix,
 * CronGuard via X-Cron-Secret). Add to the crontab to catch retrieval
 * regressions early; results are logged per company.
 */
@Controller('cron/ai')
@UseGuards(CronGuard)
export class AiEvalCronController {
  constructor(private readonly evalService: AiEvalService) {}

  @Get('eval')
  runAll(@Query('limit') limit?: string) {
    const n = limit ? parseInt(limit, 10) : 20;
    return this.evalService.runAllTenants(Number.isFinite(n) ? n : 20);
  }
}
