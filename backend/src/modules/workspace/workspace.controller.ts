import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WorkspaceService } from './workspace.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { INBOX_ROLES } from '../../common/auth/roles';

/** Per-tenant app-shell facts. All authenticated roles (agents included) — the
 *  navbar shows the WhatsApp number to everyone. */
@Controller('workspace')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard)
@Roles(...INBOX_ROLES, 'fulfillment')
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Get('whatsapp-number')
  whatsappNumber(@CurrentUser() user: { companyId: number }) {
    return this.workspace.getWhatsAppNumber(user.companyId);
  }
}
