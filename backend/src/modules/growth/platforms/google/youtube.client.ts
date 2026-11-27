import * as https from 'https';
import { AdPlatformAuthError, AdPlatformRateLimitError } from '../ad-platform.types';
import { httpJson } from '../http';
import { googleAccessToken } from './google-ads.client';

/**
 * YouTube Data API v3 + YouTube Analytics API v2 (plain functions so both the
 * Growth module and the social-comments module can use them without a module
 * import). Auth = the channel owner's Google refresh token.
 */

const DATA = 'https://www.googleapis.com/youtube/v3';
const ANALYTICS = 'https://youtubeanalytics.googleapis.com/v2';

export interface YoutubeCreds {
  clientId: string;
  clientSecret: string;
  refresh: string;
}

export interface YtChannel {
  id: string;
  title: string | null;
  handle: string | null;
  thumb: string | null;
  uploadsPlaylistId: string | null;
  subscribers: number;
  views: number;
  videos: number;
}

export interface YtVideo {
  id: string;
  title: string | null;
  thumb: string | null;
  publishedAt: string | null;
  durationS: number | null;
  privacy: string | null;
  views: number;
  likes: number;
  comments: number;
}

export interface YtDaily {
  date: string;
  views: number;
  watchMinutes: number;
  subsGained: number;
  subsLost: number;
  likes: number;
  comments: number;
  shares: number;
}

export interface YtComment {
  externalId: string;
  parentExternalId: string | null;
  videoId: string | null;
  authorName: string | null;
  authorId: string | null;
  text: string;
  hidden: boolean;
  commentedAt: Date;
  raw: Record<string, unknown>;
}

const n = (v: unknown) => Number(v ?? 0) || 0;

/** ISO-8601 duration (PT1H2M3S) → seconds. */
export function isoDurationSeconds(d: string | null | undefined): number | null {
  if (!d) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d);
  if (!m) return null;
  return n(m[1]) * 86400 + n(m[2]) * 3600 + n(m[3]) * 60 + n(m[4]);
}

/** YouTube's HTML-ish comment text → plain text. */
export function plainText(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function ytError(body: unknown, status: number): Error {
  const err = (body as { error?: { message?: string; errors?: Array<{ reason?: string }> } })?.error;
  const reason = err?.errors?.[0]?.reason ?? '';
  const msg = err?.message ?? `YouTube API error ${status}`;
  if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded' || status === 429) {
    return new AdPlatformRateLimitError('YouTube API quota reached for today; resumes automatically.', 60 * 60_000);
  }
  if (status === 401) return new AdPlatformAuthError('YouTube sign-in expired. Reconnect the channel in Growth → Connections.', 'token');
  if (status === 403) return new AdPlatformAuthError(msg, 'permission');
  return new AdPlatformAuthError(msg.slice(0, 500), 'other');
}

async function call<T>(c: YoutubeCreds, method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const token = await googleAccessToken(c.clientId, c.clientSecret, c.refresh);
  const res = await httpJson<T>(method, url, { Authorization: `Bearer ${token}` }, body);
  if (res.status >= 400) throw ytError(res.body, res.status);
  return res.body;
}

export function parseChannel(it: Record<string, any>): YtChannel {
  const sn = it.snippet ?? {};
  const st = it.statistics ?? {};
  return {
    id: String(it.id),
    title: sn.title ?? null,
    handle: sn.customUrl ?? null,
    thumb: sn.thumbnails?.medium?.url ?? sn.thumbnails?.default?.url ?? null,
    uploadsPlaylistId: it.contentDetails?.relatedPlaylists?.uploads ?? null,
    subscribers: n(st.subscriberCount),
    views: n(st.viewCount),
    videos: n(st.videoCount),
  };
}

/** Channels owned by the signed-in user (the one picked on Google's consent screen). */
export async function myChannels(c: YoutubeCreds): Promise<YtChannel[]> {
  const r = await call<{ items?: Array<Record<string, any>> }>(c, 'GET', `${DATA}/channels?part=snippet,contentDetails,statistics&mine=true&maxResults=50`);
  return (r.items ?? []).map(parseChannel);
}

