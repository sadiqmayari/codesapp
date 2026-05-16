import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WebhooksService } from './webhooks.service';
import { CreateEndpointDto } from './dtos/create-endpoint.dto';
import { UpdateEndpointDto } from './dtos/update-endpoint.dto';
import { ListLogsDto } from './dtos/list-logs.dto';

@Controller('webhooks')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get('endpoints')
  listEndpoints(
    @CurrentUser() user: { companyId: number },
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
  ) {
    return this.webhooks.listEndpoints(user.companyId, page, limit);
  }

  @Get('logs')
  listLogs(
    @CurrentUser() user: { companyId: number },
    @Query() dto: ListLogsDto,
  ) {
    return this.webhooks.listLogs(user.companyId, dto);
  }

  @Get('endpoints/:id')
  getEndpoint(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.webhooks.getEndpoint(user.companyId, id);
  }

  @Post('endpoints')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  create(
    @CurrentUser() user: { companyId: number },
    @Body() dto: CreateEndpointDto,
  ) {
    return this.webhooks.createEndpoint(user.companyId, dto);
  }

  @Patch('endpoints/:id')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  update(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEndpointDto,
  ) {
    return this.webhooks.updateEndpoint(user.companyId, id, dto);
  }

  @Delete('endpoints/:id')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  remove(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.webhooks.deleteEndpoint(user.companyId, id);
  }

  @Patch('endpoints/:id/toggle')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  toggle(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.webhooks.toggleEndpoint(user.companyId, id);
  }

  @Post('endpoints/:id/test')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  test(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.webhooks.testEndpoint(user.companyId, id);
  }

  @Post('logs/:id/retry')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  retry(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.webhooks.retryLog(user.companyId, id);
  }
}
