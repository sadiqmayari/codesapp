import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OgService } from '../og/og.service';
import { CreateKnowledgeDto, UpdateKnowledgeDto } from './dto/knowledge.dto';
import { AiRagService, RagHit } from './ai-rag.service';
import { LlmService } from './llm.service';
import { AiMeteringService } from './ai-metering.service';

/** Target chunk size for embedding long entries (chars). */
const CHUNK_CHARS = 1500;
/** Max chunks one entry is split into (≈ 75k chars). */
const MAX_PARTS = 50;
/** Max pages pulled from one sitemap import. */
const MAX_SITEMAP_PAGES = 25;

/** Split long text into ~CHUNK_CHARS parts on paragraph / sentence boundaries. */
export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const t = (text || '').replace(/\r/g, '').trim();
  if (!t) return [];
  if (t.length <= size) return [t];
  const paras = t.split(/\n{2,}/);
  const out: string[] = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = '';
  };
  for (const p of paras) {
    if (p.length > size) {
      push();
      const sentences = p.split(/(?<=[.!?۔])\s+/);
      for (const s of sentences) {
        if ((cur + ' ' + s).length > size) push();
        cur += (cur ? ' ' : '') + s;
        while (cur.length > size) {
          out.push(cur.slice(0, size));
          cur = cur.slice(size);
        }
      }
      push();
      continue;
    }
    if ((cur + '\n\n' + p).length > size) push();
    cur += (cur ? '\n\n' : '') + p;
  }
  push();
  return out.slice(0, MAX_PARTS);
}

/** Crude but dependency-free HTML → readable text. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  let s = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
  return { title, text: s };
}

/**
 * Tenant knowledge base: manual entries / FAQ pairs / imported website pages /
 * imported documents. Every enabled entry is EMBEDDED (source_type 'manual',
 * store 0) so the agent RETRIEVES the relevant parts instead of the old
 * "inject the whole KB until 35k chars" approach. Entries stay editable rows in
 * `ai_knowledge_base`; the chunks are derived (kb-<id>-<n>).
 */
@Injectable()
export class AiKnowledgeService {
  private readonly logger = new Logger(AiKnowledgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rag: AiRagService,
    private readonly og: OgService,
    private readonly llm: LlmService,
    private readonly metering: AiMeteringService,
  ) {}

  list(companyId: number) {
    return this.prisma.aiKnowledgeBase.findMany({
      where: { company_id: companyId },
      orderBy: { title: 'asc' },
    });
  }

  async get(companyId: number, id: number) {
    const entry = await this.prisma.aiKnowledgeBase.findFirst({
      where: { id, company_id: companyId },
    });
    if (!entry) throw new NotFoundException('Knowledge entry not found');
    return entry;
  }

