import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { EMBEDDING_MODEL } from './ai.constants';

/**
 * Text embeddings via OpenAI (`text-embedding-3-small`). Used by the RAG index
 * + retrieval. Independent of the active TEXT provider (Anthropic has no
 * embeddings API in this abstraction), so it reads OPENAI_API_KEY directly.
 *
 * Fail-safe: if the key is missing or anything throws, returns null and the
 * caller falls back to whole-knowledge-base injection — RAG never breaks the
 * AI flow.
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private client: OpenAI | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return !!this.config.get<string>('OPENAI_API_KEY');
  }

  private getClient(): OpenAI | null {
    if (this.client) return this.client;
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) return null;
    this.client = new OpenAI({ apiKey });
    return this.client;
  }

  /**
   * Embed a batch of texts. Returns one Float32Array per input (same order),
   * or null on any failure / missing key. Batches in chunks of 96 to stay well
   * within request limits.
   */
  async embed(texts: string[]): Promise<Float32Array[] | null> {
    const client = this.getClient();
    if (!client) return null;
    if (texts.length === 0) return [];
    const out: Float32Array[] = [];
    const BATCH = 96;
    try {
      for (let i = 0; i < texts.length; i += BATCH) {
        const slice = texts
          .slice(i, i + BATCH)
          // OpenAI rejects empty strings; substitute a single space.
          .map((t) => (t && t.trim() ? t.slice(0, 8000) : ' '));
        const res = await client.embeddings.create({
          model: EMBEDDING_MODEL,
          input: slice,
        });
        for (const d of res.data) out.push(Float32Array.from(d.embedding));
      }
      return out;
    } catch (e) {
      this.logger.warn(
        `Embedding failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  /** Embed a single text. Returns null on failure. */
  async embedOne(text: string): Promise<Float32Array | null> {
    const res = await this.embed([text]);
    return res && res[0] ? res[0] : null;
  }

  /** Small in-process LRU of recent QUERY vectors (10 min) — the same
   *  question in a chat (or across retries) is embedded + billed once. */
  private readonly queryCache = new Map<string, { at: number; vec: Float32Array }>();

  /**
   * Embed a retrieval query with caching. `fresh` = true when an API call was
   * made (the caller meters it); false on a cache hit.
   */
  async embedQuery(
    text: string,
  ): Promise<{ vec: Float32Array; fresh: boolean } | null> {
    const key = text.trim().toLowerCase().slice(0, 2000);
    const hit = this.queryCache.get(key);
    if (hit && Date.now() - hit.at < 600_000) {
      this.queryCache.delete(key);
      this.queryCache.set(key, hit); // refresh LRU order
      return { vec: hit.vec, fresh: false };
    }
    const vec = await this.embedOne(text);
    if (!vec) return null;
    this.queryCache.set(key, { at: Date.now(), vec });
    if (this.queryCache.size > 500) {
      const oldest = this.queryCache.keys().next().value;
      if (oldest !== undefined) this.queryCache.delete(oldest);
    }
    return { vec, fresh: true };
  }
}
