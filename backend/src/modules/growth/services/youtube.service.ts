import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { EncryptionService } from '../../../common/services/encryption.service';
import { JobQueueService } from '../../../common/services/job-queue.service';
import { FeatureService } from '../../../common/services/feature.service';
import { runsBackground } from '../../../common/utils/process-role';
import { AdPlatformAuthError, AdPlatformRateLimitError } from '../platforms/ad-platform.types';
import { GoogleOAuthService } from '../platforms/google/google-oauth.service';
import { YoutubeCreds, channelById, channelDaily, recentVideos, uploadUnlisted } from '../platforms/google/youtube.client';
import { GrowthVersionService } from './growth-version.service';
import { addDays, n } from '../growth.util';

export const YOUTUBE_QUEUE = 'growth-youtube';
const TICK_MS = 60 * 60_000;
const SYNC_EVERY_MS = 6 * 3_600_000;
const FIRST_DAYS = 90;
const REFRESH_DAYS = 7;

type ChannelRow = { id: number; company_id: number; channel_id: string; uploads_playlist_id: string | null; token_encrypted: string | null };

/**
 * YouTube channels for Growth: connect (after "Connect YouTube channel"),
 * background sync (channel stats, recent uploads, daily analytics), the
 * channel ↔ Google Ads link (videos played by the tenant's ads), the YouTube
 * report, and unlisted uploads for Google video ads.
 */
