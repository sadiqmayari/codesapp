import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InboxModule } from '../inbox/inbox.module';
import { BotsController } from './bots.controller';
import { BotsService } from './bots.service';
import { BotEngineService } from './bot-engine.service';

@Module({
  imports: [AuthModule, forwardRef(() => InboxModule)],
  controllers: [BotsController],
  providers: [BotsService, BotEngineService],
  exports: [BotEngineService, BotsService],
})
export class BotsModule {}
