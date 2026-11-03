import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { MetaAdsService } from './meta-ads.service';
import { ConnectMetaAdsDto } from './dtos/connect-meta-ads.dto';
import { SetTargetsDto } from './dtos/set-targets.dto';
import { SetMetaAdsSyncScheduleDto } from './dtos/sync-schedule.dto';

/**
 * Meta Ads connection + per-product monthly targets. Owner/admin only — this
 * configures billing-relevant credentials and goals. Lives under /api.
 */
@Controller('meta-ads')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard)
@Roles('owner', 'admin')
export class MetaAdsController {
  constructor(private readonly metaAds: MetaAdsService) {}

  @Get('connection')
  getConnection(@CurrentUser() user: { companyId: number }) {
    return this.metaAds.getConnection(user.companyId);
  }

  @Post('connection')
  connect(
    @CurrentUser() user: { companyId: number },
    @Body() dto: ConnectMetaAdsDto,
  ) {
    return this.metaAds.connect(user.companyId, dto);
  }

  @Delete('connection')
  disconnect(@CurrentUser() user: { companyId: number }) {
    return this.metaAds.disconnect(user.companyId);
  }

  @Delete('connection/token')
  clearToken(@CurrentUser() user: { companyId: number }) {
    return this.metaAds.clearOverrideToken(user.companyId);
  }

  // Manual refresh — pull fresh spend from Meta now.
  @Post('sync')
  sync(@CurrentUser() user: { companyId: number }) {
    return this.metaAds.triggerSync(user.companyId);
  }

  @Get('sync-schedule')
  getSyncSchedule(@CurrentUser() user: { companyId: number }) {
    return this.metaAds.getSchedule(user.companyId);
  }

  @Put('sync-schedule')
  setSyncSchedule(
    @CurrentUser() user: { companyId: number },
    @Body() dto: SetMetaAdsSyncScheduleDto,
  ) {
    return this.metaAds.setSchedule(user.companyId, dto.intervalMinutes);
  }

  // Retroactively resolve customer-journey UTMs for recent web orders.
  @Post('attribution/backfill')
  backfillAttribution(@CurrentUser() user: { companyId: number }) {
    return this.metaAds.backfillAttribution(user.companyId);
  }

  @Get('targets')
  getTargets(
    @CurrentUser() user: { companyId: number },
    @Query('month') month: string,
  ) {
    const m = /^\d{4}-\d{2}$/.test(month ?? '')
      ? month
      : new Date().toISOString().slice(0, 7);
    return this.metaAds.getTargets(user.companyId, m);
  }

  @Put('targets')
  setTargets(
    @CurrentUser() user: { companyId: number },
    @Body() dto: SetTargetsDto,
  ) {
    return this.metaAds.setTargets(user.companyId, dto);
  }
}
