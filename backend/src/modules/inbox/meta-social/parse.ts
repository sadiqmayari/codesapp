/**
 * Pure parser for Meta Page / Instagram webhook payloads (Messenger + Instagram
 * DMs, Page feed comments, Instagram comments). No I/O — unit-tested in
 * parse.spec.ts. The WhatsApp payload (`object: whatsapp_business_account`) is
 * NOT handled here; the caller routes by `object` first.
 */

export type SocialChannel = 'messenger' | 'instagram';

export interface SocialAttachment {
  /** Normalised to our message types. */
  type: 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'other';
  url: string | null;
  /** Shares / story mentions / fallbacks carry a title or url to show. */
  title: string | null;
}

export interface ParsedMessaging {
  kind: 'message' | 'echo' | 'read' | 'delivery' | 'reaction' | 'postback';
  channel: SocialChannel;
  /** entry.id — the Page id (messenger) or Instagram account id (instagram). */
  accountId: string;
  /** The customer's Page-scoped / Instagram-scoped id. */
  userId: string;
  mid: string | null;
  text: string | null;
  attachments: SocialAttachment[];
  replyToMid: string | null;
  /** epoch ms */
  timestamp: number;
  /** read: everything sent up to this time (messenger watermark, ms) is read. */
  watermark: number | null;
  /** read (instagram) / delivery (messenger): the mids concerned. */
  mids: string[];
  /** reaction: emoji or null when removed. */
  emoji: string | null;
  /** Message sent from a Meta inbox (Business Suite) by an app other than ours. */
  appId: string | null;
  isDeleted: boolean;
  /** Ad / post that started the chat (click-to-Messenger / IG ads). */
  referral: { source: string | null; type: string | null; adId: string | null; ref: string | null } | null;
}

export interface ParsedComment {
  platform: 'facebook' | 'instagram';
  accountId: string;
  commentId: string;
  postId: string | null;
  /** Parent COMMENT id for a reply; null for a top-level comment. */
  parentId: string | null;
  text: string;
  authorId: string | null;
  authorName: string | null;
  verb: 'add' | 'edited' | 'remove' | 'hide' | 'unhide';
  createdAt: Date;
  adId: string | null;
  adName: string | null;
  /** The Page / IG account itself wrote it (our own reply). */
  fromSelf: boolean;
}

export interface ParsedSocialPayload {
  object: 'page' | 'instagram' | null;
  messaging: ParsedMessaging[];
  comments: ParsedComment[];
}

type J = Record<string, unknown>;

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : null;

const obj = (v: unknown): J | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : null;

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function toMs(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  // Meta sends ms for messaging, seconds for feed created_time.
  return n < 1e12 ? n * 1000 : n;
}

function attachmentType(t: string | null): SocialAttachment['type'] {
  switch ((t ?? '').toLowerCase()) {
    case 'image':
    case 'photo':
      return 'image';
    case 'video':
    case 'ig_reel':
    case 'reel':
      return 'video';
    case 'audio':
      return 'audio';
    case 'file':
      return 'document';
    case 'sticker':
    case 'animated_image':
      return 'image';
    default:
      return 'other';
  }
}

function parseAttachments(message: J): SocialAttachment[] {
  const out: SocialAttachment[] = [];
  for (const a of arr(message.attachments)) {
    const at = obj(a);
    if (!at) continue;
    const payload = obj(at.payload) ?? {};
    // Messenger sticker: payload.sticker_id + url.
    const type = payload.sticker_id ? 'sticker' : attachmentType(str(at.type));
    out.push({
      type: type === 'sticker' ? 'image' : type,
      url: str(payload.url),
      title: str(payload.title) ?? str(at.title) ?? null,
    });
  }
  return out;
}

function parseMessagingEvent(channel: SocialChannel, accountId: string, ev: J): ParsedMessaging | null {
  const sender = str(obj(ev.sender)?.id);
  const recipient = str(obj(ev.recipient)?.id);
  const ts = toMs(ev.timestamp, Date.now());
  const base: ParsedMessaging = {
    kind: 'message',
    channel,
    accountId,
    userId: '',
    mid: null,
    text: null,
    attachments: [],
    replyToMid: null,
    timestamp: ts,
    watermark: null,
    mids: [],
    emoji: null,
    appId: null,
    isDeleted: false,
    referral: null,
  };

  const message = obj(ev.message);
  if (message) {
    const isEcho = message.is_echo === true;
    // Echo = WE (the Page/IG account) sent it; the customer is the recipient.
    const userId = isEcho ? recipient : sender;
    if (!userId || userId === accountId) return null;
    const replyTo = obj(message.reply_to);
    return {
      ...base,
      kind: isEcho ? 'echo' : 'message',
      userId,
      mid: str(message.mid),
      text: str(message.text),
      attachments: parseAttachments(message),
      replyToMid: str(replyTo?.mid),
      appId: str(message.app_id),
      isDeleted: message.is_deleted === true,
      referral: parseReferral(ev.referral ?? obj(message)?.referral),
    };
  }

  const read = obj(ev.read);
  if (read && sender) {
    return {
      ...base,
      kind: 'read',
      userId: sender,
      watermark: read.watermark != null ? toMs(read.watermark, ts) : null,
      mids: str(read.mid) ? [str(read.mid) as string] : [],
    };
  }

  const delivery = obj(ev.delivery);
  if (delivery && sender) {
    return {
      ...base,
      kind: 'delivery',
      userId: sender,
      watermark: delivery.watermark != null ? toMs(delivery.watermark, ts) : null,
      mids: arr(delivery.mids).map(str).filter((x): x is string => !!x),
    };
  }

  const reaction = obj(ev.reaction);
  if (reaction && sender) {
    const removed = str(reaction.action) === 'unreact';
    return {
      ...base,
      kind: 'reaction',
      userId: sender,
      mid: str(reaction.mid),
      emoji: removed ? null : str(reaction.emoji) ?? str(reaction.reaction),
    };
  }

  const postback = obj(ev.postback);
  if (postback && sender) {
    return {
      ...base,
      kind: 'postback',
      userId: sender,
      mid: str(postback.mid),
      text: str(postback.title) ?? str(postback.payload),
      referral: parseReferral(postback.referral),
    };
  }
  return null;
}

