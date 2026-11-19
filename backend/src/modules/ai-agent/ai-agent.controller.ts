import {
  Body,
  Controller,
  Get,
  NotFoundException,
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
import { FeedbackDto, PerformanceQueryDto, PlaygroundDto } from '../ai/dto/agent-profile.dto';
import { AgentRuntimeService } from './agent-runtime.service';
import { AgentInsightsService } from './agent-insights.service';
import { AgentBookingsService } from './bookings.service';

interface Viewer {
  companyId: number;
  userId: number;
  role: string;
}

/**
 * AI Agent v2 endpoints that need the runtime (Inbox + commerce). Profile /
 * knowledge endpoints live in AiModule (no Inbox dependency).
 */
@Controller('ai/agent')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class AiAgentController {
  constructor(
    private readonly runtime: AgentRuntimeService,
    private readonly insights: AgentInsightsService,
    private readonly bookings: AgentBookingsService,
  ) {}

  /** Chat with your own agent — dry run (nothing is sent or created). */
  @Post('playground')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  playground(@CurrentUser() user: Viewer, @Body() dto: PlaygroundDto) {
    return this.runtime.playground(user.companyId, dto);
  }

  /** AI state of one chat (inbox badge): on/off/muted/paused/handed-off/cap… */
  @Get('state/:conversationId')
  state(@CurrentUser() user: Viewer, @Param('conversationId', ParseIntPipe) id: number) {
    return this.insights.state(user, id);
  }

  /** Give the chat back to the AI (clears the handoff pause / mute). */
  @Post('resume/:conversationId')
  resume(@CurrentUser() user: Viewer, @Param('conversationId', ParseIntPipe) id: number) {
    return this.insights.resume(user, id);
  }

  /** "Why this reply?" — the per-turn traces of a conversation. */
  @Get('trace/:conversationId')
  trace(@CurrentUser() user: Viewer, @Param('conversationId', ParseIntPipe) id: number) {
    return this.insights.trace(user, id);
  }

  /** Thumbs up/down on an AI-written message. */
  @Post('feedback')
  feedback(@CurrentUser() user: Viewer, @Body() dto: FeedbackDto) {
    return this.insights.feedback(user, dto);
  }

  /** Settings → AI Agent → Performance. */
  @Get('performance')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  performance(@CurrentUser() user: Viewer, @Query() q: PerformanceQueryDto) {
    return this.insights.performance(user.companyId, q.days ?? 30);
  }

  @Get('bookings')
  bookingsList(@CurrentUser() user: Viewer) {
    return this.bookings.list(user.companyId);
  }

  @Post('bookings/:id/cancel')
  async cancelBooking(@CurrentUser() user: Viewer, @Param('id', ParseIntPipe) id: number) {
    const b = await this.bookings.cancel(user.companyId, id).catch(() => null);
    if (!b) throw new NotFoundException('Booking not found');
    return { ok: true };
  }
}
