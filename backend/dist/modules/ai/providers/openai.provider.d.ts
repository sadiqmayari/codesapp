import { ConfigService } from '@nestjs/config';
import { AiProviderName } from '../ai.constants';
import { CompleteOpts, CompletionResult, LlmProvider } from './llm-provider.interface';
export declare class OpenAiProvider implements LlmProvider {
    private readonly config;
    readonly name: AiProviderName;
    private client;
    constructor(config: ConfigService);
    isConfigured(): boolean;
    private getClient;
    complete(opts: CompleteOpts): Promise<CompletionResult>;
}
