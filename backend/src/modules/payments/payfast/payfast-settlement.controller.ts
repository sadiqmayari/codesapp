import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FilesInterceptor } from '@nestjs/platform-express';
import { TenantGuard } from '../../../common/guards/tenant.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { PayfastSettlementService } from './payfast-settlement.service';
import { ShopifyService } from '../../integrations/shopify/shopify.service';

/**
 * PayFast settlement reconciliation. Under the /api prefix, guarded owner/admin
 * (it moves money — same as courier invoices). Upload the PayFast transaction
 * export (+ optional settlement summary) → preview (no writes) → apply.
 */
@Controller('payfast')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard)
export class PayfastSettlementController {
  constructor(
    private readonly settlements: PayfastSettlementService,
    private readonly shopify: ShopifyService,
  ) {}

  // Read + download: owner/admin AND the view-only finance role.
  @Get('settlements')
  @Roles('owner', 'admin', 'finance')
  list(@CurrentUser() user: { companyId: number }) {
    return this.settlements.listSettlements(user.companyId);
  }

  // Money actions (upload/apply/backfill) stay owner/admin only.
  @Post('settlements/upload')
  @Roles('owner', 'admin')
  @UseInterceptors(FilesInterceptor('files', 2, { limits: { fileSize: 10 * 1024 * 1024 } }))
  upload(
    @CurrentUser() user: { companyId: number; userId: number },
    @UploadedFiles()
    files: Array<{ buffer?: Buffer; mimetype?: string; originalname?: string; size?: number }>,
  ) {
    return this.settlements.uploadAndPreview(user.companyId, files ?? [], user.userId);
  }

  @Get('settlements/:id')
  @Roles('owner', 'admin', 'finance')
  get(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.settlements.getSettlement(user.companyId, id);
  }

  @Post('settlements/:id/apply')
  @Roles('owner', 'admin')
  apply(
    @CurrentUser() user: { companyId: number; userId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.settlements.applySettlement(user.companyId, id, user.userId);
  }

  // Download/generate the statement PDF — allowed for finance.
  @Post('settlements/:id/pdf')
  @Roles('owner', 'admin', 'finance')
  async pdf(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    const url = await this.settlements.generatePdf(user.companyId, id);
    return { url };
  }

  /**
   * One-off: backfill `gateway_payment_ref` for orders in a date window (reads
   * their Shopify transactions). Preview auto-backfills the file's window, so
   * this is only for a manual wider sweep.
   */
  @Post('backfill-refs')
  @Roles('owner', 'admin')
  backfill(
    @CurrentUser() user: { companyId: number },
    @Body() body: { sinceISO?: string; untilISO?: string },
  ) {
    return this.shopify.backfillGatewayPaymentRefs(user.companyId, {
      sinceISO: body?.sinceISO,
      untilISO: body?.untilISO,
    });
  }
}
