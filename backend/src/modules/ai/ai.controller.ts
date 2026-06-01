import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AiService } from './ai.service';
import { AiMeteringService } from './ai-metering.service';
import {
  RewriteDto,
  SuggestReplyDto,
  SummarizeDto,
  TranslateDto,
} from './dto/ai-actions.dto';

type AuthUser = { companyId: number; userId: number };

@Controller('ai')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly metering: AiMeteringService,
  ) {}

  @Post('suggest-reply')
  suggestReply(@CurrentUser() user: AuthUser, @Body() dto: SuggestReplyDto) {
    return this.ai.suggestReply(
      user.companyId,
      user.userId,
      dto.conversationId,
      dto.instruction,
    );
  }

  @Post('summarize')
  summarize(@CurrentUser() user: AuthUser, @Body() dto: SummarizeDto) {
    return this.ai.summarize(user.companyId, user.userId, dto.conversationId);
  }

  @Post('rewrite')
  rewrite(@CurrentUser() user: AuthUser, @Body() dto: RewriteDto) {
    return this.ai.rewrite(user.companyId, user.userId, dto.text, dto.mode);
  }

  @Post('translate')
  translate(@CurrentUser() user: AuthUser, @Body() dto: TranslateDto) {
    return this.ai.translate(
      user.companyId,
      user.userId,
      dto.text,
      dto.targetLang,
    );
  }

  @Get('usage')
  usage(@CurrentUser() user: AuthUser) {
    return this.metering.getMonthlyUsage(user.companyId);
  }
}
