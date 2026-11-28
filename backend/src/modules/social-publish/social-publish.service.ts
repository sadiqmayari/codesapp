import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaService } from '../../common/services/media.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { InboxGateway } from '../inbox/inbox.gateway';
import { MetaGraphError, MetaSocialService } from '../inbox/meta-social/meta-social.service';
import { ContentService } from '../content/content.service';
import { GDriveService } from '../content/gdrive.service';
import {
  PostMedia,
  PostPlatform,
  buildPlan,
  fillPlaceholders,
  overallStatus,
  validatePost,
} from './publish-plan';

export const SOCIAL_PUBLISH_QUEUE = 'social-publish';

const IMAGE_MAX = 8 * 1024 * 1024;
const VIDEO_MAX = 100 * 1024 * 1024;

export interface PostMediaInput {
  webPath: string;
  type: 'image' | 'video';
  mime?: string;
}
export interface PostTarget {
  metaPageId: number;
  platform: PostPlatform;
}
export interface PostResult extends PostTarget {
  externalId: string | null;
  permalink: string | null;
  error: string | null;
  at: string;
}
export interface CreatePostInput {
  caption: string;
  media: PostMediaInput[];
  targets: PostTarget[];
  /** ISO time; future = schedule, absent/past = publish now. */
  scheduledAt?: string | null;
}

type Row = Prisma.SocialPostGetPayload<Record<string, never>>;

/**
 * Publish / schedule posts to a tenant's Facebook Pages and Instagram accounts
 * through their own Meta app (MetaSocialService owns the Page tokens + Graph).
 * Scheduling = a delayed `social-publish` job; the worker re-checks the row so
 * cancel / reschedule never needs to delete a job (broadcast pattern).
 */
@Injectable()
export class SocialPublishService implements OnModuleInit {
  private readonly logger = new Logger(SocialPublishService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metaSocial: MetaSocialService,
    private readonly media: MediaService,
    private readonly jobs: JobQueueService,
    private readonly gateway: InboxGateway,
    private readonly gdrive: GDriveService,
    private readonly content: ContentService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerWorker(
      SOCIAL_PUBLISH_QUEUE,
      (p) => this.run(p as { postId: number; at?: string | null }),
      2,
      900,
    );
  }

  // ------------------------------------------------------------- accounts

  async accounts(companyId: number) {
    const pages = await this.prisma.metaPage.findMany({
      where: { company_id: companyId, status: { not: 'disconnected' } },
      orderBy: { id: 'asc' },
    });
    const out: Array<{ metaPageId: number; platform: PostPlatform; name: string; pictureUrl: string | null }> = [];
    for (const p of pages) {
      out.push({ metaPageId: p.id, platform: 'facebook', name: p.name, pictureUrl: p.picture_url });
      if (p.ig_user_id) {
        out.push({ metaPageId: p.id, platform: 'instagram', name: `@${p.ig_username ?? p.ig_user_id}`, pictureUrl: p.picture_url });
      }
    }
    return { accounts: out };
  }

  // ---------------------------------------------------------------- media

  uploadMedia(companyId: number, file: { buffer?: Buffer; mimetype?: string; originalname?: string; size?: number }) {
    if (!file?.buffer) throw new BadRequestException('Choose a file');
    const mime = (file.mimetype || '').toLowerCase();
    const type = mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image' : null;
    if (!type) throw new BadRequestException('Only photos and videos can be posted');
    if (type === 'image' && !['image/jpeg', 'image/png'].includes(mime)) {
      throw new BadRequestException('Use a JPG or PNG photo (Instagram does not accept other formats)');
    }
    if (type === 'video' && !['video/mp4', 'video/quicktime'].includes(mime)) {
      throw new BadRequestException('Use an MP4 or MOV video');
    }
    const max = type === 'image' ? IMAGE_MAX : VIDEO_MAX;
    if ((file.size ?? file.buffer.length) > max) {
      throw new BadRequestException(`${type === 'image' ? 'Photos' : 'Videos'} can be up to ${max / 1024 / 1024} MB`);
    }
    const saved = this.media.saveBuffer(file.buffer, mime, companyId, file.originalname);
    return { webPath: saved.webPath, type, mime, url: this.metaSocial.publicMediaUrl(saved.webPath) };
  }

  // ----------------------------------------------------------------- read

  private view(r: Row) {
    return {
      id: r.id,
      contentItemId: r.content_item_id,
      caption: r.caption,
      media: r.media,
      targets: r.targets,
      status: r.status,
      scheduledAt: r.scheduled_at,
      publishedAt: r.published_at,
      results: r.results ?? [],
      lastError: r.last_error,
      createdAt: r.created_at,
    };
  }

