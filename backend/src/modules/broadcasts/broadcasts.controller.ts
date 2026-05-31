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

@Controller('broadcasts')
@UseGuards(AuthGuard('jwt'), TenantGuard, BroadcastPlanGuard)
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
  @HttpCode(HttpStatus.OK)
  previewAudience(
    @CurrentUser() user: { companyId: number },
    @Body() dto: PreviewAudienceDto,
  ) {
    return this.broadcastsService.previewAudience(user.companyId, dto);
  }

  @Post('test-send')
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
  create(
    @CurrentUser() user: { companyId: number },
    @Body() dto: CreateBroadcastDto,
  ) {
    return this.broadcastsService.create(user.companyId, dto);
  }

  @Post(':id/duplicate')
  @HttpCode(HttpStatus.OK)
  duplicate(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.broadcastsService.duplicate(user.companyId, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateBroadcastDto,
  ) {
    return this.broadcastsService.update(user.companyId, id, dto);
  }

  @Post(':id/send')
  @HttpCode(HttpStatus.OK)
  send(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.broadcastsService.sendNow(user.companyId, id);
  }

  @Post(':id/schedule')
  @HttpCode(HttpStatus.OK)
  schedule(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ScheduleBroadcastDto,
  ) {
    return this.broadcastsService.schedule(user.companyId, id, dto);
  }

  @Post(':id/cancel')
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
