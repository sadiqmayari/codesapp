import {
  Body,
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

  /**
   * One-shot rewrite of pre-billing-lifecycle invoices to the canonical
   * format. body: { dryRun?: boolean (default true), companyId?: number }
   * Returns a per-invoice change list — caller previews dryRun=true, then
   * re-fires with dryRun=false.
   */
  @Post('invoices/rewrite-legacy')
  rewriteLegacy(
    @Body() body: { dryRun?: boolean; companyId?: number | null },
  ) {
    return this.billing.rewriteLegacyInvoices({
      dryRun: body?.dryRun !== false, // default = dry-run
      companyId:
        typeof body?.companyId === 'number' ? body.companyId : null,
    });
  }
}