  async list(companyId: number, tab?: string, page = 1) {
    const where: Prisma.SocialPostWhereInput = { company_id: companyId };
    if (tab === 'scheduled') where.status = { in: ['scheduled', 'publishing'] };
    else if (tab === 'published') where.status = { in: ['published', 'partial'] };
    else if (tab === 'failed') where.status = { in: ['failed', 'partial'] };
    const take = 30;
    const [rows, total, counts] = await Promise.all([
      this.prisma.socialPost.findMany({
        where,
        orderBy: tab === 'scheduled' ? [{ scheduled_at: 'asc' }, { id: 'asc' }] : [{ id: 'desc' }],
        skip: (Math.max(1, page) - 1) * take,
        take,
      }),
      this.prisma.socialPost.count({ where }),
      this.prisma.socialPost.groupBy({ by: ['status'], where: { company_id: companyId }, _count: { _all: true } }),
    ]);
    const c = Object.fromEntries(counts.map((g) => [g.status, g._count._all]));
    return {
      rows: rows.map((r) => this.view(r)),
      total,
      page,
      counts: {
        scheduled: (c.scheduled ?? 0) + (c.publishing ?? 0),
        published: (c.published ?? 0) + (c.partial ?? 0),
        failed: (c.failed ?? 0) + (c.partial ?? 0),
      },
    };
  }

  private async row(companyId: number, id: number) {
    const r = await this.prisma.socialPost.findFirst({ where: { id, company_id: companyId } });
    if (!r) throw new NotFoundException('Post not found');
    return r;
  }

  async get(companyId: number, id: number) {
    return this.view(await this.row(companyId, id));
  }

  // ---------------------------------------------------------------- write

