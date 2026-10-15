import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { FeatureService } from '../../common/services/feature.service';
import { GDriveService } from './gdrive.service';
import {
  CreateContentDto,
  CreatePlanDto,
  ReviewContentDto,
  ScheduleContentDto,
} from './dto/content.dto';

const parseDate = (v?: string | null): Date | null =>
  v ? new Date(v) : null;

type UploadedFile = {
  buffer: Buffer;
  mimetype: string;
  originalname?: string;
  size: number;
};

/** Allowed content media (Drive-backed; not WhatsApp-constrained). */
const CONTENT_MEDIA_RULES: { type: 'image' | 'video'; mimes: string[] }[] = [
  { type: 'image', mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] },
  {
    type: 'video',
    mimes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp'],
  },
];
const MAX_UPLOAD_BYTES = 150 * 1024 * 1024; // 150MB

@Injectable()
export class ContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly feature: FeatureService,
    private readonly gdrive: GDriveService,
  ) {}

  /** Gate every content operation on the resolved feature flag. */
  async assertEnabled(companyId: number) {
    const on = await this.feature.contentEnabled(companyId);
    if (!on) throw new ForbiddenException('Content module is not enabled');
  }

  // ─── Drive connection (owner/admin) ───────────────────────────────────────

  driveStatus(companyId: number) {
    return this.gdrive.status(companyId);
  }

  async driveConnectUrl(companyId: number) {
    return { url: this.gdrive.getAuthUrl(companyId) };
  }

  async driveDisconnect(companyId: number) {
    await this.gdrive.disconnect(companyId);
    return { ok: true };
  }

  // ─── Content items ─────────────────────────────────────────────────────────

  list(companyId: number, status?: string) {
    return this.prisma.contentItem.findMany({
      where: { company_id: companyId, ...(status ? { status } : {}) },
      orderBy: [{ scheduled_publish_at: 'asc' }, { created_at: 'desc' }],
    });
  }

  async get(companyId: number, id: number) {
    const item = await this.prisma.contentItem.findFirst({
      where: { id, company_id: companyId },
    });
    if (!item) throw new NotFoundException('Content not found');
    return item;
  }

  async createUpload(
    companyId: number,
    userId: number | undefined,
    file: UploadedFile | undefined,
    dto: CreateContentDto,
  ) {
    if (!file) throw new BadRequestException('A file is required');
    const rule = this.validateFile(file);

    const { fileId } = await this.gdrive.upload(
      companyId,
      file.buffer,
      file.mimetype,
      file.originalname || dto.title,
    );

    return this.prisma.contentItem.create({
      data: {
        company_id: companyId,
        created_by_user_id: userId ?? null,
        title: dto.title.trim(),
        caption: dto.caption ?? null,
        platform: dto.platform?.trim() || null,
        media_type: rule.type,
        drive_file_id: fileId,
        mime: file.mimetype,
        size_bytes: file.size,
        status: 'uploaded',
        scheduled_publish_at: parseDate(dto.scheduledPublishAt),
        deadline: parseDate(dto.deadline),
      },
    });
  }

  /** Create a PLANNED item with no media yet (the plan-then-produce flow). */
  private planData(userId: number | undefined, dto: CreatePlanDto) {
    return {
      created_by_user_id: userId ?? null,
      title: dto.title.trim(),
      caption: dto.caption ?? null,
      platform: dto.platform?.trim() || null,
      media_type: null,
      drive_file_id: null,
      status: 'planned',
      scheduled_publish_at: parseDate(dto.scheduledPublishAt),
      deadline: parseDate(dto.deadline),
    };
  }

  createPlan(companyId: number, userId: number | undefined, dto: CreatePlanDto) {
    return this.prisma.contentItem.create({
      data: { company_id: companyId, ...this.planData(userId, dto) },
    });
  }

  /** Plan several items at once (the planning list). */
  async createPlanBulk(
    companyId: number,
    userId: number | undefined,
    items: CreatePlanDto[],
  ) {
    await this.prisma.contentItem.createMany({
      data: items.map((dto) => ({ company_id: companyId, ...this.planData(userId, dto) })),
    });
    return { ok: true, count: items.length };
  }

  /**
   * Attach / replace the media on an item. Used both for a planned item's
   * first upload AND for a "needs changes" revision — in the revision case the
   * OLD Drive file is deleted first so stale media never lingers in Drive.
   */
  async attachMedia(companyId: number, id: number, file: UploadedFile | undefined) {
    const item = await this.get(companyId, id);
    if (!file) throw new BadRequestException('A file is required');
    const rule = this.validateFile(file);

    const { fileId } = await this.gdrive.upload(
      companyId,
      file.buffer,
      file.mimetype,
      file.originalname || item.title,
    );

    // Delete the previous Drive file (revision / re-upload) — best-effort so a
    // Drive hiccup never blocks the fresh upload from being recorded.
    if (item.drive_file_id && item.drive_file_id !== fileId) {
      await this.gdrive.deleteFile(companyId, item.drive_file_id);
    }

    return this.prisma.contentItem.update({
      where: { id },
      data: {
        media_type: rule.type,
        drive_file_id: fileId,
        mime: file.mimetype,
        size_bytes: file.size,
        // A planned item becomes 'uploaded'; re-uploading a 'needs_changes'
        // item sends the fresh content back for review.
        status: 'uploaded',
        review_feedback: null,
        reviewed_by_user_id: null,
        reviewed_at: null,
      },
    });
  }

  private validateFile(file: UploadedFile) {
    const rule = CONTENT_MEDIA_RULES.find((r) =>
      r.mimes.includes(file.mimetype),
    );
    if (!rule) {
      throw new BadRequestException(`Unsupported file type: ${file.mimetype}`);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException('File exceeds the 150MB limit');
    }
    return rule;
  }

  /** Owner/admin review decision; sets status + feedback + reviewer stamp. */
  async review(
    companyId: number,
    id: number,
    dto: ReviewContentDto,
    reviewerId: number,
  ) {
    await this.get(companyId, id);
    return this.prisma.contentItem.update({
      where: { id },
      data: {
        status: dto.decision,
        review_feedback: dto.feedback ?? null,
        reviewed_by_user_id: reviewerId,
        reviewed_at: new Date(),
      },
    });
  }

  async schedule(companyId: number, id: number, dto: ScheduleContentDto) {
    await this.get(companyId, id);
    const data: Record<string, unknown> = {};
    if (dto.scheduledPublishAt !== undefined)
      data.scheduled_publish_at = parseDate(dto.scheduledPublishAt);
    if (dto.deadline !== undefined) data.deadline = parseDate(dto.deadline);
    return this.prisma.contentItem.update({ where: { id }, data });
  }

  async markPublished(companyId: number, id: number) {
    const item = await this.get(companyId, id);
    if (item.status !== 'approved') {
      throw new BadRequestException('Only approved content can be published');
    }
    return this.prisma.contentItem.update({
      where: { id },
      data: { status: 'published', published_at: new Date() },
    });
  }

  async remove(companyId: number, id: number) {
    const item = await this.get(companyId, id);
    // Drop the Drive file first (best-effort), then the row.
    if (item.drive_file_id) {
      await this.gdrive.deleteFile(companyId, item.drive_file_id);
    }
    await this.prisma.contentItem.delete({ where: { id } });
    return { ok: true };
  }

  /** Items with a scheduled publish date inside [from, to] for the calendar. */
  calendar(companyId: number, from: Date, to: Date) {
    return this.prisma.contentItem.findMany({
      where: {
        company_id: companyId,
        scheduled_publish_at: { gte: from, lte: to },
      },
      orderBy: { scheduled_publish_at: 'asc' },
    });
  }

  /** Pipeline overview for the dashboard. */
  async stats(companyId: number) {
    const grouped = await this.prisma.contentItem.groupBy({
      by: ['status'],
      where: { company_id: companyId },
      _count: { _all: true },
    });
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const g of grouped) {
      byStatus[g.status] = g._count._all;
      total += g._count._all;
    }

    // Overdue = past the task deadline and not yet published.
    const overdue = await this.prisma.contentItem.count({
      where: {
        company_id: companyId,
        deadline: { lt: new Date() },
        status: { not: 'published' },
      },
    });

    return { total, byStatus, overdue };
  }
}
