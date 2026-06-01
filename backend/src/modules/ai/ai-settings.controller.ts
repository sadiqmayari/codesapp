import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AiSettingsService } from './ai-settings.service';
import { UpdateAiSettingsDto } from './dto/ai-settings.dto';

@Controller('ai/settings')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class AiSettingsController {
  constructor(private readonly settings: AiSettingsService) {}

  @Get()
  get(@CurrentUser() user: { companyId: number }) {
    return this.settings.get(user.companyId);
  }

  @Patch()
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  update(
    @CurrentUser() user: { companyId: number },
    @Body() dto: UpdateAiSettingsDto,
  ) {
    return this.settings.update(user.companyId, dto);
  }
}
