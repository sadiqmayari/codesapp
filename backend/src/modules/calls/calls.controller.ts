import {
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
import { CallsService } from './calls.service';
import { InboxService } from '../inbox/inbox.service';

type Viewer = { userId: number; companyId: number; role: string };

@Controller('calls')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class CallsController {
  constructor(
    private readonly calls: CallsService,
    private readonly inbox: InboxService,
  ) {}

  @Get('sip-credentials')
  sipCredentials(@CurrentUser() user: Viewer) {
    return this.calls.sipCredentials({ userId: user.userId, companyId: user.companyId });
  }

  /**
   * Manual re-sync of the SIP trunk password from the stored Meta token. The
   * token save paths (onboarding step 3, add/update WhatsApp number) do this
   * automatically; this endpoint is the owner/admin fallback for the current
   * broken state (token already rotated before this feature existed).
   */
  @Post('sync-trunk-auth')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  syncTrunkAuth(@CurrentUser() user: Viewer) {
    return this.calls.syncTrunkAuth(user.companyId);
  }

  /** Company-wide call log for the inbox Calls tab (pool-model RBAC, paginated). */
  @Get()
  listCalls(
    @CurrentUser() user: Viewer,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('filter') filter?: string,
    @Query('search') search?: string,
  ) {
    return this.calls.listCompanyCalls(
      user.companyId,
      { userId: user.userId, role: user.role },
      {
        page: page ? Number(page) : 1,
        limit: limit ? Number(limit) : 30,
        filter,
        search,
      },
    );
  }

  @Get('conversation/:id')
  async forConversation(
    @CurrentUser() user: Viewer,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.inbox.assertConversationAccess(user.companyId, id, {
      userId: user.userId,
      role: user.role,
    });
    return this.calls.listForConversation(user.companyId, id);
  }
}
