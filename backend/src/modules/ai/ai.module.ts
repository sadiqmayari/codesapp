import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiController } from './ai.controller';
import { AiKnowledgeController } from './ai-knowledge.controller';
import { AiSettingsController } from './ai-settings.controller';
import { AiService } from './ai.service';
import { AiKnowledgeService } from './ai-knowledge.service';
import { AiSettingsService } from './ai-settings.service';
import { AiMeteringService } from './ai-metering.service';
import { AudioTranscriptionService } from './audio-transcription.service';
import { LlmService } from './llm.service';
import { AnthropicProvider } from './providers/anthropic.provider';
import { OpenAiProvider } from './providers/openai.provider';

@Module({
  imports: [AuthModule],
  controllers: [AiController, AiKnowledgeController, AiSettingsController],
  providers: [
    AiService,
    AiKnowledgeService,
    AiSettingsService,
    AiMeteringService,
    AudioTranscriptionService,
    LlmService,
    AnthropicProvider,
    OpenAiProvider,
  ],
  // AiService is consumed by BotsModule (auto-reply); AiMeteringService by
  // BillingModule (invoice arrears).
  exports: [AiService, AiMeteringService],
})
export class AiModule {}
