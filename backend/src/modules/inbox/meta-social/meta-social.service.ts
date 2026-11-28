import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { EncryptionService } from '../../../common/services/encryption.service';
import { MediaService } from '../../../common/services/media.service';
import {
  MEDIA_RETENTION_MS,
  generateImageThumbnail,
} from '../../../common/utils/media-path';
import { UsageMeteringService } from '../../usage-metering/usage-metering.service';
import { WebhookDispatcherService } from '../../webhooks/webhook-dispatcher.service';
import { InboxGateway } from '../inbox.gateway';
import {
  ParsedComment,
  ParsedMessaging,
  SocialAttachment,
  SocialChannel,
  attachmentSummary,
  parseMetaSocial,
} from './parse';

/** Permissions the system-user token needs for DMs + comments. */
export const META_SOCIAL_SCOPES = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'pages_read_engagement',
  'pages_manage_engagement',
  'instagram_basic',
  'instagram_manage_messages',
  'instagram_manage_comments',
] as const;

/** Page webhook fields we subscribe each Page to (POST /{page}/subscribed_apps). */
const PAGE_FIELDS = [
  'messages',
  'messaging_postbacks',
  'message_echoes',
  'message_reads',
  'message_deliveries',
  'message_reactions',
  'feed',
];

const MAX_INBOUND_MEDIA = 25 * 1024 * 1024;
const WINDOW_MS = 24 * 60 * 60 * 1000;

type MetaPageRow = {
  id: number;
  company_id: number;
  page_id: string;
  name: string;
  page_token_encrypted: string;
  ig_user_id: string | null;
  ig_username: string | null;
  status: string;
};

export class MetaGraphError extends Error {
  constructor(message: string, readonly code?: number, readonly status?: number) {
    super(message);
  }
}

interface AvailablePage {
  pageId: string;
  name: string;
  pictureUrl: string | null;
  igUserId: string | null;
  igUsername: string | null;
  token: string;
}

/**
 * Facebook Messenger + Instagram DMs and FB/IG comments through the tenant's
 * OWN Meta app (the same app as their WhatsApp; same callback URL + app
 * secret). Owns: the Page connection (system-user token → Page tokens), the
 * inbound handler for `object: page|instagram` webhooks and the Graph send /
 * comment-moderation calls. Persistence of agent sends stays in InboxService.
 */
