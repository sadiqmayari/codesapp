import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { SuperAdminIpGuard } from '../../common/guards/super-admin-ip.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Industry } from '../ai/agent/packs';
import { SuperAdminAiService } from './super-admin-ai.service';

interface Actor {
  userId?: number;
  email?: string;
}

/**
 * Super-admin → AI Control Center (`/api/super-admin/ai/*`).
 * Guards: JWT → SuperAdminIp → Roles('super_admin') (CLAUDE.md rule 2).
 * Bodies are plain objects validated/whitelisted inside the service (same
 * pattern as PATCH /super-admin/settings).
 */
@Controller('super-admin/ai')
@UseGuards(AuthGuard('jwt'), SuperAdminIpGuard, RolesGuard)
@Roles('super_admin')
export class SuperAdminAiController {
  constructor(private readonly svc: SuperAdminAiService) {}

  @Get('platform')
  platform() {
    return this.svc.platform();
  }

  @Patch('platform')
  updatePlatform(@CurrentUser() u: Actor, @Body() body: Record<string, unknown>) {
    return this.svc.updatePlatform(u?.userId ?? null, body as Parameters<SuperAdminAiService['updatePlatform']>[1]);
  }

  @Get('tenants')
  tenants() {
    return this.svc.tenants();
  }

  @Patch('tenants/:id')
  updateTenant(
    @CurrentUser() u: Actor,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.svc.updateTenant(u?.userId ?? null, id, body as Parameters<SuperAdminAiService['updateTenant']>[2]);
  }

  @Get('tenants/:id/shadow')
  shadow(@Param('id', ParseIntPipe) id: number) {
    return this.svc.shadowSamples(id);
  }

  @Get('costs')
  costs(@Query('months') months?: string) {
    return this.svc.costs(Math.min(12, Math.max(1, Number(months) || 3)));
  }

  @Get('quality')
  quality() {
    return this.svc.quality();
  }

  @Get('prompts')
  prompts() {
    return this.svc.listPrompts();
  }

  @Post('prompts')
  draftPrompt(@CurrentUser() u: Actor, @Body() body: { key?: string; body?: string }) {
    return this.svc.draftPrompt(u?.userId ?? null, String(body?.key ?? ''), String(body?.body ?? ''), u?.email ?? 'super-admin');
  }

  @Post('prompts/:id/status')
  promptStatus(
    @CurrentUser() u: Actor,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status?: string },
  ) {
    const st = body?.status === 'live' ? 'live' : body?.status === 'retired' ? 'retired' : 'draft';
    return this.svc.setPromptStatus(u?.userId ?? null, id, st);
  }

  @Post('evals/run')
  runEval(@CurrentUser() u: Actor, @Body() body: { pack?: string; companyId?: number }) {
    return this.svc.runEval(u?.userId ?? null, (body?.pack ?? 'ecommerce') as Industry, Number(body?.companyId));
  }

  @Get('evals/:id')
  evalRun(@Param('id', ParseIntPipe) id: number) {
    return this.svc.evalRun(id);
  }
}
