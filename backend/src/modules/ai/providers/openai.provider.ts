import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { AiProviderName, PROVIDER_MODELS } from '../ai.constants';
import {
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

    const res = await client.chat.completions.create({
      model: model.id,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0.4,
      messages: [
        { role: 'system', content: systemText },
        { role: 'user', content: opts.userText },
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
}
