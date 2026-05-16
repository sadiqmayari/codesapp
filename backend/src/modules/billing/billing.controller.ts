import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BillingService } from './billing.service';
import { ListInvoicesDto } from './dtos/list-invoices.dto';

@Controller('billing')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

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
