import { PlatformSettingService } from '../../common/services/platform-setting.service';
import { AiProviderName } from './ai.constants';
import { AnthropicProvider } from './providers/anthropic.provider';
import { OpenAiProvider } from './providers/openai.provider';
import { AgentCompleteOpts, AgentCompletionResult, CompleteOpts, CompletionResult } from './providers/llm-provider.interface';
export interface CompletionWithProvider extends CompletionResult {
    provider: AiProviderName;
}
export interface AgentCompletionWithProvider extends AgentCompletionResult {
    provider: AiProviderName;
}
export declare class LlmService {
    private readonly platformSetting;
    private readonly providers;
    constructor(platformSetting: PlatformSettingService, anthropic: AnthropicProvider, openai: OpenAiProvider);
    getActiveProviderName(): Promise<AiProviderName>;
    isConfigured(): Promise<boolean>;
    complete(opts: CompleteOpts): Promise<CompletionWithProvider>;
    completeWithTools(opts: AgentCompleteOpts): Promise<AgentCompletionWithProvider>;
}
