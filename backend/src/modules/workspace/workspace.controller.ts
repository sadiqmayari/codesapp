import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WorkspaceService } from './workspace.service';

/** Per-tenant app-shell facts. All authenticated roles (agents included) — the
 *  navbar shows the WhatsApp number to everyone. */
@Controller('workspace')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Get('whatsapp-number')
  whatsappNumber(@CurrentUser() user: { companyId: number }) {
    return this.workspace.getWhatsAppNumber(user.companyId);
  }
}
