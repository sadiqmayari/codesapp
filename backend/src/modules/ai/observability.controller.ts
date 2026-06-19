import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ObservabilityService } from '../../common/services/observability.service';

type AuthUser = { companyId: number; userId: number };

/**
 * Read-only observability + audit endpoints (increment 6, spec #12/#7). Additive
 * — new routes under the existing `/api/ai` prefix, same guard stack as the rest
 * of the AI surface. Metrics are owner/admin-only; the conversation audit timeline
 * is available to any authenticated tenant user (agents review their own chats).
 */
@Controller('ai')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class ObservabilityController {
  constructor(private readonly observability: ObservabilityService) {}

  /** Dashboard metrics snapshot for the tenant over the last `days` (default 30). */
  @Get('metrics')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  metrics(@CurrentUser() user: AuthUser, @Query('days') days?: string) {
    const d = days ? parseInt(days, 10) : undefined;
    return this.observability.tenantMetrics(user.companyId, d);
  }

  /** Per-conversation event timeline ("why did the AI do this?"). */
  @Get('audit/:conversationId')
  audit(
    @CurrentUser() user: AuthUser,
    @Param('conversationId', ParseIntPipe) conversationId: number,
  ) {
    return this.observability.conversationAudit(user.companyId, conversationId);
  }
}
