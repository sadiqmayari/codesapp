import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { SuperAdminIpGuard } from '../../common/guards/super-admin-ip.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { BillingService } from './billing.service';

@Controller('super-admin/billing')
@UseGuards(AuthGuard('jwt'), SuperAdminIpGuard, RolesGuard)
@Roles('super_admin')
export class BillingSuperAdminController {
  constructor(private readonly billing: BillingService) {}

  @Get('overview')
  overview() {
    return this.billing.overview();
  }

  @Post('invoices/:id/mark-paid')
  markPaid(@Param('id', ParseIntPipe) id: number) {
    return this.billing.markPaid(id);
  }

  @Post('invoices/generate')
  generate() {
    return this.billing.generateInvoices();
  }
}
