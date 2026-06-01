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
}