function parseReferral(v: unknown): ParsedMessaging['referral'] {
  const r = obj(v);
  if (!r) return null;
  return {
    source: str(r.source),
    type: str(r.type),
    adId: str(r.ad_id),
    ref: str(r.ref),
  };
}

function parseFeedChange(accountId: string, value: J): ParsedComment | null {
  if (str(value.item) !== 'comment') return null;
  const commentId = str(value.comment_id);
  if (!commentId) return null;
  const postId = str(value.post_id);
  const parent = str(value.parent_id);
  const from = obj(value.from);
  const authorId = str(from?.id);
  const verbRaw = str(value.verb) ?? 'add';
  const verb = (['add', 'edited', 'remove', 'hide', 'unhide'].includes(verbRaw) ? verbRaw : 'add') as ParsedComment['verb'];
  return {
    platform: 'facebook',
    accountId,
    commentId,
    postId,
    parentId: parent && parent !== postId ? parent : null,
    text: str(value.message) ?? '',
    authorId,
    authorName: str(from?.name),
    verb,
    createdAt: new Date(toMs(value.created_time, Date.now())),
    adId: null,
    adName: null,
    fromSelf: !!authorId && authorId === accountId,
  };
}

function parseIgComment(accountId: string, value: J, time: unknown): ParsedComment | null {
  const commentId = str(value.id);
  if (!commentId) return null;
  const from = obj(value.from);
  const media = obj(value.media);
  const authorId = str(from?.id);
  return {
    platform: 'instagram',
    accountId,
    commentId,
    postId: str(media?.id),
    parentId: str(value.parent_id),
    text: str(value.text) ?? '',
    authorId,
    authorName: str(from?.username),
    verb: 'add',
    createdAt: new Date(toMs(time, Date.now())),
    adId: str(media?.ad_id),
    adName: str(media?.ad_title),
    fromSelf: !!authorId && authorId === accountId,
  };
}

export function parseMetaSocial(body: unknown): ParsedSocialPayload {
  const b = obj(body);
  const objectName = str(b?.object);
  if (objectName !== 'page' && objectName !== 'instagram') {
    return { object: null, messaging: [], comments: [] };
  }
  const channel: SocialChannel = objectName === 'page' ? 'messenger' : 'instagram';
  const out: ParsedSocialPayload = { object: objectName, messaging: [], comments: [] };
  for (const e of arr(b?.entry)) {
    const entry = obj(e);
    const accountId = str(entry?.id);
    if (!entry || !accountId) continue;
    // `messaging` (Messenger webhooks) and `standby` (another app owns the
    // thread — Business Suite handover) both carry messaging events.
    for (const ev of [...arr(entry.messaging), ...arr(entry.standby)]) {
      const o = obj(ev);
      if (!o) continue;
      const parsed = parseMessagingEvent(channel, accountId, o);
      if (parsed) out.messaging.push(parsed);
    }
    for (const c of arr(entry.changes)) {
      const ch = obj(c);
      const value = obj(ch?.value);
      if (!ch || !value) continue;
      const field = str(ch.field);
      if (objectName === 'page' && field === 'feed') {
        const p = parseFeedChange(accountId, value);
        if (p) out.comments.push(p);
      } else if (objectName === 'instagram' && (field === 'comments' || field === 'live_comments')) {
        const p = parseIgComment(accountId, value, entry.time);
        if (p) out.comments.push(p);
      } else if (objectName === 'instagram' && field === 'messages') {
        // Some Instagram apps deliver DMs as a `changes` field instead of
        // `messaging`; the value has the same shape as a messaging event.
        const parsed = parseMessagingEvent('instagram', accountId, value);
        if (parsed) out.messaging.push(parsed);
      }
    }
  }
  return out;
}

/**
 * Per-chat serial key for the job queue (`conv:fb:{page}:{psid}` /
 * `conv:ig:{ig}:{igsid}`) when the payload concerns exactly one customer.
 * Comment-only payloads get none.
 */
export function socialSerialKey(body: unknown): string | undefined {
  const p = parseMetaSocial(body);
  if (!p.object || p.comments.length) return undefined;
  const keys = new Set(
    p.messaging.map((m) => `${m.channel === 'messenger' ? 'fb' : 'ig'}:${m.accountId}:${m.userId}`),
  );
  return keys.size === 1 ? `conv:${keys.values().next().value}` : undefined;
}

/** Short text for the conversation list / a message with no text. */
export function attachmentSummary(a: SocialAttachment[]): string | null {
  if (!a.length) return null;
  const first = a[0];
  if (first.type === 'other') return first.title ? `🔗 ${first.title}` : first.url ? `🔗 ${first.url}` : '(attachment)';
  return null;
}
