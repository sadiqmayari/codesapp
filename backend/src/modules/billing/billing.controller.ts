import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BillingService } from './billing.service';
import { ListInvoicesDto } from './dtos/list-invoices.dto';
import { RequestPlanChangeDto } from './dtos/request-plan-change.dto';

@Controller('billing')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('plan-request')
  getPlanRequest(@CurrentUser() user: { companyId: number }) {
    return this.billing.getMyPlanRequest(user.companyId);
  }

  @Post('plan-request')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  requestPlanChange(
    @CurrentUser() user: { companyId: number; userId: number },
    @Body() dto: RequestPlanChangeDto,
  ) {
    return this.billing.requestPlanChange(user.companyId, user.userId, dto);
  }

  @Get('invoices')
  listInvoices(
    @CurrentUser() user: { companyId: number },
    @Query() dto: ListInvoicesDto,
  ) {
    return this.billing.listInvoices(user.companyId, dto);
  }

  @Get('subscription')
  subscription(@CurrentUser() user: { companyId: number }) {
    return this.billing.getSubscription(user.companyId);
  }

  @Get('invoices/:id')
  getInvoice(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.billing.getInvoice(user.companyId, id);
  }
}
