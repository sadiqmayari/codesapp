import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { CreateBotDto } from './dto/create-bot.dto';
import { UpdateBotDto } from './dto/update-bot.dto';

@Injectable()
export class BotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  list(companyId: number) {
    return this.prisma.bot.findMany({
      where: { company_id: companyId },
      orderBy: { created_at: 'desc' },
    });
  }

  async get(companyId: number, id: number) {
    const bot = await this.prisma.bot.findFirst({
      where: { id, company_id: companyId },
    });
    if (!bot) throw new NotFoundException('Bot not found');
    return bot;
  }

  async create(companyId: number, dto: CreateBotDto) {
    const bot = await this.prisma.bot.create({
      data: {
        company_id: companyId,
        name: dto.name,
        trigger_type: dto.triggerType,
        keyword: dto.keyword,
        actions: dto.actions as unknown as object,
        status: 'active',
      },
    });
    this.invalidateCache(companyId);
    return bot;
  }

  async update(companyId: number, id: number, dto: UpdateBotDto) {
    await this.get(companyId, id);
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.triggerType !== undefined) data.trigger_type = dto.triggerType;
    if (dto.keyword !== undefined) data.keyword = dto.keyword;
    if (dto.actions !== undefined) data.actions = dto.actions;

    const bot = await this.prisma.bot.update({
      where: { id },
      data,
    });
    this.invalidateCache(companyId);
    return bot;
  }

  async delete(companyId: number, id: number) {
    await this.get(companyId, id);
    await this.prisma.bot.delete({ where: { id } });
    this.invalidateCache(companyId);
    return { ok: true };
  }

  async toggle(companyId: number, id: number) {
    const bot = await this.get(companyId, id);
    const next = bot.status === 'active' ? 'inactive' : 'active';
    const updated = await this.prisma.bot.update({
      where: { id },
      data: { status: next },
    });
    this.invalidateCache(companyId);
    return updated;
  }

  private invalidateCache(companyId: number): void {
    this.cache.del(`bots:active:${companyId}`);
  }
}
