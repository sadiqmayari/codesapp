import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { ModelTier } from './ai.constants';
export interface SystemBlock {
    text: string;
    cache?: boolean;
}
export interface NormalizedUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}
export interface CompletionResult {
    text: string;
    usage: NormalizedUsage;
    modelId: string;
}
export declare class AnthropicClientService {
    private readonly config;
    private readonly logger;
    private client;
    constructor(config: ConfigService);
    isConfigured(): boolean;
    private getClient;
    complete(opts: {
        tier: ModelTier;
        system: SystemBlock[];
        messages: Anthropic.MessageParam[];
        maxTokens: number;
        temperature?: number;
    }): Promise<CompletionResult>;
}
