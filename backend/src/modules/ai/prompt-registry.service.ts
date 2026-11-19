import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';

/** Prompt keys the super-admin may override (code holds the defaults). */
export const PROMPT_KEYS = [
  'agent.core',
  'pack.ecommerce',
  'pack.clinic',
  'pack.real_estate',
  'pack.education',
  'pack.restaurant',
  'pack.services',
  'pack.travel',
  'pack.generic',
] as const;

const TTL = 60;

/**
 * Super-admin prompt overrides: draft → live → retired. At most ONE `live`
 * version per key; `get(key)` returns its body (null = use the code default).
 * Cached 60s per process.
 */
@Injectable()
export class PromptRegistryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async get(key: string): Promise<{ body: string; version: string } | null> {
    const ck = `prompt-live:${key}`;
    const hit = this.cache.get<{ body: string; version: string } | 'none'>(ck);
    if (hit) return hit === 'none' ? null : hit;
    const row = await this.prisma.aiPromptOverride
      .findFirst({
        where: { prompt_key: key, status: 'live' },
        orderBy: { updated_at: 'desc' },
        select: { body: true, version: true },
      })
      .catch(() => null);
    this.cache.set(ck, row ?? 'none', TTL);
    return row;
  }

  list() {
    return this.prisma.aiPromptOverride.findMany({
      orderBy: [{ prompt_key: 'asc' }, { created_at: 'desc' }],
      take: 200,
    });
  }

  async createDraft(key: string, body: string, by: string) {
    if (!(PROMPT_KEYS as readonly string[]).includes(key)) {
      throw new BadRequestException('Unknown prompt key');
    }
    if (!body.trim()) throw new BadRequestException('Prompt body is empty');
    const n = await this.prisma.aiPromptOverride.count({ where: { prompt_key: key } });
    return this.prisma.aiPromptOverride.create({
      data: {
        prompt_key: key,
        version: `o${n + 1}`,
        body: body.slice(0, 20000),
        status: 'draft',
        created_by: by.slice(0, 120),
      },
    });
  }

  async setStatus(id: number, status: 'live' | 'retired' | 'draft', evalPass?: number) {
    const row = await this.prisma.aiPromptOverride.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Prompt override not found');
    await this.prisma.$transaction(async (tx) => {
      if (status === 'live') {
        await tx.aiPromptOverride.updateMany({
          where: { prompt_key: row.prompt_key, status: 'live' },
          data: { status: 'retired' },
        });
      }
      await tx.aiPromptOverride.update({
        where: { id },
        data: { status, ...(evalPass !== undefined ? { eval_pass: evalPass } : {}) },
      });
    });
    this.cache.del(`prompt-live:${row.prompt_key}`);
    return { ok: true };
  }
}
