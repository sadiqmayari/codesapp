import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiController } from './ai.controller';
import { AiKnowledgeController } from './ai-knowledge.controller';
import { AiSettingsController } from './ai-settings.controller';
import { AiService } from './ai.service';
import { AiKnowledgeService } from './ai-knowledge.service';
import { AiSettingsService } from './ai-settings.service';
import { AiMeteringService } from './ai-metering.service';
import { AnthropicClientService } from './anthropic-client.service';

@Module({
  imports: [AuthModule],
  controllers: [AiController, AiKnowledgeController, AiSettingsController],
  providers: [
    AiService,
    AiKnowledgeService,
    AiSettingsService,
    AiMeteringService,
    AnthropicClientService,
  ],
  exports: [AiMeteringService],
})
export class AiModule {}
