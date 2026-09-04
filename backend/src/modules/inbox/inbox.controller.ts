import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { InboxService } from './inbox.service';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AssignDto } from './dto/assign.dto';
import { AddLabelDto } from './dto/add-label.dto';
import { AddNoteDto } from './dto/add-note.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { ListConversationsDto } from './dto/list-conversations.dto';

// Every authenticated request carries the full identity (see JwtStrategy) — we
// need role + userId (not just companyId) to enforce the pool-model RBAC.
type ReqUser = { companyId: number; userId: number; role: string };

@Controller('inbox')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class InboxController {
  constructor(private readonly inboxService: InboxService) {}

  private viewer(user: ReqUser) {
    return { userId: user.userId, role: user.role };
  }

  @Get('conversations')
  list(@CurrentUser() user: ReqUser, @Query() dto: ListConversationsDto) {
    return this.inboxService.listConversations(
      user.companyId,
      dto,
      this.viewer(user),
    );
  }

  @Get('conversations/:id')
  get(@CurrentUser() user: ReqUser, @Param('id', ParseIntPipe) id: number) {
    return this.inboxService.getConversation(
      user.companyId,
      id,
      this.viewer(user),
    );
  }

  @Post('conversations/:id/assign')
  async assign(
    @CurrentUser() user: ReqUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignDto,
  ) {
    await this.inboxService.assertConversationAccess(
      user.companyId,
      id,
      this.viewer(user),
    );
    // Agents may only claim a chat for themselves (or release their own) —
    // they can't hand a chat to another agent.
    if (
      user.role !== 'owner' &&
      user.role !== 'admin' &&
      dto.userId !== null &&
      dto.userId !== user.userId
    ) {
      throw new ForbiddenException('Agents can only assign chats to themselves');
    }
    return this.inboxService.assign(user.companyId, id, dto.userId);
  }

  @Post('conversations/:id/resolve')
  async resolve(
    @CurrentUser() user: ReqUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.inboxService.assertConversationAccess(
      user.companyId,
      id,
      this.viewer(user),
    );
    return this.inboxService.setStatus(user.companyId, id, 'resolved');
  }

  @Post('conversations/:id/reopen')
  async reopen(
    @CurrentUser() user: ReqUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.inboxService.assertConversationAccess(
      user.companyId,
      id,
      this.viewer(user),
    );
    return this.inboxService.setStatus(user.companyId, id, 'open');
  }

  @Post('conversations/:id/labels')
  async addLabel(
    @CurrentUser() user: ReqUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddLabelDto,
  ) {
    await this.inboxService.assertConversationAccess(
      user.companyId,
      id,
      this.viewer(user),
    );
    return this.inboxService.addLabel(user.companyId, id, dto.label);
  }

  @Delete('conversations/:id/labels/:label')
  async removeLabel(
    @CurrentUser() user: ReqUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('label') label: string,
  ) {
    await this.inboxService.assertConversationAccess(
      user.companyId,
      id,
      this.viewer(user),
    );
    return this.inboxService.removeLabel(user.companyId, id, label);
  }

  @Post('conversations/:id/notes')
  async addNote(
    @CurrentUser() user: ReqUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddNoteDto,
  ) {
    await this.inboxService.assertConversationAccess(
      user.companyId,
      id,
      this.viewer(user),
    );
    return this.inboxService.addNote(user.companyId, id, user.userId, dto.body);
  }

  @Get('conversations/:id/notes')
  async listNotes(
    @CurrentUser() user: ReqUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.inboxService.assertConversationAccess(
      user.companyId,
      id,
      this.viewer(user),
    );
    return this.inboxService.listNotes(user.companyId, id);
  }

  @Get('conversations/:id/messages')
  async messages(
    @CurrentUser() user: ReqUser,
    @Param('id', ParseIntPipe) id: number,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    await this.inboxService.assertConversationAccess(
      user.companyId,
      id,
      this.viewer(user),
    );
    const cursorNum = cursor ? Number(cursor) : undefined;
    const limitNum = limit ? Number(limit) : 50;
    return this.inboxService.listMessages(
      user.companyId,
      id,
      cursorNum,
      limitNum,
    );
  }

  // On-demand voice-note transcription (chevron → Transcribe). AI-gated + metered.
  @Post('conversations/:id/messages/:messageId/transcribe')
  async transcribe(
    @CurrentUser() user: ReqUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('messageId', ParseIntPipe) messageId: number,
  ) {
    await this.inboxService.assertConversationAccess(
      user.companyId,
      id,
      this.viewer(user),
    );
    return this.inboxService.transcribeMessage(user.companyId, id, messageId);
  }

  @Post('conversations/:id/send')
  async send(
    @CurrentUser() user: ReqUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SendMessageDto,
  ) {
    await this.inboxService.assertConversationAccess(
      user.companyId,
      id,
      this.viewer(user),
    );
    return this.inboxService.sendMessage(user.companyId, id, dto, user.userId);
  }

  @Post('conversations/:id/send-media')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 25 * 1024 * 1024 }, // hard cap above per-type limits
    }),
  )
  async sendMedia(
    @CurrentUser() user: ReqUser,
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile()
    file:
      | {
          buffer: Buffer;
          mimetype: string;
          originalname?: string;
          size: number;
        }
      | undefined,
    @Body('caption') caption?: string,
    @Body('contextMessageId') contextMessageId?: string,
    @Body('clientId') clientId?: string,
    @Body('voice') voice?: string,
  ) {
    await this.inboxService.assertConversationAccess(
      user.companyId,
      id,
      this.viewer(user),
    );
    if (!file) throw new BadRequestException('file is required');
    const ctxId = contextMessageId ? Number(contextMessageId) : undefined;
    return this.inboxService.sendMedia({
      companyId: user.companyId,
      conversationId: id,
      file,
      caption,
      contextMessageId:
        ctxId !== undefined && Number.isFinite(ctxId) ? ctxId : undefined,
      userId: user.userId,
      clientId: clientId ? String(clientId).slice(0, 64) : undefined,
      voice: voice === 'true' || voice === '1',
    });
  }

  @Post('conversations/:id/pin')
  async pin(
    @CurrentUser() user: ReqUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.inboxService.assertConversationAccess(
      user.companyId,
      id,
      this.viewer(user),
    );
    return this.inboxService.setPinned(user.companyId, id, true);
  }

  @Post('conversations/:id/unpin')
  async unpin(
    @CurrentUser() user: ReqUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.inboxService.assertConversationAccess(
      user.companyId,
      id,
      this.viewer(user),
    );
    return this.inboxService.setPinned(user.companyId, id, false);
  }

  @Post('conversations/:id/clear')
  async clear(
    @CurrentUser() user: ReqUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.inboxService.assertConversationAccess(
      user.companyId,
      id,
      this.viewer(user),
    );
    return this.inboxService.clearHistory(user.companyId, id);
  }

  @Post('conversations/:id/mark-read')
  async markRead(
    @CurrentUser() user: ReqUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.inboxService.assertConversationAccess(
      user.companyId,
      id,
      this.viewer(user),
    );
    return this.inboxService.markRead(user.companyId, id, user.userId);
  }

  // Per-conversation AI auto-pilot toggle. mode: 'on' | 'off' | 'default'.
  @Post('conversations/:id/ai-autoreply')
  async setAiAutoReply(
    @CurrentUser() user: ReqUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { mode?: string },
  ) {
    await this.inboxService.assertConversationAccess(
      user.companyId,
      id,
      this.viewer(user),
    );
    const mode = body?.mode;
    if (mode !== 'on' && mode !== 'off' && mode !== 'default') {
      throw new BadRequestException("mode must be 'on', 'off' or 'default'");
    }
    return this.inboxService.setAiAutoReply(user.companyId, id, mode);
  }
}
