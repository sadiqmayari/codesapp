import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InboxModule } from '../inbox/inbox.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { AiModule } from '../ai/ai.module';
import { BotsController } from './bots.controller';
import { BotsService } from './bots.service';
import { BotEngineService } from './bot-engine.service';
import { AiAutoReplyService } from './ai-autoreply.service';

@Module({
  imports: [AuthModule, WebhooksModule, AiModule, forwardRef(() => InboxModule)],
  controllers: [BotsController],
  providers: [BotsService, BotEngineService, AiAutoReplyService],
  exports: [BotEngineService, BotsService],
})
export class BotsModule {}
