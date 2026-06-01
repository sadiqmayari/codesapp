import { AiProviderName, ModelTier } from '../ai.constants';

/** A system-prompt block; `cache: true` marks it for prompt caching (Anthropic). */
export interface SystemBlock {
  text: string;
  cache?: boolean;
}

/** Normalized token usage returned alongside the completion text. */
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

export interface CompleteOpts {
  tier: ModelTier;
  system: SystemBlock[];
  /** Single user turn (we format transcripts into one user message). */
  userText: string;
  maxTokens: number;
  temperature?: number;
}

/** A pluggable LLM backend (Anthropic, OpenAI, …). */
export interface LlmProvider {
  readonly name: AiProviderName;
  isConfigured(): boolean;
  complete(opts: CompleteOpts): Promise<CompletionResult>;
}
