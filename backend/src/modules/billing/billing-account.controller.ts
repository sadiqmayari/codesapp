import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BillingService } from './billing.service';

/**
 * JWT-only (deliberately NOT TenantGuard'd) so a company suspended for
 * non-payment can still learn *why* and see its outstanding invoice to
 * render the billing-blocked screen.
 */
@Controller('billing/account-status')
@UseGuards(AuthGuard('jwt'))
export class BillingAccountController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  accountStatus(@CurrentUser() user: { companyId: number }) {
    return this.billing.accountStatus(user.companyId);
  }
}
