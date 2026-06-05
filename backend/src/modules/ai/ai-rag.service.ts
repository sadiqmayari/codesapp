import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { EmbeddingService } from './embedding.service';
import { AiMeteringService } from './ai-metering.service';
import {
  CHARS_PER_TOKEN,
  EMBEDDING_MICROS_PER_TOKEN,
  RAG_CHAR_BUDGET,
  RAG_TOP_K,
} from './ai.constants';

export interface RagItem {
  sourceId: string;
  title: string;
  content: string;
}

interface LoadedChunk {
  title: string;
  content: string;
  vec: Float32Array;
}

/** 5-min in-process cache of a company's loaded chunk vectors. */
const CHUNK_CACHE_TTL = 300;

/**
 * Strip lone UTF-16 surrogates (e.g. an emoji cut in half by a .slice()) and
 * trim. A lone surrogate breaks Prisma's parameter serialization with
 * "unexpected end of hex escape", failing the whole insert.
 */
function sanitizeText(s: string): string {
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .trim();
}

function base64ToFloat32(s: string): Float32Array {
  const buf = Buffer.from(s, 'base64');
  // Copy into an aligned, exactly-sized ArrayBuffer.
  return new Float32Array(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
}

function float32ToBase64(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
}

function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * RAG index + retrieval. Stores one embedded chunk per product/policy in
 * `ai_knowledge_chunks`; at query time embeds the question, scores all the
 * tenant's chunks by cosine similarity in-process, and returns only the top
 * few as a compact context string. Tenant-scoped throughout.
 *
 * Everything is fail-safe: if embeddings are unavailable (no OPENAI_API_KEY or
 * an API error) indexing reports `embedded:false` (the caller falls back to
 * whole-KB injection) and retrieval returns null.
 */
@Injectable()
export class AiRagService {
  private readonly logger = new Logger(AiRagService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly embeddings: EmbeddingService,
    private readonly metering: AiMeteringService,
  ) {}

  isConfigured(): boolean {
    return this.embeddings.isConfigured();
  }

  private cacheKey(companyId: number): string {
    return `rag:${companyId}`;
  }

  /**
   * Replace ALL chunks of one source_type for a company with the given items
   * (re-embeds everything). Returns whether embeddings succeeded + the count.
   * On embedding failure NOTHING is changed (the existing index is preserved).
   */
  async indexSource(
    companyId: number,
    sourceType: string,
    items: RagItem[],
  ): Promise<{ embedded: boolean; indexed: number }> {
    if (!this.embeddings.isConfigured()) {
      return { embedded: false, indexed: 0 };
    }
    if (items.length === 0) {
      await this.prisma.$executeRaw`
        DELETE FROM ai_knowledge_chunks
        WHERE company_id = ${companyId} AND source_type = ${sourceType}`;
      this.cache.del(this.cacheKey(companyId));
      return { embedded: true, indexed: 0 };
    }

    // Slice THEN sanitize so a cut-in-half emoji (lone surrogate) can't reach
    // the embedder or the SQL parameter serializer.
    const clean = items.map((it) => ({
      sourceId: sanitizeText(it.sourceId.slice(0, 191)),
      title: sanitizeText(it.title.slice(0, 255)),
      content: sanitizeText(it.content),
    }));

    const vectors = await this.embeddings.embed(clean.map((i) => i.content));
    if (!vectors) return { embedded: false, indexed: 0 };

    // Replace the whole source_type set (delete then insert). Writes go through
    // RAW SQL on purpose: passing the embedding through the typed Prisma client
    // tripped "unexpected end of hex escape" whenever the deployed client was
    // out of sync with the column type. Raw SQL is immune to client/column drift.
    await this.prisma.$executeRaw`
      DELETE FROM ai_knowledge_chunks
      WHERE company_id = ${companyId} AND source_type = ${sourceType}`;
    let inserted = 0;
    let skipped = 0;
    for (let i = 0; i < clean.length; i++) {
      const it = clean[i];
      const vec = vectors[i];
      if (!vec) continue;
      try {
        await this.prisma.$executeRaw`
          INSERT INTO ai_knowledge_chunks
            (company_id, source_type, source_id, title, content, embedding, dim, created_at, updated_at)
          VALUES (
            ${companyId},
            ${sourceType},
            ${it.sourceId},
            ${it.title},
            ${it.content},
            ${float32ToBase64(vec)},
            ${vec.length},
            NOW(3),
            NOW(3)
          )`;
        inserted++;
      } catch (e) {
        // One unusual row must NEVER abort the whole sync — skip and log it so
        // the remaining products still get indexed.
        skipped++;
        this.logger.warn(
          `Skipped chunk ${sourceType}/${it.sourceId} for company ${companyId}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    if (skipped > 0) {
      this.logger.warn(
        `indexSource(${sourceType}) company ${companyId}: inserted ${inserted}, skipped ${skipped}`,
      );
    }

    // Meter the indexing embedding cost (best-effort).
    const chars = clean.reduce((s, i) => s + i.content.length, 0);
    const tokens = Math.ceil(chars / CHARS_PER_TOKEN);
    await this.metering.recordEmbedding(
      companyId,
      tokens,
      tokens * EMBEDDING_MICROS_PER_TOKEN,
    );

    this.cache.del(this.cacheKey(companyId));
    return { embedded: true, indexed: inserted };
  }

  /** Remove every chunk for a company (e.g. when disconnecting Shopify). */
  async clear(companyId: number, sourceType?: string): Promise<void> {
    await this.prisma.aiKnowledgeChunk.deleteMany({
      where: {
        company_id: companyId,
        ...(sourceType ? { source_type: sourceType } : {}),
      },
    });
    this.cache.del(this.cacheKey(companyId));
  }

  private async loadChunks(companyId: number): Promise<LoadedChunk[]> {
    const cached = this.cache.get<LoadedChunk[]>(this.cacheKey(companyId));
    if (cached) return cached;
    // Raw SQL read (mirrors the raw write) so retrieval is immune to a stale
    // Prisma client mapping `embedding` as Bytes vs text.
    const rows = await this.prisma.$queryRaw<
      Array<{ title: string; content: string; embedding: string; dim: number }>
    >`SELECT title, content, embedding, dim
        FROM ai_knowledge_chunks
        WHERE company_id = ${companyId}`;
    const loaded: LoadedChunk[] = [];
    for (const r of rows) {
      let vec: Float32Array;
      try {
        vec = base64ToFloat32(r.embedding);
      } catch {
        continue; // skip an unreadable embedding
      }
      // Drop corrupt rows (e.g. legacy binary rows mangled by the text
      // conversion): empty, or length not matching the recorded dim.
      if (vec.length === 0 || (r.dim > 0 && vec.length !== r.dim)) continue;
      loaded.push({ title: r.title, content: r.content, vec });
    }
    this.cache.set(this.cacheKey(companyId), loaded, CHUNK_CACHE_TTL);
    return loaded;
  }

  /**
   * Retrieve the most relevant chunks for a query as a compact context string,
   * or null when RAG is unavailable / there are no chunks. Does NOT meter the
   * tiny per-query embedding (negligible cost, avoids a DB write per AI call).
   */
  async retrieve(
    companyId: number,
    query: string,
    opts?: { topK?: number; maxChars?: number },
  ): Promise<string | null> {
    if (!this.embeddings.isConfigured()) return null;
    const q = (query || '').trim();
    if (!q) return null;

    let chunks: LoadedChunk[];
    try {
      chunks = await this.loadChunks(companyId);
    } catch (e) {
      this.logger.warn(
        `RAG load failed for company ${companyId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return null;
    }
    if (chunks.length === 0) return null;

    const qvec = await this.embeddings.embedOne(q);
    if (!qvec) return null;

    const topK = opts?.topK ?? RAG_TOP_K;
    const maxChars = opts?.maxChars ?? RAG_CHAR_BUDGET;

    const scored = chunks
      .map((c) => ({ c, score: cosine(qvec, c.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    let out = '';
    for (const { c } of scored) {
      const block = `## ${c.title}\n${c.content}\n\n`;
      if (out.length + block.length > maxChars) break;
      out += block;
    }
    return out.trim() || null;
  }
}
