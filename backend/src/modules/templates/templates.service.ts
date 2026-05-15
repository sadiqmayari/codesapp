import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UsageMeteringService } from '../usage-metering/usage-metering.service';
import { MetaTemplateSyncService } from './meta-template-sync.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { ListTemplatesDto } from './dto/list-templates.dto';

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metering: UsageMeteringService,
    private readonly metaSync: MetaTemplateSyncService,
  ) {}

  list(companyId: number, dto: ListTemplatesDto) {
    const where: Prisma.TemplateWhereInput = {
      company_id: companyId,
      deleted_at: null,
    };
    if (dto.status) where.status = dto.status;
    if (dto.category) where.category = dto.category;
    return this.prisma.template.findMany({
      where,
      orderBy: { created_at: 'desc' },
    });
  }

  async get(companyId: number, id: number) {
    const tpl = await this.prisma.template.findFirst({
      where: { id, company_id: companyId, deleted_at: null },
    });
    if (!tpl) throw new NotFoundException('Template not found');
    return tpl;
  }

  async create(companyId: number, dto: CreateTemplateDto) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { waba_id: true },
    });
    if (!company?.waba_id) {
      throw new ForbiddenException('WhatsApp Business Account not configured');
    }

    const tpl = await this.prisma.template.create({
      data: {
        company_id: companyId,
        meta_template_id: null,
        name: dto.name,
        category: dto.category,
        status: 'pending',
        content: {
          language: dto.language,
          components: dto.components,
        } as unknown as object,
      },
    });

    const result = await this.metaSync.submitToMeta(companyId, company.waba_id, {
      name: dto.name,
      category: dto.category,
      language: dto.language,
      components: dto.components,
    });

    if (result.id) {
      const updated = await this.prisma.template.update({
        where: { id: tpl.id },
        data: { meta_template_id: result.id },
      });
      await this.metering.incrementTemplates(companyId);
      return updated;
    }

    return this.prisma.template.update({
      where: { id: tpl.id },
      data: {
        status: 'rejected',
        rejection_reason: result.error ?? 'Meta API rejected template',
      },
    });
  }

  async softDelete(companyId: number, id: number) {
    await this.get(companyId, id);
    await this.prisma.template.update({
      where: { id },
      data: { deleted_at: new Date() },
    });
    return { ok: true };
  }

  sync(companyId: number) {
    return this.metaSync.syncFromMeta(companyId);
  }
}