  /** Check targets belong to this tenant and the post fits every platform. */
  private async validate(companyId: number, input: CreatePostInput) {
    const caption = (input.caption ?? '').slice(0, 63206);
    const media = (input.media ?? []).slice(0, 10).map((m) => {
      if (!/^\/storage\/media\//.test(m.webPath)) throw new BadRequestException('Upload the media first');
      return { ...m, type: m.type === 'video' ? 'video' : 'image' } as PostMediaInput;
    });
    const targets = input.targets ?? [];
    if (!targets.length) throw new BadRequestException('Pick at least one Page or Instagram account');
    const pageIds = [...new Set(targets.map((t) => t.metaPageId))];
    const pages = await this.prisma.metaPage.findMany({
      where: { id: { in: pageIds }, company_id: companyId, status: { not: 'disconnected' } },
    });
    const byId = new Map(pages.map((p) => [p.id, p]));
    const seen = new Set<string>();
    const clean: PostTarget[] = [];
    const problems: string[] = [];
    const urls: PostMedia[] = media.map((m) => ({ url: this.metaSocial.publicMediaUrl(m.webPath), type: m.type }));
    for (const t of targets) {
      const p = byId.get(t.metaPageId);
      const platform: PostPlatform = t.platform === 'instagram' ? 'instagram' : 'facebook';
      if (!p) throw new BadRequestException('One of the accounts is not connected any more');
      if (platform === 'instagram' && !p.ig_user_id) throw new BadRequestException(`${p.name} has no Instagram account linked`);
      const key = `${p.id}:${platform}`;
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push({ metaPageId: p.id, platform });
      for (const e of validatePost(platform, caption, urls)) problems.push(e);
    }
    if (problems.length) throw new BadRequestException([...new Set(problems)].join('. '));
    return { caption, media, targets: clean };
  }

  private parseWhen(at?: string | null): Date | null {
    if (!at) return null;
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid schedule time');
    return d.getTime() > Date.now() + 30_000 ? d : null;
  }

  private async enqueue(r: { id: number; scheduled_at: Date | null; status: string }) {
    const at = r.status === 'scheduled' && r.scheduled_at ? r.scheduled_at : null;
    await this.jobs.enqueue(
      SOCIAL_PUBLISH_QUEUE,
      { postId: r.id, at: at ? at.toISOString() : null },
      {
        delayMs: at ? Math.max(0, at.getTime() - Date.now()) : 0,
        dedupKey: `social-publish:${r.id}:${at ? at.toISOString() : 'now'}:${Date.now() - (Date.now() % 1000)}`,
        maxAttempts: 1,
      },
    );
  }

  private emit(companyId: number, id: number, status: string) {
    try {
      this.gateway.emitToCompany(companyId, 'social_posts.updated', { id, status });
    } catch {
      /* never block a publish on a socket */
    }
  }

  private async audit(companyId: number, userId: number | null, action: string, id: number, meta: Record<string, unknown> = {}) {
    try {
      await this.prisma.auditLog.create({
        data: { company_id: companyId, user_id: userId, action, entity: 'social_post', entity_id: id, metadata: meta as Prisma.InputJsonValue },
      });
    } catch {
      /* best-effort */
    }
  }

  async create(companyId: number, userId: number, input: CreatePostInput, contentItemId: number | null = null) {
    const v = await this.validate(companyId, input);
    const when = this.parseWhen(input.scheduledAt);
    const r = await this.prisma.socialPost.create({
      data: {
        company_id: companyId,
        content_item_id: contentItemId,
        caption: v.caption,
        media: v.media as unknown as Prisma.InputJsonValue,
        targets: v.targets as unknown as Prisma.InputJsonValue,
        status: when ? 'scheduled' : 'publishing',
        scheduled_at: when,
        created_by_user_id: userId,
      },
    });
    await this.enqueue(r);
    await this.audit(companyId, userId, when ? 'social_post.scheduled' : 'social_post.publish', r.id, { targets: v.targets.length });
    this.emit(companyId, r.id, r.status);
    return this.view(r);
  }

  async update(companyId: number, userId: number, id: number, input: CreatePostInput) {
    const r = await this.row(companyId, id);
    if (!['scheduled', 'failed', 'draft', 'cancelled'].includes(r.status)) {
      throw new BadRequestException('Only scheduled, failed or cancelled posts can be edited');
    }
    const v = await this.validate(companyId, input);
    const when = this.parseWhen(input.scheduledAt);
    const next = await this.prisma.socialPost.update({
      where: { id: r.id },
      data: {
        caption: v.caption,
        media: v.media as unknown as Prisma.InputJsonValue,
        targets: v.targets as unknown as Prisma.InputJsonValue,
        status: when ? 'scheduled' : 'publishing',
        scheduled_at: when,
        results: Prisma.DbNull,
        last_error: null,
      },
    });
    await this.enqueue(next);
    await this.audit(companyId, userId, 'social_post.updated', r.id);
    this.emit(companyId, r.id, next.status);
    return this.view(next);
  }

  async cancel(companyId: number, userId: number, id: number) {
    const r = await this.row(companyId, id);
    if (r.status !== 'scheduled') throw new BadRequestException('Only scheduled posts can be cancelled');
    const next = await this.prisma.socialPost.update({ where: { id: r.id }, data: { status: 'cancelled' } });
    await this.audit(companyId, userId, 'social_post.cancelled', r.id);
    this.emit(companyId, r.id, 'cancelled');
    return this.view(next);
  }

  /** Re-run only the targets that failed. */
  async retry(companyId: number, userId: number, id: number) {
    const r = await this.row(companyId, id);
    if (!['failed', 'partial'].includes(r.status)) throw new BadRequestException('Only failed posts can be retried');
    const next = await this.prisma.socialPost.update({ where: { id: r.id }, data: { status: 'publishing', scheduled_at: null } });
    await this.enqueue(next);
    await this.audit(companyId, userId, 'social_post.retry', r.id);
    this.emit(companyId, r.id, 'publishing');
    return this.view(next);
  }

  /** Publish an approved Content item (its Drive media + caption). */
  async fromContent(
    companyId: number,
    userId: number,
    contentId: number,
    input: { caption?: string; targets: PostTarget[]; scheduledAt?: string | null },
  ) {
    const item = await this.content.get(companyId, contentId);
    if (item.status !== 'approved') throw new BadRequestException('Only approved content can be published');
    if (!item.drive_file_id) throw new BadRequestException('This item has no media yet');
    const file = await this.gdrive.downloadBytes(companyId, item.drive_file_id, VIDEO_MAX);
    const up = this.uploadMedia(companyId, {
      buffer: file.buffer,
      mimetype: file.mime,
      originalname: file.name,
      size: file.buffer.length,
    });
    const post = await this.create(
      companyId,
      userId,
      {
        caption: input.caption ?? item.caption ?? '',
        media: [{ webPath: up.webPath, type: up.type as 'image' | 'video', mime: up.mime }],
        targets: input.targets,
        scheduledAt: input.scheduledAt,
      },
      item.id,
    );
    if (post.scheduledAt) {
      await this.prisma.contentItem
        .update({ where: { id: item.id }, data: { scheduled_publish_at: post.scheduledAt } })
        .catch(() => undefined);
    }
    return post;
  }

  // ---------------------------------------------------------------- worker

  private async run(job: { postId: number; at?: string | null }) {
    const r = await this.prisma.socialPost.findUnique({ where: { id: job.postId } });
    if (!r) return;
    if (r.status === 'scheduled') {
      // A reschedule enqueues a new job; this one only fires for its own time.
      if (!job.at || !r.scheduled_at || r.scheduled_at.toISOString() !== job.at) return;
    } else if (r.status !== 'publishing') {
      return; // cancelled / already done
    }
    await this.prisma.socialPost.update({ where: { id: r.id }, data: { status: 'publishing' } });
    this.emit(r.company_id, r.id, 'publishing');

    const targets = (r.targets as unknown as PostTarget[]) ?? [];
    const media = ((r.media as unknown as PostMediaInput[]) ?? []).map((m) => ({
      url: this.metaSocial.publicMediaUrl(m.webPath),
      type: m.type,
    }));
    const previous = ((r.results as unknown as PostResult[]) ?? []).filter((x) => x.externalId && !x.error);
    const results: PostResult[] = [...previous];
    for (const t of targets) {
      if (previous.some((p) => p.metaPageId === t.metaPageId && p.platform === t.platform)) continue;
      try {
        const out = await this.publishTarget(r.company_id, t, r.caption, media);
        results.push({ ...t, ...out, error: null, at: new Date().toISOString() });
      } catch (err) {
        results.push({ ...t, externalId: null, permalink: null, error: this.friendly(err, t.platform), at: new Date().toISOString() });
      }
    }
    const status = overallStatus(results);
    const firstErr = results.find((x) => x.error)?.error ?? null;
    await this.prisma.socialPost.update({
      where: { id: r.id },
      data: {
        status,
        results: results as unknown as Prisma.InputJsonValue,
        published_at: status === 'failed' ? null : new Date(),
        last_error: firstErr?.slice(0, 500) ?? null,
      },
    });
    if (status !== 'failed' && r.content_item_id) {
      await this.content.markPublished(r.company_id, r.content_item_id).catch(() => undefined);
    }
    this.emit(r.company_id, r.id, status);
    this.logger.log(`social post ${r.id} → ${status}`);
  }

  private async publishTarget(
    companyId: number,
    target: PostTarget,
    caption: string,
    media: PostMedia[],
  ): Promise<{ externalId: string; permalink: string | null }> {
    const { page, token } = await this.metaSocial.pageWithToken(companyId, target.metaPageId);
    if (target.platform === 'instagram' && !page.ig_user_id) throw new Error('No Instagram account linked to this Page');
    const vars: Record<string, string> = { page: page.page_id, ig: page.ig_user_id ?? '' };
    for (const step of buildPlan(target.platform, caption, media)) {
      const path = fillPlaceholders(step.path, vars);
      const body = step.body ? fillPlaceholders(step.body, vars) : undefined;
      const res = await this.metaSocial.graph<{ id?: string; post_id?: string }>(step.method, path, token, { body });
      const id = res.post_id ?? res.id;
      if (step.save && id) vars[step.save] = id;
      if (step.waitReady && res.id) await this.waitReady(res.id, token);
    }
    const externalId = vars.post;
    if (!externalId) throw new Error('Meta did not return the post id');
    let permalink: string | null = null;
    try {
      const field = target.platform === 'instagram' ? 'permalink' : 'permalink_url';
      const p = await this.metaSocial.graph<Record<string, string>>('GET', externalId, token, { query: { fields: field } });
      permalink = p[field] ?? null;
    } catch {
      permalink = null;
    }
    return { externalId, permalink };
  }

  /** Instagram video containers process asynchronously. */
  private async waitReady(containerId: string, token: string) {
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const r = await this.metaSocial.graph<{ status_code?: string; status?: string }>('GET', containerId, token, {
        query: { fields: 'status_code,status' },
      });
      if (r.status_code === 'FINISHED') return;
      if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') {
        throw new Error(`Instagram could not process the video${r.status ? `: ${r.status}` : ''}`);
      }
      await new Promise((res) => setTimeout(res, 5000));
    }
    throw new Error('Instagram took too long to process the video');
  }

  private friendly(err: unknown, platform: PostPlatform): string {
    const e = err as MetaGraphError;
    const name = platform === 'instagram' ? 'Instagram' : 'Facebook';
    const msg = String(e?.message ?? 'publish failed');
    if (e?.code === 10 || e?.code === 200) {
      return `${name}: not allowed (${msg}). The Meta token needs ${platform === 'instagram' ? 'instagram_content_publish' : 'pages_manage_posts'}.`;
    }
    if (e?.code === 190) return `${name}: the Page token expired, reconnect in Settings`;
    return `${name}: ${msg}`.slice(0, 500);
  }
}