export async function channelById(c: YoutubeCreds, id: string): Promise<YtChannel | null> {
  const r = await call<{ items?: Array<Record<string, any>> }>(c, 'GET', `${DATA}/channels?part=snippet,contentDetails,statistics&id=${encodeURIComponent(id)}`);
  return r.items?.[0] ? parseChannel(r.items[0]) : null;
}

/** Most recent uploads (≤ max), with stats. ~1 + max/50 × 2 quota units. */
export async function recentVideos(c: YoutubeCreds, uploadsPlaylistId: string, max = 500): Promise<YtVideo[]> {
  const ids: string[] = [];
  let page: string | undefined;
  while (ids.length < max) {
    const r = await call<{ items?: Array<{ contentDetails?: { videoId?: string } }>; nextPageToken?: string }>(
      c,
      'GET',
      `${DATA}/playlistItems?part=contentDetails&maxResults=50&playlistId=${encodeURIComponent(uploadsPlaylistId)}${page ? `&pageToken=${page}` : ''}`,
    );
    for (const it of r.items ?? []) if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
    page = r.nextPageToken;
    if (!page) break;
  }
  return videosByIds(c, ids.slice(0, max));
}

export async function videosByIds(c: YoutubeCreds, ids: string[]): Promise<YtVideo[]> {
  const out: YtVideo[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    const r = await call<{ items?: Array<Record<string, any>> }>(
      c,
      'GET',
      `${DATA}/videos?part=snippet,contentDetails,statistics,status&id=${part.map(encodeURIComponent).join(',')}`,
    );
    for (const it of r.items ?? []) {
      const sn = it.snippet ?? {};
      const st = it.statistics ?? {};
      out.push({
        id: String(it.id),
        title: sn.title ?? null,
        thumb: sn.thumbnails?.medium?.url ?? sn.thumbnails?.default?.url ?? null,
        publishedAt: sn.publishedAt ?? null,
        durationS: isoDurationSeconds(it.contentDetails?.duration),
        privacy: it.status?.privacyStatus ?? null,
        views: n(st.viewCount),
        likes: n(st.likeCount),
        comments: n(st.commentCount),
      });
    }
  }
  return out;
}

/** Daily channel metrics from YouTube Analytics (channel==MINE). */
export async function channelDaily(c: YoutubeCreds, since: string, until: string): Promise<YtDaily[]> {
  const metrics = 'views,estimatedMinutesWatched,subscribersGained,subscribersLost,likes,comments,shares';
  const q = `ids=channel%3D%3DMINE&startDate=${since}&endDate=${until}&metrics=${metrics}&dimensions=day&sort=day`;
  const r = await call<{ rows?: Array<Array<string | number>> }>(c, 'GET', `${ANALYTICS}/reports?${q}`);
  return (r.rows ?? []).map((row) => ({
    date: String(row[0]),
    views: n(row[1]),
    watchMinutes: n(row[2]),
    subsGained: n(row[3]),
    subsLost: n(row[4]),
    likes: n(row[5]),
    comments: n(row[6]),
    shares: n(row[7]),
  }));
}

export function parseThread(t: Record<string, any>): YtComment[] {
  const top = t.snippet?.topLevelComment;
  const out: YtComment[] = [];
  const one = (cm: Record<string, any>, parent: string | null): YtComment | null => {
    const sn = cm?.snippet ?? {};
    if (!cm?.id) return null;
    return {
      externalId: String(cm.id),
      parentExternalId: parent,
      videoId: sn.videoId ?? t.snippet?.videoId ?? null,
      authorName: sn.authorDisplayName ?? null,
      authorId: sn.authorChannelId?.value ?? null,
      text: plainText(sn.textOriginal ?? sn.textDisplay),
      hidden: sn.moderationStatus === 'heldForReview' || sn.moderationStatus === 'rejected',
      commentedAt: new Date(sn.publishedAt ?? Date.now()),
      raw: { id: cm.id, videoId: sn.videoId ?? t.snippet?.videoId ?? null, channelId: sn.channelId ?? t.snippet?.channelId ?? null, threadId: t.id },
    };
  };
  const first = one(top, null);
  if (first) out.push(first);
  for (const r of t.replies?.comments ?? []) {
    const x = one(r, first?.externalId ?? null);
    if (x) out.push(x);
  }
  return out;
}

