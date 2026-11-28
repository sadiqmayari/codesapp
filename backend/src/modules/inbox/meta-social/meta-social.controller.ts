import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { TenantGuard } from '../../../common/guards/tenant.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { ModuleGuard } from '../../../common/guards/module.guard';
import { RequireModule } from '../../../common/decorators/require-module.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { PRIVILEGED } from '../../../common/auth/roles';
import { MetaSocialService } from './meta-social.service';

class ConnectDto {
  /** Omit to use the WhatsApp token already saved for the workspace. */
  @IsOptional() @IsString() @MinLength(20) @MaxLength(2000) token?: string;
}

class EnablePageDto {
  @IsString() @MinLength(1) @MaxLength(64) pageId!: string;
}

type U = { companyId: number };

/** Settings → Facebook & Instagram (owner/admin, module `meta_inbox`). */
@Controller('settings/meta-social')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard, ModuleGuard)
@Roles(...PRIVILEGED)
@RequireModule('meta_inbox')
export class MetaSocialController {
  constructor(private readonly svc: MetaSocialService) {}

  @Get('status')
  status(@CurrentUser() u: U) {
    return this.svc.status(u.companyId);
  }

  @Get('diagnostics')
  diagnostics(@CurrentUser() u: U, @Query('fresh') fresh?: string) {
    return this.svc.diagnostics(u.companyId, fresh === '1');
  }

  @Post('connect')
  connect(@CurrentUser() u: U, @Body() dto: ConnectDto) {
    return this.svc.connect(u.companyId, dto.token);
  }

  @Get('available')
  available(@CurrentUser() u: U) {
    return this.svc.listAvailable(u.companyId);
  }

  @Post('pages')
  enable(@CurrentUser() u: U, @Body() dto: EnablePageDto) {
    return this.svc.enablePage(u.companyId, dto.pageId);
  }

  @Post('pages/:id/resubscribe')
  resubscribe(@CurrentUser() u: U, @Param('id', ParseIntPipe) id: number) {
    return this.svc.resubscribe(u.companyId, id);
  }

  @Delete('pages/:id')
  disable(@CurrentUser() u: U, @Param('id', ParseIntPipe) id: number) {
    return this.svc.disablePage(u.companyId, id);
  }
}
