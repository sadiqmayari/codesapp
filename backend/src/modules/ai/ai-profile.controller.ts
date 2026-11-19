import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { AiProfileService } from './ai-profile.service';
import { AiMeteringService } from './ai-metering.service';
import { UpdateAgentProfileDto, UpdateStoreProfileDto } from './dto/agent-profile.dto';
import { PACKS, Industry } from './agent/packs';

/**
 * Settings → AI Agent (owner/admin). The profile holds persona, industry pack,
 * locale, skills, handoff rules and business hours; per-store overrides layer
 * brand / currency / payment details for multi-store tenants.
 */
@Controller('ai/agent')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard)
@Roles('owner', 'admin')
export class AiProfileController {
  constructor(
    private readonly profiles: AiProfileService,
    private readonly metering: AiMeteringService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('profile')
  get(@CurrentUser() user: { companyId: number }) {
    return this.profiles.getEditable(user.companyId);
  }

  @Patch('profile')
  update(@CurrentUser() user: { companyId: number }, @Body() dto: UpdateAgentProfileDto) {
    return this.profiles.save(user.companyId, dto);
  }

  /** Defaults of an industry pack (the Settings pack picker previews these). */
  @Get('packs/:key')
  pack(@Param('key') key: string) {
    const p = PACKS[key as Industry];
    if (!p) throw new BadRequestException('Unknown pack');
    return p;
  }

  /** Overall AI status for the Settings header (why it's paused, if it is). */
  @Get('status')
  async status(@CurrentUser() user: { companyId: number }) {
    const [reason, usage, co] = await Promise.all([
      this.metering.blockReason(user.companyId),
      this.metering.getMonthlyUsage(user.companyId),
      this.prisma.company.findUnique({
        where: { id: user.companyId },
        select: { ai_autoreply_enabled: true, ai_auto_order_enabled: true },
      }),
    ]);
    const engine = (await this.profiles.load(user.companyId)).profile.engine;
    return {
      blocked: reason,
      engine,
      autoReplyAll: co?.ai_autoreply_enabled ?? false,
      autoOrder: co?.ai_auto_order_enabled ?? false,
      usage,
    };
  }

  @Get('stores')
  stores(@CurrentUser() user: { companyId: number }) {
    return this.profiles.listStoreProfiles(user.companyId);
  }

  @Patch('stores/:storeId')
  async saveStore(
    @CurrentUser() user: { companyId: number },
    @Param('storeId', ParseIntPipe) storeId: number,
    @Body() dto: UpdateStoreProfileDto,
  ) {
    try {
      await this.profiles.saveStoreProfile(user.companyId, storeId, dto);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : 'Could not save');
    }
    return { ok: true };
  }
}
