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
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { SuperAdminService } from './super-admin.service';
import { SuperAdminIpGuard } from '../../common/guards/super-admin-ip.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { LoginDto } from '../auth/dto/login.dto';

@Controller('super-admin')
export class SuperAdminController {
  constructor(private readonly superAdminService: SuperAdminService) {}

  // Super admin login — IP guard only
  @Post('auth/login')
  @UseGuards(SuperAdminIpGuard)
  login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.superAdminService.login(dto.email, dto.password, res);
  }

  // Rehydrate session from sa_refresh_token cookie — IP guard only.
  @Post('auth/refresh')
  @UseGuards(SuperAdminIpGuard)
  refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.superAdminService.refresh(
      (req as any).cookies?.['sa_refresh_token'],
      res,
    );
  }

  // Clear the sa_refresh_token cookie — IP guard only. Tenant /auth/logout
  // only clears the tenant refresh_token, leaving the super-admin session
  // alive (and the login page would silently rehydrate it).
  @Post('auth/logout')
  @UseGuards(SuperAdminIpGuard)
  logout(@Res({ passthrough: true }) res: Response) {
    return this.superAdminService.logout(res);
  }

  // All other routes: JWT + IP + Role
  @Get('dashboard')
  @UseGuards(AuthGuard('jwt'), SuperAdminIpGuard, RolesGuard)
  @Roles('super_admin')
  getDashboard() {
    return this.superAdminService.getDashboard();
  }

  @Get('clients')
  @UseGuards(AuthGuard('jwt'), SuperAdminIpGuard, RolesGuard)
  @Roles('super_admin')
  getClients(
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
  ) {
    return this.superAdminService.getClients(page, limit);
  }

  @Get('clients/:id')
  @UseGuards(AuthGuard('jwt'), SuperAdminIpGuard, RolesGuard)
  @Roles('super_admin')
  getClient(@Param('id', ParseIntPipe) id: number) {
    return this.superAdminService.getClient(id);
  }

  // Expanded payload for the client profile page (Phase 2 redesign).
  // Sibling of getClient — kept separate so existing callers stay intact.
  @Get('clients/:id/detail')
  @UseGuards(AuthGuard('jwt'), SuperAdminIpGuard, RolesGuard)
  @Roles('super_admin')
  getClientDetail(@Param('id', ParseIntPipe) id: number) {
    return this.superAdminService.getClientDetail(id);
  }

  @Patch('clients/:id/activate')
  @UseGuards(AuthGuard('jwt'), SuperAdminIpGuard, RolesGuard)
  @Roles('super_admin')
  activateClient(@Param('id', ParseIntPipe) id: number) {
    return this.superAdminService.activateClient(id);
  }

  @Patch('clients/:id/suspend')
  @UseGuards(AuthGuard('jwt'), SuperAdminIpGuard, RolesGuard)
  @Roles('super_admin')
  suspendClient(@Param('id', ParseIntPipe) id: number) {
    return this.superAdminService.suspendClient(id);
  }

  // Grant a delinquent client extra time. body: { until: ISO string | null }
  @Patch('clients/:id/grace')
  @UseGuards(AuthGuard('jwt'), SuperAdminIpGuard, RolesGuard)
  @Roles('super_admin')
  grantGrace(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { until?: string | null },
  ) {
    const until =
      body?.until === null || body?.until === undefined || body.until === ''
        ? null
        : new Date(body.until);
    return this.superAdminService.grantGrace(id, until);
  }

  // Per-company usage-limit override. body: { action: 'block'|'warn_only'|null }
  @Patch('clients/:id/usage-limit-action')
  @UseGuards(AuthGuard('jwt'), SuperAdminIpGuard, RolesGuard)
  @Roles('super_admin')
  setUsageLimitAction(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { action?: 'block' | 'warn_only' | null },
  ) {
    const action =
      body?.action === 'block' || body?.action === 'warn_only'
        ? body.action
        : null;
    return this.superAdminService.setUsageLimitAction(id, action);
  }

  @Get('settings')
  @UseGuards(AuthGuard('jwt'), SuperAdminIpGuard, RolesGuard)
  @Roles('super_admin')
  getSettings() {
    return this.superAdminService.getSettings();
  }

  @Patch('settings')
  @UseGuards(AuthGuard('jwt'), SuperAdminIpGuard, RolesGuard)
  @Roles('super_admin')
  updateSettings(@Body() body: { usageLimitAction?: string }) {
    const action =
      body?.usageLimitAction === 'warn_only' ? 'warn_only' : 'block';
    return this.superAdminService.updateSettings(action);
  }

  @Delete('clients/:id')
  @UseGuards(AuthGuard('jwt'), SuperAdminIpGuard, RolesGuard)
  @Roles('super_admin')
  deleteClient(@Param('id', ParseIntPipe) id: number) {
    return this.superAdminService.deleteClient(id);
  }

  @Get('plans')
  @UseGuards(AuthGuard('jwt'), SuperAdminIpGuard, RolesGuard)
  @Roles('super_admin')
  getPlans() {
    return this.superAdminService.getPlans();
  }

  @Post('plans')
  @UseGuards(AuthGuard('jwt'), SuperAdminIpGuard, RolesGuard)
  @Roles('super_admin')
  createPlan(@Body() body: any) {
    return this.superAdminService.createPlan(body);
  }

  @Patch('plans/:id')
  @UseGuards(AuthGuard('jwt'), SuperAdminIpGuard, RolesGuard)
  @Roles('super_admin')
  updatePlan(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.superAdminService.updatePlan(id, body);
  }

  @Get('invoices')
  @UseGuards(AuthGuard('jwt'), SuperAdminIpGuard, RolesGuard)
  @Roles('super_admin')
  getInvoices(
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
  ) {
    return this.superAdminService.getInvoices(page, limit);
  }

  @Get('usage')
  @UseGuards(AuthGuard('jwt'), SuperAdminIpGuard, RolesGuard)
  @Roles('super_admin')
  getUsage() {
    return this.superAdminService.getUsage();
  }

  @Get('audit-logs')
  @UseGuards(AuthGuard('jwt'), SuperAdminIpGuard, RolesGuard)
  @Roles('super_admin')
  getAuditLogs(
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 50,
  ) {
    return this.superAdminService.getAuditLogs(page, limit);
  }

  @Post('impersonate/:companyId')
  @UseGuards(AuthGuard('jwt'), SuperAdminIpGuard, RolesGuard)
  @Roles('super_admin')
  impersonate(
    @Param('companyId', ParseIntPipe) companyId: number,
    @CurrentUser() user: { userId: number },
  ) {
    return this.superAdminService.impersonate(companyId, user.userId);
  }
}
