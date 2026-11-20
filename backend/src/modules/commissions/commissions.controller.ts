import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CommissionsService } from './commissions.service';
import { CommissionPlanDto, PreviewPlanDto } from './dto/commission-plan.dto';

type JwtUser = { userId: number; companyId: number; role: string };

@Controller('commissions')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class CommissionsController {
  constructor(private readonly commissions: CommissionsService) {}

  /** Every member: my earnings this month. */
  @Get('me')
  me(@CurrentUser() user: JwtUser, @Query('month') month?: string) {
    return this.commissions.mine(user.companyId, user, month);
  }

  @Get('plans')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  plans(@CurrentUser() user: JwtUser) {
    return this.commissions.listPlans(user.companyId);
  }

  @Post('plans')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  create(@CurrentUser() user: JwtUser, @Body() dto: CommissionPlanDto) {
    return this.commissions.createPlan(user.companyId, user.userId, dto);
  }

  @Patch('plans/:id')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  update(@CurrentUser() user: JwtUser, @Param('id', ParseIntPipe) id: number, @Body() dto: CommissionPlanDto) {
    return this.commissions.updatePlan(user.companyId, id, dto);
  }

  @Delete('plans/:id')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  remove(@CurrentUser() user: JwtUser, @Param('id', ParseIntPipe) id: number) {
    return this.commissions.deletePlan(user.companyId, id);
  }

  @Post('preview')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  preview(@CurrentUser() user: JwtUser, @Body() dto: PreviewPlanDto) {
    return this.commissions.preview(user.companyId, dto);
  }

  @Get('statement')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  statement(@CurrentUser() user: JwtUser, @Query('month') month: string) {
    return this.commissions.statement(user.companyId, month);
  }

  @Post('backfill')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  backfill(@CurrentUser() user: JwtUser) {
    return this.commissions.backfill(user.companyId);
  }
}
