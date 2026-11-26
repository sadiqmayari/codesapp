import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { FeatureService } from '../../common/services/feature.service';
import { runsBackground } from '../../common/utils/process-role';
import { InboxGateway } from '../inbox/inbox.gateway';
import { listTikTokComments, replyTikTokComment, setTikTokCommentHidden } from './tiktok-comments.client';

const TICK_MS = 10 * 60_000;
const FIRST_PULL_DAYS = 14;
const OVERLAP_MS = 60 * 60_000;

export interface CommentListQuery {
  platform?: string;
  status?: 'visible' | 'hidden' | 'unreplied' | 'all';
  q?: string;
  page?: number;
  limit?: number;
}

type PullAccount = { id: number; company_id: number; external_id: string; token_encrypted: string | null };

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Ad / social comments. TikTok ad comments are pulled by a worker poller
 * (TikTok has no comment webhook for ads) from every active TikTok ad account
 * of tenants granted the `social_comments` module, then listed, replied to and
 * hidden from the Comments page. Meta FB/IG plug in later as another platform.
 */
@Injectable()
export class SocialCommentsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SocialCommentsService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly feature: FeatureService,
    private readonly gateway: InboxGateway,
  ) {}

  onModuleInit() {
    if (!runsBackground()) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    setTimeout(() => void this.tick(), 90_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private tiktokAccounts(companyIds: number[]) {
    return this.prisma.adAccount.findMany({
      where: { company_id: { in: companyIds }, platform: 'tiktok', status: 'active', token_encrypted: { not: null } },
      select: { id: true, company_id: true, external_id: true, token_encrypted: true },
    });
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const granted = await this.feature.companiesWith('social_comments');
      if (!granted.size) return;
      for (const a of await this.tiktokAccounts(Array.from(granted))) {
        try {
          const n = await this.pullAccount(a);
          if (n) this.log.log(`tiktok comments: ${n} new for company ${a.company_id} account ${a.external_id}`);
        } catch (e) {
          this.log.warn(`tiktok comments pull failed (company ${a.company_id}, ${a.external_id}): ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.log.warn(`comments tick failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Pull since the newest stored comment (minus 1 h overlap); first run = 14 days. Returns # new rows. */
  async pullAccount(a: PullAccount) {
    if (!a.token_encrypted) return 0;
    const token = this.encryption.decrypt(a.token_encrypted);
    const last = await this.prisma.socialComment.findFirst({
      where: { company_id: a.company_id, platform: 'tiktok', account_id: a.id },
      orderBy: { commented_at: 'desc' },
      select: { commented_at: true },
    });
    const sinceMs = last ? last.commented_at.getTime() - OVERLAP_MS : Date.now() - FIRST_PULL_DAYS * 86_400_000;
    const since = ymd(new Date(Math.max(sinceMs, Date.now() - 29 * 86_400_000)));
    const rows = await listTikTokComments(token, a.external_id, since, ymd(new Date()));
    let created = 0;
    for (const c of rows) {
      const key = { company_id: a.company_id, platform: 'tiktok', external_id: c.externalId };
      const existing = await this.prisma.socialComment.findUnique({
        where: { company_id_platform_external_id: key },
        select: { id: true },
      });
      const data = {
        parent_external_id: c.parentExternalId,
        ad_id: c.adId,
        ad_name: c.adName,
        post_id: c.postId,
        author_name: c.authorName,
        author_id: c.authorId,
        text: c.text,
        status: c.hidden ? 'hidden' : 'visible',
        raw: c.raw as Prisma.InputJsonValue,
      };
      if (existing) {
        await this.prisma.socialComment.update({ where: { id: existing.id }, data });
      } else {
        try {
          await this.prisma.socialComment.create({
            data: { ...key, source: 'ad', account_id: a.id, commented_at: c.commentedAt, ...data },
          });
          created++;
        } catch (e) {
          if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        }
      }
    }
    if (created) this.safeEmit(a.company_id, 'comments.new', { platform: 'tiktok', count: created });
    return created;
  }

  async list(companyId: number, q: CommentListQuery) {
    const page = Math.max(1, Math.trunc(q.page ?? 1));
    const limit = Math.min(100, Math.max(1, Math.trunc(q.limit ?? 50)));
    const where: Prisma.SocialCommentWhereInput = { company_id: companyId };
    if (q.platform) where.platform = q.platform;
    if (q.status === 'visible' || q.status === 'hidden') where.status = q.status;
    if (q.status === 'unreplied') {
      where.replied_at = null;
      where.parent_external_id = null;
      where.status = 'visible';
    }
    const term = q.q?.trim().slice(0, 100);
    if (term) where.OR = [{ text: { contains: term } }, { author_name: { contains: term } }, { ad_name: { contains: term } }];
    const [rows, total, unreplied, accounts] = await Promise.all([
      this.prisma.socialComment.findMany({
        where,
        orderBy: [{ commented_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, platform: true, source: true, ad_id: true, ad_name: true, author_name: true, text: true, status: true,
          parent_external_id: true, commented_at: true, reply_text: true, replied_at: true,
        },
      }),
      this.prisma.socialComment.count({ where }),
      this.prisma.socialComment.count({ where: { company_id: companyId, replied_at: null, parent_external_id: null, status: 'visible' } }),
      this.prisma.adAccount.count({ where: { company_id: companyId, platform: 'tiktok', status: 'active' } }),
    ]);
    return { rows, total, page, limit, unreplied, hasAccounts: accounts > 0 };
  }

  private async load(companyId: number, id: number) {
    const c = await this.prisma.socialComment.findFirst({ where: { id, company_id: companyId } });
    if (!c) throw new NotFoundException('Comment not found');
    if (c.platform !== 'tiktok' || !c.account_id) throw new BadRequestException('This comment can only be answered on its platform.');
    const acc = await this.prisma.adAccount.findFirst({ where: { id: c.account_id, company_id: companyId } });
    if (!acc?.token_encrypted) {
      throw new BadRequestException('The TikTok account behind this comment is disconnected. Reconnect it in Growth → Connections.');
    }
    return { c, acc, token: this.encryption.decrypt(acc.token_encrypted) };
  }

  async reply(companyId: number, userId: number, id: number, text: string) {
    const body = text.trim();
    if (!body) throw new BadRequestException('Write a reply first.');
    const { c, acc, token } = await this.load(companyId, id);
    try {
      await replyTikTokComment(token, acc.external_id, (c.raw ?? {}) as Record<string, unknown>, body);
    } catch (e) {
      throw new BadRequestException(`TikTok refused the reply: ${(e as Error).message}`);
    }
    const row = await this.prisma.socialComment.update({
      where: { id: c.id },
      data: { reply_text: body, replied_at: new Date(), replied_by_user_id: userId },
    });
    await this.audit(companyId, userId, 'comment.replied', c.id, { platform: c.platform });
    this.safeEmit(companyId, 'comments.updated', { id: c.id });
    return row;
  }

  async setHidden(companyId: number, userId: number, id: number, hidden: boolean) {
    const { c, acc, token } = await this.load(companyId, id);
    try {
      await setTikTokCommentHidden(token, acc.external_id, c.external_id, hidden);
    } catch (e) {
      throw new BadRequestException(`TikTok refused: ${(e as Error).message}`);
    }
    const row = await this.prisma.socialComment.update({ where: { id: c.id }, data: { status: hidden ? 'hidden' : 'visible' } });
    await this.audit(companyId, userId, hidden ? 'comment.hidden' : 'comment.unhidden', c.id, { platform: c.platform });
    this.safeEmit(companyId, 'comments.updated', { id: c.id });
    return row;
  }

  /** Manual "Check now": pull this tenant's TikTok accounts immediately. */
  async refresh(companyId: number) {
    const accounts = await this.tiktokAccounts([companyId]);
    let created = 0;
    const errors: string[] = [];
    for (const a of accounts) {
      try {
        created += await this.pullAccount(a);
      } catch (e) {
        errors.push(`${a.external_id}: ${(e as Error).message}`);
      }
    }
    return { accounts: accounts.length, created, errors };
  }

  private async audit(companyId: number, userId: number, action: string, entityId: number, metadata: Record<string, unknown>) {
    try {
      await this.prisma.auditLog.create({
        data: { company_id: companyId, user_id: userId, action, entity: 'social_comment', entity_id: entityId, metadata: metadata as Prisma.InputJsonValue },
      });
    } catch (e) {
      this.log.warn(`audit ${action} failed: ${(e as Error).message}`);
    }
  }

  private safeEmit(companyId: number, event: string, payload: unknown) {
    try {
      this.gateway.emitToCompany(companyId, event, payload);
    } catch {
      // a socket failure never blocks a comment action
    }
  }
}
