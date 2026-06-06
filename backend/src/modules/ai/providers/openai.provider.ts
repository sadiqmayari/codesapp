import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { AiProviderName, PROVIDER_MODELS } from '../ai.constants';
import {
  AgentCompleteOpts,
  AgentCompletionResult,
  CompleteOpts,
  CompletionResult,
  LlmProvider,
  NormalizedUsage,
} from './llm-provider.interface';

/**
 * OpenAI backend. ONE platform key (env OPENAI_API_KEY). System blocks are
 * concatenated into a single system message (OpenAI has no explicit prompt
 * caching — it auto-caches long prefixes; the `cache` flag is ignored).
 */
@Injectable()
export class OpenAiProvider implements LlmProvider {
  readonly name: AiProviderName = 'openai';
  private client: OpenAI | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return !!this.config.get<string>('OPENAI_API_KEY');
  }

  private getClient(): OpenAI {
    if (this.client) return this.client;
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'OpenAI is not configured on this server.',
      );
    }
    this.client = new OpenAI({ apiKey });
    return this.client;
  }

  async complete(opts: CompleteOpts): Promise<CompletionResult> {
    const model = PROVIDER_MODELS.openai[opts.tier];
    const client = this.getClient();

    const systemText = opts.system.map((b) => b.text).join('\n\n');

    // Vision: when images are supplied, send the user turn as content parts
    // (text + data-URI images). Otherwise keep the plain-string message.
    const userContent: OpenAI.Chat.ChatCompletionUserMessageParam['content'] =
      opts.images && opts.images.length
        ? [
            { type: 'text', text: opts.userText },
            ...opts.images.map(
              (img): OpenAI.Chat.ChatCompletionContentPartImage => ({
                type: 'image_url',
                image_url: {
                  url: `data:${img.mime};base64,${img.dataBase64}`,
                },
              }),
            ),
          ]
        : opts.userText;

    const res = await client.chat.completions.create({
      model: model.id,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0.4,
      messages: [
        { role: 'system', content: systemText },
        { role: 'user', content: userContent },
      ],
    });

    const text = (res.choices[0]?.message?.content ?? '').trim();

    const u = res.usage;
    const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
    const usage: NormalizedUsage = {
      inputTokens: Math.max((u?.prompt_tokens ?? 0) - cached, 0),
      outputTokens: u?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    };

    return { text, usage, modelId: model.id };
  }

  async completeWithTools(
    opts: AgentCompleteOpts,
  ): Promise<AgentCompletionResult> {
    const model = PROVIDER_MODELS.openai[opts.tier];
    const client = this.getClient();

    const systemText = opts.system.map((b) => b.text).join('\n\n');
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemText },
    ];
    for (const m of opts.messages) {
      if (m.role === 'user') {
        messages.push({ role: 'user', content: m.text });
      } else if (m.role === 'assistant') {
        const msg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: m.text ?? '',
        };
        if (m.toolCalls?.length) {
          msg.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          }));
        }
        messages.push(msg);
      } else {
        messages.push({
          role: 'tool',
          tool_call_id: m.toolCallId,
          content: m.content,
        });
      }
    }

    const tools: OpenAI.Chat.ChatCompletionTool[] = opts.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    const res = await client.chat.completions.create({
      model: model.id,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0.4,
      messages,
      ...(tools.length ? { tools } : {}),
    });

    const choice = res.choices[0]?.message;
    const text = (choice?.content ?? '').trim() || null;
    const toolCalls: AgentCompletionResult['toolCalls'] = [];
    for (const tc of choice?.tool_calls ?? []) {
      if (tc.type !== 'function') continue;
      let input: Record<string, unknown> = {};
      try {
        input = tc.function.arguments
          ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
          : {};
      } catch {
        input = {};
      }
      toolCalls.push({ id: tc.id, name: tc.function.name, input });
    }

    const u = res.usage;
    const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
    const usage: NormalizedUsage = {
      inputTokens: Math.max((u?.prompt_tokens ?? 0) - cached, 0),
      outputTokens: u?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    };

    return {
      text,
      toolCalls,
      usage,
      modelId: model.id,
      stop:
        res.choices[0]?.finish_reason === 'tool_calls' ? 'tool_use' : 'end',
    };
  }
}
