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

/** An inline image attached to the user turn (vision). Base64-encoded bytes. */
export interface ImageInput {
  /** MIME type, e.g. "image/jpeg", "image/png", "image/webp". */
  mime: string;
  /** Raw base64 (no data: prefix). */
  dataBase64: string;
}

export interface CompleteOpts {
  tier: ModelTier;
  system: SystemBlock[];
  /** Single user turn (we format transcripts into one user message). */
  userText: string;
  /**
   * Optional inline images appended to the user turn for vision-capable models.
   * Only populated when the tenant has vision enabled. Providers that ignore
   * them fall back to text-only.
   */
  images?: ImageInput[];
  maxTokens: number;
  temperature?: number;
}

/** A pluggable LLM backend (Anthropic, OpenAI, …). */
export interface LlmProvider {
  readonly name: AiProviderName;
  isConfigured(): boolean;
  complete(opts: CompleteOpts): Promise<CompletionResult>;
}
