import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import { EMBEDDING_DIM } from './ai.constants';

/**
 * Postgres + pgvector knowledge store (preferred retrieval path).
 *
 * One embedded chunk per product / policy / manual entry per tenant, with a
 * `vector(1536)` column (HNSW) AND a `tsvector` keyword column → HYBRID search
 * (semantic recall fused with keyword recall via Reciprocal Rank Fusion).
 *
 * v2 (Nov-2026):
 *  - `store_id` scoping (0 = company-wide; >0 = a commerce store) — syncing
 *    store B no longer wipes store A, and retrieval can be filtered by store.
 *  - per-row SAVEPOINTs: one bad row used to abort the whole Postgres
 *    transaction (every later insert failed, COMMIT rolled back) while the
 *    method still returned true.
 *  - keyword arm uses OR-ed terms (plainto_tsquery AND-ed every word of the
 *    customer's last three messages, so it almost never matched).
 *
 * EVERYTHING is fail-safe: PGVECTOR_URL unset / unreachable → `enabled=false`
 * and AiRagService falls back to the MariaDB in-process cosine path.
 */

export interface PgChunk {
  sourceId: string;
  title: string;
  content: string;
  embedding: Float32Array;
}

export interface PgHit {
  title: string;
  content: string;
  sourceType: string;
  storeId: number;
  score: number;
  distance: number | null;
}

/** RRF constant — dampens the contribution of lower-ranked hits. */
const RRF_K = 60;

