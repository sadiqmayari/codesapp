import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { GrowthService } from './growth.service';
import { AdManageService, ChangeInput } from './services/ad-manage.service';
import { AdCreateService, UploadedMedia } from './services/ad-create.service';
import { CreateDraft } from './platforms/ad-writer.types';
import {
  CitySearchDto,
  CreateAccountDto,
  CreateCampaignDto,
  ManageChangesDto,
  ManageEntityDto,
  ManageLogDto,
  ManageUndoDto,
  SaveDraftDto,
} from './dtos/ad-manage.dto';
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
  constructor(
    private readonly growth: GrowthService,
    private readonly manage: AdManageService,
    private readonly creator: AdCreateService,
  ) {}

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

  @Post('sync/today')
  syncToday(@CurrentUser() u: U) {
    return this.growth.sync.requestToday(u.companyId);
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
  // ── Ad management (the ONLY write path to ad platforms) ────────────────────
  @Get('manage/access')
  manageAccess(@CurrentUser() u: U) {
    return this.manage.access(u.companyId);
  }

  @Get('manage/settings')
  manageSettings(@CurrentUser() u: U, @Query() q: ManageEntityDto) {
    return this.manage.settings(u.companyId, q.level, q.entityId);
  }

  @Post('manage/preview')
  managePreview(@CurrentUser() u: U, @Body() dto: ManageChangesDto) {
    return this.manage.preview(u.companyId, dto.changes as unknown as ChangeInput[]);
  }

  @Post('manage/publish')
  managePublish(@CurrentUser() u: U, @Body() dto: ManageChangesDto) {
    return this.manage.publish({ companyId: u.companyId, userId: u.userId }, dto.changes as unknown as ChangeInput[]);
  }

  @Post('manage/duplicate')
  manageDuplicate(@CurrentUser() u: U, @Body() dto: ManageEntityDto) {
    return this.manage.duplicate({ companyId: u.companyId, userId: u.userId }, dto.level, dto.entityId);
  }

  @Get('manage/log')
  manageLog(@CurrentUser() u: U, @Query() q: ManageLogDto) {
    return this.manage.log(u.companyId, q);
  }

  @Post('manage/undo')
  manageUndo(@CurrentUser() u: U, @Body() dto: ManageUndoDto) {
    return this.manage.undo({ companyId: u.companyId, userId: u.userId }, dto);
  }

  // ── Create (everything is created PAUSED) ──────────────────────────────────
  @Get('create/assets')
  createAssets(@CurrentUser() u: U, @Query() q: CreateAccountDto) {
    return this.creator.assets(u.companyId, q.accountId);
  }

  @Get('create/cities')
  createCities(@CurrentUser() u: U, @Query() q: CitySearchDto) {
    return this.creator.searchCities(u.companyId, q.accountId, q.q, q.country ?? 'PK');
  }

  @Post('create/media')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 200 * 1024 * 1024 } }))
  createMedia(@CurrentUser() u: U, @Query() q: CreateAccountDto, @UploadedFile() file?: UploadedMedia) {
    return this.creator.uploadMedia(u.companyId, q.accountId, file);
  }

  @Get('create/draft')
  getDraft(@CurrentUser() u: U) {
    return this.creator.getDraft({ companyId: u.companyId, userId: u.userId });
  }

  @Put('create/draft')
  saveDraft(@CurrentUser() u: U, @Body() dto: SaveDraftDto) {
    return this.creator.saveDraft({ companyId: u.companyId, userId: u.userId }, dto.payload ?? null);
  }

  @Post('create')
  createCampaign(@CurrentUser() u: U, @Body() dto: CreateCampaignDto) {
    return this.creator.create({ companyId: u.companyId, userId: u.userId }, dto.accountId, dto.draft as unknown as CreateDraft);
  }
}
