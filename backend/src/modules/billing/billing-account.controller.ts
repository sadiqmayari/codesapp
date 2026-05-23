import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BillingService } from './billing.service';
import { LimitNotifierService } from './limit-notifier.service';

/**
 * Mixed-guard module:
 *  - `/billing/account-status` is JWT-only (NOT TenantGuard'd) so a company
 *    suspended for non-payment can still learn *why* and see its outstanding
 *    invoice to render the billing-blocked screen.
 *  - `/billing/usage-warnings` IS TenantGuard'd — it's only useful for
 *    active tenants that can still hit limits.
 */
@Controller('billing')
export class BillingAccountController {
  constructor(
    private readonly billing: BillingService,
    private readonly limitNotifier: LimitNotifierService,
  ) {}

  @Get('account-status')
  @UseGuards(AuthGuard('jwt'))
  accountStatus(@CurrentUser() user: { companyId: number }) {
    return this.billing.accountStatus(user.companyId);
  }

  /**
   * Hydration endpoint for the in-app sticky banner + navbar pulse chip.
   * Returns the CURRENT active warnings (≥90% on any capped dimension)
   * so a page load doesn't have to wait for a socket tick to render.
   */
  @Get('usage-warnings')
  @UseGuards(AuthGuard('jwt'), TenantGuard)
  usageWarnings(@CurrentUser() user: { companyId: number }) {
    return this.limitNotifier.snapshot(user.companyId);
  }
}
