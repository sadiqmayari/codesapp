import { AiProviderName, ModelTier } from '../ai.constants';
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
export interface ImageInput {
    mime: string;
    dataBase64: string;
}
export interface CompleteOpts {
    tier: ModelTier;
    system: SystemBlock[];
    userText: string;
    images?: ImageInput[];
    maxTokens: number;
    temperature?: number;
}
export interface LlmProvider {
    readonly name: AiProviderName;
    isConfigured(): boolean;
    complete(opts: CompleteOpts): Promise<CompletionResult>;
}
