import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { GrowthService } from './growth.service';
import { AskGrowthDto, ConnectAdAccountDto, GrowthRangeDto, GrowthStoreDto, UpdateAdAccountDto } from './dtos/growth.dto';

type U = { companyId: number; userId: number };

/**
 * Growth module (renamed from the Ad Report): multi-platform ad spend,
 * attribution, profit, forecasts and AI. Owner/admin only — exposes spend,
 * margins and ad credentials. Lives under /api/growth.
 */
@Controller('growth')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard)
@Roles('owner', 'admin')
export class GrowthController {
  constructor(private readonly growth: GrowthService) {}

  @Get('catalog')
  catalog() {
    return this.growth.catalog();
  }

  @Get('status')
  status(@CurrentUser() u: U) {
    return this.growth.status(u.companyId);
  }

  @Get('overview')
  overview(@CurrentUser() u: U, @Query() q: GrowthRangeDto) {
    return this.growth.query.overview(u.companyId, q);
  }

  @Get('campaigns')
  campaigns(@CurrentUser() u: U, @Query() q: GrowthRangeDto) {
    return this.growth.query.campaigns(u.companyId, q);
  }

  @Get('creatives')
  creatives(@CurrentUser() u: U, @Query() q: GrowthRangeDto) {
    return this.growth.query.creatives(u.companyId, q);
  }

  @Get('attribution')
  attribution(@CurrentUser() u: U, @Query() q: GrowthRangeDto) {
    return this.growth.query.attribution(u.companyId, q);
  }

  @Get('customers')
  customers(@CurrentUser() u: U, @Query() q: GrowthRangeDto) {
    return this.growth.query.customers(u.companyId, q);
  }

  @Get('forecast')
  forecast(@CurrentUser() u: U, @Query() q: GrowthStoreDto) {
    return this.growth.forecast.forecast(u.companyId, q.storeId);
  }

  @Get('opportunities')
  opportunities(@CurrentUser() u: U, @Query() q: GrowthRangeDto) {
    return this.growth.opportunities.list(u.companyId, q);
  }

  @Get('brief')
  brief(@CurrentUser() u: U, @Query() q: GrowthRangeDto) {
    return this.growth.ai.brief(u.companyId, q);
  }

  @Post('ask')
  ask(@CurrentUser() u: U, @Body() dto: AskGrowthDto) {
    return this.growth.ai.ask(u.companyId, u.userId, dto.question, dto, dto.history ?? []);
  }

  // ── Connections ────────────────────────────────────────────────────────────
  @Get('accounts')
  accounts(@CurrentUser() u: U) {
    return this.growth.accounts.list(u.companyId);
  }

  @Post('accounts')
  connect(@CurrentUser() u: U, @Body() dto: ConnectAdAccountDto) {
    return this.growth.connect(u.companyId, dto);
  }

  @Patch('accounts/:id')
  updateAccount(@CurrentUser() u: U, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateAdAccountDto) {
    return this.growth.accounts.update(u.companyId, id, dto);
  }

  @Delete('accounts/:id')
  disconnect(@CurrentUser() u: U, @Param('id', ParseIntPipe) id: number) {
    return this.growth.disconnect(u.companyId, id);
  }

  @Post('accounts/:id/sync')
  async syncAccount(@CurrentUser() u: U, @Param('id', ParseIntPipe) id: number) {
    await this.growth.accounts.get(u.companyId, id);
    return this.growth.sync.request(id);
  }

  @Post('sync')
  syncAll(@CurrentUser() u: U) {
    return this.growth.sync.requestForCompany(u.companyId);
  }

  @Post('rebuild')
  rebuild(@CurrentUser() u: U) {
    return this.growth.rebuild(u.companyId);
  }

  @Post('backfill/attribution')
  backfillAttribution(@CurrentUser() u: U) {
    return this.growth.backfillAttribution(u.companyId);
  }

  @Post('backfill/financials')
  backfillFinancials(@CurrentUser() u: U) {
    return this.growth.backfillFinancials(u.companyId);
  }

  @Post('cogs/sync')
  syncCogs(@CurrentUser() u: U) {
    return this.growth.syncCogs(u.companyId);
  }
}
