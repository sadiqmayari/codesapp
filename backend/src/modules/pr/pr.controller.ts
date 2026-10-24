import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrService } from './pr.service';
import {
  CreateManualSubmissionDto,
  CreatePrCampaignDto,
  DecideSubmissionDto,
  SendPackageDto,
  SetOutcomeDto,
  UpdateInfluencerDto,
  UpdatePrCampaignDto,
} from './dto/pr.dto';

type CU = { companyId: number; userId: number; role: string };

@Controller('pr')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard)
@Roles('owner', 'admin', 'creative_executive', 'social_media_executive', 'pr_manager')
export class PrController {
  constructor(private readonly pr: PrService) {}

  // ── Campaigns ───────────────────────────────────────────────────────────────
  @Get('campaigns')
  async listCampaigns(@CurrentUser() user: CU) {
    await this.pr.assertEnabled(user.companyId);
    return this.pr.listCampaigns(user.companyId);
  }

  @Post('campaigns')
  async createCampaign(
    @CurrentUser() user: CU,
    @Body() dto: CreatePrCampaignDto,
  ) {
    await this.pr.assertEnabled(user.companyId);
    return this.pr.createCampaign(user.companyId, dto);
  }

  @Patch('campaigns/:id')
  async updateCampaign(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePrCampaignDto,
  ) {
    await this.pr.assertEnabled(user.companyId);
    return this.pr.updateCampaign(user.companyId, id, dto);
  }

  @Delete('campaigns/:id')
  async deleteCampaign(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.pr.assertEnabled(user.companyId);
    return this.pr.deleteCampaign(user.companyId, id);
  }

  // ── Submissions ───────────────────────────────────────────────────────────────
  @Get('submissions')
  async listSubmissions(
    @CurrentUser() user: CU,
    @Query('campaignId') campaignId?: string,
    @Query('status') status?: string,
  ) {
    await this.pr.assertEnabled(user.companyId);
    return this.pr.listSubmissions(user.companyId, {
      campaignId: campaignId ? Number(campaignId) : undefined,
      status,
    });
  }

  @Post('submissions')
  async createManualSubmission(
    @CurrentUser() user: CU,
    @Body() dto: CreateManualSubmissionDto,
  ) {
    await this.pr.assertEnabled(user.companyId);
    return this.pr.createManualSubmission(user.companyId, dto, user.userId);
  }

  @Get('submissions/:id')
  async getSubmission(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.pr.assertEnabled(user.companyId);
    return this.pr.getSubmission(user.companyId, id);
  }

  @Patch('submissions/:id/decide')
  async decide(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DecideSubmissionDto,
  ) {
    await this.pr.assertEnabled(user.companyId);
    return this.pr.decide(user.companyId, id, dto, user.userId);
  }

  @Post('submissions/:id/send-package')
  async sendPackage(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SendPackageDto,
  ) {
    await this.pr.assertEnabled(user.companyId);
    return this.pr.sendPackage(user.companyId, id, dto, user.userId);
  }

  @Patch('submissions/:id/outcome')
  async setOutcome(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetOutcomeDto,
  ) {
    await this.pr.assertEnabled(user.companyId);
    return this.pr.setOutcome(user.companyId, id, dto);
  }

  // ── Influencer CRM ──────────────────────────────────────────────────────────
  @Get('influencers')
  async listInfluencers(
    @CurrentUser() user: CU,
    @Query('status') status?: string,
    @Query('q') q?: string,
  ) {
    await this.pr.assertEnabled(user.companyId);
    return this.pr.listInfluencers(user.companyId, { status, q });
  }

  @Get('influencers/:id')
  async getInfluencer(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.pr.assertEnabled(user.companyId);
    return this.pr.getInfluencer(user.companyId, id);
  }

  @Patch('influencers/:id')
  async updateInfluencer(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateInfluencerDto,
  ) {
    await this.pr.assertEnabled(user.companyId);
    return this.pr.updateInfluencer(user.companyId, id, dto);
  }
}
