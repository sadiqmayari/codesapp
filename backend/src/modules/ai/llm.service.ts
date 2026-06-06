import { Injectable } from '@nestjs/common';
import { PlatformSettingService } from '../../common/services/platform-setting.service';
import {
  AI_PROVIDER_DEFAULT,
  AI_PROVIDER_KEY,
  AiProviderName,
} from './ai.constants';
import { AnthropicProvider } from './providers/anthropic.provider';
import { OpenAiProvider } from './providers/openai.provider';
import {
  AgentCompleteOpts,
  AgentCompletionResult,
  CompleteOpts,
  CompletionResult,
  LlmProvider,
} from './providers/llm-provider.interface';

export interface CompletionWithProvider extends CompletionResult {
  provider: AiProviderName;
}

export interface AgentCompletionWithProvider extends AgentCompletionResult {
  provider: AiProviderName;
}

/**
 * Provider-agnostic LLM gateway. Resolves the active provider from the
 * platform setting `ai_provider` (super-admin controlled, cached 5m by
 * PlatformSettingService) and routes the call. The result carries the
 * resolved provider name so metering can price it correctly.
 */
@Injectable()
export class LlmService {
  private readonly providers: Record<AiProviderName, LlmProvider>;

  constructor(
    private readonly platformSetting: PlatformSettingService,
    anthropic: AnthropicProvider,
    openai: OpenAiProvider,
  ) {
    this.providers = { anthropic, openai };
  }

  async getActiveProviderName(): Promise<AiProviderName> {
    const v = await this.platformSetting.get(
      AI_PROVIDER_KEY,
      AI_PROVIDER_DEFAULT,
    );
    return v === 'openai' ? 'openai' : 'anthropic';
  }

  /** Is the currently-active provider's API key configured? */
  async isConfigured(): Promise<boolean> {
    const name = await this.getActiveProviderName();
    return this.providers[name].isConfigured();
  }

  async complete(opts: CompleteOpts): Promise<CompletionWithProvider> {
    const name = await this.getActiveProviderName();
    const result = await this.providers[name].complete(opts);
    return { ...result, provider: name };
  }

  async completeWithTools(
    opts: AgentCompleteOpts,
  ): Promise<AgentCompletionWithProvider> {
    const name = await this.getActiveProviderName();
    const result = await this.providers[name].completeWithTools(opts);
    return { ...result, provider: name };
  }
}
