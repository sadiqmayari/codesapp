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

// ── Tool calling (agent) ──────────────────────────────────────────────────

/** A tool the model may call. inputSchema is a JSON-schema object. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A model's request to call a tool. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** One turn of an agent conversation. */
export type AgentMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface AgentCompleteOpts {
  tier: ModelTier;
  system: SystemBlock[];
  messages: AgentMessage[];
  /** Tools the model may call. Omit/empty to force a plain text answer. */
  tools: ToolDef[];
  maxTokens: number;
  temperature?: number;
}

export interface AgentCompletionResult {
  /** Assistant text (may be null when it only emitted tool calls). */
  text: string | null;
  toolCalls: ToolCall[];
  usage: NormalizedUsage;
  modelId: string;
  /** 'tool_use' → the caller must run the tools and continue; 'end' → final. */
  stop: 'tool_use' | 'end';
}

/** A pluggable LLM backend (Anthropic, OpenAI, …). */
export interface LlmProvider {
  readonly name: AiProviderName;
  isConfigured(): boolean;
  complete(opts: CompleteOpts): Promise<CompletionResult>;
  /** Multi-turn tool-calling completion (agent loop). */
  completeWithTools(opts: AgentCompleteOpts): Promise<AgentCompletionResult>;
}
