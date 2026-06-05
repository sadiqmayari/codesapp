import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { AiProviderName, PROVIDER_MODELS } from '../ai.constants';
import {
  CompleteOpts,
  CompletionResult,
  LlmProvider,
  NormalizedUsage,
} from './llm-provider.interface';

/**
 * Anthropic backend. ONE platform key (env ANTHROPIC_API_KEY); cost is billed
 * back to tenants via metering. Stateless per call, never touches the DB.
 * Supports explicit prompt caching on system blocks flagged `cache: true`.
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
    this.client = new Anthropic({ apiKey });
    return this.client;
  }

  async complete(opts: CompleteOpts): Promise<CompletionResult> {
    const model = PROVIDER_MODELS.anthropic[opts.tier];
    const client = this.getClient();

    const system: Anthropic.TextBlockParam[] = opts.system.map((b) => ({
      type: 'text',
      text: b.text,
      ...(b.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }));

    // Vision: when images are supplied, send a content array (images first,
    // then the text turn). Otherwise keep the plain-string single user message.
    const userContent: Anthropic.MessageParam['content'] =
      opts.images && opts.images.length
        ? [
            ...opts.images.map(
              (img): Anthropic.ImageBlockParam => ({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: img.mime as Anthropic.Base64ImageSource['media_type'],
                  data: img.dataBase64,
                },
              }),
            ),
            { type: 'text', text: opts.userText },
          ]
        : opts.userText;

    const res = await client.messages.create({
      model: model.id,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0.4,
      system,
      messages: [{ role: 'user', content: userContent }],
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    const u = res.usage;
    const usage: NormalizedUsage = {
      inputTokens: u?.input_tokens ?? 0,
      outputTokens: u?.output_tokens ?? 0,
      cacheReadTokens: u?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
    };

    return { text, usage, modelId: model.id };
  }
}
