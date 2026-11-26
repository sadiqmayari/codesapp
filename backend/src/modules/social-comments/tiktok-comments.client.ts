import { httpJson } from '../growth/platforms/http';

const BASE = 'https://business-api.tiktok.com/open_api/v1.3';

export interface ParsedComment {
  externalId: string;
  parentExternalId: string | null;
  adId: string | null;
  adName: string | null;
  postId: string | null;
  authorName: string | null;
  authorId: string | null;
  text: string;
  hidden: boolean;
  commentedAt: Date;
  raw: Record<string, unknown>;
}

export class TikTokApiError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));

/** TikTok times are "YYYY-MM-DD HH:mm:ss" UTC, or unix seconds. */
function parseTime(v: unknown): Date {
  if (typeof v === 'number' || /^\d{9,11}$/.test(String(v ?? ''))) return new Date(Number(v) * 1000);
  const s = String(v ?? '');
  const d = new Date(/\d{4}-\d{2}-\d{2} \d/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Pure mapper for one /comment/list/ row. TikTok's field names are read with
 * fallbacks (content|text|comment_text, user_name|username|nickname…) — the
 * full row is kept in `raw` so reply/hide can reuse identity + item ids.
 */
export function parseTikTokComment(r: Record<string, unknown>): ParsedComment | null {
  const externalId = str(r.comment_id ?? r.id);
  const text = str(r.content ?? r.text ?? r.comment_text ?? r.comment);
  if (!externalId || text === null) return null;
  const status = String(r.status ?? r.comment_status ?? '').toUpperCase();
  return {
    externalId,
    parentExternalId: str(r.original_comment_id ?? r.parent_comment_id ?? r.reply_to_comment_id),
    adId: str(r.ad_id),
    adName: str(r.ad_name),
    postId: str(r.tiktok_item_id ?? r.item_id ?? r.video_id),
    authorName: str(r.user_name ?? r.username ?? r.nickname ?? r.display_name),
    authorId: str(r.user_id ?? r.open_id),
    text,
    hidden: status === 'HIDDEN' || status === 'HIDE',
    commentedAt: parseTime(r.create_time ?? r.created_time ?? r.comment_time),
    raw: r,
  };
}

type Resp<T> = { code?: number; message?: string; data?: T };

async function call<T>(method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<T> {
  const res = await httpJson<Resp<T>>(method, `${BASE}${path}`, { 'Access-Token': token }, body);
  const code = res.body.code ?? (res.status >= 400 ? res.status : 0);
  if (code !== 0) throw new TikTokApiError(res.body.message ?? `TikTok API error ${code}`, code);
  return res.body.data as T;
}

/** Ad comments of one advertiser created in [since, until] (YYYY-MM-DD, ≤30 days), newest first. */
export async function listTikTokComments(token: string, advertiserId: string, since: string, until: string, maxPages = 20) {
  const out: ParsedComment[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const q = [
      `advertiser_id=${encodeURIComponent(advertiserId)}`,
      `start_time=${since}`,
      `end_time=${until}`,
      'comment_type=ALL',
      'comment_status=ALL',
      'sort_field=CREATE_TIME',
      'sort_type=DESC',
      `page=${page}`,
      'page_size=100',
    ].join('&');
    const data = await call<{ comments?: Record<string, unknown>[]; list?: Record<string, unknown>[]; page_info?: { total_page?: number } }>(
      'GET',
      `/comment/list/?${q}`,
      token,
    );
    for (const r of data?.comments ?? data?.list ?? []) {
      const c = parseTikTokComment(r);
      if (c) out.push(c);
    }
    if (!data?.page_info?.total_page || page >= data.page_info.total_page) break;
  }
  return out;
}

export async function replyTikTokComment(token: string, advertiserId: string, raw: Record<string, unknown>, text: string) {
  return call<Record<string, unknown>>('POST', '/comment/reply/', token, {
    advertiser_id: advertiserId,
    ad_id: str(raw.ad_id),
    comment_id: str(raw.comment_id),
    comment_type: 'REPLY',
    text,
    identity_type: str(raw.identity_type),
    identity_id: str(raw.identity_id),
    tiktok_item_id: str(raw.tiktok_item_id ?? raw.item_id),
  });
}

export async function setTikTokCommentHidden(token: string, advertiserId: string, commentId: string, hidden: boolean) {
  return call<Record<string, unknown>>('POST', '/comment/status/update/', token, {
    advertiser_id: advertiserId,
    comment_ids: [commentId],
    operation: hidden ? 'HIDDEN' : 'PUBLIC',
  });
}
