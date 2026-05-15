import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateSegmentDto,
  SegmentFilterDto,
  UpdateSegmentDto,
} from './dto/create-segment.dto';

@Injectable()
export class SegmentsService {
  constructor(private readonly prisma: PrismaService) {}

  list(companyId: number) {
    return this.prisma.segment.findMany({
      where: { company_id: companyId },
      orderBy: { created_at: 'desc' },
    });
  }

  async get(companyId: number, id: number) {
    const seg = await this.prisma.segment.findFirst({
      where: { id, company_id: companyId },
    });
    if (!seg) throw new NotFoundException('Segment not found');
    return seg;
  }

  create(companyId: number, dto: CreateSegmentDto) {
    return this.prisma.segment.create({
      data: {
        company_id: companyId,
        name: dto.name,
        filter: dto.filter as unknown as object,
      },
    });
  }

  async update(companyId: number, id: number, dto: UpdateSegmentDto) {
    await this.get(companyId, id);
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.filter !== undefined) data.filter = dto.filter;
    return this.prisma.segment.update({ where: { id }, data });
  }

  async delete(companyId: number, id: number) {
    await this.get(companyId, id);
    await this.prisma.segment.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Translate a SegmentFilter into a Prisma where clause for the contacts table.
   * Exposed for unit testing.
   */
  static buildContactWhere(
    companyId: number,
    filter: SegmentFilterDto,
  ): Prisma.ContactWhereInput {
    const where: Prisma.ContactWhereInput = {
      company_id: companyId,
      deleted_at: null,
    };

    if (filter.status) {
      where.status = filter.status;
    }

    if (filter.hasEmail === true) {
      where.email = { not: null };
    } else if (filter.hasEmail === false) {
      where.email = null;
    }

    if (filter.lastMessageAfter || filter.lastMessageBefore) {
      const range: Prisma.DateTimeNullableFilter = {};
      if (filter.lastMessageAfter) range.gte = new Date(filter.lastMessageAfter);
      if (filter.lastMessageBefore) range.lte = new Date(filter.lastMessageBefore);
      where.last_message_at = range;
    }

    return where;
  }

  /**
   * Resolve contact IDs matching the segment filter. Tag matching is done
   * post-fetch because MySQL JSON array containment requires raw SQL.
   */
  async resolveContacts(
    companyId: number,
    filter: SegmentFilterDto,
    limit?: number,
  ): Promise<number[]> {
    const where = SegmentsService.buildContactWhere(companyId, filter);
    const rows = await this.prisma.contact.findMany({
      where,
      select: { id: true, tags: true },
      take: limit ?? 10_000,
    });

    if (!filter.tags || filter.tags.length === 0) {
      return rows.map((r) => r.id);
    }

    const requiredTags = filter.tags.map((t) => t.toLowerCase());
    return rows
      .filter((r) => {
        const contactTags = Array.isArray(r.tags)
          ? (r.tags as string[]).map((t) => t.toLowerCase())
          : [];
        return requiredTags.every((t) => contactTags.includes(t));
      })
      .map((r) => r.id);
  }

  async preview(companyId: number, id: number, limit = 20) {
    const seg = await this.get(companyId, id);
    const filter = seg.filter as unknown as SegmentFilterDto;
    const ids = await this.resolveContacts(companyId, filter, limit);
    const contacts = await this.prisma.contact.findMany({
      where: { id: { in: ids }, company_id: companyId },
      take: limit,
      select: { id: true, name: true, phone: true, email: true, tags: true },
    });
    return contacts;
  }
}
