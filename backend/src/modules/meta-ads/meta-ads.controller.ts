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
