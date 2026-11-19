import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { EmbeddingService } from './embedding.service';
import { AiMeteringService } from './ai-metering.service';
import { PgVectorService, PgChunk } from './pgvector.service';
import {
  CHARS_PER_TOKEN,
  EMBEDDING_MICROS_PER_TOKEN,
  RAG_ABS_FLOOR,
  RAG_CHAR_BUDGET,
  RAG_REL_FLOOR,
  RAG_TOP_K,
} from './ai.constants';

export interface RagItem {
  sourceId: string;
  title: string;
  content: string;
}

/** One retrieved chunk (structured — the agent trace shows these as sources). */
export interface RagHit {
  title: string;
  content: string;
  sourceType: string;
  storeId: number;
  score: number;
}

export interface RetrieveOpts {
  topK?: number;
  maxChars?: number;
  /** Limit to this store's chunks + company-wide (store 0) chunks. */
  storeId?: number | null;
  /** Limit to these source types (e.g. ['product']). */
  types?: string[];
}

interface LoadedChunk {
  title: string;
  content: string;
  sourceType: string;
  storeId: number;
  vec: Float32Array;
}

/** 5-min in-process cache of a company's loaded chunk vectors. */
const CHUNK_CACHE_TTL = 300;

/** Strip lone UTF-16 surrogates (an emoji cut in half breaks Prisma params). */
function sanitizeText(s: string): string {
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .trim();
}

