import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { MODELS, ModelTier } from './ai.constants';

/** A system-prompt block; `cache: true` marks it for prompt caching. */
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

/**
 * Thin wrapper around the Anthropic SDK. Holds ONE platform API key
 * (env ANTHROPIC_API_KEY) — costs are billed back to tenants via metering.
 *
 * Stateless per call; never touches the DB (so it never holds the single
 * Prisma connection across a slow model call). Throws 503 when the key is
 * not configured — the same posture as the encryption-placeholder guard.
 */
@Injectable()
export class AnthropicClientService {
  private readonly logger = new Logger(AnthropicClientService.name);
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
        'AI is not configured on this server.',
      );
    }
    this.client = new Anthropic({ apiKey });
    return this.client;
  }

  /**
   * Run a single non-streaming completion. `system` blocks flagged
   * `cache: true` get a `cache_control` breakpoint (prompt caching).
   */
  async complete(opts: {
    tier: ModelTier;
    system: SystemBlock[];
    messages: Anthropic.MessageParam[];
    maxTokens: number;
    temperature?: number;
  }): Promise<CompletionResult> {
    const model = MODELS[opts.tier];
    const client = this.getClient();

    const system: Anthropic.TextBlockParam[] = opts.system.map((b) => ({
      type: 'text',
      text: b.text,
      ...(b.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }));

    const res = await client.messages.create({
      model: model.id,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0.4,
      system,
      messages: opts.messages,
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
