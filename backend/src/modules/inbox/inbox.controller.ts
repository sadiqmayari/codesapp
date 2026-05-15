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
import { InboxService } from './inbox.service';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AssignDto } from './dto/assign.dto';
import { AddLabelDto } from './dto/add-label.dto';
import { AddNoteDto } from './dto/add-note.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { ListConversationsDto } from './dto/list-conversations.dto';

@Controller('inbox')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class InboxController {
  constructor(private readonly inboxService: InboxService) {}

  @Get('conversations')
  list(
    @CurrentUser() user: { companyId: number },
    @Query() dto: ListConversationsDto,
  ) {
    return this.inboxService.listConversations(user.companyId, dto);
  }

  @Get('conversations/:id')
  get(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.inboxService.getConversation(user.companyId, id);
  }

  @Post('conversations/:id/assign')
  assign(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignDto,
  ) {
    return this.inboxService.assign(user.companyId, id, dto.userId);
  }

  @Post('conversations/:id/resolve')
  resolve(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.inboxService.setStatus(user.companyId, id, 'resolved');
  }

  @Post('conversations/:id/reopen')
  reopen(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.inboxService.setStatus(user.companyId, id, 'open');
  }

  @Post('conversations/:id/labels')
  addLabel(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddLabelDto,
  ) {
    return this.inboxService.addLabel(user.companyId, id, dto.label);
  }

  @Delete('conversations/:id/labels/:label')
  removeLabel(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Param('label') label: string,
  ) {
    return this.inboxService.removeLabel(user.companyId, id, label);
  }

  @Post('conversations/:id/notes')
  addNote(
    @CurrentUser() user: { companyId: number; userId: number },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddNoteDto,
  ) {
    return this.inboxService.addNote(user.companyId, id, user.userId, dto.body);
  }

  @Get('conversations/:id/notes')
  listNotes(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.inboxService.listNotes(user.companyId, id);
  }

  @Get('conversations/:id/messages')
  messages(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const cursorNum = cursor ? Number(cursor) : undefined;
    const limitNum = limit ? Number(limit) : 50;
    return this.inboxService.listMessages(
      user.companyId,
      id,
      cursorNum,
      limitNum,
    );
  }

  @Post('conversations/:id/send')
  send(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SendMessageDto,
  ) {
    return this.inboxService.sendMessage(user.companyId, id, dto);
  }

  @Post('conversations/:id/mark-read')
  markRead(
    @CurrentUser() user: { companyId: number; userId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.inboxService.markRead(user.companyId, id, user.userId);
  }
}
