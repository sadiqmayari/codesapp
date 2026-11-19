import { AiProviderName, ModelSpec, ModelTier } from '../ai.constants';

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
  /** The model declined (Anthropic `stop_reason: refusal`). Text is empty. */
  refused?: boolean;
}

/** Shared per-call knobs resolved by LlmService before a provider is called. */
export interface CallTuning {
  /** Resolved model (id + capabilities). Set by LlmService; callers pass tier. */
  model?: ModelSpec;
  /** Reasoning effort for models that support it (default 'low' = fast replies). */
  effort?: 'low' | 'medium' | 'high';
  /** 'off' = no extended thinking where the model allows it (plain tasks). */
  thinking?: 'auto' | 'off';
  /** Per-request timeout in ms (default LLM_CALL_TIMEOUT_MS). */
  timeoutMs?: number;
}

/** An inline image attached to the user turn (vision). Base64-encoded bytes. */
export interface ImageInput {
  /** MIME type, e.g. "image/jpeg", "image/png", "image/webp". */
  mime: string;
  /** Raw base64 (no data: prefix). */
  dataBase64: string;
}

export interface CompleteOpts extends CallTuning {
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
  /** Optional PDF documents (base64) — Anthropic only (knowledge import). */
  documents?: Array<{ mime: 'application/pdf'; dataBase64: string }>;
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
  | {
      role: 'assistant';
      text: string | null;
      toolCalls?: ToolCall[];
      /**
       * Provider-native content of this assistant turn (e.g. Anthropic content
       * blocks incl. thinking). Replayed verbatim by the SAME provider — newer
       * Claude models require thinking blocks to come back unchanged in a tool
       * loop. Other providers ignore it.
       */
      raw?: { provider: AiProviderName; content: unknown };
    }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface AgentCompleteOpts extends CallTuning {
  tier: ModelTier;
  system: SystemBlock[];
  messages: AgentMessage[];
  /** Tools the model may call. Omit/empty to force a plain text answer. */
  tools: ToolDef[];
  /** 'none' = tools stay declared (history may contain tool blocks) but the
   *  model must answer in text. Default 'auto'. */
  toolChoice?: 'auto' | 'none';
  maxTokens: number;
  temperature?: number;
  /** Optional inline images for the FIRST user turn (vision). */
  images?: ImageInput[];
}

export interface AgentCompletionResult {
  /** Assistant text (may be null when it only emitted tool calls). */
  text: string | null;
  toolCalls: ToolCall[];
  usage: NormalizedUsage;
  modelId: string;
  /** 'tool_use' → the caller must run the tools and continue; 'end' → final. */
  stop: 'tool_use' | 'end';
  /** Provider-native assistant content (replay in the next loop step). */
  raw?: { provider: AiProviderName; content: unknown };
  refused?: boolean;
}

/** A pluggable LLM backend (Anthropic, OpenAI, …). */
export interface LlmProvider {
  readonly name: AiProviderName;
  isConfigured(): boolean;
  complete(opts: CompleteOpts): Promise<CompletionResult>;
  /** Multi-turn tool-calling completion (agent loop). */
  completeWithTools(opts: AgentCompleteOpts): Promise<AgentCompletionResult>;
}
