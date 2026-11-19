import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import {
  AiProviderName,
  LLM_CALL_TIMEOUT_MS,
  ModelSpec,
  modelSpec,
  DEFAULT_TIER_MODELS,
} from '../ai.constants';
import {
  AgentCompleteOpts,
  AgentCompletionResult,
  CallTuning,
  CompleteOpts,
  CompletionResult,
  ImageInput,
  LlmProvider,
  NormalizedUsage,
  SystemBlock,
} from './llm-provider.interface';

/**
 * Anthropic backend. ONE platform key (env ANTHROPIC_API_KEY); cost is billed
 * back to tenants via metering. Stateless per call, never touches the DB.
 *
 * Model-aware request shaping (see ModelSpec in ai.constants):
 *  - temperature only for models that accept it (Haiku/Sonnet 5.5 reject a
 *    non-default value)
 *  - `output_config.effort` for models that support it (default 'low' — short
 *    WhatsApp replies don't need deep reasoning)
 *  - thinking switched off for plain tasks where the model allows it
 *  - assistant content (incl. thinking blocks) replayed VERBATIM inside a tool
 *    loop — required by the current models
 *  - `tool_choice: none` to force a text answer while tools stay declared
 *  - explicit per-request timeout + 1 SDK retry
 */
@Injectable()
export class AnthropicProvider implements LlmProvider {
  readonly name: AiProviderName = 'anthropic';
  private client: Anthropic | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return !!this.config.get<string>('ANTHROPIC_API_KEY');
  }

  private getClient(): Anthropic {
    if (this.client) return this.client;
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'Anthropic is not configured on this server.',
      );
    }
    this.client = new Anthropic({
      apiKey,
      timeout: LLM_CALL_TIMEOUT_MS,
      maxRetries: 1,
    });
    return this.client;
  }

  private spec(opts: CallTuning & { tier: 'fast' | 'smart' }): ModelSpec {
    return (
      opts.model ??
      modelSpec(DEFAULT_TIER_MODELS.anthropic[opts.tier], 'anthropic', opts.tier)
    );
  }

  private systemBlocks(blocks: SystemBlock[]): Anthropic.TextBlockParam[] {
    return blocks
      .filter((b) => b.text && b.text.trim())
      .map((b) => ({
        type: 'text',
        text: b.text,
        ...(b.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
      }));
  }

  private imageBlocks(images?: ImageInput[]): Anthropic.ImageBlockParam[] {
    return (images ?? []).map((img) => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mime as Anthropic.Base64ImageSource['media_type'],
        data: img.dataBase64,
      },
    }));
  }

  /**
   * Model-dependent request params (temperature / effort / thinking). Returned
   * as a loose record: newer params (`between_tools`) aren't in the installed
   * SDK's types yet, and the API is the authority.
   */
  private tuningParams(
    spec: ModelSpec,
    opts: CallTuning & { temperature?: number },
    agentic: boolean,
  ): Record<string, unknown> {
    const p: Record<string, unknown> = {};
    if (spec.temperature && typeof opts.temperature === 'number') {
      p.temperature = opts.temperature;
    }
    if (spec.effort) {
      p.output_config = { effort: opts.effort ?? 'low' };
    }
    // Thinking off only for plain (tool-less) tasks: with tools, disabling it
    // can make newer models write tool calls into visible text.
    if (!agentic && opts.thinking === 'off') {
      if (spec.thinkingOff === 'disabled') p.thinking = { type: 'disabled' };
      else if (spec.thinkingOff === 'between_tools')
        p.thinking = { type: 'between_tools' };
    }
    return p;
  }

  private usageOf(u: Anthropic.Usage | undefined): NormalizedUsage {
    return {
      inputTokens: u?.input_tokens ?? 0,
      outputTokens: u?.output_tokens ?? 0,
      cacheReadTokens: u?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
    };
  }

  async complete(opts: CompleteOpts): Promise<CompletionResult> {
    const spec = this.spec(opts);
    const client = this.getClient();

    const docs: Anthropic.DocumentBlockParam[] = (opts.documents ?? []).map((d) => ({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: d.dataBase64 },
    }));
    const userContent: Anthropic.MessageParam['content'] =
      (opts.images && opts.images.length) || docs.length
        ? [
            ...docs,
            ...this.imageBlocks(opts.images),
            { type: 'text', text: opts.userText },
          ]
        : opts.userText;

    const res = (await client.messages.create(
      {
        model: spec.id,
        // Thinking (when on) shares max_tokens with the answer — leave headroom.
        max_tokens: spec.effort ? Math.max(opts.maxTokens, 2048) : opts.maxTokens,
        system: this.systemBlocks(opts.system),
        messages: [{ role: 'user', content: userContent }],
        ...this.tuningParams(spec, opts, false),
      } as Anthropic.MessageCreateParamsNonStreaming,
      { timeout: opts.timeoutMs ?? LLM_CALL_TIMEOUT_MS },
    )) as Anthropic.Message;

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    return {
      text: res.stop_reason === 'refusal' ? '' : text,
      usage: this.usageOf(res.usage),
      modelId: spec.id,
      refused: res.stop_reason === 'refusal',
    };
  }

  async completeWithTools(
    opts: AgentCompleteOpts,
  ): Promise<AgentCompletionResult> {
    const spec = this.spec(opts);
    const client = this.getClient();

    let firstUser = true;
    const messages: Anthropic.MessageParam[] = opts.messages.map((m) => {
      if (m.role === 'user') {
        const imgs = firstUser ? this.imageBlocks(opts.images) : [];
        firstUser = false;
        return {
          role: 'user',
          content: imgs.length ? [...imgs, { type: 'text', text: m.text }] : m.text,
        };
      }
      if (m.role === 'assistant') {
        // Replay our own native content verbatim (keeps thinking blocks valid).
        if (m.raw && m.raw.provider === 'anthropic' && Array.isArray(m.raw.content)) {
          return {
            role: 'assistant',
            content: m.raw.content as Anthropic.ContentBlockParam[],
          };
        }
        const content: Anthropic.ContentBlockParam[] = [];
        if (m.text) content.push({ type: 'text', text: m.text });
        for (const tc of m.toolCalls ?? []) {
          content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
        }
        return { role: 'assistant', content };
      }
      return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
      };
    });
    // Consecutive tool results must arrive in ONE user turn (parallel calls).
    const merged: Anthropic.MessageParam[] = [];
    for (const msg of messages) {
      const prev = merged[merged.length - 1];
      const isToolResult =
        msg.role === 'user' &&
        Array.isArray(msg.content) &&
        msg.content.every((c) => (c as { type: string }).type === 'tool_result');
      const prevIsToolResult =
        prev &&
        prev.role === 'user' &&
        Array.isArray(prev.content) &&
        prev.content.every((c) => (c as { type: string }).type === 'tool_result');
      if (isToolResult && prevIsToolResult) {
        (prev.content as Anthropic.ContentBlockParam[]).push(
          ...(msg.content as Anthropic.ContentBlockParam[]),
        );
      } else {
        merged.push(msg);
      }
    }

    const tools: Anthropic.Tool[] = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));

    const res = (await client.messages.create(
      {
        model: spec.id,
        max_tokens: spec.effort ? Math.max(opts.maxTokens, 4096) : opts.maxTokens,
        system: this.systemBlocks(opts.system),
        messages: merged,
        ...(tools.length
          ? {
              tools,
              tool_choice:
                opts.toolChoice === 'none' ? { type: 'none' } : { type: 'auto' },
            }
          : {}),
        ...this.tuningParams(spec, opts, true),
      } as Anthropic.MessageCreateParamsNonStreaming,
      { timeout: opts.timeoutMs ?? LLM_CALL_TIMEOUT_MS },
    )) as Anthropic.Message;

    let text: string | null = null;
    const toolCalls: AgentCompletionResult['toolCalls'] = [];
    for (const block of res.content) {
      if (block.type === 'text') {
        text = (text ?? '') + block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }
    if (text) text = text.trim();
    const refused = res.stop_reason === 'refusal';

    return {
      text: refused ? null : text,
      toolCalls: refused ? [] : toolCalls,
      usage: this.usageOf(res.usage),
      modelId: spec.id,
      stop: !refused && res.stop_reason === 'tool_use' ? 'tool_use' : 'end',
      raw: { provider: 'anthropic', content: res.content },
      refused,
    };
  }
}
