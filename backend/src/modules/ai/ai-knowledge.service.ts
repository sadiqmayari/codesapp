import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateKnowledgeDto, UpdateKnowledgeDto } from './dto/knowledge.dto';

/**
 * Tenant knowledge-base CRUD (company-scoped). Entries are injected — whole,
 * prompt-cached — into the AI system context by AiService.
 */
@Injectable()
export class AiKnowledgeService {
  constructor(private readonly prisma: PrismaService) {}

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

  create(companyId: number, dto: CreateKnowledgeDto) {
    return this.prisma.aiKnowledgeBase.create({
      data: {
        company_id: companyId,
        title: dto.title.trim(),
        content: dto.content,
        enabled: dto.enabled ?? true,
      },
    });
  }

  async update(companyId: number, id: number, dto: UpdateKnowledgeDto) {
    await this.get(companyId, id);
    const data: Record<string, unknown> = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.content !== undefined) data.content = dto.content;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    return this.prisma.aiKnowledgeBase.update({ where: { id }, data });
  }

  async remove(companyId: number, id: number) {
    await this.get(companyId, id);
    await this.prisma.aiKnowledgeBase.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Create-or-replace a single entry identified by its exact title (used by the
   * Shopify auto-sync so re-running it overwrites rather than duplicating).
   */
  async upsertByTitle(companyId: number, title: string, content: string) {
    const t = title.trim();
    const existing = await this.prisma.aiKnowledgeBase.findFirst({
      where: { company_id: companyId, title: t },
      select: { id: true },
    });
    if (existing) {
      return this.prisma.aiKnowledgeBase.update({
        where: { id: existing.id },
        data: { content, enabled: true },
      });
    }
    return this.prisma.aiKnowledgeBase.create({
      data: { company_id: companyId, title: t, content, enabled: true },
    });
  }

  /** Delete a manual entry by exact title if present (no-op otherwise). */
  async deleteByTitle(companyId: number, title: string): Promise<void> {
    await this.prisma.aiKnowledgeBase.deleteMany({
      where: { company_id: companyId, title: title.trim() },
    });
  }
}
