import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { MetaClientService } from './meta-client.service';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WabaSubscriptionService } from '../../common/services/waba-subscription.service';
import { CallingReadinessService } from '../../common/services/calling-readiness.service';

/**
 * Multi-Number management for Settings → WhatsApp numbers. A tenant connects
 * several Cloud API numbers that all feed the one merged inbox. Each number
 * keeps its own access token + webhook URL. Add/edit/remove are owner/admin
 * only; the brief list is agent-readable for the inbox "Reply from" selector.
 */
@Controller('settings/whatsapp')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class WhatsAppNumbersController {
  constructor(
    private readonly meta: MetaClientService,
    private readonly wabaSubscription: WabaSubscriptionService,
    private readonly callingReadiness: CallingReadinessService,
  ) {}

  /**
   * WhatsApp Calling setup checklist (live from Meta). Not behind the `calls`
   * module guard on purpose: it tells a tenant what is missing, including the
   * module grant itself.
   */
  @Get('calling-readiness')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  callingSetup(@CurrentUser() user: { companyId: number }) {
    return this.callingReadiness.readiness(user.companyId);
  }

  /**
   * Webhook delivery check: is our app subscribed to each WABA? Meta sends
   * no inbound messages or status ticks without it. POST repairs it.
   */
  @Get('webhook-subscription')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  subscriptionStatus(@CurrentUser() user: { companyId: number }) {
    return this.wabaSubscription.ensureSubscribed(user.companyId, false);
  }

  @Post('webhook-subscription')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  fixSubscription(@CurrentUser() user: { companyId: number }) {
    return this.wabaSubscription.ensureSubscribed(user.companyId, true);
  }

  /** Agent-safe brief list (no secrets) for the inbox reply-from selector. */
  @Get('numbers-brief')
  listBrief(@CurrentUser() user: { companyId: number }) {
    return this.meta.listNumbersBrief(user.companyId);
  }

  @Get('numbers')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  list(@CurrentUser() user: { companyId: number }) {
    return this.meta.listNumbers(user.companyId);
  }

  @Post('numbers')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  add(
    @CurrentUser() user: { companyId: number },
    @Body()
    dto: {
      label?: string;
      wabaId?: string;
      phoneNumberId: string;
      accessToken: string;
      appSecret?: string;
    },
  ) {
    return this.meta.addNumber(user.companyId, dto);
  }

  @Patch('numbers/:id')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  update(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Body()
    dto: {
      label?: string;
      wabaId?: string;
      accessToken?: string;
      appSecret?: string;
      status?: string;
    },
  ) {
    return this.meta.updateNumber(user.companyId, id, dto);
  }

  @Post('numbers/:id/default')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  setDefault(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.meta.setDefaultNumber(user.companyId, id);
  }

  @Delete('numbers/:id')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  remove(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.meta.removeNumber(user.companyId, id);
  }
}
