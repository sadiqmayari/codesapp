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
  AssignContentDto,
  CreateContentDto,
  CreatePlanDto,
  ReviewContentDto,
  ScheduleContentDto,
} from './dto/content.dto';

const parseDate = (v?: string | null): Date | null =>
  v ? new Date(v) : null;

/** Roles that only ever see/act on tasks assigned to them. */
const UPLOADER_ROLES = ['videographer', 'graphic_designer'];
const isUploader = (role?: string) => !!role && UPLOADER_ROLES.includes(role);

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

  // ─── Workflow audit ──────────────────────────────────────────────────────

  /** Append a timeline event (non-throwing — never blocks the main op). */
  private async logEvent(
    companyId: number,
    contentItemId: number,
    actorUserId: number | undefined,
    type: string,
    detail?: string,
  ) {
    try {
      await this.prisma.contentEvent.create({
        data: {
          company_id: companyId,
          content_item_id: contentItemId,
          actor_user_id: actorUserId ?? null,
          type,
          detail: detail ?? null,
        },
      });
    } catch {
      /* best-effort */
    }
  }

  async getEvents(
    companyId: number,
    id: number,
    viewer?: { userId: number; role: string },
  ) {
    await this.get(companyId, id, viewer); // tenant + assignee scope assert
    const [events, users] = await Promise.all([
      this.prisma.contentEvent.findMany({
        where: { company_id: companyId, content_item_id: id },
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.user.findMany({
        where: { company_id: companyId },
        select: { id: true, name: true },
      }),
    ]);
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    return events.map((e) => ({
      ...e,
      actor_name: e.actor_user_id ? nameOf.get(e.actor_user_id) ?? null : null,
    }));
  }

  /** Users who can be assigned content tasks (uploaders + execs). */
  listAssignees(companyId: number) {
    return this.prisma.user.findMany({
      where: {
        company_id: companyId,
        status: { not: 'suspended' },
        role: { in: ['videographer', 'graphic_designer', 'creative_executive'] },
      },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });
  }

  // ─── Content items ─────────────────────────────────────────────────────────

  list(companyId: number, status?: string, viewer?: { userId: number; role: string }) {
    return this.prisma.contentItem.findMany({
      where: {
        company_id: companyId,
        ...(status ? { status } : {}),
        // Uploaders only ever see tasks assigned to them.
        ...(isUploader(viewer?.role) ? { assignee_user_id: viewer!.userId } : {}),
      },
      orderBy: [{ scheduled_publish_at: 'asc' }, { created_at: 'desc' }],
    });
  }

  async get(companyId: number, id: number, viewer?: { userId: number; role: string }) {
    const item = await this.prisma.contentItem.findFirst({
      where: { id, company_id: companyId },
    });
    if (!item) throw new NotFoundException('Content not found');
    // Uploaders can only open their own assigned tasks.
    if (isUploader(viewer?.role) && item.assignee_user_id !== viewer!.userId) {
      throw new NotFoundException('Content not found');
    }
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

    const created = await this.prisma.contentItem.create({
      data: {
        company_id: companyId,
        created_by_user_id: userId ?? null,
        assignee_user_id: dto.assigneeUserId ?? null,
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
    await this.logEvent(companyId, created.id, userId, 'uploaded', dto.title.trim());
    return created;
  }

  /** Create a PLANNED item with no media yet (the plan-then-produce flow). */
  private planData(userId: number | undefined, dto: CreatePlanDto) {
    return {
      created_by_user_id: userId ?? null,
      assignee_user_id: dto.assigneeUserId ?? null,
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

  async createPlan(companyId: number, userId: number | undefined, dto: CreatePlanDto) {
    const created = await this.prisma.contentItem.create({
      data: { company_id: companyId, ...this.planData(userId, dto) },
    });
    await this.logEvent(companyId, created.id, userId, 'planned', dto.title.trim());
    if (dto.assigneeUserId) {
      await this.logEvent(companyId, created.id, userId, 'assigned');
    }
    return created;
  }

  /** Plan several items at once (the planning list). */
  async createPlanBulk(
    companyId: number,
    userId: number | undefined,
    items: CreatePlanDto[],
  ) {
    // createMany can't return ids, so create sequentially to log per-item.
    for (const dto of items) {
      await this.createPlan(companyId, userId, dto);
    }
    return { ok: true, count: items.length };
  }

  /** Assign (or reassign / unassign) a task to an uploader. */
  async assign(
    companyId: number,
    id: number,
    dto: AssignContentDto,
    actorId: number,
  ) {
    const item = await this.get(companyId, id);
    const next = dto.assigneeUserId ?? null;
    const updated = await this.prisma.contentItem.update({
      where: { id },
      data: { assignee_user_id: next },
    });
    await this.logEvent(
      companyId,
      id,
      actorId,
      item.assignee_user_id ? 'reassigned' : 'assigned',
      next === null ? 'unassigned' : undefined,
    );
    return updated;
  }

  /**
   * Attach / replace the media on an item. Used both for a planned item's
   * first upload AND for a "needs changes" revision — in the revision case the
   * OLD Drive file is deleted first so stale media never lingers in Drive.
   */
  async attachMedia(
    companyId: number,
    id: number,
    file: UploadedFile | undefined,
    viewer?: { userId: number; role: string },
  ) {
    const item = await this.get(companyId, id, viewer);
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

    const wasRevision = item.status === 'needs_changes';
    const updated = await this.prisma.contentItem.update({
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
    await this.logEvent(
      companyId,
      id,
      viewer?.userId,
      wasRevision ? 'resubmitted' : 'uploaded',
    );
    return updated;
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
    const updated = await this.prisma.contentItem.update({
      where: { id },
      data: {
        status: dto.decision,
        review_feedback: dto.feedback ?? null,
        reviewed_by_user_id: reviewerId,
        reviewed_at: new Date(),
      },
    });
    await this.logEvent(companyId, id, reviewerId, dto.decision, dto.feedback ?? undefined);
    return updated;
  }

  async schedule(
    companyId: number,
    id: number,
    dto: ScheduleContentDto,
    actorId?: number,
  ) {
    await this.get(companyId, id);
    const data: Record<string, unknown> = {};
    if (dto.scheduledPublishAt !== undefined)
      data.scheduled_publish_at = parseDate(dto.scheduledPublishAt);
    if (dto.deadline !== undefined) data.deadline = parseDate(dto.deadline);
    const updated = await this.prisma.contentItem.update({ where: { id }, data });
    await this.logEvent(companyId, id, actorId, 'scheduled');
    return updated;
  }

  async markPublished(companyId: number, id: number, actorId?: number) {
    const item = await this.get(companyId, id);
    if (item.status !== 'approved') {
      throw new BadRequestException('Only approved content can be published');
    }
    const updated = await this.prisma.contentItem.update({
      where: { id },
      data: { status: 'published', published_at: new Date() },
    });
    await this.logEvent(companyId, id, actorId, 'published');
    return updated;
  }

  async remove(companyId: number, id: number, actorId?: number) {
    const item = await this.get(companyId, id);
    // Drop the Drive file first (best-effort), then the row + its events.
    if (item.drive_file_id) {
      await this.gdrive.deleteFile(companyId, item.drive_file_id);
    }
    await this.prisma.contentEvent.deleteMany({ where: { content_item_id: id } });
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
