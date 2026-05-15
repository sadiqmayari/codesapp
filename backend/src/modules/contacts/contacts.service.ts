import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UsageMeteringService } from '../usage-metering/usage-metering.service';
import { SegmentsService } from './segments.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { ListContactsDto } from './dto/list-contacts.dto';

const DEFAULT_PAGE_SIZE = 50;

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metering: UsageMeteringService,
    private readonly segmentsService: SegmentsService,
  ) {}

  async list(companyId: number, dto: ListContactsDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;
    const skip = (page - 1) * limit;

    const where: Prisma.ContactWhereInput = {
      company_id: companyId,
      deleted_at: null,
    };
    if (dto.status) where.status = dto.status;
    if (dto.search) {
      where.OR = [
        { name: { contains: dto.search } },
        { phone: { contains: dto.search } },
        { email: { contains: dto.search } },
      ];
    }

    let idFilter: number[] | undefined;
    if (dto.segmentId) {
      const seg = await this.segmentsService.get(companyId, dto.segmentId);
      idFilter = await this.segmentsService.resolveContacts(
        companyId,
        seg.filter as Record<string, unknown>,
      );
      where.id = { in: idFilter };
    }

    const [total, rows] = await Promise.all([
      this.prisma.contact.count({ where }),
      this.prisma.contact.findMany({
        where,
        orderBy: { id: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    // Tag filter is post-fetch because Prisma can't query JSON array contains on MySQL
    let filtered = rows;
    if (dto.tag) {
      const want = dto.tag.toLowerCase();
      filtered = rows.filter((r) => {
        const tags = Array.isArray(r.tags) ? (r.tags as string[]) : [];
        return tags.map((t) => t.toLowerCase()).includes(want);
      });
    }

    return {
      success: true,
      data: filtered,
      message: 'OK',
      meta: { page, limit, total },
    };
  }

  async get(companyId: number, id: number) {
    const contact = await this.prisma.contact.findFirst({
      where: { id, company_id: companyId, deleted_at: null },
    });
    if (!contact) throw new NotFoundException('Contact not found');
    return contact;
  }

  async create(companyId: number, dto: CreateContactDto) {
    const existing = await this.prisma.contact.findFirst({
      where: {
        company_id: companyId,
        phone: dto.phone,
        deleted_at: null,
      },
    });
    if (existing) {
      throw new ForbiddenException('Contact with this phone already exists');
    }

    const contact = await this.prisma.contact.create({
      data: {
        company_id: companyId,
        name: dto.name,
        phone: dto.phone,
        email: dto.email ?? null,
        tags: dto.tags ?? [],
        custom_fields: (dto.customFields ?? {}) as Prisma.InputJsonValue,
      },
    });
    await this.metering.incrementContacts(companyId);
    return contact;
  }

  async update(companyId: number, id: number, dto: UpdateContactDto) {
    await this.get(companyId, id);
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.tags !== undefined) data.tags = dto.tags;
    if (dto.customFields !== undefined) {
      data.custom_fields = dto.customFields as Prisma.InputJsonValue;
    }
    if (dto.status !== undefined) data.status = dto.status;

    return this.prisma.contact.update({ where: { id }, data });
  }

  async softDelete(companyId: number, id: number) {
    await this.get(companyId, id);
    await this.prisma.contact.update({
      where: { id },
      data: { deleted_at: new Date() },
    });
    return { ok: true };
  }

  /**
   * Distinct tags across all contacts in the company. Returns up to 200 most-used.
   */
  async distinctTags(companyId: number): Promise<string[]> {
    const rows = await this.prisma.contact.findMany({
      where: { company_id: companyId, deleted_at: null },
      select: { tags: true },
      take: 5000,
    });
    const counts = new Map<string, number>();
    for (const r of rows) {
      const tags = Array.isArray(r.tags) ? (r.tags as string[]) : [];
      for (const t of tags) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 200)
      .map(([t]) => t);
  }
}
