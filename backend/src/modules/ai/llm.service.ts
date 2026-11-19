import { Injectable, Logger } from '@nestjs/common';
import { PlatformSettingService } from '../../common/services/platform-setting.service';
import {
  AI_FALLBACK_PROVIDER_KEY,
  AI_MODEL_KEY,
  AI_PROVIDER_DEFAULT,
  AI_PROVIDER_KEY,
  AiProviderName,
  DEFAULT_TIER_MODELS,
  ModelSpec,
  ModelTier,
  modelSpec,
} from './ai.constants';
import { AnthropicProvider } from './providers/anthropic.provider';
import { OpenAiProvider } from './providers/openai.provider';
import {
  AgentCompleteOpts,
  AgentCompletionResult,
  CompleteOpts,
  CompletionResult,
  LlmProvider,
} from './providers/llm-provider.interface';

export interface CompletionWithProvider extends CompletionResult {
  provider: AiProviderName;
  /** Wall-clock ms for the call (incl. a failover attempt). */
  latencyMs: number;
}

export interface AgentCompletionWithProvider extends AgentCompletionResult {
  provider: AiProviderName;
  latencyMs: number;
}

/**
 * Provider-agnostic LLM gateway — the ONLY entry point to a model.
 *
 *  - Active provider = platform setting `ai_provider` (super-admin).
 *  - Model per tier  = platform setting `ai_model_<provider>_<tier>`
 *    (defaults in DEFAULT_TIER_MODELS), so models can be upgraded without a
 *    deploy.
 *  - Failover: when `ai_fallback_provider` names a configured provider, a
 *    failed call is retried ONCE on it (same tier). A tool loop may therefore
 *    switch provider mid-loop; providers ignore each other's `raw` content.
 *
 * Results carry provider + model id so metering prices the call exactly.
 * Settings are cached 5 min per process (PlatformSettingService).
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly providers: Record<AiProviderName, LlmProvider>;

  constructor(
    private readonly platformSetting: PlatformSettingService,
    anthropic: AnthropicProvider,
    openai: OpenAiProvider,
  ) {
    this.providers = { anthropic, openai };
  }

  async getActiveProviderName(): Promise<AiProviderName> {
    const v = await this.platformSetting.get(AI_PROVIDER_KEY, AI_PROVIDER_DEFAULT);
    return v === 'openai' ? 'openai' : 'anthropic';
  }

  async getFallbackProviderName(): Promise<AiProviderName | null> {
    const v = await this.platformSetting.get(AI_FALLBACK_PROVIDER_KEY, 'none');
    if (v !== 'anthropic' && v !== 'openai') return null;
    return this.providers[v].isConfigured() ? v : null;
  }

  /** The live model spec for a provider tier (super-admin editable). */
  async modelFor(provider: AiProviderName, tier: ModelTier): Promise<ModelSpec> {
    const id = await this.platformSetting.get(
      AI_MODEL_KEY(provider, tier),
      DEFAULT_TIER_MODELS[provider][tier],
    );
    return modelSpec(id.trim() || DEFAULT_TIER_MODELS[provider][tier], provider, tier);
  }

  /** Is the currently-active provider's API key configured? */
  async isConfigured(): Promise<boolean> {
    const name = await this.getActiveProviderName();
    return this.providers[name].isConfigured();
  }

  /** Configured flag per provider (super-admin status display). */
  configuredProviders(): Record<AiProviderName, boolean> {
    return {
      anthropic: this.providers.anthropic.isConfigured(),
      openai: this.providers.openai.isConfigured(),
    };
  }

  async complete(opts: CompleteOpts): Promise<CompletionWithProvider> {
    return this.withFailover(async (name) => {
      const model = await this.modelFor(name, opts.tier);
      return this.providers[name].complete({ ...opts, model });
    });
  }

  async completeWithTools(
    opts: AgentCompleteOpts,
  ): Promise<AgentCompletionWithProvider> {
    return this.withFailover(async (name) => {
      const model = await this.modelFor(name, opts.tier);
      return this.providers[name].completeWithTools({ ...opts, model });
    });
  }

  private async withFailover<T>(
    call: (name: AiProviderName) => Promise<T>,
  ): Promise<T & { provider: AiProviderName; latencyMs: number }> {
    const started = Date.now();
    const primary = await this.getActiveProviderName();
    try {
      const r = await call(primary);
      return { ...r, provider: primary, latencyMs: Date.now() - started };
    } catch (e) {
      const fallback = await this.getFallbackProviderName();
      if (!fallback || fallback === primary) throw e;
      this.logger.warn(
        `LLM ${primary} failed (${e instanceof Error ? e.message : String(e)}) → failover to ${fallback}`,
      );
      const r = await call(fallback);
      return { ...r, provider: fallback, latencyMs: Date.now() - started };
    }
  }
}
