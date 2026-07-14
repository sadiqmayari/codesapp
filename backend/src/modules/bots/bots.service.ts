import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { CreateBotDto } from './dto/create-bot.dto';
import { UpdateBotDto } from './dto/update-bot.dto';

// Mirror of the inbox media pipeline (same disk root + WhatsApp Cloud API
// per-type mime/size caps). sendMedia re-validates authoritatively at send
// time; this rejects bad staged files early. Keep in sync with inbox.service.
const STORAGE_ROOT = path.join(process.cwd(), '..', 'storage', 'media');

const MEDIA_RULES: Array<{
  kind: 'image' | 'audio' | 'video' | 'document';
  maxBytes: number;
  mimes: string[];
  ext: Record<string, string>;
}> = [
  {
    kind: 'image',
    maxBytes: 5 * 1024 * 1024,
    mimes: ['image/jpeg', 'image/png'],
    ext: { 'image/jpeg': 'jpg', 'image/png': 'png' },
  },
  {
    kind: 'video',
    maxBytes: 16 * 1024 * 1024,
    mimes: ['video/mp4', 'video/3gpp'],
    ext: { 'video/mp4': 'mp4', 'video/3gpp': '3gp' },
  },
  {
    kind: 'audio',
    maxBytes: 10 * 1024 * 1024,
    mimes: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'],
    ext: {
      'audio/aac': 'aac',
      'audio/mp4': 'm4a',
      'audio/mpeg': 'mp3',
      'audio/amr': 'amr',
      'audio/ogg': 'ogg',
    },
  },
  {
    kind: 'document',
    maxBytes: 10 * 1024 * 1024,
    mimes: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
    ],
    ext: {
      'application/pdf': 'pdf',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        'docx',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/vnd.ms-powerpoint': 'ppt',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation':
        'pptx',
      'text/plain': 'txt',
    },
  },
];

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

  /**
   * Stage a media file for a `send_media` bot action. Saves to the same disk
   * layout as inbox media and returns the web path + mime + filename to embed
   * in the action. The file is re-uploaded to Meta on each trigger (Meta media
   * ids expire), so we persist the source file, not a Meta id.
   */
  stageMedia(
    companyId: number,
    file:
      | { buffer: Buffer; mimetype: string; originalname?: string; size: number }
      | undefined,
  ): { mediaPath: string; mediaMime: string; mediaFilename: string } {
    if (!file) throw new BadRequestException('file is required');
    const mime = (file.mimetype || '').toLowerCase();
    const rule = MEDIA_RULES.find((r) => r.mimes.includes(mime));
    if (!rule) {
      throw new BadRequestException(`Unsupported media type: ${mime || 'unknown'}`);
    }
    if (file.size > rule.maxBytes) {
      throw new BadRequestException(
        `${rule.kind} exceeds the ${Math.round(
          rule.maxBytes / (1024 * 1024),
        )}MB limit`,
      );
    }

    const now = new Date();
    const dir = path.join(
      STORAGE_ROOT,
      String(companyId),
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
    );
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ext = rule.ext[mime] ?? 'bin';
    const diskName = `${uuidv4()}.${ext}`;
    fs.writeFileSync(path.join(dir, diskName), file.buffer);
    const rel = path
      .relative(STORAGE_ROOT, path.join(dir, diskName))
      .split(path.sep)
      .join('/');

    const filename = (file.originalname || `file.${ext}`)
      .replace(/[\r\n"]/g, '')
      .slice(0, 240);

    return {
      mediaPath: `/storage/media/${rel}`,
      mediaMime: mime,
      mediaFilename: filename,
    };
  }

  private invalidateCache(companyId: number): void {
    this.cache.del(`bots:active:${companyId}`);
  }
}
