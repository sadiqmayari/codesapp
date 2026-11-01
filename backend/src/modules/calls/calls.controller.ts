import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
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
  sipCredentials() {
    return this.calls.sipCredentials();
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