function base64ToFloat32(s: string): Float32Array {
  const buf = Buffer.from(s, 'base64');
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

/** Render hits as a compact context block within a char budget. */
export function renderHits(hits: RagHit[], maxChars: number): string {
  let out = '';
  for (const h of hits) {
    const block = `## ${h.title}\n${h.content}\n\n`;
    if (out.length + block.length > maxChars) break;
    out += block;
  }
  return out.trim();
}

/**
 * RAG index + retrieval, store-scoped (v2).
 *
 * Index: one embedded chunk per product / policy (per commerce STORE) and per
 * manual knowledge entry / FAQ / imported page (store 0 = company-wide), in
 * MariaDB `ai_knowledge_chunks` (always) + pgvector (when configured).
 *
 * Retrieval: pgvector hybrid search first, MariaDB in-process cosine fallback;
 * both filtered to (store, company-wide) when a store is given. Returns
 * STRUCTURED hits so the agent trace can show its sources.
 *
 * Fail-safe everywhere: no embeddings key / API error → indexing reports
 * `embedded:false` and retrieval returns [] (the reply still goes out).
 */
@Injectable()
export class AiRagService {
  private readonly logger = new Logger(AiRagService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly embeddings: EmbeddingService,
    private readonly metering: AiMeteringService,
    private readonly pg: PgVectorService,
  ) {}

  isConfigured(): boolean {
    return this.embeddings.isConfigured();
  }

  private cacheKey(companyId: number): string {
    return `rag:${companyId}`;
  }

  private bust(companyId: number): void {
    this.cache.del(this.cacheKey(companyId));
  }

  /** Company-wide index status (Settings → Knowledge banner). */
  async status(companyId: number): Promise<{
    configured: boolean;
    products: number;
    policies: number;
    manual: number;
    total: number;
    lastSyncedAt: string | null;
  }> {
    const rows = await this.prisma.$queryRaw<
      Array<{ source_type: string; n: bigint | number; last: Date | null }>
    >`SELECT source_type, COUNT(*) AS n, MAX(updated_at) AS last
        FROM ai_knowledge_chunks
        WHERE company_id = ${companyId}
        GROUP BY source_type`;
    let products = 0;
    let policies = 0;
    let manual = 0;
    let last: Date | null = null;
    for (const r of rows) {
      const n = Number(r.n);
      if (r.source_type === 'product') products += n;
      else if (r.source_type === 'policy') policies += n;
      else manual += n;
      if (r.last && (!last || r.last > last)) last = r.last;
    }
    return {
      configured: this.embeddings.isConfigured(),
      products,
      policies,
      manual,
      total: products + policies + manual,
      lastSyncedAt: last ? last.toISOString() : null,
    };
  }

  /** Per-store index status (Settings → Knowledge "by store" table). */
  async statusByStore(companyId: number): Promise<
    Array<{ storeId: number; products: number; policies: number; lastSyncedAt: string | null }>
  > {
    const rows = await this.prisma.$queryRaw<
      Array<{ store_id: number; source_type: string; n: bigint | number; last: Date | null }>
    >`SELECT store_id, source_type, COUNT(*) AS n, MAX(updated_at) AS last
        FROM ai_knowledge_chunks
        WHERE company_id = ${companyId} AND source_type IN ('product','policy')
        GROUP BY store_id, source_type`;
    const map = new Map<number, { products: number; policies: number; last: Date | null }>();
    for (const r of rows) {
      const sid = Number(r.store_id);
      const cur = map.get(sid) ?? { products: 0, policies: 0, last: null };
      if (r.source_type === 'product') cur.products = Number(r.n);
      else cur.policies = Number(r.n);
      if (r.last && (!cur.last || r.last > cur.last)) cur.last = r.last;
      map.set(sid, cur);
    }
    return Array.from(map.entries()).map(([storeId, v]) => ({
      storeId,
      products: v.products,
      policies: v.policies,
      lastSyncedAt: v.last ? v.last.toISOString() : null,
    }));
  }

  private clean(items: RagItem[]): RagItem[] {
    return items.map((it) => ({
      sourceId: sanitizeText(it.sourceId.slice(0, 191)),
      title: sanitizeText(it.title.slice(0, 255)),
      content: sanitizeText(it.content),
    }));
  }

  private async meterIndexing(companyId: number, items: RagItem[]): Promise<void> {
    const chars = items.reduce((s, i) => s + i.content.length, 0);
    const tokens = Math.ceil(chars / CHARS_PER_TOKEN);
    await this.metering.recordEmbedding(companyId, tokens, tokens * EMBEDDING_MICROS_PER_TOKEN);
  }

  /**
   * Replace ALL chunks of one (store, source_type) with `items` (re-embeds
   * everything). Atomic in MariaDB (single transaction) and pgvector, so
   * retrieval never sees a half-built index. When a real store (>0) syncs
   * products/policies, legacy store-0 rows of that type are removed too.
   * Gated: no indexing (and no embedding spend) while AI is blocked for the
   * tenant. On embedding failure NOTHING changes.
   */
  async indexSource(
    companyId: number,
    sourceType: string,
    items: RagItem[],
    storeId = 0,
  ): Promise<{ embedded: boolean; indexed: number; blocked?: string }> {
    if (!this.embeddings.isConfigured()) return { embedded: false, indexed: 0 };
    const blocked = await this.metering.blockReason(companyId);
    if (blocked) return { embedded: false, indexed: 0, blocked };

    const clean = this.clean(items);
    const vectors = clean.length ? await this.embeddings.embed(clean.map((i) => i.content)) : [];
    if (!vectors) return { embedded: false, indexed: 0 };

    let inserted = 0;
    let skipped = 0;
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          DELETE FROM ai_knowledge_chunks
          WHERE company_id = ${companyId} AND source_type = ${sourceType}
            AND (store_id = ${storeId}
                 OR (${storeId} > 0 AND store_id = 0 AND source_type IN ('product','policy')))`;
        for (let i = 0; i < clean.length; i++) {
          const it = clean[i];
          const vec = vectors[i];
          if (!vec) continue;
          try {
            // Raw SQL on purpose: immune to Prisma client/column drift on the
            // base64 `embedding` text column. MySQL does not abort the
            // transaction on a failed statement, so one bad row is skipped.
            await tx.$executeRaw`
              INSERT INTO ai_knowledge_chunks
                (company_id, store_id, source_type, source_id, title, content, embedding, dim, created_at, updated_at)
              VALUES (${companyId}, ${storeId}, ${sourceType}, ${it.sourceId}, ${it.title},
                      ${it.content}, ${float32ToBase64(vec)}, ${vec.length}, NOW(3), NOW(3))
              ON DUPLICATE KEY UPDATE title = VALUES(title), content = VALUES(content),
                embedding = VALUES(embedding), dim = VALUES(dim), updated_at = NOW(3)`;
            inserted++;
          } catch (e) {
            skipped++;
            this.logger.warn(
              `Skipped chunk ${sourceType}/${it.sourceId} for company ${companyId}: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        }
      },
      { timeout: 180_000, maxWait: 20_000 },
    );
    if (skipped) {
      this.logger.warn(
        `indexSource(${sourceType}, store ${storeId}) company ${companyId}: inserted ${inserted}, skipped ${skipped}`,
      );
    }

    const pgRows: PgChunk[] = [];
    clean.forEach((c, i) => {
      if (vectors[i]) pgRows.push({ ...c, embedding: vectors[i] });
    });
    await this.pg.replaceSource(companyId, storeId, sourceType, pgRows);

    if (clean.length) await this.meterIndexing(companyId, clean);
    this.bust(companyId);
    return { embedded: true, indexed: inserted };
  }

  /** Upsert ONE chunk (incremental webhook update / manual entry save). */
  async upsertOne(
    companyId: number,
    sourceType: string,
    item: RagItem,
    storeId = 0,
  ): Promise<boolean> {
    if (!this.embeddings.isConfigured()) return false;
    if (await this.metering.blockReason(companyId)) return false;
    const [it] = this.clean([item]);
    const vecs = await this.embeddings.embed([it.content]);
    const vec = vecs?.[0];
    if (!vec) return false;
    await this.prisma.$executeRaw`
      INSERT INTO ai_knowledge_chunks
        (company_id, store_id, source_type, source_id, title, content, embedding, dim, created_at, updated_at)
      VALUES (${companyId}, ${storeId}, ${sourceType}, ${it.sourceId}, ${it.title},
              ${it.content}, ${float32ToBase64(vec)}, ${vec.length}, NOW(3), NOW(3))
      ON DUPLICATE KEY UPDATE title = VALUES(title), content = VALUES(content),
        embedding = VALUES(embedding), dim = VALUES(dim), updated_at = NOW(3)`;
    await this.pg.upsertOne(companyId, storeId, sourceType, { ...it, embedding: vec });
    await this.meterIndexing(companyId, [it]);
    this.bust(companyId);
    return true;
  }

  /**
   * Replace every chunk whose source_id starts with `prefix` (one manual entry
   * split into parts) with `items`. Empty items = delete. Store 0. Gated.
   */
  async replaceEntry(
    companyId: number,
    sourceType: string,
    prefix: string,
    items: RagItem[],
  ): Promise<boolean> {
    const like = `${prefix}%`;
    const del = async () => {
      await this.prisma.$executeRaw`
        DELETE FROM ai_knowledge_chunks
        WHERE company_id = ${companyId} AND store_id = 0
          AND source_type = ${sourceType} AND source_id LIKE ${like}`;
    };
    if (!items.length) {
      await del();
      for (let i = 0; i < 50; i++) {
        await this.pg.deleteOne(companyId, 0, sourceType, `${prefix}${i}`);
      }
      this.bust(companyId);
      return true;
    }
    if (!this.embeddings.isConfigured()) return false;
    if (await this.metering.blockReason(companyId)) return false;
    const clean = this.clean(items);
    const vecs = await this.embeddings.embed(clean.map((c) => c.content));
    if (!vecs) return false;
    await del();
    for (let i = 0; i < 50; i++) {
      await this.pg.deleteOne(companyId, 0, sourceType, `${prefix}${i}`);
    }
    for (let i = 0; i < clean.length; i++) {
      const it = clean[i];
      const vec = vecs[i];
      if (!vec) continue;
      await this.prisma.$executeRaw`
        INSERT INTO ai_knowledge_chunks
          (company_id, store_id, source_type, source_id, title, content, embedding, dim, created_at, updated_at)
        VALUES (${companyId}, 0, ${sourceType}, ${it.sourceId}, ${it.title},
                ${it.content}, ${float32ToBase64(vec)}, ${vec.length}, NOW(3), NOW(3))
        ON DUPLICATE KEY UPDATE title = VALUES(title), content = VALUES(content),
          embedding = VALUES(embedding), dim = VALUES(dim), updated_at = NOW(3)`;
      await this.pg.upsertOne(companyId, 0, sourceType, { ...it, embedding: vec });
    }
    await this.meterIndexing(companyId, clean);
    this.bust(companyId);
    return true;
  }

  /** Delete ONE chunk (product deleted/archived, manual entry removed). */
  async deleteOne(
    companyId: number,
    sourceType: string,
    sourceId: string,
    storeId = 0,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM ai_knowledge_chunks
      WHERE company_id = ${companyId} AND store_id = ${storeId}
        AND source_type = ${sourceType} AND source_id = ${sourceId}`;
    await this.pg.deleteOne(companyId, storeId, sourceType, sourceId);
    this.bust(companyId);
  }

  /** Remove chunks (a whole company, one type, or one store). */
  async clear(companyId: number, sourceType?: string, storeId?: number): Promise<void> {
    await this.prisma.aiKnowledgeChunk.deleteMany({
      where: {
        company_id: companyId,
        ...(sourceType ? { source_type: sourceType } : {}),
        ...(storeId !== undefined ? { store_id: storeId } : {}),
      },
    });
    await this.pg.clear(companyId, sourceType, storeId);
    this.bust(companyId);
  }

  private async loadChunks(companyId: number): Promise<LoadedChunk[]> {
    const cached = this.cache.get<LoadedChunk[]>(this.cacheKey(companyId));
    if (cached) return cached;
    const rows = await this.prisma.$queryRaw<
      Array<{
        title: string;
        content: string;
        source_type: string;
        store_id: number;
        embedding: string;
        dim: number;
      }>
    >`SELECT title, content, source_type, store_id, embedding, dim
        FROM ai_knowledge_chunks
        WHERE company_id = ${companyId}`;
    const loaded: LoadedChunk[] = [];
    for (const r of rows) {
      let vec: Float32Array;
      try {
        vec = base64ToFloat32(r.embedding);
      } catch {
        continue;
      }
      if (vec.length === 0 || (r.dim > 0 && vec.length !== r.dim)) continue;
      loaded.push({
        title: r.title,
        content: r.content,
        sourceType: r.source_type,
        storeId: Number(r.store_id),
        vec,
      });
    }
    this.cache.set(this.cacheKey(companyId), loaded, CHUNK_CACHE_TTL);
    return loaded;
  }

  /**
   * Retrieve the most relevant chunks as STRUCTURED hits ([] when RAG is
   * unavailable / nothing relevant). The query embedding is metered (cached
   * repeats are free).
   */
  async retrieveHits(
    companyId: number,
    query: string,
    opts: RetrieveOpts = {},
  ): Promise<RagHit[]> {
    if (!this.embeddings.isConfigured()) return [];
    const q = (query || '').trim();
    if (!q) return [];
    const topK = opts.topK ?? RAG_TOP_K;

    const emb = await this.embeddings.embedQuery(q);
    if (!emb) return [];
    if (emb.fresh) {
      const tokens = Math.ceil(q.length / CHARS_PER_TOKEN);
      void this.metering.recordEmbedding(companyId, tokens, tokens * EMBEDDING_MICROS_PER_TOKEN);
    }
    const qvec = emb.vec;

    if (this.pg.enabled()) {
      const hits = await this.pg.searchHybrid(companyId, qvec, q, topK, {
        storeId: opts.storeId,
        types: opts.types,
      });
      if (hits.length) {
        return hits.map((h) => ({
          title: h.title,
          content: h.content,
          sourceType: h.sourceType,
          storeId: h.storeId,
          score: h.distance === null ? h.score : 1 - h.distance,
        }));
      }
    }

    let chunks: LoadedChunk[];
    try {
      chunks = await this.loadChunks(companyId);
    } catch (e) {
      this.logger.warn(
        `RAG load failed for company ${companyId}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return [];
    }
    const store = opts.storeId && opts.storeId > 0 ? opts.storeId : null;
    const pool = chunks.filter(
      (c) =>
        (store === null || c.storeId === 0 || c.storeId === store) &&
        (!opts.types?.length || opts.types.includes(c.sourceType)),
    );
    if (!pool.length) return [];
    const ranked = pool
      .map((c) => ({ c, score: cosine(qvec, c.vec) }))
      .sort((a, b) => b.score - a.score);
    // Relevance gate: keep the best hit, drop the tail far below it or weak in
    // absolute terms (stops unrelated/other-brand products being injected).
    const topScore = ranked[0]?.score ?? 0;
    if (topScore < RAG_ABS_FLOOR) return [];
    const cutoff = Math.max(topScore * RAG_REL_FLOOR, RAG_ABS_FLOOR);
    return ranked
      .filter((r, i) => i === 0 || r.score >= cutoff)
      .slice(0, topK)
      .map(({ c, score }) => ({
        title: c.title,
        content: c.content,
        sourceType: c.sourceType,
        storeId: c.storeId,
        score,
      }));
  }

  /** Back-compat: retrieval as a compact context string (null when empty). */
  async retrieve(
    companyId: number,
    query: string,
    opts: RetrieveOpts = {},
  ): Promise<string | null> {
    const hits = await this.retrieveHits(companyId, query, opts);
    if (!hits.length) return null;
    return renderHits(hits, opts.maxChars ?? RAG_CHAR_BUDGET) || null;
  }
}
