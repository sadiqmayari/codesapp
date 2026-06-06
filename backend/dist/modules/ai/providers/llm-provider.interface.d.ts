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
export interface ToolDef {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
export interface ToolCall {
    id: string;
    name: string;
    input: Record<string, unknown>;
}
export type AgentMessage = {
    role: 'user';
    text: string;
} | {
    role: 'assistant';
    text: string | null;
    toolCalls?: ToolCall[];
} | {
    role: 'tool';
    toolCallId: string;
    name: string;
    content: string;
};
export interface AgentCompleteOpts {
    tier: ModelTier;
    system: SystemBlock[];
    messages: AgentMessage[];
    tools: ToolDef[];
    maxTokens: number;
    temperature?: number;
}
export interface AgentCompletionResult {
    text: string | null;
    toolCalls: ToolCall[];
    usage: NormalizedUsage;
    modelId: string;
    stop: 'tool_use' | 'end';
}
export interface LlmProvider {
    readonly name: AiProviderName;
    isConfigured(): boolean;
    complete(opts: CompleteOpts): Promise<CompletionResult>;
    completeWithTools(opts: AgentCompleteOpts): Promise<AgentCompletionResult>;
}