  /** (Re)embed one entry's chunks — or remove them when disabled. Never throws. */
  private async syncEntry(entry: {
    id: number;
    company_id: number;
    title: string;
    content: string;
    enabled: boolean;
  }): Promise<void> {
    const prefix = `kb-${entry.id}-`;
    try {
      if (!entry.enabled) {
        await this.rag.replaceEntry(entry.company_id, 'manual', prefix, []);
        return;
      }
      const parts = chunkText(entry.content);
      await this.rag.replaceEntry(
        entry.company_id,
        'manual',
        prefix,
        parts.map((content, i) => ({
          sourceId: `${prefix}${i}`,
          title: parts.length > 1 ? `${entry.title} (${i + 1}/${parts.length})` : entry.title,
          content: `${entry.title}\n${content}`,
        })),
      );
    } catch (e) {
      this.logger.warn(
        `knowledge sync failed (entry ${entry.id}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async create(companyId: number, dto: CreateKnowledgeDto) {
    const entry = await this.prisma.aiKnowledgeBase.create({
      data: {
        company_id: companyId,
        title: dto.title.trim(),
        content: dto.content,
        enabled: dto.enabled ?? true,
      },
    });
    await this.syncEntry(entry);
    return entry;
  }

  async update(companyId: number, id: number, dto: UpdateKnowledgeDto) {
    await this.get(companyId, id);
    const data: Record<string, unknown> = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.content !== undefined) data.content = dto.content;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    const entry = await this.prisma.aiKnowledgeBase.update({ where: { id }, data });
    await this.syncEntry(entry);
    return entry;
  }

  async remove(companyId: number, id: number) {
    await this.get(companyId, id);
    await this.prisma.aiKnowledgeBase.delete({ where: { id } });
    await this.rag.replaceEntry(companyId, 'manual', `kb-${id}-`, []).catch(() => undefined);
    return { ok: true };
  }

  /** Create-or-replace a single entry by exact title (sync/import re-runs). */
  async upsertByTitle(companyId: number, title: string, content: string) {
    const t = title.trim().slice(0, 200);
    const existing = await this.prisma.aiKnowledgeBase.findFirst({
      where: { company_id: companyId, title: t },
      select: { id: true },
    });
    const entry = existing
      ? await this.prisma.aiKnowledgeBase.update({
          where: { id: existing.id },
          data: { content, enabled: true },
        })
      : await this.prisma.aiKnowledgeBase.create({
          data: { company_id: companyId, title: t, content, enabled: true },
        });
    await this.syncEntry(entry);
    return entry;
  }

  /** Delete a manual entry by exact title if present (no-op otherwise). */
  async deleteByTitle(companyId: number, title: string): Promise<void> {
    const rows = await this.prisma.aiKnowledgeBase.findMany({
      where: { company_id: companyId, title: title.trim() },
      select: { id: true },
    });
    for (const r of rows) {
      await this.prisma.aiKnowledgeBase.delete({ where: { id: r.id } });
      await this.rag.replaceEntry(companyId, 'manual', `kb-${r.id}-`, []).catch(() => undefined);
    }
  }

  /** Re-embed every enabled entry (backfill + "Rebuild index" button). */
  async reindexAll(companyId: number): Promise<{ entries: number }> {
    const rows = await this.prisma.aiKnowledgeBase.findMany({
      where: { company_id: companyId },
    });
    for (const r of rows) await this.syncEntry(r);
    return { entries: rows.length };
  }

  /**
   * Import a public web page (or every page of a sitemap.xml, up to 25) as
   * knowledge entries "🌐 <title>". SSRF-safe (OgService.fetchPage).
   */
  async importUrl(
    companyId: number,
    url: string,
  ): Promise<{ imported: number; failed: number; titles: string[] }> {
    await this.metering.assertAllowed(companyId);
    const first = await this.og.fetchPage(url.trim());
    if (!first.ok) {
      throw new BadRequestException(`Could not read that page (${first.reason ?? 'failed'}).`);
    }
    let urls: string[] = [first.url];
    let preloaded: typeof first | null = first;
    if (/xml/.test(first.contentType) || /<urlset|<sitemapindex/i.test(first.body.slice(0, 500))) {
      urls = Array.from(first.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi))
        .map((m) => m[1])
        .filter((u) => !/\.(jpg|jpeg|png|webp|gif|pdf|xml)(\?|$)/i.test(u))
        .slice(0, MAX_SITEMAP_PAGES);
      preloaded = null;
    }
    let imported = 0;
    let failed = 0;
    const titles: string[] = [];
    for (const u of urls) {
      const page = preloaded && u === preloaded.url ? preloaded : await this.og.fetchPage(u);
      if (!page.ok || !/html|text\/plain/.test(page.contentType)) {
        failed++;
        continue;
      }
      const { title, text } = /html/.test(page.contentType)
        ? htmlToText(page.body)
        : { title: '', text: page.body };
      if (text.length < 80) {
        failed++;
        continue;
      }
      let path = page.url;
      try {
        path = new URL(page.url).pathname || page.url;
      } catch {
        /* keep url */
      }
      const t = `🌐 ${(title || path).slice(0, 180)}`;
      await this.upsertByTitle(companyId, t, `Source: ${page.url}\n\n${text.slice(0, 60000)}`);
      titles.push(t);
      imported++;
    }
    return { imported, failed, titles };
  }

  /**
   * Import an uploaded document as a knowledge entry "📄 <file>". Plain text /
   * CSV / Markdown are read directly; a PDF is transcribed by the model (needs
   * the Anthropic provider). Metered as feature 'knowledge'.
   */
  async importDocument(
    companyId: number,
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
  ): Promise<{ title: string; chars: number }> {
    if (!file?.buffer?.length) throw new BadRequestException('Empty file.');
    if (file.size > 15 * 1024 * 1024) throw new BadRequestException('File is larger than 15 MB.');
    await this.metering.assertAllowed(companyId);
    const name = (file.originalname || 'document').slice(0, 150);
    let text = '';
    if (/^text\/|csv|markdown|json/.test(file.mimetype) || /\.(txt|md|csv)$/i.test(name)) {
      text = file.buffer.toString('utf8');
    } else if (file.mimetype === 'application/pdf' || /\.pdf$/i.test(name)) {
      const res = await this.llm.complete({
        tier: 'fast',
        thinking: 'off',
        system: [
          {
            text:
              'You convert documents to clean plain text for a customer-support knowledge base. ' +
              'Reproduce ALL factual content faithfully (prices, policies, timings, product details, ' +
              'contact info). Keep headings on their own lines, turn tables into "label: value" lines. ' +
              'No commentary, no summary — only the document text.',
          },
        ],
        userText: 'Convert this document to plain text.',
        documents: [{ mime: 'application/pdf', dataBase64: file.buffer.toString('base64') }],
        maxTokens: 16000,
        timeoutMs: 180_000,
      });
      await this.metering.recordUsage(companyId, null, 'knowledge', res.provider, 'fast', res.usage, {
        modelId: res.modelId,
        latencyMs: res.latencyMs,
      });
      text = res.text;
    } else {
      throw new BadRequestException(
        'Unsupported file type. Upload a PDF, TXT, CSV or Markdown file (save Word documents as PDF).',
      );
    }
    text = text.trim();
    if (text.length < 20) throw new BadRequestException('No readable text found in that file.');
    const title = `📄 ${name}`;
    await this.upsertByTitle(companyId, title, text.slice(0, 75000));
    return { title, chars: text.length };
  }

  /** "Test a question" — exactly what the agent would retrieve. */
  async testQuestion(
    companyId: number,
    question: string,
    storeId?: number | null,
  ): Promise<{ hits: Array<Omit<RagHit, 'content'> & { preview: string }> }> {
    await this.metering.assertAllowed(companyId);
    const hits = await this.rag.retrieveHits(companyId, question, { storeId, topK: 8 });
    return {
      hits: hits.map((h) => ({
        title: h.title,
        sourceType: h.sourceType,
        storeId: h.storeId,
        score: Math.round(h.score * 1000) / 1000,
        preview: h.content.slice(0, 280),
      })),
    };
  }
}
