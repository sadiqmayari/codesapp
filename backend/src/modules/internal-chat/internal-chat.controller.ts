import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { InternalChatService, Actor } from './internal-chat.service';

@Controller('team-chat')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class InternalChatController {
  constructor(private readonly chat: InternalChatService) {}

  @Get('roster')
  roster(@CurrentUser() user: Actor) {
    return this.chat.roster(user.companyId, user.userId);
  }

  @Get('presence')
  presence(@CurrentUser() user: Actor) {
    return this.chat.presence(user.companyId);
  }

  @Get('threads')
  threads(@CurrentUser() user: Actor) {
    return this.chat.listThreads(user.companyId, user.userId);
  }

  @Get('unread')
  unread(@CurrentUser() user: Actor) {
    return this.chat.unreadTotal(user.companyId, user.userId);
  }

  @Post('threads/dm')
  openDm(@CurrentUser() user: Actor, @Body() body: { userId?: number }) {
    return this.chat.openDm(user.companyId, user.userId, Number(body?.userId));
  }

  @Get('threads/:id/messages')
  messages(
    @CurrentUser() user: Actor,
    @Param('id', ParseIntPipe) id: number,
    @Query('cursor') cursor?: string,
  ) {
    const c = cursor ? Number(cursor) : undefined;
    return this.chat.getMessages(
      user.companyId,
      user.userId,
      id,
      Number.isFinite(c) ? c : undefined,
    );
  }

  @Post('threads/:id/messages')
  send(
    @CurrentUser() user: Actor,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { text?: string; clientId?: string },
  ) {
    return this.chat.sendText(user, id, body?.text ?? '', body?.clientId);
  }

  @Post('threads/:id/media')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 25 * 1024 * 1024 },
    }),
  )
  sendMedia(
    @CurrentUser() user: Actor,
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: { buffer: Buffer; mimetype: string; originalname?: string },
    @Body() body: { kind?: string; clientId?: string },
  ) {
    return this.chat.sendMedia(user, id, file, body?.kind, body?.clientId);
  }

  @Post('threads/:id/read')
  read(@CurrentUser() user: Actor, @Param('id', ParseIntPipe) id: number) {
    return this.chat.markRead(user.companyId, user.userId, id);
  }
}