/** Build an OR-ed tsquery string from free text ('' when nothing usable). */
export function orQuery(text: string): string {
  const words = (text || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && w.length <= 40);
  const uniq = Array.from(new Set(words)).slice(0, 16);
  return uniq.map((w) => w.replace(/'/g, '')).filter(Boolean).join(' | ');
}

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

  /** Create the extension, table and indexes (idempotent, incl. v2 upgrade). */
  private async bootstrap(): Promise<void> {
    if (!this.pool) return;
    await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id          bigserial PRIMARY KEY,
        company_id  integer NOT NULL,
        store_id    integer NOT NULL DEFAULT 0,
        source_type text NOT NULL,
        source_id   text NOT NULL,
        title       text NOT NULL,
        content     text NOT NULL,
        embedding   vector(${EMBEDDING_DIM}),
        tsv         tsvector GENERATED ALWAYS AS (
                      to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(content,''))
                    ) STORED,
        updated_at  timestamptz DEFAULT now()
      )
    `);
    // v2 upgrade of a v1 table: add store scope, swap the unique key.
    await this.pool.query(
      'ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS store_id integer NOT NULL DEFAULT 0',
    );
    await this.pool.query(
      'ALTER TABLE knowledge_chunks DROP CONSTRAINT IF EXISTS knowledge_chunks_company_id_source_type_source_id_key',
    );
    await this.pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS knowledge_chunks_scope_uq
         ON knowledge_chunks (company_id, store_id, source_type, source_id)`,
    );
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
         ON knowledge_chunks (company_id, store_id)`,
    );
  }

  private static vec(v: Float32Array): string {
    return `[${Array.from(v).join(',')}]`;
  }

  private async insertRow(
    client: PoolClient,
    companyId: number,
    storeId: number,
    sourceType: string,
    r: PgChunk,
  ): Promise<void> {
    await client.query(
      `INSERT INTO knowledge_chunks
         (company_id, store_id, source_type, source_id, title, content, embedding, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::vector, now())
       ON CONFLICT (company_id, store_id, source_type, source_id)
       DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content,
         embedding = EXCLUDED.embedding, updated_at = now()`,
      [
        companyId,
        storeId,
        sourceType,
        r.sourceId.slice(0, 191),
        r.title.slice(0, 255),
        r.content,
        PgVectorService.vec(r.embedding),
      ],
    );
  }

  /**
   * Replace ALL chunks of one (store, source_type) for a company atomically
   * (readers keep seeing the old set until COMMIT). A bad row is skipped via a
   * SAVEPOINT instead of poisoning the transaction. When a real store syncs,
   * legacy store-0 rows of the same type are removed too. Never throws.
   */
  async replaceSource(
    companyId: number,
    storeId: number,
    sourceType: string,
    rows: PgChunk[],
  ): Promise<boolean> {
    if (!this.enabled() || !this.pool) return false;
    const client = await this.pool.connect().catch(() => null);
    if (!client) return false;
    let skipped = 0;
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM knowledge_chunks
          WHERE company_id = $1 AND source_type = $2
            AND (store_id = $3 OR ($3 > 0 AND store_id = 0 AND $2 IN ('product','policy')))`,
        [companyId, sourceType, storeId],
      );
      for (const r of rows) {
        if (!r.embedding || r.embedding.length !== EMBEDDING_DIM) continue;
        await client.query('SAVEPOINT row_sp');
        try {
          await this.insertRow(client, companyId, storeId, sourceType, r);
          await client.query('RELEASE SAVEPOINT row_sp');
        } catch (e) {
          skipped++;
          await client.query('ROLLBACK TO SAVEPOINT row_sp').catch(() => undefined);
          this.logger.warn(
            `pgvector row skipped ${sourceType}/${r.sourceId} (company ${companyId}): ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }
      await client.query('COMMIT');
      if (skipped) {
        this.logger.warn(`pgvector replaceSource company ${companyId}: ${skipped} row(s) skipped`);
      }
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

  /** Upsert ONE chunk (incremental product webhook). Never throws. */
  async upsertOne(
    companyId: number,
    storeId: number,
    sourceType: string,
    row: PgChunk,
  ): Promise<void> {
    if (!this.enabled() || !this.pool) return;
    if (!row.embedding || row.embedding.length !== EMBEDDING_DIM) return;
    const client = await this.pool.connect().catch(() => null);
    if (!client) return;
    try {
      await this.insertRow(client, companyId, storeId, sourceType, row);
    } catch (e) {
      this.logger.warn(
        `pgvector upsertOne failed (company ${companyId}): ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      client.release();
    }
  }

  /** Delete ONE chunk (product deleted / archived). Never throws. */
  async deleteOne(
    companyId: number,
    storeId: number,
    sourceType: string,
    sourceId: string,
  ): Promise<void> {
    if (!this.enabled() || !this.pool) return;
    await this.pool
      .query(
        'DELETE FROM knowledge_chunks WHERE company_id=$1 AND store_id=$2 AND source_type=$3 AND source_id=$4',
        [companyId, storeId, sourceType, sourceId],
      )
      .catch(() => undefined);
  }

  /**
   * Hybrid search filtered to the company (and, when `storeId` is given, to
   * that store + company-wide rows). Returns [] when disabled / on error.
   */
  async searchHybrid(
    companyId: number,
    embedding: Float32Array,
    queryText: string,
    topK: number,
    opts: { storeId?: number | null; pool?: number; maxDistance?: number; types?: string[] } = {},
  ): Promise<PgHit[]> {
    if (!this.enabled() || !this.pool) return [];
    if (!embedding || embedding.length !== EMBEDDING_DIM) return [];
    const pool = opts.pool ?? 40;
    // Cosine-DISTANCE floor for the vector arm (distance = 1 - similarity):
    // drops clearly unrelated hits so off-topic queries return nothing.
    const maxDistance = opts.maxDistance ?? 0.75;
    const store = opts.storeId && opts.storeId > 0 ? opts.storeId : null;
    const tsq = orQuery(queryText);
    const types = opts.types?.length ? opts.types : null;
    try {
      const res = await this.pool.query<{
        title: string;
        content: string;
        source_type: string;
        store_id: number;
        score: number;
        distance: number | null;
      }>(
        `
        WITH scope AS (
          SELECT * FROM knowledge_chunks
           WHERE company_id = $2
             AND ($8::int IS NULL OR store_id = 0 OR store_id = $8)
             AND ($9::text[] IS NULL OR source_type = ANY($9))
        ),
        v AS (
          SELECT id, (embedding <=> $1::vector) AS dist,
                 ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
          FROM scope
          WHERE embedding IS NOT NULL AND (embedding <=> $1::vector) < $7
          ORDER BY embedding <=> $1::vector
          LIMIT $4
        ),
        k AS (
          SELECT id,
                 ROW_NUMBER() OVER (ORDER BY ts_rank(tsv, to_tsquery('simple', $3)) DESC) AS rank
          FROM scope
          WHERE $3 <> '' AND tsv @@ to_tsquery('simple', $3)
          ORDER BY ts_rank(tsv, to_tsquery('simple', $3)) DESC
          LIMIT $4
        ),
        fused AS (
          SELECT COALESCE(v.id, k.id) AS id, v.dist,
                 (COALESCE(1.0 / ($5 + v.rank), 0) + COALESCE(1.0 / ($5 + k.rank), 0)) AS score
          FROM v FULL OUTER JOIN k ON v.id = k.id
        )
        SELECT c.title, c.content, c.source_type, c.store_id, f.score, f.dist AS distance
        FROM fused f JOIN knowledge_chunks c ON c.id = f.id
        ORDER BY f.score DESC
        LIMIT $6
        `,
        [
          PgVectorService.vec(embedding),
          companyId,
          tsq,
          pool,
          RRF_K,
          topK,
          maxDistance,
          store,
          types,
        ],
      );
      return res.rows.map((r) => ({
        title: r.title,
        content: r.content,
        sourceType: r.source_type,
        storeId: Number(r.store_id),
        score: Number(r.score),
        distance: r.distance === null ? null : Number(r.distance),
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

  async clear(companyId: number, sourceType?: string, storeId?: number): Promise<void> {
    if (!this.enabled() || !this.pool) return;
    try {
      await this.pool.query(
        `DELETE FROM knowledge_chunks
          WHERE company_id = $1
            AND ($2::text IS NULL OR source_type = $2)
            AND ($3::int IS NULL OR store_id = $3)`,
        [companyId, sourceType ?? null, storeId ?? null],
      );
    } catch {
      /* best-effort */
    }
  }
}