@Injectable()
export class MetaSocialService {
  private readonly logger = new Logger(MetaSocialService.name);
  private readonly version: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly media: MediaService,
    private readonly metering: UsageMeteringService,
    private readonly webhookDispatcher: WebhookDispatcherService,
    private readonly gateway: InboxGateway,
  ) {
    this.version = this.config.get<string>('META_GRAPH_VERSION') ?? 'v19.0';
  }

  // ---------------------------------------------------------------- Graph

  private async graph<T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    token: string,
    opts: { query?: Record<string, string>; body?: Record<string, unknown> } = {},
  ): Promise<T> {
    const url = new URL(`https://graph.facebook.com/${this.version}/${path.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(opts.body ? { 'content-type': 'application/json' } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new MetaGraphError(
        `Could not reach Meta: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const raw = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      /* non-JSON */
    }
    const err = json.error as { message?: string; code?: number; error_user_msg?: string } | undefined;
    if (!res.ok || err) {
      const msg = err?.error_user_msg || err?.message || `Meta returned HTTP ${res.status}`;
      throw new MetaGraphError(msg, err?.code, res.status);
    }
    return json as T;
  }

  private decryptOrNull(v: string | null | undefined): string | null {
    if (!v) return null;
    try {
      return this.encryption.decrypt(v);
    } catch {
      return null;
    }
  }

  private async companyToken(companyId: number): Promise<string> {
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { meta_social_token_encrypted: true },
    });
    const t = this.decryptOrNull(c?.meta_social_token_encrypted);
    if (!t) throw new BadRequestException('Connect your Meta token first');
    return t;
  }

  private pageToken(page: { page_token_encrypted: string }): string {
    const t = this.decryptOrNull(page.page_token_encrypted);
    if (!t) throw new BadRequestException('Page token unreadable — reconnect the Page');
    return t;
  }

  private async fetchAvailablePages(token: string): Promise<AvailablePage[]> {
    const out: AvailablePage[] = [];
    let after: string | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await this.graph<{
        data?: Array<{
          id: string;
          name: string;
          access_token?: string;
          picture?: { data?: { url?: string } };
          instagram_business_account?: { id?: string; username?: string };
        }>;
        paging?: { cursors?: { after?: string }; next?: string };
      }>('GET', 'me/accounts', token, {
        query: {
          fields: 'id,name,access_token,picture{url},instagram_business_account{id,username}',
          limit: '100',
          ...(after ? { after } : {}),
        },
      });
      for (const p of res.data ?? []) {
        if (!p.access_token) continue;
        out.push({
          pageId: p.id,
          name: p.name,
          pictureUrl: p.picture?.data?.url ?? null,
          igUserId: p.instagram_business_account?.id ?? null,
          igUsername: p.instagram_business_account?.username ?? null,
          token: p.access_token,
        });
      }
      after = res.paging?.next ? res.paging?.cursors?.after : undefined;
      if (!after) break;
    }
    return out;
  }

  // ------------------------------------------------------------- Settings

  /** Callback URL key + verify token: the SAME pair the tenant uses for WhatsApp. */
  private async webhookInfo(companyId: number) {
    const num = await this.prisma.whatsAppNumber.findFirst({
      where: { company_id: companyId, status: 'active' },
      orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
      select: { webhook_key: true, webhook_verify_token: true },
    });
    const co = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { webhook_key: true, webhook_verify_token: true, meta_social_token_encrypted: true },
    });
    return {
      webhookKey: num?.webhook_key ?? co?.webhook_key ?? null,
      verifyToken: num?.webhook_verify_token ?? co?.webhook_verify_token ?? null,
      tokenSet: !!co?.meta_social_token_encrypted,
    };
  }

  private pagePublic(p: {
    id: number;
    page_id: string;
    name: string;
    picture_url: string | null;
    ig_user_id: string | null;
    ig_username: string | null;
    status: string;
    last_error: string | null;
    last_event_at: Date | null;
  }) {
    return {
      id: p.id,
      pageId: p.page_id,
      name: p.name,
      pictureUrl: p.picture_url,
      igUserId: p.ig_user_id,
      igUsername: p.ig_username,
      status: p.status,
      lastError: p.last_error,
      lastEventAt: p.last_event_at,
    };
  }

  async status(companyId: number) {
    const info = await this.webhookInfo(companyId);
    const pages = await this.prisma.metaPage.findMany({
      where: { company_id: companyId },
      orderBy: { id: 'asc' },
    });
    return {
      tokenSet: info.tokenSet,
      webhookKey: info.webhookKey,
      verifyToken: info.verifyToken,
      pages: pages.map((p) => this.pagePublic(p)),
    };
  }

  /** Validate + store the system-user token; returns permissions + Pages it can reach. */
  async connect(companyId: number, rawToken: string) {
    const token = rawToken.trim();
    if (token.length < 20) throw new BadRequestException('Paste the full access token');
    let me: { id?: string; name?: string };
    try {
      me = await this.graph('GET', 'me', token, { query: { fields: 'id,name' } });
    } catch (err) {
      throw new BadRequestException(`Meta rejected the token: ${(err as Error).message}`);
    }
    const missing = await this.missingScopes(token);
    let pages: AvailablePage[] = [];
    try {
      pages = await this.fetchAvailablePages(token);
    } catch (err) {
      throw new BadRequestException(`Could not list Pages: ${(err as Error).message}`);
    }
    await this.prisma.company.update({
      where: { id: companyId },
      data: { meta_social_token_encrypted: this.encryption.encrypt(token) },
    });
    // Refresh the stored Page tokens of already-connected Pages.
    for (const p of pages) {
      await this.prisma.metaPage
        .updateMany({
          where: { company_id: companyId, page_id: p.pageId },
          data: {
            page_token_encrypted: this.encryption.encrypt(p.token),
            name: p.name,
            picture_url: p.pictureUrl,
            ig_user_id: p.igUserId,
            ig_username: p.igUsername,
          },
        })
        .catch(() => undefined);
    }
    return {
      account: me.name ?? me.id ?? null,
      missingScopes: missing,
      available: await this.availableList(companyId, pages),
    };
  }

  private async missingScopes(token: string): Promise<string[]> {
    try {
      const res = await this.graph<{ data?: Array<{ permission: string; status: string }> }>(
        'GET',
        'me/permissions',
        token,
      );
      const granted = new Set(
        (res.data ?? []).filter((p) => p.status === 'granted').map((p) => p.permission),
      );
      // Some system-user tokens return an empty list → unknown, don't nag.
      if (!granted.size) return [];
      return META_SOCIAL_SCOPES.filter((s) => !granted.has(s));
    } catch {
      return [];
    }
  }

  private async availableList(companyId: number, pages: AvailablePage[]) {
    const rows = await this.prisma.metaPage.findMany({
      where: { page_id: { in: pages.map((p) => p.pageId) } },
      select: { page_id: true, company_id: true, status: true },
    });
    const byId = new Map(rows.map((r) => [r.page_id, r]));
    return pages.map((p) => {
      const row = byId.get(p.pageId);
      return {
        pageId: p.pageId,
        name: p.name,
        pictureUrl: p.pictureUrl,
        igUserId: p.igUserId,
        igUsername: p.igUsername,
        enabled: !!row && row.company_id === companyId && row.status !== 'disconnected',
        otherWorkspace: !!row && row.company_id !== companyId,
      };
    });
  }

  async listAvailable(companyId: number) {
    const token = await this.companyToken(companyId);
    const pages = await this.fetchAvailablePages(token);
    return { available: await this.availableList(companyId, pages) };
  }

  async enablePage(companyId: number, pageId: string) {
    const token = await this.companyToken(companyId);
    const pages = await this.fetchAvailablePages(token);
    const p = pages.find((x) => x.pageId === pageId);
    if (!p) throw new NotFoundException('This token cannot reach that Page');
    const owner = await this.prisma.metaPage.findUnique({ where: { page_id: pageId } });
    if (owner && owner.company_id !== companyId) {
      throw new ConflictException('This Page is connected to another workspace');
    }
    if (p.igUserId) {
      const igOwner = await this.prisma.metaPage.findUnique({ where: { ig_user_id: p.igUserId } });
      if (igOwner && igOwner.company_id !== companyId) {
        throw new ConflictException('This Instagram account is connected to another workspace');
      }
    }
    const data = {
      name: p.name,
      picture_url: p.pictureUrl,
      page_token_encrypted: this.encryption.encrypt(p.token),
      ig_user_id: p.igUserId,
      ig_username: p.igUsername,
    };
    const row = owner
      ? await this.prisma.metaPage.update({ where: { id: owner.id }, data })
      : await this.prisma.metaPage.create({ data: { company_id: companyId, page_id: pageId, ...data } });
    const subscribed = await this.subscribe(row.id);
    void this.backfillComments(companyId).catch(() => undefined);
    return subscribed;
  }

  /** (Re)subscribe the Page to the tenant's app for DMs + feed. Records status. */
  async subscribe(metaPageId: number) {
    const page = await this.prisma.metaPage.findUnique({ where: { id: metaPageId } });
    if (!page) throw new NotFoundException('Page not found');
    try {
      await this.graph('POST', `${page.page_id}/subscribed_apps`, this.pageToken(page), {
        query: { subscribed_fields: PAGE_FIELDS.join(',') },
      });
      const row = await this.prisma.metaPage.update({
        where: { id: page.id },
        data: { status: 'active', last_error: null, subscribed_fields: PAGE_FIELDS },
      });
      return this.pagePublic(row);
    } catch (err) {
      const row = await this.prisma.metaPage.update({
        where: { id: page.id },
        data: { status: 'error', last_error: (err as Error).message.slice(0, 500) },
      });
      return this.pagePublic(row);
    }
  }

  async resubscribe(companyId: number, id: number) {
    const page = await this.prisma.metaPage.findFirst({ where: { id, company_id: companyId } });
    if (!page) throw new NotFoundException('Page not found');
    return this.subscribe(page.id);
  }

  async disablePage(companyId: number, id: number) {
    const page = await this.prisma.metaPage.findFirst({ where: { id, company_id: companyId } });
    if (!page) throw new NotFoundException('Page not found');
    try {
      await this.graph('DELETE', `${page.page_id}/subscribed_apps`, this.pageToken(page));
    } catch (err) {
      this.logger.warn(`unsubscribe page ${page.page_id} failed: ${(err as Error).message}`);
    }
    const row = await this.prisma.metaPage.update({
      where: { id: page.id },
      data: { status: 'disconnected' },
    });
    return this.pagePublic(row);
  }

  // -------------------------------------------------------------- Inbound

  /**
   * Handle an `object: page | instagram` delivery. `keyCompanyId` = the
   * company that owns the webhook key the request was signed for — a Page of
   * another tenant is ignored (one tenant's app secret must not inject into
   * another tenant's inbox). Never throws for one bad event.
   */
  async handleWebhook(body: unknown, keyCompanyId: number | null): Promise<void> {
    const parsed = parseMetaSocial(body);
    if (!parsed.object) return;
    const cache = new Map<string, MetaPageRow | null>();
    const resolve = async (channel: SocialChannel | 'facebook', accountId: string) => {
      const k = `${channel}:${accountId}`;
      if (cache.has(k)) return cache.get(k) ?? null;
      const page = await this.prisma.metaPage.findFirst({
        where: channel === 'instagram' ? { ig_user_id: accountId } : { page_id: accountId },
      });
      let ok: MetaPageRow | null = page;
      if (page && page.status === 'disconnected') ok = null;
      if (page && keyCompanyId == null) ok = null;
      if (page && keyCompanyId != null && page.company_id !== keyCompanyId) {
        this.logger.warn(
          `meta-social: ${channel} ${accountId} belongs to company ${page.company_id}, webhook signed for ${keyCompanyId} — ignored`,
        );
        ok = null;
      }
      if (!page) this.logger.debug(`meta-social: no connected page for ${channel} ${accountId}`);
      if (ok) {
        void this.prisma.metaPage
          .update({ where: { id: ok.id }, data: { last_event_at: new Date() } })
          .catch(() => undefined);
      }
      cache.set(k, ok);
      return ok;
    };

    for (const ev of parsed.messaging) {
      try {
        const page = await resolve(ev.channel, ev.accountId);
        if (page) await this.handleMessaging(page, ev);
      } catch (err) {
        this.logger.warn(`meta-social messaging ${ev.kind} failed: ${(err as Error).message}`);
      }
    }
    for (const c of parsed.comments) {
      try {
        const page = await resolve(c.platform === 'instagram' ? 'instagram' : 'facebook', c.accountId);
        if (page) await this.handleComment(page, c);
      } catch (err) {
        this.logger.warn(`meta-social comment failed: ${(err as Error).message}`);
      }
    }
  }

  private idField(channel: SocialChannel): 'fb_psid' | 'ig_sid' {
    return channel === 'messenger' ? 'fb_psid' : 'ig_sid';
  }

  private async fetchProfile(
    page: MetaPageRow,
    channel: SocialChannel,
    userId: string,
  ): Promise<{ name: string | null; avatar: string | null }> {
    try {
      const fields = channel === 'messenger' ? 'first_name,last_name,profile_pic' : 'name,username,profile_pic';
      const r = await this.graph<Record<string, string | undefined>>('GET', userId, this.pageToken(page), {
        query: { fields },
      });
      const name =
        channel === 'messenger'
          ? [r.first_name, r.last_name].filter(Boolean).join(' ') || null
          : r.name || r.username || null;
      return { name, avatar: r.profile_pic ?? null };
    } catch {
      return { name: null, avatar: null };
    }
  }

  /** Find or create the contact for a FB/IG user (revives a soft-deleted one). */
  async resolveContact(page: MetaPageRow, channel: SocialChannel, userId: string) {
    const field = this.idField(channel);
    const companyId = page.company_id;
    const live = await this.prisma.contact.findFirst({
      where: { company_id: companyId, [field]: userId, deleted_at: null },
      orderBy: { id: 'asc' },
    });
    if (live) return { contact: live, isNew: false };
    const dead = await this.prisma.contact.findFirst({
      where: { company_id: companyId, [field]: userId, deleted_at: { not: null } },
      orderBy: { id: 'desc' },
    });
    if (dead) {
      const contact = await this.prisma.contact.update({
        where: { id: dead.id },
        data: { deleted_at: null },
      });
      return { contact, isNew: false };
    }
    const profile = await this.fetchProfile(page, channel, userId);
    const contact = await this.prisma.contact.create({
      data: {
        company_id: companyId,
        name: profile.name ?? (channel === 'messenger' ? 'Facebook user' : 'Instagram user'),
        phone: '',
        [field]: userId,
        avatar_url: profile.avatar?.slice(0, 1000) ?? null,
      },
    });
    await this.metering.incrementContacts(companyId).catch(() => undefined);
    return { contact, isNew: true };
  }

  private async findConversation(companyId: number, contactId: number, channel: SocialChannel) {
    return this.prisma.conversation.findFirst({
      where: { company_id: companyId, contact_id: contactId, channel, deleted_at: null },
      orderBy: { id: 'desc' },
    });
  }

  private async downloadAttachment(companyId: number, url: string): Promise<{ webPath: string; abs: string } | null> {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:') return null;
      const res = await fetch(u, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return null;
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > MAX_INBOUND_MEDIA) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_INBOUND_MEDIA) return null;
      const mime = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim();
      const name = decodeURIComponent(u.pathname.split('/').pop() ?? '');
      const saved = this.media.saveBuffer(buf, mime, companyId, name);
      void generateImageThumbnail(saved.path);
      return { webPath: saved.webPath, abs: saved.path };
    } catch (err) {
      this.logger.warn(`meta-social media download failed: ${(err as Error).message}`);
      return null;
    }
  }

  private messageTypeOf(a: SocialAttachment | undefined): 'text' | 'image' | 'video' | 'audio' | 'document' {
    if (!a || a.type === 'other' || a.type === 'sticker') return a?.type === 'sticker' ? 'image' : 'text';
    return a.type;
  }

  private async handleMessaging(page: MetaPageRow, ev: ParsedMessaging): Promise<void> {
    const companyId = page.company_id;
    if (ev.kind === 'read' || ev.kind === 'delivery') return this.handleReceipt(page, ev);
    if (ev.kind === 'reaction') return this.handleReaction(page, ev);
    if (ev.isDeleted) return;

    // Our own sends come back as echoes too. The send path stores the mid
    // right after Meta answers; give it a moment so the echo finds it.
    if (ev.kind === 'echo' && ev.mid) {
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (ev.mid) {
      const dup = await this.prisma.message.findFirst({
        where: { company_id: companyId, meta_message_id: { in: [ev.mid, `${ev.mid}#1`] } },
        select: { id: true },
      });
      if (dup) return;
    }

    const { contact, isNew } = await this.resolveContact(page, ev.channel, ev.userId);
    const inbound = ev.kind !== 'echo';
    const isBlocked = contact.status === 'blocked';
    const now = new Date();
    const windowExpiresAt = new Date(Date.now() + WINDOW_MS);

    let convo = await this.findConversation(companyId, contact.id, ev.channel);
    let isNewConvo = false;
    if (!convo) {
      convo = await this.prisma.conversation.create({
        data: {
          company_id: companyId,
          contact_id: contact.id,
          channel: ev.channel,
          meta_page_id: page.id,
          status: 'open',
          window_expires_at: inbound ? windowExpiresAt : null,
          unread_count: inbound && !isBlocked ? 1 : 0,
        },
      });
      isNewConvo = true;
    } else if (inbound) {
      convo = await this.prisma.conversation.update({
        where: { id: convo.id },
        data: {
          meta_page_id: page.id,
          window_expires_at: windowExpiresAt,
          status: convo.status === 'resolved' ? 'open' : convo.status,
          unread_count: isBlocked ? undefined : { increment: 1 },
        },
      });
    }
    if (inbound) {
      await this.prisma.contact
        .update({ where: { id: contact.id }, data: { last_message_at: now } })
        .catch(() => undefined);
    }

    // Click-to-Messenger / Instagram ad: first-touch referral + label.
    if (inbound && ev.referral && convo.referral == null) {
      const isAd = (ev.referral.source ?? '').toUpperCase() === 'ADS' || !!ev.referral.adId;
      await this.prisma.conversation
        .update({
          where: { id: convo.id },
          data: {
            referral: {
              source_type: isAd ? 'ad' : (ev.referral.source ?? '').toLowerCase() || null,
              source_id: ev.referral.adId,
              ref: ev.referral.ref,
              channel: ev.channel,
              received_at: now.toISOString(),
            },
            referral_source_id: ev.referral.adId,
            referral_at: now,
          },
        })
        .catch(() => undefined);
      const label = isAd ? '📢 From Ad' : '📢 From Post';
      await this.prisma.conversationLabel
        .upsert({
          where: { conversation_id_label: { conversation_id: convo.id, label } },
          create: { company_id: companyId, conversation_id: convo.id, label },
          update: {},
        })
        .catch(() => undefined);
    }

    // Reply context (best effort).
    let contextMessageId: number | null = null;
    if (ev.replyToMid) {
      const ref = await this.prisma.message.findFirst({
        where: { company_id: companyId, meta_message_id: ev.replyToMid },
        select: { id: true },
      });
      contextMessageId = ref?.id ?? null;
    }

    // One message row per attachment (Messenger batches several photos in one
    // event); the text rides on the first row. Extra rows get `mid#n` ids.
    const parts: Array<{ att?: SocialAttachment }> = ev.attachments.length
      ? ev.attachments.map((att) => ({ att }))
      : [{}];
    const created = [];
    for (let i = 0; i < parts.length; i++) {
      const att = parts[i].att;
      let mediaUrl: string | null = null;
      let type = this.messageTypeOf(att);
      if (att?.url && type !== 'text') {
        const dl = await this.downloadAttachment(companyId, att.url);
        mediaUrl = dl?.webPath ?? null;
        if (!mediaUrl) type = 'text';
      }
      let content = i === 0 ? ev.text : null;
      if (!content && type === 'text') {
        content = attachmentSummary(att ? [att] : []) ?? (att ? '(attachment)' : '(empty message)');
      }
      const mid = ev.mid ? (i === 0 ? ev.mid : `${ev.mid}#${i}`) : null;
      try {
        const message = await this.prisma.message.create({
          data: {
            conversation_id: convo.id,
            company_id: companyId,
            message_type: type,
            direction: inbound ? 'inbound' : 'outbound',
            content,
            media_url: mediaUrl,
            media_expires_at: mediaUrl ? new Date(Date.now() + MEDIA_RETENTION_MS) : null,
            status: inbound ? 'delivered' : 'sent',
            meta_message_id: mid,
            context_message_id: i === 0 ? contextMessageId : null,
            timestamp: new Date(ev.timestamp),
          },
          include: {
            context_message: {
              select: { id: true, direction: true, message_type: true, content: true, media_url: true },
            },
            user: { select: { id: true, name: true } },
          },
        });
        created.push(message);
      } catch (err) {
        if ((err as Prisma.PrismaClientKnownRequestError)?.code === 'P2002') continue; // raced dup
        throw err;
      }
    }
    if (!created.length) return;
    const last = created[created.length - 1];
    const preview = (ev.text ?? (last.content || `[${last.message_type}]`)).slice(0, 500);
    await this.prisma.conversation.update({
      where: { id: convo.id },
      data: { last_message: preview, last_message_at: now },
    });
    await this.metering.incrementMessages(companyId).catch(() => undefined);
    if (isNewConvo) await this.metering.incrementConversations(companyId).catch(() => undefined);

    if (inbound && isBlocked) return;
    for (const message of created) {
      if (inbound) {
        this.gateway.emitToConversationScoped(companyId, convo.assigned_user_id, 'message.received', {
          message,
          conversationId: convo.id,
          contactId: contact.id,
          contactName: contact.name,
          contactPhone: contact.phone,
          channel: ev.channel,
          isNewContact: isNew,
          windowExpiresAt: windowExpiresAt.toISOString(),
          status: convo.status,
          unreadCount: convo.unread_count,
        });
      } else {
        this.gateway.emitToConversationScoped(companyId, convo.assigned_user_id, 'message.sent', { message });
      }
    }
    if (isNewConvo) this.gateway.emitToCompany(companyId, 'conversation.updated', { conversationId: convo.id });
    if (inbound) {
      await this.webhookDispatcher
        .dispatch(companyId, 'message.received', {
          messageId: created[0].id,
          conversationId: convo.id,
          contactId: contact.id,
          isNewContact: isNew,
          messageType: created[0].message_type,
          channel: ev.channel,
        })
        .catch(() => undefined);
    }
  }

  private async handleReceipt(page: MetaPageRow, ev: ParsedMessaging): Promise<void> {
    const companyId = page.company_id;
    const target = ev.kind === 'read' ? 'read' : 'delivered';
    const rank: Record<string, number> = { sending: 0, sent: 1, delivered: 2, read: 3 };
    let rows: Array<{ id: number; status: string; conversation_id: number }> = [];
    if (ev.mids.length) {
      rows = await this.prisma.message.findMany({
        where: { company_id: companyId, meta_message_id: { in: ev.mids }, direction: 'outbound' },
        select: { id: true, status: true, conversation_id: true },
      });
    } else if (ev.watermark) {
      const { contact } = await this.resolveContact(page, ev.channel, ev.userId);
      const convo = await this.findConversation(companyId, contact.id, ev.channel);
      if (!convo) return;
      rows = await this.prisma.message.findMany({
        where: {
          conversation_id: convo.id,
          direction: 'outbound',
          status: { in: target === 'read' ? ['sent', 'delivered'] : ['sent'] },
          timestamp: { lte: new Date(ev.watermark) },
        },
        orderBy: { id: 'desc' },
        take: 50,
        select: { id: true, status: true, conversation_id: true },
      });
    }
    for (const r of rows) {
      if ((rank[r.status] ?? 0) >= rank[target]) continue;
      await this.prisma.message.update({ where: { id: r.id }, data: { status: target } });
      this.gateway.emitToCompany(companyId, 'message.status', {
        messageId: r.id,
        conversationId: r.conversation_id,
        status: target,
      });
    }
  }

  private async handleReaction(page: MetaPageRow, ev: ParsedMessaging): Promise<void> {
    if (!ev.mid) return;
    const msg = await this.prisma.message.findFirst({
      where: { company_id: page.company_id, meta_message_id: ev.mid },
      select: { id: true, conversation_id: true },
    });
    if (!msg) return;
    await this.prisma.message.update({ where: { id: msg.id }, data: { reaction: ev.emoji } });
    this.gateway.emitToCompany(page.company_id, 'message.reaction', {
      conversationId: msg.conversation_id,
      messageId: msg.id,
      emoji: ev.emoji,
    });
  }

  // ------------------------------------------------------------- Comments

  private async handleComment(page: MetaPageRow, c: ParsedComment): Promise<boolean> {
    const companyId = page.company_id;
    const where = {
      company_id_platform_external_id: {
        company_id: companyId,
        platform: c.platform,
        external_id: c.commentId,
      },
    };
    if (c.verb === 'remove') {
      await this.prisma.socialComment.deleteMany({
        where: { company_id: companyId, platform: c.platform, external_id: c.commentId },
      });
      return false;
    }
    if (c.verb === 'hide' || c.verb === 'unhide') {
      await this.prisma.socialComment.updateMany({
        where: { company_id: companyId, platform: c.platform, external_id: c.commentId },
        data: { status: c.verb === 'hide' ? 'hidden' : 'visible' },
      });
      return false;
    }
    if (c.fromSelf) {
      // Our own reply (from CodesApp or Meta Business Suite): mark the parent replied.
      if (c.parentId) {
        await this.prisma.socialComment.updateMany({
          where: { company_id: companyId, platform: c.platform, external_id: c.parentId, reply_text: null },
          data: { reply_text: c.text.slice(0, 5000), replied_at: c.createdAt },
        });
      }
      return false;
    }
    if (c.verb === 'edited') {
      await this.prisma.socialComment.updateMany({
        where: { company_id: companyId, platform: c.platform, external_id: c.commentId },
        data: { text: c.text },
      });
      return false;
    }
    const exists = await this.prisma.socialComment.findUnique({ where, select: { id: true } });
    if (exists) return false;
    try {
      await this.prisma.socialComment.create({
        data: {
          company_id: companyId,
          platform: c.platform,
          source: c.adId ? 'ad' : 'organic',
          account_id: page.id,
          external_id: c.commentId,
          parent_external_id: c.parentId,
          ad_id: c.adId,
          ad_name: c.adName,
          post_id: c.postId,
          author_name: c.authorName,
          author_id: c.authorId,
          text: c.text || '(no text)',
          commented_at: c.createdAt,
          raw: { pageId: page.page_id, igUserId: page.ig_user_id } as Prisma.InputJsonValue,
        },
      });
      this.gateway.emitToCompany(companyId, 'comments.new', { platform: c.platform, count: 1 });
      return true;
    } catch (err) {
      if ((err as Prisma.PrismaClientKnownRequestError)?.code !== 'P2002') throw err;
      return false;
    }
  }

  /** Pull the last 14 days of comments on the Pages' + IG accounts' recent posts. */
  async backfillComments(companyId: number): Promise<number> {
    const pages = await this.prisma.metaPage.findMany({
      where: { company_id: companyId, status: 'active' },
    });
    let added = 0;
    const since = Math.floor((Date.now() - 14 * 24 * 3600 * 1000) / 1000);
    for (const page of pages) {
      let token: string;
      try {
        token = this.pageToken(page);
      } catch {
        continue;
      }
      type FbC = { id: string; message?: string; created_time?: string; from?: { id?: string; name?: string } };
      try {
        const feed = await this.graph<{
          data?: Array<{ id: string; comments?: { data?: Array<FbC & { comments?: { data?: FbC[] } }> } }>;
        }>('GET', `${page.page_id}/feed`, token, {
          query: {
            fields:
              'id,comments.limit(50).order(reverse_chronological){id,message,created_time,from,comments.limit(25){id,message,created_time,from}}',
            since: String(since),
            limit: '25',
          },
        });
        for (const post of feed.data ?? []) {
          for (const top of post.comments?.data ?? []) {
            const list: Array<[FbC, string | null]> = [[top, null]];
            for (const r of top.comments?.data ?? []) list.push([r, top.id]);
            for (const [cm, parent] of list) {
              const made = await this.handleComment(page, {
                platform: 'facebook',
                accountId: page.page_id,
                commentId: cm.id,
                postId: post.id,
                parentId: parent,
                text: cm.message ?? '',
                authorId: cm.from?.id ?? null,
                authorName: cm.from?.name ?? null,
                verb: 'add',
                createdAt: cm.created_time ? new Date(cm.created_time) : new Date(),
                adId: null,
                adName: null,
                fromSelf: cm.from?.id === page.page_id,
              });
              if (made) added++;
            }
          }
        }
      } catch (err) {
        this.logger.warn(`FB comments backfill ${page.page_id} failed: ${(err as Error).message}`);
      }
      if (!page.ig_user_id) continue;
      type IgC = { id: string; text?: string; timestamp?: string; username?: string; from?: { id?: string; username?: string } };
      try {
        const media = await this.graph<{
          data?: Array<{ id: string; timestamp?: string; comments?: { data?: Array<IgC & { replies?: { data?: IgC[] } }> } }>;
        }>('GET', `${page.ig_user_id}/media`, token, {
          query: {
            fields: 'id,timestamp,comments.limit(50){id,text,timestamp,username,from,replies{id,text,timestamp,username,from}}',
            limit: '25',
          },
        });
        for (const m of media.data ?? []) {
          if (m.timestamp && new Date(m.timestamp).getTime() < since * 1000 - 30 * 24 * 3600 * 1000) continue;
          for (const top of m.comments?.data ?? []) {
            const list: Array<[IgC, string | null]> = [[top, null]];
            for (const r of top.replies?.data ?? []) list.push([r, top.id]);
            for (const [cm, parent] of list) {
              if (cm.timestamp && new Date(cm.timestamp).getTime() < since * 1000) continue;
              const authorId = cm.from?.id ?? null;
              const made = await this.handleComment(page, {
                platform: 'instagram',
                accountId: page.ig_user_id,
                commentId: cm.id,
                postId: m.id,
                parentId: parent,
                text: cm.text ?? '',
                authorId,
                authorName: cm.username ?? cm.from?.username ?? null,
                verb: 'add',
                createdAt: cm.timestamp ? new Date(cm.timestamp) : new Date(),
                adId: null,
                adName: null,
                fromSelf: authorId === page.ig_user_id || (cm.username ?? '') === page.ig_username,
              });
              if (made) added++;
            }
          }
        }
      } catch (err) {
        this.logger.warn(`IG comments backfill ${page.ig_user_id} failed: ${(err as Error).message}`);
      }
    }
    return added;
  }

  async hasPages(companyId: number) {
    const rows = await this.prisma.metaPage.findMany({
      where: { company_id: companyId, status: { not: 'disconnected' } },
      select: { ig_user_id: true },
    });
    return { facebook: rows.length > 0, instagram: rows.some((r) => !!r.ig_user_id) };
  }

  private async pageForComment(companyId: number, accountId: number | null) {
    const page = accountId
      ? await this.prisma.metaPage.findFirst({ where: { id: accountId, company_id: companyId } })
      : null;
    if (!page) throw new NotFoundException('The Page for this comment is no longer connected');
    return page;
  }

  /** Public reply under the comment. Returns the new comment id. */
  async replyToComment(
    companyId: number,
    c: { platform: string; external_id: string; account_id: number | null },
    text: string,
  ): Promise<string | null> {
    const page = await this.pageForComment(companyId, c.account_id);
    const path = c.platform === 'instagram' ? `${c.external_id}/replies` : `${c.external_id}/comments`;
    const res = await this.graph<{ id?: string }>('POST', path, this.pageToken(page), {
      body: { message: text },
    });
    return res.id ?? null;
  }

  async setCommentHidden(
    companyId: number,
    c: { platform: string; external_id: string; account_id: number | null },
    hidden: boolean,
  ): Promise<void> {
    const page = await this.pageForComment(companyId, c.account_id);
    await this.graph('POST', c.external_id, this.pageToken(page), {
      body: c.platform === 'instagram' ? { hide: hidden } : { is_hidden: hidden },
    });
  }

  /**
   * Private reply: a DM to the commenter (one per comment, within 7 days).
   * Opens / attaches the chat in the inbox and stores the message.
   */
  async privateReply(
    companyId: number,
    c: { platform: string; external_id: string; account_id: number | null; author_name: string | null },
    text: string,
    userId: number,
  ): Promise<{ conversationId: number }> {
    const page = await this.pageForComment(companyId, c.account_id);
    const res = await this.graph<{ recipient_id?: string; message_id?: string }>(
      'POST',
      'me/messages',
      this.pageToken(page),
      { body: { recipient: { comment_id: c.external_id }, message: { text } } },
    );
    const channel: SocialChannel = c.platform === 'instagram' ? 'instagram' : 'messenger';
    if (!res.recipient_id) throw new BadRequestException('Meta did not return the recipient');
    const { contact } = await this.resolveContact(page, channel, res.recipient_id);
    let convo = await this.findConversation(companyId, contact.id, channel);
    if (!convo) {
      convo = await this.prisma.conversation.create({
        data: {
          company_id: companyId,
          contact_id: contact.id,
          channel,
          meta_page_id: page.id,
          status: 'open',
          assigned_user_id: userId,
        },
      });
    }
    const message = await this.prisma.message.create({
      data: {
        conversation_id: convo.id,
        company_id: companyId,
        message_type: 'text',
        direction: 'outbound',
        content: text,
        status: 'sent',
        meta_message_id: res.message_id ?? null,
        user_id: userId,
        timestamp: new Date(),
      },
      include: { user: { select: { id: true, name: true } } },
    });
    await this.prisma.conversation.update({
      where: { id: convo.id },
      data: { last_message: text.slice(0, 500), last_message_at: new Date() },
    });
    this.gateway.emitToConversationScoped(companyId, convo.assigned_user_id ?? userId, 'message.sent', { message });
    this.gateway.emitToCompany(companyId, 'conversation.updated', { conversationId: convo.id });
    return { conversationId: convo.id };
  }

  // ------------------------------------------------------------- Outbound

  /** Page + recipient id for a FB/IG conversation. */
  private async target(companyId: number, convo: { contact_id: number; meta_page_id: number | null; channel: string }) {
    const channel = convo.channel as SocialChannel;
    const contact = await this.prisma.contact.findUnique({
      where: { id: convo.contact_id },
      select: { fb_psid: true, ig_sid: true, status: true },
    });
    if (!contact) throw new NotFoundException('Contact not found');
    if (contact.status === 'blocked') {
      throw new ForbiddenException('Contact is blocked — unblock them to send messages');
    }
    const recipient = channel === 'messenger' ? contact.fb_psid : contact.ig_sid;
    if (!recipient) throw new BadRequestException('This contact has no Facebook/Instagram id');
    let page = convo.meta_page_id
      ? await this.prisma.metaPage.findFirst({ where: { id: convo.meta_page_id, company_id: companyId } })
      : null;
    if (!page) {
      page = await this.prisma.metaPage.findFirst({
        where: {
          company_id: companyId,
          status: { not: 'disconnected' },
          ...(channel === 'instagram' ? { ig_user_id: { not: null } } : {}),
        },
      });
    }
    if (!page || page.status === 'disconnected') {
      throw new ForbiddenException('This Page is not connected any more (Settings → Facebook & Instagram)');
    }
    return { page, recipient, channel };
  }

  private async sendRaw(
    page: MetaPageRow,
    channel: SocialChannel,
    recipient: string,
    message: Record<string, unknown>,
    replyToMid?: string | null,
  ): Promise<string | null> {
    const body = (withReply: boolean): Record<string, unknown> => ({
      recipient: { id: recipient },
      ...(channel === 'messenger' ? { messaging_type: 'RESPONSE' } : {}),
      message: withReply && replyToMid ? { ...message, reply_to: { mid: replyToMid } } : message,
    });
    const token = this.pageToken(page);
    try {
      const res = await this.graph<{ message_id?: string }>('POST', 'me/messages', token, { body: body(true) });
      return res.message_id ?? null;
    } catch (err) {
      if (!replyToMid) throw this.friendly(err, channel);
      // Reply-to isn't supported everywhere — retry once without it.
      try {
        const res = await this.graph<{ message_id?: string }>('POST', 'me/messages', token, { body: body(false) });
        return res.message_id ?? null;
      } catch (err2) {
        throw this.friendly(err2, channel);
      }
    }
  }

  private friendly(err: unknown, channel: SocialChannel): Error {
    const e = err as MetaGraphError;
    const name = channel === 'messenger' ? 'Messenger' : 'Instagram';
    if (e?.code === 10 || e?.code === 551 || /outside of allowed window/i.test(e?.message ?? '')) {
      return new ForbiddenException(`${name}: the 24-hour reply window has closed for this person`);
    }
    if (e?.code === 190) return new ForbiddenException(`${name}: the Page token expired — reconnect in Settings`);
    return new BadRequestException(`${name}: ${e?.message ?? 'send failed'}`);
  }

  async sendText(
    companyId: number,
    convo: { contact_id: number; meta_page_id: number | null; channel: string },
    text: string,
    replyToMid?: string | null,
  ): Promise<string | null> {
    const t = await this.target(companyId, convo);
    return this.sendRaw(t.page, t.channel, t.recipient, { text: text.slice(0, 2000) }, replyToMid);
  }

  /** Send a file by its public URL (our /storage media are random-UUID URLs). */
  async sendAttachment(
    companyId: number,
    convo: { contact_id: number; meta_page_id: number | null; channel: string },
    kind: 'image' | 'video' | 'audio' | 'document',
    publicUrl: string,
  ): Promise<string | null> {
    const t = await this.target(companyId, convo);
    if (t.channel === 'instagram' && kind === 'document') {
      throw new BadRequestException('Instagram does not accept documents — send an image or video');
    }
    const type = kind === 'document' ? 'file' : kind;
    return this.sendRaw(t.page, t.channel, t.recipient, {
      attachment: { type, payload: { url: publicUrl, is_reusable: false } },
    });
  }

  publicMediaUrl(webPath: string): string {
    const origin = (this.config.get<string>('APP_URL') ?? 'https://apps.codentra.pk').replace(/\/+$/, '');
    return `${origin}${webPath}`;
  }
}
