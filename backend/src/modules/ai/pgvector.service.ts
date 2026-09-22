import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { EMBEDDING_DIM } from './ai.constants';

/**
 * Postgres + pgvector knowledge store — the Phase-1 retrieval upgrade.
 *
 * Holds one embedded chunk per product/policy per tenant with a real
 * `vector(1536)` column (HNSW index) AND a `tsvector` keyword column, so
 * retrieval is HYBRID (semantic vector recall fused with exact keyword search
 * via Reciprocal Rank Fusion) instead of the old pure in-process cosine.
 *
 * EVERYTHING here is fail-safe. If `PGVECTOR_URL` is unset, the container is
 * unreachable, or bootstrap fails, the service simply reports `enabled=false`
 * and `AiRagService` transparently falls back to the existing MariaDB base64
 * cosine path — a Postgres problem must NEVER break an AI reply.
 */

export interface PgChunk {
  sourceId: string;
  title: string;
  content: string;
  embedding: Float32Array;
  variantId?: string | null;
  price?: number | null;
  pack?: string | null;
  sku?: string | null;
  inStock?: boolean | null;
}

export interface PgHit {
  title: string;
  content: string;
  score: number;
}

/** RRF constant — dampens the contribution of lower-ranked hits. */
const RRF_K = 60;

