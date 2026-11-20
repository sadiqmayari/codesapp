import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BroadcastsService } from './broadcasts.service';
import { BroadcastPlanGuard } from './broadcast-plan.guard';
import { CreateBroadcastDto } from './dto/create-broadcast.dto';
import { ScheduleBroadcastDto } from './dto/schedule-broadcast.dto';
import { ListBroadcastsDto } from './dto/list-broadcasts.dto';
import { PreviewAudienceDto } from './dto/preview-audience.dto';
import { TestSendDto } from './dto/test-send.dto';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { INBOX_ROLES, PRIVILEGED } from '../../common/auth/roles';

@Controller('broadcasts')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard, BroadcastPlanGuard)
@Roles(...INBOX_ROLES)
export class BroadcastsController {
  constructor(private readonly broadcastsService: BroadcastsService) {}

  @Get()
  list(
    @CurrentUser() user: { companyId: number },
    @Query() dto: ListBroadcastsDto,
  ) {
    return this.broadcastsService.list(user.companyId, dto);
  }

  @Post('preview-audience')
  @Roles(...PRIVILEGED)
  @HttpCode(HttpStatus.OK)
  previewAudience(
    @CurrentUser() user: { companyId: number },
    @Body() dto: PreviewAudienceDto,
  ) {
    return this.broadcastsService.previewAudience(user.companyId, dto);
  }

  @Post('test-send')
  @Roles(...PRIVILEGED)
  @HttpCode(HttpStatus.OK)
  testSend(
    @CurrentUser() user: { companyId: number },
    @Body() dto: TestSendDto,
  ) {
    return this.broadcastsService.testSend(user.companyId, dto);
  }

  @Get(':id')
  get(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.broadcastsService.get(user.companyId, id);
  }

  @Post()
  @Roles(...PRIVILEGED)
  create(
    @CurrentUser() user: { companyId: number },
    @Body() dto: CreateBroadcastDto,
  ) {
    return this.broadcastsService.create(user.companyId, dto);
  }

  @Post(':id/duplicate')
  @Roles(...PRIVILEGED)
  @HttpCode(HttpStatus.OK)
  duplicate(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.broadcastsService.duplicate(user.companyId, id);
  }

  @Patch(':id')
  @Roles(...PRIVILEGED)
  update(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateBroadcastDto,
  ) {
    return this.broadcastsService.update(user.companyId, id, dto);
  }

  @Post(':id/send')
  @Roles(...PRIVILEGED)
  @HttpCode(HttpStatus.OK)
  send(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.broadcastsService.sendNow(user.companyId, id);
  }

  @Post(':id/schedule')
  @Roles(...PRIVILEGED)
  @HttpCode(HttpStatus.OK)
  schedule(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ScheduleBroadcastDto,
  ) {
    return this.broadcastsService.schedule(user.companyId, id, dto);
  }

  @Post(':id/cancel')
  @Roles(...PRIVILEGED)
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.broadcastsService.cancel(user.companyId, id);
  }

  @Get(':id/analytics')
  analytics(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.broadcastsService.analytics(user.companyId, id);
  }
}
