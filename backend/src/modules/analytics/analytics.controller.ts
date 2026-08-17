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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AnalyticsService } from './analytics.service';
import { DateRangeDto } from './dtos/date-range.dto';
import { DashboardDto } from './dtos/dashboard.dto';

@Controller('analytics')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /**
   * Power-BI-style one-shot endpoint feeding the new dashboard page. Returns
   * KPIs (with previous-period comparison), trend series, funnel, status
   * breakdown, hourly heatmap, agent leaderboard, top contacts, cost, usage.
   * Range-aware via `from`/`to`. The older overview/funnel/agents endpoints
   * are kept for backward compat but the UI no longer uses them.
   */
  @Get('dashboard')
  dashboard(
    @CurrentUser() user: { companyId: number },
    @Query() dto: DashboardDto,
  ) {
    return this.analytics.dashboard(user.companyId, dto);
  }

  @Get('overview')
  overview(
    @CurrentUser() user: { companyId: number },
    @Query() dto: DateRangeDto,
  ) {
    return this.analytics.overview(user.companyId, dto);
  }

  @Get('funnel')
  funnel(
    @CurrentUser() user: { companyId: number },
    @Query() dto: DateRangeDto,
  ) {
    return this.analytics.funnel(user.companyId, dto);
  }

  @Get('agents')
  agents(
    @CurrentUser() user: { companyId: number },
    @Query() dto: DateRangeDto,
  ) {
    return this.analytics.agents(user.companyId, dto);
  }

  // Orders created by each agent + total order value, for the dashboard card.
  @Get('agent-orders')
  agentOrders(
    @CurrentUser() user: { companyId: number },
    @Query() dto: DateRangeDto,
  ) {
    return this.analytics.agentOrdersRange(user.companyId, dto);
  }

  // Orders analytics board: sales / delivery / courier / agent KPIs with
  // previous-period comparison, driven by shopify_orders + shipments.
  @Get('orders')
  orders(
    @CurrentUser() user: { companyId: number },
    @Query() dto: DashboardDto,
  ) {
    return this.analytics.ordersAnalytics(user.companyId, dto);
  }

  @Get('conversation-cost')
  conversationCost(
    @CurrentUser() user: { companyId: number },
    @Query() dto: DateRangeDto,
  ) {
    return this.analytics.conversationCost(user.companyId, dto);
  }

  @Get('usage')
  usage(@CurrentUser() user: { companyId: number }) {
    return this.analytics.usage(user.companyId);
  }

  // Click-to-WhatsApp ad attribution: chats/contacts/orders per ad or post.
  @Get('ad-attribution')
  adAttribution(@CurrentUser() user: { companyId: number }) {
    return this.analytics.adAttribution(user.companyId);
  }

  @Get('broadcasts/:id')
  broadcast(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.analytics.broadcast(user.companyId, id);
  }
}
