import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCannedReplyDto } from './dto/create-canned-reply.dto';
import { UpdateCannedReplyDto } from './dto/update-canned-reply.dto';

@Injectable()
export class CannedRepliesService {
  constructor(private readonly prisma: PrismaService) {}

  list(companyId: number) {
    return this.prisma.cannedReply.findMany({
      where: { company_id: companyId },
      orderBy: { title: 'asc' },
    });
  }

  async get(companyId: number, id: number) {
    const reply = await this.prisma.cannedReply.findFirst({
      where: { id, company_id: companyId },
    });
    if (!reply) throw new NotFoundException('Canned reply not found');
    return reply;
  }

  create(companyId: number, dto: CreateCannedReplyDto) {
    return this.prisma.cannedReply.create({
      data: {
        company_id: companyId,
        title: dto.title.trim(),
        body: dto.body,
      },
    });
  }

  async update(companyId: number, id: number, dto: UpdateCannedReplyDto) {
    await this.get(companyId, id);
    const data: Record<string, unknown> = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.body !== undefined) data.body = dto.body;
    return this.prisma.cannedReply.update({ where: { id }, data });
  }

  async remove(companyId: number, id: number) {
    await this.get(companyId, id);
    await this.prisma.cannedReply.delete({ where: { id } });
    return { ok: true };
  }
}