@Injectable()
export class PgVectorService implements OnModuleInit {
  private readonly logger = new Logger(PgVectorService.name);
  private pool: Pool | null = null;
  private ready = false;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const url = this.config.get<string>('PGVECTOR_URL');
    if (!url) {
      this.logger.log('PGVECTOR_URL not set — pgvector store disabled (using MariaDB RAG fallback).');
      return;
    }
    try {
      this.pool = new Pool({
        connectionString: url,
        max: 4,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      });
      await this.bootstrap();
      this.ready = true;
      this.logger.log('pgvector store connected + schema ready.');
    } catch (e) {
      this.ready = false;
      this.logger.warn(
        `pgvector unavailable — falling back to MariaDB RAG. ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  enabled(): boolean {
    return this.ready && this.pool !== null;
  }

  /** Create the extension, table and indexes (idempotent). */
  private async bootstrap(): Promise<void> {
    if (!this.pool) return;
    await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id          bigserial PRIMARY KEY,
        company_id  integer NOT NULL,
        source_type text NOT NULL,
        source_id   text NOT NULL,
        variant_id  text,
        title       text NOT NULL,
        content     text NOT NULL,
        pack        text,
        sku         text,
        price       numeric,
        in_stock    boolean,
        embedding   vector(${EMBEDDING_DIM}),
        tsv         tsvector GENERATED ALWAYS AS (
                      to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(content,''))
                    ) STORED,
        updated_at  timestamptz DEFAULT now(),
        UNIQUE (company_id, source_type, source_id)
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS knowledge_chunks_embed_idx
         ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS knowledge_chunks_tsv_idx
         ON knowledge_chunks USING gin (tsv)`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS knowledge_chunks_company_idx
         ON knowledge_chunks (company_id)`,
    );
  }

  private static vec(v: Float32Array): string {
    // pgvector text input format: "[1,2,3]".
    return `[${Array.from(v).join(',')}]`;
  }

  /**
   * Replace ALL chunks of one source_type for a company (delete then insert),
   * mirroring AiRagService.indexSource's semantics. Best-effort — never throws.
   */
  async replaceSource(
    companyId: number,
    sourceType: string,
    rows: PgChunk[],
  ): Promise<boolean> {
    if (!this.enabled() || !this.pool) return false;
    const client = await this.pool.connect().catch(() => null);
    if (!client) return false;
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM knowledge_chunks WHERE company_id = $1 AND source_type = $2',
        [companyId, sourceType],
      );
      for (const r of rows) {
        if (!r.embedding || r.embedding.length !== EMBEDDING_DIM) continue;
        await client
          .query(
            `INSERT INTO knowledge_chunks
               (company_id, source_type, source_id, variant_id, title, content,
                pack, sku, price, in_stock, embedding, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector, now())
             ON CONFLICT (company_id, source_type, source_id)
             DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content,
               variant_id = EXCLUDED.variant_id, pack = EXCLUDED.pack,
               sku = EXCLUDED.sku, price = EXCLUDED.price,
               in_stock = EXCLUDED.in_stock, embedding = EXCLUDED.embedding,
               updated_at = now()`,
            [
              companyId,
              sourceType,
              r.sourceId.slice(0, 191),
              r.variantId ?? null,
              r.title.slice(0, 255),
              r.content,
              r.pack ?? null,
              r.sku ?? null,
              r.price ?? null,
              r.inStock ?? null,
              PgVectorService.vec(r.embedding),
            ],
          )
          .catch((e) => {
            this.logger.warn(
              `pgvector insert skipped ${sourceType}/${r.sourceId} (company ${companyId}): ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          });
      }
      await client.query('COMMIT');
      return true;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.logger.warn(
        `pgvector replaceSource failed (company ${companyId}, ${sourceType}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return false;
    } finally {
      client.release();
    }
  }

  /** How many chunks a company has (0 when disabled / on error). */
  async count(companyId: number): Promise<number> {
    if (!this.enabled() || !this.pool) return 0;
    try {
      const r = await this.pool.query<{ n: string }>(
        'SELECT COUNT(*)::text AS n FROM knowledge_chunks WHERE company_id = $1',
        [companyId],
      );
      return Number(r.rows[0]?.n ?? 0);
    } catch {
      return 0;
    }
  }

  /**
   * Hybrid search: vector cosine recall fused with keyword (tsvector) search via
   * Reciprocal Rank Fusion. Returns [] when disabled or on any error (caller
   * falls back). `queryText` drives the keyword arm; when it matches nothing the
   * result is effectively pure vector.
   */
  async searchHybrid(
    companyId: number,
    embedding: Float32Array,
    queryText: string,
    topK: number,
    pool = 40,
    // Absolute cosine-DISTANCE floor for the vector arm (distance = 1 - cosine
    // similarity). Drops clearly-unrelated hits so an off-topic query (e.g. a
    // greeting or the customer's own name) returns nothing rather than random
    // products. The keyword arm is unaffected (an exact keyword match is relevant).
    maxDistance = 0.8,
  ): Promise<PgHit[]> {
    if (!this.enabled() || !this.pool) return [];
    if (!embedding || embedding.length !== EMBEDDING_DIM) return [];
    try {
      const res = await this.pool.query<{ title: string; content: string; score: number }>(
        `
        WITH v AS (
          SELECT id, title, content,
                 ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
          FROM knowledge_chunks
          WHERE company_id = $2 AND embedding IS NOT NULL
            AND (embedding <=> $1::vector) < $7
          ORDER BY embedding <=> $1::vector
          LIMIT $4
        ),
        k AS (
          SELECT id, title, content,
                 ROW_NUMBER() OVER (
                   ORDER BY ts_rank(tsv, plainto_tsquery('simple', $3)) DESC
                 ) AS rank
          FROM knowledge_chunks
          WHERE company_id = $2 AND tsv @@ plainto_tsquery('simple', $3)
          ORDER BY ts_rank(tsv, plainto_tsquery('simple', $3)) DESC
          LIMIT $4
        )
        SELECT COALESCE(v.title, k.title) AS title,
               COALESCE(v.content, k.content) AS content,
               (COALESCE(1.0 / ($5 + v.rank), 0) + COALESCE(1.0 / ($5 + k.rank), 0)) AS score
        FROM v FULL OUTER JOIN k ON v.id = k.id
        ORDER BY score DESC
        LIMIT $6
        `,
        [
          PgVectorService.vec(embedding),
          companyId,
          queryText || '',
          pool,
          RRF_K,
          topK,
          maxDistance,
        ],
      );
      return res.rows.map((r) => ({
        title: r.title,
        content: r.content,
        score: Number(r.score),
      }));
    } catch (e) {
      this.logger.warn(
        `pgvector searchHybrid failed (company ${companyId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return [];
    }
  }

  async clear(companyId: number, sourceType?: string): Promise<void> {
    if (!this.enabled() || !this.pool) return;
    try {
      if (sourceType) {
        await this.pool.query(
          'DELETE FROM knowledge_chunks WHERE company_id = $1 AND source_type = $2',
          [companyId, sourceType],
        );
      } else {
        await this.pool.query('DELETE FROM knowledge_chunks WHERE company_id = $1', [
          companyId,
        ]);
      }
    } catch {
      /* best-effort */
    }
  }
}
