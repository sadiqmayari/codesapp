import {
  Body,
  Controller,
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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TicketsService } from './tickets.service';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { CreateTicketEventDto } from './dto/create-ticket-event.dto';

@Controller('tickets')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  list(
    @CurrentUser() user: { companyId: number },
    @Query('status') status?: string,
    @Query('type') type?: string,
  ) {
    return this.tickets.list(user.companyId, { status, type });
  }

  @Post()
  create(
    @CurrentUser() user: { companyId: number; userId: number },
    @Body() dto: CreateTicketDto,
  ) {
    return this.tickets.createManual(user.companyId, user.userId, dto);
  }

  @Get('conversation/:conversationId')
  openForConversation(
    @CurrentUser() user: { companyId: number },
    @Param('conversationId', ParseIntPipe) conversationId: number,
  ) {
    return this.tickets.findOpenForConversation(user.companyId, conversationId);
  }

  @Get(':id')
  get(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.tickets.get(user.companyId, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: { companyId: number; userId: number },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTicketDto,
  ) {
    return this.tickets.update(user.companyId, id, dto, user.userId);
  }

  @Post(':id/events')
  addNote(
    @CurrentUser() user: { companyId: number; userId: number },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateTicketEventDto,
  ) {
    return this.tickets.addNote(user.companyId, id, dto.body, user.userId);
  }
}
