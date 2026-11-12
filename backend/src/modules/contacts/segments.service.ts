import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateSegmentDto,
  SegmentFilterDto,
  UpdateSegmentDto,
} from './dto/create-segment.dto';
import { ContactFilter, contactWhereSql } from './contact-query';

/** Rows fetched per round-trip when resolving a whole audience. */
const RESOLVE_BATCH = 2000;

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
    await this.prisma.segment.updateMany({ where: { id, company_id: companyId }, data });
    return this.get(companyId, id);
  }

  async delete(companyId: number, id: number) {
    await this.get(companyId, id);
    await this.prisma.segment.deleteMany({ where: { id, company_id: companyId } });
    return { ok: true };
  }

  /** Stored segment filter JSON → the shared `ContactFilter`. Tolerates legacy/partial blobs. */
  static toContactFilter(raw: unknown): ContactFilter {
    const f = (raw && typeof raw === 'object' ? raw : {}) as SegmentFilterDto;
    return {
      status: f.status,
      tags: Array.isArray(f.tags) ? f.tags : undefined,
      tagMode: f.tagMode === 'any' ? 'any' : 'all',
      excludeTags: Array.isArray(f.excludeTags) ? f.excludeTags : undefined,
      city: f.city,
      hasEmail: typeof f.hasEmail === 'boolean' ? f.hasEmail : undefined,
      optedOut: typeof f.optedOut === 'boolean' ? f.optedOut : undefined,
      lastMessageAfter: f.lastMessageAfter,
      lastMessageBefore: f.lastMessageBefore,
      createdAfter: f.createdAfter,
      createdBefore: f.createdBefore,
    };
  }

  /**
   * Every contact id matching the filter, in id order, fetched in batches —
   * NO cap (the old 10,000 `take` silently truncated broadcast audiences).
   * `sendableOnly` (broadcasts) additionally drops blocked + opted-out contacts.
   * `limit` stops early (preview).
   */
  async resolveContacts(
    companyId: number,
    filter: SegmentFilterDto | Record<string, unknown>,
    limit?: number,
    opts: { sendableOnly?: boolean } = {},
  ): Promise<number[]> {
    const f = { ...SegmentsService.toContactFilter(filter), sendableOnly: opts.sendableOnly };
    return this.resolveIds(companyId, f, limit);
  }

  /** Batched id resolution for an arbitrary shared filter. */
  async resolveIds(companyId: number, f: ContactFilter, limit?: number): Promise<number[]> {
    const where = contactWhereSql(companyId, f);
    const out: number[] = [];
    let after = 0;
    for (;;) {
      const take = limit ? Math.min(RESOLVE_BATCH, limit - out.length) : RESOLVE_BATCH;
      if (take <= 0) break;
      const rows = await this.prisma.$queryRaw<{ id: number }[]>(Prisma.sql`
        SELECT id FROM contacts WHERE ${where} AND id > ${after}
        ORDER BY id ASC LIMIT ${take}`);
      for (const r of rows) out.push(Number(r.id));
      if (rows.length < take) break;
      after = Number(rows[rows.length - 1].id);
    }
    return out;
  }

  async countFilter(companyId: number, f: ContactFilter): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ c: bigint | number }[]>(Prisma.sql`
      SELECT COUNT(*) AS c FROM contacts WHERE ${contactWhereSql(companyId, f)}`);
    return Number(rows[0]?.c ?? 0);
  }

  async count(companyId: number, id: number) {
    const seg = await this.get(companyId, id);
    const f = SegmentsService.toContactFilter(seg.filter);
    const [total, sendable] = await Promise.all([
      this.countFilter(companyId, f),
      this.countFilter(companyId, { ...f, sendableOnly: true }),
    ]);
    return { total, sendable };
  }

  async preview(companyId: number, id: number, limit = 20) {
    const seg = await this.get(companyId, id);
    const ids = await this.resolveContacts(companyId, seg.filter as Record<string, unknown>, limit);
    if (!ids.length) return [];
    return this.prisma.contact.findMany({
      where: { id: { in: ids }, company_id: companyId },
      orderBy: { id: 'asc' },
      select: { id: true, name: true, phone: true, email: true, tags: true },
    });
  }
}
