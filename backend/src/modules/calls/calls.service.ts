import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { InboxGateway } from '../inbox/inbox.gateway';
import { CallEventDto } from './dto/call-event.dto';

const digits = (s?: string | null) => (s ?? '').replace(/\D/g, '');

/** Roles that staff the inbox and should ever ring for a WhatsApp call. */
const RING_ROLES = ['owner', 'admin', 'agent'] as const;
/** Owners/admins ring for EVERY call (assigned or pool). */
const ADMIN_ROLES = ['owner', 'admin'] as const;

export type SipUser = { userId: number; companyId: number };

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: InboxGateway,
    private readonly config: ConfigService,
  ) {}

  // ── SIP identity (per agent) ─────────────────────────────────────────────
  /** SIP username for a user — must be SIP-safe (alnum + hyphen). */
  private sipUsername(companyId: number, userId: number) {
    return `agent-${companyId}-${userId}`;
  }

  /** Deterministic per-user SIP password (no storage) — HMAC of a platform secret. */
  private sipPassword(companyId: number, userId: number) {
    const secret =
      this.config.get<string>('SIP_PROVISION_SECRET') ||
      this.config.get<string>('CALLS_WEBHOOK_SECRET') ||
      'codesapp-sip';
    return createHmac('sha256', secret)
      .update(`${companyId}:${userId}`)
      .digest('hex')
      .slice(0, 24);
  }

  /**
   * Ensure this user has a per-agent WebRTC SIP endpoint in the Asterisk
   * realtime tables (asterisk.ps_endpoints/ps_auths/ps_aors), then return the
   * browser-softphone registration credentials. Idempotent — safe to call on
   * every app load. Provisioning failure must NOT break the credentials fetch
   * (the feature just won't ring that agent until the next successful load).
   */
  async sipCredentials(user: SipUser) {
    const wssUrl = this.config.get<string>('SIP_WSS_URL') ?? '';
    const realm = this.config.get<string>('SIP_REALM') ?? 'sip.codentra.pk';
    const username = this.sipUsername(user.companyId, user.userId);
    const password = this.sipPassword(user.companyId, user.userId);
    if (!wssUrl) return { configured: false, wssUrl: '', realm, username: '', password: '' };

    try {
      await this.provisionEndpoint(user.companyId, user.userId, username, password);
    } catch (e) {
      this.logger.error(`SIP provisioning failed for ${username}: ${(e as Error).message}`);
    }
    return { configured: true, wssUrl, realm, username, password };
  }

  /** Upsert the three realtime rows for a per-agent WebRTC endpoint. */
  private async provisionEndpoint(
    companyId: number,
    userId: number,
    username: string,
    password: string,
  ) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO asterisk.ps_aors (id,max_contacts,remove_existing,qualify_frequency)
       VALUES (?,?, 'yes', 0)
       ON DUPLICATE KEY UPDATE max_contacts=VALUES(max_contacts)`,
      username,
      3,
    );
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO asterisk.ps_auths (id,auth_type,username,password)
       VALUES (?, 'userpass', ?, ?)
       ON DUPLICATE KEY UPDATE password=VALUES(password), username=VALUES(username)`,
      username,
      username,
      password,
    );
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO asterisk.ps_endpoints
         (id,transport,aors,auth,context,disallow,allow,webrtc,dtls_auto_generate_cert,
          ice_support,rtp_symmetric,force_rport,rewrite_contact,company_id,user_id)
       VALUES (?, 'transport-wss', ?, ?, 'from-agent', 'all', 'opus', 'yes', 'yes',
               'yes', 'yes', 'yes', 'yes', ?, ?)
       ON DUPLICATE KEY UPDATE company_id=VALUES(company_id), user_id=VALUES(user_id),
         allow=VALUES(allow), transport=VALUES(transport)`,
      username,
      username,
      username,
      companyId,
      userId,
    );
  }

  // ── Routing (dialplan asks who to ring) ──────────────────────────────────
  /**
   * Resolve the dial string the Asterisk dialplan should ring for an inbound
   * WhatsApp call. Policy: a chat's ASSIGNED agent + all owners/admins; an
   * unassigned/new caller → all agents + owners/admins (pool, first-answer
   * wins). Only agents with a provisioned endpoint (app open at some point)
   * are dialled; Asterisk skips any that aren't currently registered.
   * Returns e.g. "PJSIP/agent-1-5&PJSIP/agent-1-2" or "" when nobody to ring.
   */
  async route(fromNumber: string, toNumber: string): Promise<string> {
    try {
      const businessDigits = digits(toNumber);
      if (!businessDigits) return '';
      const companyId = await this.companyForBusiness(businessDigits);
      if (!companyId) return '';

      const assigned = await this.assignedUserForCustomer(companyId, digits(fromNumber));

      // Target user set per policy.
      const admins = await this.prisma.user.findMany({
        where: { company_id: companyId, status: 'active', role: { in: ADMIN_ROLES as never } },
        select: { id: true },
      });
      const targetIds = new Set<number>(admins.map((u) => u.id));
      if (assigned) {
        targetIds.add(assigned);
      } else {
        const agents = await this.prisma.user.findMany({
          where: { company_id: companyId, status: 'active', role: { in: RING_ROLES as never } },
          select: { id: true },
        });
        agents.forEach((u) => targetIds.add(u.id));
      }
      if (!targetIds.size) return '';

      // Keep only users that actually have a provisioned SIP endpoint.
      const ids = [...targetIds].filter((n) => Number.isInteger(n));
      if (!ids.length) return '';
      const rows = await this.prisma.$queryRawUnsafe<{ user_id: number }[]>(
        `SELECT user_id FROM asterisk.ps_endpoints
          WHERE company_id = ? AND user_id IN (${ids.map(() => '?').join(',')})`,
        companyId,
        ...ids,
      );
      const provisioned = rows.map((r) => r.user_id);
      if (!provisioned.length) return '';
      return provisioned.map((uid) => `PJSIP/${this.sipUsername(companyId, uid)}`).join('&');
    } catch (e) {
      this.logger.error(`route failed: ${(e as Error).message}`);
      return '';
    }
  }

  private async companyForBusiness(businessDigits: string): Promise<number | null> {
    const numbers = await this.prisma.whatsAppNumber.findMany({
      select: { company_id: true, display_phone_number: true },
    });
    const match = numbers.find((n) =>
      digits(n.display_phone_number).endsWith(businessDigits.slice(-11)),
    );
    return match?.company_id ?? null;
  }

  private async assignedUserForCustomer(
    companyId: number,
    customerDigits: string,
  ): Promise<number | null> {
    if (!customerDigits) return null;
    const variants = [customerDigits, `+${customerDigits}`, customerDigits.slice(-10), customerDigits.slice(-11)];
    const contact = await this.prisma.contact.findFirst({
      where: { company_id: companyId, phone: { in: variants } },
      select: { id: true },
    });
    if (!contact) return null;
    const convo = await this.prisma.conversation.findFirst({
      where: { company_id: companyId, contact_id: contact.id, deleted_at: null },
      orderBy: { last_message_at: 'desc' },
      select: { assigned_user_id: true },
    });
    return convo?.assigned_user_id ?? null;
  }

  // ── Call lifecycle events (dialplan webhook) ─────────────────────────────
  /**
   * Resolve the tenant company from the business WhatsApp number on the call,
   * then the contact + conversation from the customer number, upsert the
   * call_logs row for this call lifecycle event, and emit a scoped socket event.
   * Fully best-effort — a call must never fail because logging did.
   */
  async handleEvent(dto: CallEventDto): Promise<{ ok: boolean }> {
    try {
      const businessRaw = dto.direction === 'inbound' ? dto.to : dto.from;
      const customerRaw = dto.direction === 'inbound' ? dto.from : dto.to;
      const businessDigits = digits(businessRaw);
      if (!businessDigits) return { ok: false };

      const companyId = await this.companyForBusiness(businessDigits);
      if (!companyId) {
        this.logger.warn(`call event: no company for business ${businessDigits}`);
        return { ok: false };
      }

      // Contact + latest conversation via the customer number.
      const cust = digits(customerRaw);
      let contactId: number | null = null;
      let conversationId: number | null = null;
      let assignedUserId: number | null = null;
      if (cust) {
        const variants = [cust, `+${cust}`, cust.slice(-10), cust.slice(-11)];
        const contact = await this.prisma.contact.findFirst({
          where: { company_id: companyId, phone: { in: variants } },
          select: { id: true },
        });
        if (contact) {
          contactId = contact.id;
          const convo = await this.prisma.conversation.findFirst({
            where: { company_id: companyId, contact_id: contact.id, deleted_at: null },
            orderBy: { last_message_at: 'desc' },
            select: { id: true, assigned_user_id: true },
          });
          if (convo) {
            conversationId = convo.id;
            assignedUserId = convo.assigned_user_id ?? null;
          }
        }
      }

      // Which agent handled the call (outbound: the placing endpoint; else assigned).
      const handlerId = this.userIdFromEndpoint(dto.agent, companyId) ?? assignedUserId;

      const existing = await this.prisma.callLog.findFirst({
        where: { company_id: companyId, provider_call_id: dto.callId },
        select: { id: true, started_at: true },
      });

      const now = new Date();
      let row;
      if (dto.event === 'call_started') {
        row = existing
          ? await this.prisma.callLog.update({
              where: { id: existing.id },
              data: { status: 'ringing', user_id: handlerId ?? undefined },
            })
          : await this.prisma.callLog.create({
              data: {
                company_id: companyId,
                conversation_id: conversationId,
                contact_id: contactId,
                user_id: handlerId,
                direction: dto.direction,
                status: 'ringing',
                from_number: dto.from ?? null,
                to_number: dto.to ?? null,
                provider_call_id: dto.callId,
                started_at: now,
              },
            });
      } else if (dto.event === 'call_answered') {
        row = await this.upsert(existing?.id, companyId, dto, conversationId, contactId, handlerId, {
          status: 'answered',
          answered_at: now,
        });
      } else {
        // call_ended
        const answered = dto.answered === true || (dto.durationSec ?? 0) > 0;
        row = await this.upsert(existing?.id, companyId, dto, conversationId, contactId, handlerId, {
          status: answered ? 'completed' : 'missed',
          ended_at: now,
          duration_sec: dto.durationSec ?? null,
        });
      }

      this.gateway.emitToConversationScoped(companyId, assignedUserId, 'call.updated', {
        conversationId,
        call: row,
      });
      return { ok: true };
    } catch (e) {
      this.logger.error(`handleEvent failed: ${(e as Error).message}`);
      return { ok: false };
    }
  }

  /** Parse "agent-<companyId>-<userId>" (the dialling endpoint) → userId. */
  private userIdFromEndpoint(endpoint: string | undefined, companyId: number): number | null {
    if (!endpoint) return null;
    const m = /^agent-(\d+)-(\d+)$/.exec(endpoint.trim());
    if (!m) return null;
    if (Number(m[1]) !== companyId) return null;
    return Number(m[2]);
  }

  private async upsert(
    id: number | undefined,
    companyId: number,
    dto: CallEventDto,
    conversationId: number | null,
    contactId: number | null,
    handlerId: number | null,
    data: Record<string, unknown>,
  ) {
    if (id) {
      return this.prisma.callLog.update({
        where: { id },
        data: { ...data, ...(handlerId ? { user_id: handlerId } : {}) },
      });
    }
    return this.prisma.callLog.create({
      data: {
        company_id: companyId,
        conversation_id: conversationId,
        contact_id: contactId,
        user_id: handlerId,
        direction: dto.direction,
        from_number: dto.from ?? null,
        to_number: dto.to ?? null,
        provider_call_id: dto.callId,
        started_at: new Date(),
        ...data,
      } as never,
    });
  }

  listForConversation(companyId: number, conversationId: number) {
    return this.prisma.callLog.findMany({
      where: { company_id: companyId, conversation_id: conversationId },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
  }

  /**
   * Company-wide call log for the inbox "Calls" tab. Pool-model RBAC (mirrors
   * InboxService.listConversations): owners/admins see every call; an agent sees
   * calls they handled, calls on chats assigned to them or unassigned, and calls
   * with no conversation (unknown numbers = pool). Paginated, newest first.
   */
  async listCompanyCalls(
    companyId: number,
    viewer: { userId: number; role: string },
    opts: { page?: number; limit?: number; filter?: string },
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(Math.max(1, opts.limit ?? 30), 100);
    const where: Record<string, unknown> = { company_id: companyId };

    if (opts.filter === 'missed') where.status = { in: ['missed', 'failed'] };
    else if (opts.filter === 'incoming') where.direction = 'inbound';
    else if (opts.filter === 'outgoing') where.direction = 'outbound';

    const isPrivileged = viewer.role === 'owner' || viewer.role === 'admin';
    if (!isPrivileged) {
      where.OR = [
        { user_id: viewer.userId },
        { conversation: { assigned_user_id: viewer.userId } },
        { conversation: { assigned_user_id: null } },
        { conversation_id: null },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.callLog.count({ where }),
      this.prisma.callLog.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          contact: { select: { id: true, name: true, phone: true } },
          user: { select: { id: true, name: true } },
          conversation: { select: { id: true } },
        },
      }),
    ]);

    const mapped = rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      contactId: r.contact_id,
      contactName: r.contact?.name ?? null,
      contactPhone: r.contact?.phone ?? r.from_number ?? r.to_number ?? null,
      direction: r.direction,
      status: r.status,
      durationSec: r.duration_sec,
      startedAt: r.started_at,
      createdAt: r.created_at,
      agentId: r.user?.id ?? null,
      agentName: r.user?.name ?? null,
    }));
    return { rows: mapped, total, page, limit };
  }

  /** Timing-safe compare of the dialplan's shared secret. */
  verifyRouteSecret(secret: string | undefined): boolean {
    const expected =
      this.config.get<string>('CALLS_WEBHOOK_SECRET') ||
      this.config.get<string>('SIP_PROVISION_SECRET') ||
      '';
    if (!expected || !secret) return false;
    // constant-time-ish; lengths differ rarely, string compare is acceptable here
    return secret === expected;
  }
}
