import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AiRagService } from './ai-rag.service';

export interface RetrievalEvalResult {
  configured: boolean;
  cases: number;
  hits: number;
  /** Fraction of product questions whose OWN product chunk was retrieved. */
  hitRate: number | null;
  misses: string[];
  ranAt: string;
}

/**
 * Retrieval evaluation harness — the "biggest missing safety net" from the AI
 * redesign. It measures, per tenant, whether the retrieval layer actually
 * surfaces the RIGHT product for a natural question about it. Cases are
 * AUTO-GENERATED from the tenant's own indexed catalogue (no manual curation):
 * for a sample of products we ask a natural-language question and check the
 * product's own chunk comes back. A dropping hit-rate is an early warning that
 * retrieval (and therefore answer grounding) has regressed.
 *
 * Read-only and side-effect-free apart from the model embedding calls RAG makes.
 */
@Injectable()
export class AiEvalService {
  private readonly logger = new Logger(AiEvalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rag: AiRagService,
  ) {}

  /** Turn "Brand | Variant | Detail" into a natural question about the product. */
  private toQuestion(title: string): string {
    const segments = title
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
    // Drop the brand (first segment) so the query isn't a trivial exact match.
    const name = (segments.length > 1 ? segments.slice(1) : segments).join(' ');
    return `Do you have ${name}? What is the price?`;
  }

  async runRetrievalEval(
    companyId: number,
    limit = 20,
  ): Promise<RetrievalEvalResult> {
    const ranAt = new Date().toISOString();
    if (!this.rag.isConfigured()) {
      return { configured: false, cases: 0, hits: 0, hitRate: null, misses: [], ranAt };
    }
    const sample = Math.min(Math.max(Math.floor(limit) || 20, 1), 50);
    const rows = await this.prisma.$queryRaw<Array<{ title: string }>>`
      SELECT title FROM ai_knowledge_chunks
      WHERE company_id = ${companyId} AND source_type = 'product'
      ORDER BY RAND()
      LIMIT ${sample}`;
    if (!rows.length) {
      return { configured: true, cases: 0, hits: 0, hitRate: null, misses: [], ranAt };
    }

    let hits = 0;
    const misses: string[] = [];
    for (const r of rows) {
      const title = r.title;
      let ctx: string | null = null;
      try {
        ctx = await this.rag.retrieve(companyId, this.toQuestion(title), { topK: 8 });
      } catch {
        ctx = null;
      }
      // A hit = the product's own chunk (its exact title) is in the retrieved
      // context for a natural question about it.
      if (ctx && ctx.includes(title)) hits += 1;
      else misses.push(title);
    }
    const cases = rows.length;
    const result: RetrievalEvalResult = {
      configured: true,
      cases,
      hits,
      hitRate: cases > 0 ? Math.round((hits / cases) * 1000) / 1000 : null,
      misses: misses.slice(0, 12),
      ranAt,
    };
    this.logger.log(
      `retrieval eval company ${companyId}: ${hits}/${cases} hit (${
        result.hitRate != null ? Math.round(result.hitRate * 100) : '—'
      }%)`,
    );
    return result;
  }

  /** Run the eval for every company that has indexed product chunks. Used by the
   *  scheduled cron; returns a compact per-company summary. */
  async runAllTenants(limit = 20): Promise<
    Array<{ companyId: number; hitRate: number | null; hits: number; cases: number }>
  > {
    const companies = await this.prisma.$queryRaw<Array<{ company_id: number }>>`
      SELECT DISTINCT company_id FROM ai_knowledge_chunks WHERE source_type = 'product'`;
    const out: Array<{
      companyId: number;
      hitRate: number | null;
      hits: number;
      cases: number;
    }> = [];
    for (const c of companies) {
      try {
        const r = await this.runRetrievalEval(c.company_id, limit);
        out.push({
          companyId: c.company_id,
          hitRate: r.hitRate,
          hits: r.hits,
          cases: r.cases,
        });
      } catch (e) {
        this.logger.warn(
          `retrieval eval failed for company ${c.company_id}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    return out;
  }
}
