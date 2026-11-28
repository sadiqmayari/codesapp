import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { FeatureService } from '../../common/services/feature.service';
import { runsBackground } from '../../common/utils/process-role';
import { InboxGateway } from '../inbox/inbox.gateway';
import { MetaSocialService } from '../inbox/meta-social/meta-social.service';
import { listTikTokComments, replyTikTokComment, setTikTokCommentHidden } from './tiktok-comments.client';
import { ConfigService } from '@nestjs/config';
import { YoutubeCreds, channelComments, replyToComment, setCommentHidden } from '../growth/platforms/google/youtube.client';

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
type PullChannel = { id: number; company_id: number; channel_id: string; token_encrypted: string | null };

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Ad / social comments. TikTok ad comments are pulled by a worker poller
 * (TikTok has no comment webhook for ads) from every active TikTok ad account
 * of tenants granted the `social_comments` module, then listed, replied to and
 * hidden from the Comments page. Facebook + Instagram comments arrive by
 * webhook (MetaSocialService writes them); reply/hide go through it too.
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
    private readonly config: ConfigService,
    private readonly metaSocial: MetaSocialService,
  ) {}

  private isMeta(platform: string) {
    return platform === 'facebook' || platform === 'instagram';
  }

  private async loadMeta(companyId: number, id: number) {
    const c = await this.prisma.socialComment.findFirst({ where: { id, company_id: companyId } });
    return c && this.isMeta(c.platform) ? c : null;
  }

  private metaName(platform: string) {
    return platform === 'instagram' ? 'Instagram' : 'Facebook';
  }

  /** Private reply: DM the commenter on Messenger / Instagram (opens an inbox chat). */
  async privateReply(companyId: number, userId: number, id: number, text: string) {
    const body = text.trim();
    if (!body) throw new BadRequestException('Write a message first.');
    const c = await this.loadMeta(companyId, id);
    if (!c) throw new BadRequestException('Private replies work on Facebook and Instagram comments only.');
    let res: { conversationId: number };
    try {
      res = await this.metaSocial.privateReply(companyId, c, body, userId);
    } catch (e) {
      throw new BadRequestException(`${this.metaName(c.platform)} refused the private reply: ${(e as Error).message}`);
    }
    if (!c.replied_at) {
      await this.prisma.socialComment.update({
        where: { id: c.id },
        data: { replied_at: new Date(), replied_by_user_id: userId, reply_text: `(private) ${body}`.slice(0, 5000) },
      });
    }
    await this.audit(companyId, userId, 'comment.private_reply', c.id, { platform: c.platform });
    this.safeEmit(companyId, 'comments.updated', { id: c.id });
    return res;
  }

  private ytCreds(tokenEncrypted: string | null): YoutubeCreds {
    if (!tokenEncrypted) throw new BadRequestException('The YouTube channel behind this comment is disconnected. Reconnect it in Growth → Connections.');
    return {
      clientId: this.config.get<string>('GOOGLE_ADS_CLIENT_ID') ?? '',
      clientSecret: this.config.get<string>('GOOGLE_ADS_CLIENT_SECRET') ?? '',
      refresh: this.encryption.decrypt(tokenEncrypted),
    };
  }

  private youtubeChannels(companyIds: number[]) {
    return this.prisma.youtubeChannel.findMany({
      where: { company_id: { in: companyIds }, status: 'active', token_encrypted: { not: null } },
      select: { id: true, company_id: true, channel_id: true, token_encrypted: true },
    });
  }

  /** YouTube comments on the channel's videos since the newest stored one (- 1 h); first run 14 days. */
  async pullYoutube(ch: PullChannel) {
    const last = await this.prisma.socialComment.findFirst({
      where: { company_id: ch.company_id, platform: 'youtube', account_id: ch.id },
      orderBy: { commented_at: 'desc' },
      select: { commented_at: true },
    });
    const since = new Date(last ? last.commented_at.getTime() - OVERLAP_MS : Date.now() - FIRST_PULL_DAYS * 86_400_000);
    const rows = await channelComments(this.ytCreds(ch.token_encrypted), ch.channel_id, since);
    if (!rows.length) return 0;
    const vids = await this.prisma.youtubeVideo.findMany({
      where: { company_id: ch.company_id, video_id: { in: [...new Set(rows.map((r) => r.videoId).filter((v): v is string => !!v))] } },
      select: { video_id: true, title: true, used_in_ads: true },
    });
    const byVid = new Map(vids.map((v) => [v.video_id, v]));
    let created = 0;
    for (const c of rows) {
      if (c.commentedAt < since && !last) continue;
      const key = { company_id: ch.company_id, platform: 'youtube', external_id: c.externalId.slice(0, 64) };
      const v = c.videoId ? byVid.get(c.videoId) : undefined;
      const data = {
        parent_external_id: c.parentExternalId?.slice(0, 64) ?? null,
        ad_id: null,
        ad_name: v?.title?.slice(0, 255) ?? null,
        post_id: c.videoId?.slice(0, 64) ?? null,
        author_name: c.authorName?.slice(0, 255) ?? null,
        author_id: c.authorId?.slice(0, 128) ?? null,
        text: c.text || '(no text)',
        status: c.hidden ? 'hidden' : 'visible',
        raw: c.raw as Prisma.InputJsonValue,
      };
      const existing = await this.prisma.socialComment.findUnique({ where: { company_id_platform_external_id: key }, select: { id: true } });
      if (existing) {
        await this.prisma.socialComment.update({ where: { id: existing.id }, data });
        continue;
      }
      try {
        await this.prisma.socialComment.create({
          data: { ...key, source: v?.used_in_ads ? 'ad' : 'organic', account_id: ch.id, commented_at: c.commentedAt, ...data },
        });
        created++;
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      }
    }
    if (created) this.safeEmit(ch.company_id, 'comments.new', { platform: 'youtube', count: created });
    return created;
  }

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
      for (const ch of await this.youtubeChannels(Array.from(granted))) {
        try {
          const n = await this.pullYoutube(ch);
          if (n) this.log.log(`youtube comments: ${n} new for company ${ch.company_id} channel ${ch.channel_id}`);
        } catch (e) {
          this.log.warn(`youtube comments pull failed (company ${ch.company_id}, ${ch.channel_id}): ${(e as Error).message}`);
        }
      }
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
    // TikTok lists comments per ad group: every ad group that had delivery in the window (cap 150).
    const groups = await this.prisma.adInsightDaily.groupBy({
      by: ['adset_id'],
      where: { account_id: a.id, company_id: a.company_id, date: { gte: new Date(`${since}T00:00:00Z`) }, impressions: { gt: 0 }, adset_id: { not: null } },
      _sum: { spend: true },
      orderBy: { _sum: { spend: 'desc' } },
      take: 150,
    });
    const adgroupIds = groups.map((g) => g.adset_id).filter((x): x is string => !!x);
    if (!adgroupIds.length) return 0;
    const rows = await listTikTokComments(token, a.external_id, adgroupIds, since, ymd(new Date()));
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
    const [rows, total, unreplied, accounts, channels, meta, byPlatform] = await Promise.all([
      this.prisma.socialComment.findMany({
        where,
        orderBy: [{ commented_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, platform: true, source: true, ad_id: true, ad_name: true, post_id: true, author_name: true, text: true, status: true,
          parent_external_id: true, commented_at: true, reply_text: true, replied_at: true,
        },
      }),
      this.prisma.socialComment.count({ where }),
      this.prisma.socialComment.count({ where: { company_id: companyId, replied_at: null, parent_external_id: null, status: 'visible' } }),
      this.prisma.adAccount.count({ where: { company_id: companyId, platform: 'tiktok', status: 'active' } }),
      this.prisma.youtubeChannel.count({ where: { company_id: companyId, status: 'active' } }),
      this.metaSocial.hasPages(companyId),
      this.prisma.socialComment.groupBy({
        by: ['platform'],
        where: { company_id: companyId, replied_at: null, parent_external_id: null, status: 'visible' },
        _count: { _all: true },
      }),
    ]);
    const unrepliedByPlatform: Record<string, number> = {};
    for (const g of byPlatform) unrepliedByPlatform[g.platform] = g._count._all;
    return {
      rows,
      total,
      page,
      limit,
      unreplied,
      unrepliedByPlatform,
      hasAccounts: accounts + channels > 0 || meta.facebook,
      hasTikTok: accounts > 0,
      hasYoutube: channels > 0,
      hasFacebook: meta.facebook,
      hasInstagram: meta.instagram,
    };
  }

  private async loadYoutube(companyId: number, id: number) {
    const c = await this.prisma.socialComment.findFirst({ where: { id, company_id: companyId, platform: 'youtube' } });
    if (!c?.account_id) return null;
    const ch = await this.prisma.youtubeChannel.findFirst({ where: { id: c.account_id, company_id: companyId } });
    return { c, creds: this.ytCreds(ch?.token_encrypted ?? null) };
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
    const mc = await this.loadMeta(companyId, id);
    if (mc) {
      try {
        await this.metaSocial.replyToComment(companyId, mc, body);
      } catch (e) {
        throw new BadRequestException(`${this.metaName(mc.platform)} refused the reply: ${(e as Error).message}`);
      }
      const row = await this.prisma.socialComment.update({
        where: { id: mc.id },
        data: { reply_text: body, replied_at: new Date(), replied_by_user_id: userId },
      });
      await this.audit(companyId, userId, 'comment.replied', mc.id, { platform: mc.platform });
      this.safeEmit(companyId, 'comments.updated', { id: mc.id });
      return row;
    }
    const yt = await this.loadYoutube(companyId, id);
    if (yt) {
      try {
        // YouTube replies attach to the top-level comment of the thread.
        await replyToComment(yt.creds, yt.c.parent_external_id ?? yt.c.external_id, body);
      } catch (e) {
        throw new BadRequestException(`YouTube refused the reply: ${(e as Error).message}`);
      }
      const row = await this.prisma.socialComment.update({ where: { id: yt.c.id }, data: { reply_text: body, replied_at: new Date(), replied_by_user_id: userId } });
      await this.audit(companyId, userId, 'comment.replied', yt.c.id, { platform: 'youtube' });
      this.safeEmit(companyId, 'comments.updated', { id: yt.c.id });
      return row;
    }
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
    const mc = await this.loadMeta(companyId, id);
    if (mc) {
      try {
        await this.metaSocial.setCommentHidden(companyId, mc, hidden);
      } catch (e) {
        throw new BadRequestException(`${this.metaName(mc.platform)} refused: ${(e as Error).message}`);
      }
      const row = await this.prisma.socialComment.update({ where: { id: mc.id }, data: { status: hidden ? 'hidden' : 'visible' } });
      await this.audit(companyId, userId, hidden ? 'comment.hidden' : 'comment.unhidden', mc.id, { platform: mc.platform });
      this.safeEmit(companyId, 'comments.updated', { id: mc.id });
      return row;
    }
    const yt = await this.loadYoutube(companyId, id);
    if (yt) {
      try {
        await setCommentHidden(yt.creds, yt.c.external_id, hidden);
      } catch (e) {
        throw new BadRequestException(`YouTube refused: ${(e as Error).message}`);
      }
      const row = await this.prisma.socialComment.update({ where: { id: yt.c.id }, data: { status: hidden ? 'hidden' : 'visible' } });
      await this.audit(companyId, userId, hidden ? 'comment.hidden' : 'comment.unhidden', yt.c.id, { platform: 'youtube' });
      this.safeEmit(companyId, 'comments.updated', { id: yt.c.id });
      return row;
    }
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
    const channels = await this.youtubeChannels([companyId]);
    for (const ch of channels) {
      try {
        created += await this.pullYoutube(ch);
      } catch (e) {
        errors.push(`YouTube ${ch.channel_id}: ${(e as Error).message}`);
      }
    }
    for (const a of accounts) {
      try {
        created += await this.pullAccount(a);
      } catch (e) {
        errors.push(`${a.external_id}: ${(e as Error).message}`);
      }
    }
    const meta = await this.metaSocial.hasPages(companyId);
    if (meta.facebook) {
      try {
        created += await this.metaSocial.backfillComments(companyId);
      } catch (e) {
        errors.push(`Facebook/Instagram: ${(e as Error).message}`);
      }
    }
    return { accounts: accounts.length + channels.length + (meta.facebook ? 1 : 0), created, errors };
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
