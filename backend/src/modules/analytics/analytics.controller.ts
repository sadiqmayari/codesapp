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

@Controller('analytics')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  overview(@CurrentUser() user: { companyId: number }) {
    return this.analytics.overview(user.companyId);
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

  @Get('broadcasts/:id')
  broadcast(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.analytics.broadcast(user.companyId, id);
  }
}