/**
 * Comment threads on all the channel's videos, newest first, stopping at
 * `since` (1 quota unit per page of 100). Includes held-for-review ones.
 */
export async function channelComments(c: YoutubeCreds, channelId: string, since: Date, maxPages = 10): Promise<YtComment[]> {
  const out: YtComment[] = [];
  for (const status of ['published', 'heldForReview'] as const) {
    let page: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const r = await call<{ items?: Array<Record<string, any>>; nextPageToken?: string }>(
        c,
        'GET',
        `${DATA}/commentThreads?part=snippet,replies&allThreadsRelatedToChannelId=${encodeURIComponent(channelId)}&maxResults=100&order=time&textFormat=plainText` +
          `${status === 'heldForReview' ? '&moderationStatus=heldForReview' : ''}${page ? `&pageToken=${page}` : ''}`,
      ).catch((e) => {
        // held-for-review listing needs owner rights; the published list is the important one.
        if (status === 'heldForReview') return { items: [] as Array<Record<string, any>>, nextPageToken: undefined };
        throw e;
      });
      let older = false;
      for (const t of r.items ?? []) {
        const rows = parseThread(t);
        if (rows[0] && rows[0].commentedAt < since && !(t.replies?.comments ?? []).length) older = true;
        out.push(...rows);
      }
      page = r.nextPageToken;
      if (!page || older) break;
    }
  }
  return out;
}

export async function replyToComment(c: YoutubeCreds, parentId: string, text: string): Promise<string | null> {
  const r = await call<{ id?: string }>(c, 'POST', `${DATA}/comments?part=snippet`, { snippet: { parentId, textOriginal: text } });
  return r.id ?? null;
}

/** heldForReview = hidden from the public; published = visible again. Channel owner only. */
export async function setCommentHidden(c: YoutubeCreds, commentId: string, hidden: boolean): Promise<void> {
  const q = `id=${encodeURIComponent(commentId)}&moderationStatus=${hidden ? 'heldForReview' : 'published'}`;
  await call<unknown>(c, 'POST', `${DATA}/comments/setModerationStatus?${q}`, {});
}

/**
 * Upload a video to the channel as UNLISTED (for Google video ads). Resumable
 * upload: one init POST, one PUT of the bytes. ~1600 quota units.
 */
export async function uploadUnlisted(c: YoutubeCreds, bytes: Buffer, title: string, mimetype: string): Promise<string> {
  const token = await googleAccessToken(c.clientId, c.clientSecret, c.refresh);
  const meta = JSON.stringify({ snippet: { title: title.slice(0, 100) || 'Ad video', categoryId: '22' }, status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false } });
  const init = await rawRequest('POST', 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Upload-Content-Length': String(bytes.length),
    'X-Upload-Content-Type': mimetype,
  }, Buffer.from(meta));
  const location = init.headers.location;
  if (init.status >= 400 || typeof location !== 'string') throw ytError(safeJson(init.body), init.status);
  const put = await rawRequest('PUT', location, { 'Content-Type': mimetype }, bytes, 600_000);
  const body = safeJson(put.body) as { id?: string };
  if (put.status >= 400 || !body.id) throw ytError(body, put.status);
  return body.id;
}

function safeJson(b: Buffer): unknown {
  try {
    return JSON.parse(b.toString('utf8'));
  } catch {
    return {};
  }
}

function rawRequest(method: string, url: string, headers: Record<string, string>, body: Buffer, timeoutMs = 60_000) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers: { ...headers, 'Content-Length': String(body.length) }, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (x) => chunks.push(x as Buffer));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('YouTube upload timed out'));
    });
    req.write(body);
    req.end();
  });
}