@Injectable()
export class YoutubeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(YoutubeService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly jobs: JobQueueService,
    private readonly feature: FeatureService,
    private readonly config: ConfigService,
    private readonly oauth: GoogleOAuthService,
    private readonly version: GrowthVersionService,
  ) {}

  onModuleInit() {
    this.jobs.registerWorker(YOUTUBE_QUEUE, (p) => this.handle(p as { channelId: number; days?: number }), 1, 600);
    if (!runsBackground()) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.logger.warn(`tick: ${e}`)), TICK_MS);
    setTimeout(() => void this.tick().catch(() => undefined), 120_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  creds(tokenEncrypted: string | null): YoutubeCreds {
    const clientId = this.config.get<string>('GOOGLE_ADS_CLIENT_ID') ?? '';
    const clientSecret = this.config.get<string>('GOOGLE_ADS_CLIENT_SECRET') ?? '';
    if (!clientId || !clientSecret) throw new ServiceUnavailableException('Google is not set up yet.');
    if (!tokenEncrypted) throw new AdPlatformAuthError('This YouTube channel has no sign-in. Reconnect it.', 'token');
    return { clientId, clientSecret, refresh: this.encryption.decrypt(tokenEncrypted) };
  }

  // ── connect / list / disconnect ───────────────────────────────────────────
  async connect(companyId: number, pickId: string, channelIds: string[]) {
    const pick = await this.oauth.takePick(companyId, pickId, 'youtube');
    const allowed = new Map((pick.channels ?? []).map((c) => [c.id, c]));
    const token = this.encryption.encrypt(pick.refresh);
    const connected: number[] = [];
    const failed: Array<{ channelId: string; error: string }> = [];
    for (const id of [...new Set(channelIds)]) {
      const c = allowed.get(id);
      if (!c) {
        failed.push({ channelId: id, error: 'Not part of this Google sign-in.' });
        continue;
      }
      const data = {
        title: c.title?.slice(0, 255) ?? null, handle: c.handle?.slice(0, 128) ?? null, thumb_url: c.thumb,
        uploads_playlist_id: c.uploadsPlaylistId, token_encrypted: token, status: 'active', subscribers: c.subscribers,
        views: BigInt(Math.round(c.views)), videos: c.videos, last_error: null,
      };
      const row = await this.prisma.youtubeChannel.upsert({
        where: { company_id_channel_id: { company_id: companyId, channel_id: id } },
        create: { company_id: companyId, channel_id: id, ...data },
        update: { ...data, connected_at: new Date() },
      });
      connected.push(row.id);
      await this.request(row.id, FIRST_DAYS);
    }
    return { connected: connected.length, failed };
  }

  async list(companyId: number) {
    const rows = await this.prisma.youtubeChannel.findMany({ where: { company_id: companyId, status: { not: 'disconnected' } }, orderBy: { id: 'asc' } });
    const videos = await this.prisma.youtubeVideo.groupBy({
      by: ['channel_id'], where: { company_id: companyId, used_in_ads: true }, _count: { _all: true },
    });
    const usedBy = new Map(videos.map((v) => [v.channel_id, v._count._all]));
    const link = await this.adLinks(companyId);
    return {
      available: this.oauth.youtubeAvailable(),
      channels: rows.map((r) => ({
        id: r.id, channelId: r.channel_id, title: r.title, handle: r.handle, thumb: r.thumb_url, status: r.status,
        subscribers: r.subscribers, views: Number(r.views), videos: r.videos, lastSuccessAt: r.last_success_at, lastError: r.last_error,
        connectedAt: r.connected_at, videosInAds: usedBy.get(r.id) ?? 0,
        adAccounts: link.byChannel.get(r.id) ?? [],
      })),
      /** Videos played by the tenant's Google ads whose channel isn't connected. */
      unconnectedAdVideos: link.orphanCount,
    };
  }

  async disconnect(companyId: number, id: number) {
    const ch = await this.prisma.youtubeChannel.findFirst({ where: { id, company_id: companyId } });
    if (!ch) throw new NotFoundException('YouTube channel not found');
    await this.prisma.$transaction([
      this.prisma.youtubeChannelDaily.deleteMany({ where: { company_id: companyId, channel_id: ch.id } }),
      this.prisma.youtubeVideo.deleteMany({ where: { company_id: companyId, channel_id: ch.id } }),
      this.prisma.youtubeChannel.delete({ where: { id: ch.id } }),
    ]);
    this.version.bump(companyId, 'spend');
    return { success: true };
  }

  // ── sync ──────────────────────────────────────────────────────────────────
  async request(channelId: number, days = REFRESH_DAYS) {
    await this.jobs.enqueue(YOUTUBE_QUEUE, { channelId, days }, { dedupKey: `growth:yt:${channelId}`, maxAttempts: 2 });
    return { started: true };
  }

  async requestForCompany(companyId: number) {
    const rows = await this.prisma.youtubeChannel.findMany({ where: { company_id: companyId, status: 'active' }, select: { id: true } });
    for (const r of rows) await this.request(r.id);
    return { started: rows.length };
  }

  private async tick() {
    const granted = await this.feature.companiesWith('growth');
    if (!granted.size) return;
    const due = await this.prisma.youtubeChannel.findMany({
      where: {
        company_id: { in: [...granted] },
        status: 'active',
        OR: [{ last_attempt_at: null }, { last_attempt_at: { lt: new Date(Date.now() - SYNC_EVERY_MS) } }],
      },
      select: { id: true, last_success_at: true },
    });
    for (const c of due) await this.request(c.id, c.last_success_at ? REFRESH_DAYS : FIRST_DAYS);
  }

  private async handle(job: { channelId: number; days?: number }) {
    const ch = await this.prisma.youtubeChannel.findUnique({ where: { id: job.channelId } });
    if (!ch || ch.status !== 'active') return;
    await this.prisma.youtubeChannel.update({ where: { id: ch.id }, data: { last_attempt_at: new Date() } });
    try {
      await this.syncChannel(ch, job.days ?? REFRESH_DAYS);
      await this.prisma.youtubeChannel.update({ where: { id: ch.id }, data: { last_success_at: new Date(), last_error: null } });
      await this.markUsedInAds(ch.company_id);
      this.version.bump(ch.company_id, 'spend');
    } catch (e) {
      const msg = (e as Error).message?.slice(0, 500) ?? 'YouTube sync failed';
      await this.prisma.youtubeChannel.update({ where: { id: ch.id }, data: { last_error: msg } });
      if (e instanceof AdPlatformRateLimitError || e instanceof AdPlatformAuthError) return; // retry next tick, no job retry storm
      throw e;
    }
  }

  async syncChannel(ch: ChannelRow, days: number) {
    const creds = this.creds(ch.token_encrypted);
    const info = await channelById(creds, ch.channel_id);
    if (info) {
      await this.prisma.youtubeChannel.update({
        where: { id: ch.id },
        data: {
          title: info.title?.slice(0, 255) ?? null, handle: info.handle?.slice(0, 128) ?? null, thumb_url: info.thumb,
          uploads_playlist_id: info.uploadsPlaylistId, subscribers: info.subscribers, views: BigInt(Math.round(info.views)), videos: info.videos,
        },
      });
    }
    const playlist = info?.uploadsPlaylistId ?? ch.uploads_playlist_id;
    if (playlist) {
      for (const v of await recentVideos(creds, playlist, 500)) {
        const data = {
          channel_id: ch.id, title: v.title?.slice(0, 255) ?? null, thumb_url: v.thumb, published_at: v.publishedAt ? new Date(v.publishedAt) : null,
          duration_s: v.durationS, privacy: v.privacy?.slice(0, 16) ?? null, views: BigInt(Math.round(v.views)), likes: v.likes, comments: v.comments,
        };
        await this.prisma.youtubeVideo.upsert({
          where: { company_id_video_id: { company_id: ch.company_id, video_id: v.id } },
          create: { company_id: ch.company_id, video_id: v.id, ...data },
          update: data,
        });
      }
    }
    const until = addDays(new Date().toISOString().slice(0, 10), -1);
    const since = addDays(until, -(Math.max(1, Math.min(365, days)) - 1));
    try {
      for (const d of await channelDaily(creds, since, until)) {
        const data = {
          views: d.views, watch_minutes: Math.round(d.watchMinutes), subs_gained: d.subsGained, subs_lost: d.subsLost,
          likes: d.likes, comments: d.comments, shares: d.shares,
        };
        await this.prisma.youtubeChannelDaily.upsert({
          where: { channel_id_date: { channel_id: ch.id, date: new Date(`${d.date}T00:00:00Z`) } },
          create: { company_id: ch.company_id, channel_id: ch.id, date: new Date(`${d.date}T00:00:00Z`), ...data },
          update: data,
        });
      }
    } catch (e) {
      // Analytics can be off for brand-new channels; stats + videos still count as a sync.
      this.logger.warn(`youtube analytics (channel ${ch.id}): ${(e as Error).message}`);
      if (e instanceof AdPlatformAuthError && e.kind === 'token') throw e;
    }
  }

  /** used_in_ads = the video is played by one of this tenant's Google ads. */
  async markUsedInAds(companyId: number) {
    await this.prisma.$executeRawUnsafe(
      `UPDATE youtube_videos v SET used_in_ads = EXISTS (
         SELECT 1 FROM ad_entities e WHERE e.company_id = v.company_id AND e.platform = 'google'
            AND e.youtube_video_id COLLATE utf8mb4_general_ci = v.video_id COLLATE utf8mb4_general_ci)
        WHERE v.company_id = ?`,
      companyId,
    );
  }

  /** channel row id → the Google Ads accounts whose ads play its videos; + ad videos from unconnected channels. */
  private async adLinks(companyId: number) {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ channel_id: number | null; account_id: number; name: string | null; ads: bigint; videos: bigint }>>(
      `SELECT v.channel_id, e.account_id, a.name, COUNT(DISTINCT e.external_id) ads, COUNT(DISTINCT e.youtube_video_id) videos
         FROM ad_entities e
         JOIN ad_accounts a ON a.id = e.account_id
         LEFT JOIN youtube_videos v ON v.company_id = e.company_id AND v.video_id COLLATE utf8mb4_general_ci = e.youtube_video_id COLLATE utf8mb4_general_ci
        WHERE e.company_id = ? AND e.platform = 'google' AND e.level = 'ad' AND e.youtube_video_id IS NOT NULL
        GROUP BY v.channel_id, e.account_id, a.name`,
      companyId,
    );
    const byChannel = new Map<number, Array<{ accountId: number; name: string | null; ads: number; videos: number }>>();
    let orphanCount = 0;
    for (const r of rows) {
      if (r.channel_id == null) {
        orphanCount += Number(r.videos);
        continue;
      }
      const list = byChannel.get(r.channel_id) ?? [];
      list.push({ accountId: r.account_id, name: r.name, ads: Number(r.ads), videos: Number(r.videos) });
      byChannel.set(r.channel_id, list);
    }
    return { byChannel, orphanCount };
  }

  // ── report ────────────────────────────────────────────────────────────────
  async overview(companyId: number, q: { from?: string; to?: string; channelId?: number }) {
    const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to ?? '') ? q.to! : new Date().toISOString().slice(0, 10);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from ?? '') ? q.from! : addDays(to, -27);
    const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1);
    const pFrom = addDays(from, -days);
    const pTo = addDays(from, -1);
    const channels = await this.prisma.youtubeChannel.findMany({
      where: { company_id: companyId, status: 'active', ...(q.channelId ? { id: q.channelId } : {}) },
      select: { id: true, title: true, handle: true, subscribers: true, views: true, videos: true, thumb_url: true },
    });
    const chIds = channels.map((c) => c.id);
    const inCh = chIds.length ? `AND channel_id IN (${chIds.map(Number).join(',')})` : 'AND 1 = 0';
    const sumOrganic = async (a: string, b: string) => {
      const [r] = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT SUM(views) v, SUM(watch_minutes) w, SUM(subs_gained) g, SUM(subs_lost) l, SUM(likes) k, SUM(comments) c
           FROM youtube_channel_daily WHERE company_id = ? ${inCh} AND date BETWEEN ? AND ?`,
        companyId, a, b,
      );
      return { views: n(r?.v), watchHours: n(r?.w) / 60, subsNet: n(r?.g) - n(r?.l), likes: n(r?.k), comments: n(r?.c) };
    };
    const sumAds = async (a: string, b: string) => {
      const [r] = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT SUM(i.spend_base) s, SUM(i.impressions) im, SUM(i.thruplay) v, SUM(i.purchases) p, COUNT(DISTINCT e.youtube_video_id) vids
           FROM ad_insights_daily i
           JOIN ad_entities e ON e.account_id = i.account_id AND e.level = 'ad' AND e.external_id = i.ad_id
          WHERE i.company_id = ? AND i.platform = 'google' AND e.youtube_video_id IS NOT NULL AND i.date BETWEEN ? AND ?`,
        companyId, a, b,
      );
      const spend = n(r?.s);
      const views = n(r?.v);
      const imp = n(r?.im);
      return { spend, impressions: imp, views, purchases: n(r?.p), videos: n(r?.vids), cpv: views > 0 ? spend / views : null, viewRate: imp > 0 ? views / imp : null };
    };
    const [organic, organicPrev, ads, adsPrev] = await Promise.all([sumOrganic(from, to), sumOrganic(pFrom, pTo), sumAds(from, to), sumAds(pFrom, pTo)]);
    const trend = await this.prisma.$queryRawUnsafe<Array<{ d: Date; v: unknown }>>(
      `SELECT date d, SUM(views) v FROM youtube_channel_daily WHERE company_id = ? ${inCh} AND date BETWEEN ? AND ? GROUP BY date ORDER BY date`,
      companyId, from, to,
    );
    const adTrend = await this.prisma.$queryRawUnsafe<Array<{ d: Date; v: unknown; s: unknown }>>(
      `SELECT i.date d, SUM(i.thruplay) v, SUM(i.spend_base) s FROM ad_insights_daily i
         JOIN ad_entities e ON e.account_id = i.account_id AND e.level = 'ad' AND e.external_id = i.ad_id
        WHERE i.company_id = ? AND i.platform = 'google' AND e.youtube_video_id IS NOT NULL AND i.date BETWEEN ? AND ?
        GROUP BY i.date ORDER BY i.date`,
      companyId, from, to,
    );
    const ymd = (d: Date) => new Date(d).toISOString().slice(0, 10);
    const series = new Map<string, { date: string; organic: number; ads: number; adSpend: number }>();
    for (let i = 0; i < days; i++) {
      const k = addDays(from, i);
      series.set(k, { date: k, organic: 0, ads: 0, adSpend: 0 });
    }
    for (const r of trend) { const x = series.get(ymd(r.d)); if (x) x.organic = n(r.v); }
    for (const r of adTrend) { const x = series.get(ymd(r.d)); if (x) { x.ads = n(r.v); x.adSpend = n(r.s); } }
    // Per-video: lifetime organic stats + in-period ad results + attributed net (last click, 7 d).
    const vids = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT v.video_id, v.title, v.thumb_url, v.published_at, v.views, v.likes, v.comments, v.used_in_ads,
              a.spend, a.impressions, a.views ad_views, a.purchases, a.ads, a.ad_ids
         FROM youtube_videos v
         LEFT JOIN (
           SELECT e.youtube_video_id vid, SUM(i.spend_base) spend, SUM(i.impressions) impressions, SUM(i.thruplay) views,
                  SUM(i.purchases) purchases, COUNT(DISTINCT e.external_id) ads, GROUP_CONCAT(DISTINCT e.external_id) ad_ids
             FROM ad_entities e
             JOIN ad_insights_daily i ON i.account_id = e.account_id AND i.ad_id = e.external_id AND i.date BETWEEN ? AND ?
            WHERE e.company_id = ? AND e.platform = 'google' AND e.level = 'ad' AND e.youtube_video_id IS NOT NULL
            GROUP BY e.youtube_video_id
         ) a ON a.vid COLLATE utf8mb4_general_ci = v.video_id COLLATE utf8mb4_general_ci
        WHERE v.company_id = ? ${chIds.length ? `AND v.channel_id IN (${chIds.map(Number).join(',')})` : 'AND 1 = 0'}
        ORDER BY COALESCE(a.spend, 0) DESC, v.published_at DESC
        LIMIT 50`,
      from, to, companyId, companyId,
    );
    const adIds = vids.flatMap((v) => String(v.ad_ids ?? '').split(',').filter(Boolean));
    const netByAd = new Map<string, number>();
    if (adIds.length) {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ ad_id: string; net: unknown }>>(
        `SELECT ad_id, SUM(net * credit) net FROM growth_attribution
          WHERE company_id = ? AND model = 'last' AND win = 7 AND platform = 'google' AND order_date BETWEEN ? AND ?
            AND ad_id IN (${adIds.map(() => '?').join(',')}) GROUP BY ad_id`,
        companyId, from, to, ...adIds,
      );
      for (const r of rows) netByAd.set(r.ad_id, n(r.net));
    }
    const topVideos = vids.map((v) => {
      const ids = String(v.ad_ids ?? '').split(',').filter(Boolean);
      const spend = n(v.spend);
      const adViews = n(v.ad_views);
      const imp = n(v.impressions);
      return {
        videoId: String(v.video_id), title: (v.title as string) ?? null, thumb: (v.thumb_url as string) ?? null,
        publishedAt: v.published_at ?? null, views: n(v.views), likes: n(v.likes), comments: n(v.comments),
        usedInAds: !!Number(v.used_in_ads), ads: n(v.ads), adSpend: spend, adViews,
        viewRate: imp > 0 ? adViews / imp : null, cpv: adViews > 0 ? spend / adViews : null,
        purchases: n(v.purchases), net: ids.reduce((s, id) => s + (netByAd.get(id) ?? 0), 0),
      };
    });
    return {
      from, to,
      channels: channels.map((c) => ({ id: c.id, title: c.title, handle: c.handle, subscribers: c.subscribers, views: Number(c.views), videos: c.videos, thumb: c.thumb_url })),
      organic, organicPrev, ads, adsPrev,
      trend: [...series.values()],
      topVideos,
    };
  }

  // ── uploads for Google video ads ──────────────────────────────────────────
  /** Upload to the tenant's first connected channel as UNLISTED; returns the YouTube video id. */
  async uploadForAds(companyId: number, file: { buffer: Buffer; mimetype: string; originalname: string }) {
    const ch = await this.prisma.youtubeChannel.findFirst({ where: { company_id: companyId, status: 'active' }, orderBy: { id: 'asc' } });
    if (!ch) throw new BadRequestException('Connect a YouTube channel first (Growth → Connections) — Google video ads play YouTube videos.');
    const id = await uploadUnlisted(this.creds(ch.token_encrypted), file.buffer, file.originalname.replace(/\.[a-z0-9]+$/i, ''), file.mimetype);
    void this.request(ch.id, 1);
    return id;
  }

  /** Connected-channel videos for the Google builder (newest first). */
  async videosForBuilder(companyId: number) {
    const rows = await this.prisma.youtubeVideo.findMany({
      where: { company_id: companyId },
      orderBy: { published_at: 'desc' },
      take: 60,
      select: { video_id: true, title: true, thumb_url: true },
    });
    return rows.map((r) => ({ id: r.video_id, title: r.title, thumb: r.thumb_url }));
  }
}
