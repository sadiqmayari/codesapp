import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { DateRangeDto } from './dtos/date-range.dto';

const CACHE_TTL_SEC = 300;
const MAX_RANGE_DAYS = 90;
const DEFAULT_RANGE_DAYS = 30;

function n(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (v === null || v === undefined) return 0;
  return Number(v);
}

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
  ) {}

  private resolveRange(dto: DateRangeDto): { from: Date; to: Date } {
    const to = dto.to ? new Date(dto.to) : new Date();
    const from = dto.from
      ? new Date(dto.from)
      : new Date(to.getTime() - DEFAULT_RANGE_DAYS * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Invalid date range');
    }
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('`from` must be before `to`');
    }
    const spanDays = (to.getTime() - from.getTime()) / 86_400_000;
    if (spanDays > MAX_RANGE_DAYS) {
      throw new BadRequestException(
        `Date range cannot exceed ${MAX_RANGE_DAYS} days`,
      );
    }
    return { from, to };
  }

  private async cached<T>(
    companyId: number,
    route: string,
    paramHash: string,
    producer: () => Promise<T>,
  ): Promise<T> {
    const key = `analytics:${companyId}:${route}:${paramHash}`;
    const hit = this.cache.get<T>(key);
    if (hit !== undefined) return hit;
    const fresh = await producer();
    this.cache.set(key, fresh, CACHE_TTL_SEC);
    return fresh;
  }

  async overview(companyId: number) {
    return this.cached(companyId, 'overview', 'static', async () => {
      const monthStart = new Date().toISOString().slice(0, 7) + '-01';

      const [contacts] = await this.prisma.$queryRawUnsafe<
        { c: bigint }[]
      >(
        `SELECT COUNT(*) c FROM contacts WHERE company_id = ? AND deleted_at IS NULL`,
        companyId,
      );
      const [convos] = await this.prisma.$queryRawUnsafe<
        { active: bigint; open: bigint }[]
      >(
        `SELECT
           SUM(status <> 'resolved') active,
           SUM(status = 'open') open
         FROM conversations WHERE company_id = ? AND deleted_at IS NULL`,
        companyId,
      );
      const [msgs] = await this.prisma.$queryRawUnsafe<
        {
          this_month: bigint;
          sent: bigint;
          delivered: bigint;
          read: bigint;
          inbound: bigint;
        }[]
      >(
        `SELECT
           SUM(created_at >= ?) this_month,
           SUM(direction = 'outbound') sent,
           SUM(direction = 'outbound' AND status IN ('delivered','read')) delivered,
           SUM(direction = 'outbound' AND status = 'read') \`read\`,
           SUM(direction = 'inbound') inbound
         FROM messages WHERE company_id = ?`,
        monthStart,
        companyId,
      );
      const [bots] = await this.prisma.$queryRawUnsafe<{ c: bigint }[]>(
        `SELECT COUNT(*) c FROM audit_logs
         WHERE company_id = ? AND action = 'bot.executed'`,
        companyId,
      );

      const sent = n(msgs?.sent);
      const delivered = n(msgs?.delivered);
      const read = n(msgs?.read);
      const inbound = n(msgs?.inbound);
      const botExec = n(bots?.c);

      // Reply rate = of conversations we messaged outbound, how many the
      // customer replied to. (The old inbound/sent ratio could exceed 100%
      // because one customer can send many inbound messages.)
      const [conv] = await this.prisma.$queryRawUnsafe<
        { out_convos: bigint; replied: bigint }[]
      >(
        `SELECT COUNT(*) out_convos, SUM(has_in) replied FROM (
           SELECT conversation_id, MAX(direction = 'inbound') has_in
           FROM messages WHERE company_id = ?
           GROUP BY conversation_id
           HAVING MAX(direction = 'outbound') = 1
         ) t`,
        companyId,
      );

      // Clamp every ratio to 0–100 so a metric can never read 1400%.
      const pct = (a: number, b: number) =>
        b > 0
          ? Math.min(100, Math.max(0, Math.round((a / b) * 10000) / 100))
          : 0;

      return {
        totalContacts: n(contacts?.c),
        activeConversations: n(convos?.active),
        openChats: n(convos?.open),
        messagesThisMonth: n(msgs?.this_month),
        deliveryRate: pct(delivered, sent),
        readRate: pct(read, delivered),
        replyRate: pct(n(conv?.replied), n(conv?.out_convos)),
        botHandledPct: pct(botExec, inbound),
      };
    });
  }

  async funnel(companyId: number, dto: DateRangeDto) {
    const { from, to } = this.resolveRange(dto);
    return this.cached(
      companyId,
      'funnel',
      `${from.toISOString()}_${to.toISOString()}`,
      async () => {
        const rows = await this.prisma.$queryRawUnsafe<
          {
            date: string;
            sent: bigint;
            delivered: bigint;
            read: bigint;
            replied: bigint;
          }[]
        >(
          `SELECT
             DATE(created_at) date,
             SUM(direction = 'outbound') sent,
             SUM(direction = 'outbound' AND status IN ('delivered','read')) delivered,
             SUM(direction = 'outbound' AND status = 'read') \`read\`,
             SUM(direction = 'inbound') replied
           FROM messages
           WHERE company_id = ? AND created_at >= ? AND created_at <= ?
           GROUP BY DATE(created_at)
           ORDER BY DATE(created_at)`,
          companyId,
          from,
          to,
        );
        return rows.map((r) => ({
          date: r.date,
          sent: n(r.sent),
          delivered: n(r.delivered),
          read: n(r.read),
          replied: n(r.replied),
        }));
      },
    );
  }

  async agents(companyId: number, dto: DateRangeDto) {
    const { from, to } = this.resolveRange(dto);
    return this.cached(
      companyId,
      'agents',
      `${from.toISOString()}_${to.toISOString()}`,
      async () => {
        const rows = await this.prisma.$queryRawUnsafe<
          {
            userId: number;
            name: string;
            conversationsHandled: bigint;
            avgResponseTimeMin: number | null;
            messagesSent: bigint;
          }[]
        >(
          `SELECT
             u.id userId,
             u.name name,
             COUNT(DISTINCT c.id) conversationsHandled,
             AVG(TIMESTAMPDIFF(MINUTE, c.created_at, c.updated_at)) avgResponseTimeMin,
             COALESCE(SUM(m.direction = 'outbound'), 0) messagesSent
           FROM users u
           JOIN conversations c
             ON c.assigned_user_id = u.id AND c.company_id = ?
            AND c.created_at >= ? AND c.created_at <= ?
           LEFT JOIN messages m ON m.conversation_id = c.id
           WHERE u.company_id = ?
           GROUP BY u.id, u.name
           ORDER BY conversationsHandled DESC`,
          companyId,
          from,
          to,
          companyId,
        );
        return rows.map((r) => ({
          userId: n(r.userId),
          name: r.name,
          conversationsHandled: n(r.conversationsHandled),
          avgResponseTimeMin: Math.round(n(r.avgResponseTimeMin) * 100) / 100,
          messagesSent: n(r.messagesSent),
        }));
      },
    );
  }

  async broadcast(companyId: number, broadcastId: number) {
    return this.cached(
      companyId,
      'broadcast',
      String(broadcastId),
      async () => {
        const b = await this.prisma.broadcast.findFirst({
          where: { id: broadcastId, company_id: companyId },
        });
        if (!b) {
          throw new BadRequestException('Broadcast not found');
        }
        const [reply] = await this.prisma.$queryRawUnsafe<{ c: bigint }[]>(
          `SELECT COUNT(*) c FROM messages
           WHERE company_id = ? AND direction = 'inbound'
             AND conversation_id IN (
               SELECT DISTINCT conversation_id FROM messages
               WHERE company_id = ? AND broadcast_id = ?
             )`,
          companyId,
          companyId,
          broadcastId,
        );
        const byHour = await this.prisma.$queryRawUnsafe<
          { hour: number; c: bigint }[]
        >(
          `SELECT HOUR(created_at) hour, COUNT(*) c
           FROM messages
           WHERE company_id = ? AND broadcast_id = ?
             AND status IN ('delivered','read')
           GROUP BY HOUR(created_at) ORDER BY hour`,
          companyId,
          broadcastId,
        );
        return {
          sent: b.sent_count,
          delivered: b.delivered_count,
          read: b.read_count,
          failed: b.failed_count,
          replyCount: n(reply?.c),
          deliveryByHour: byHour.map((r) => ({
            hour: n(r.hour),
            count: n(r.c),
          })),
        };
      },
    );
  }

  async conversationCost(companyId: number, dto: DateRangeDto) {
    const { from, to } = this.resolveRange(dto);
    return this.cached(
      companyId,
      'conversation-cost',
      `${from.toISOString()}_${to.toISOString()}`,
      async () => {
        const [row] = await this.prisma.$queryRawUnsafe<{ c: bigint }[]>(
          `SELECT COUNT(*) c FROM (
             SELECT c.contact_id, DATE(m.created_at) d
             FROM messages m
             JOIN conversations c ON c.id = m.conversation_id
             WHERE m.company_id = ? AND m.created_at >= ? AND m.created_at <= ?
             GROUP BY c.contact_id, DATE(m.created_at)
           ) grp`,
          companyId,
          from,
          to,
        );
        const totalConversations = n(row?.c);
        const rateUsed = Number(
          this.config.get<string>('META_CONVERSATION_FLAT_USD') ?? 0.005,
        );
        return {
          totalConversations,
          estimatedCostUSD:
            Math.round(totalConversations * rateUsed * 10000) / 10000,
          rateUsed,
          note: 'Placeholder flat-rate estimate — not Meta-billed pricing. Distinct (company, contact, day) buckets.',
        };
      },
    );
  }

  /** NEVER cached — always fresh. */
  async usage(companyId: number) {
    const period = new Date().toISOString().slice(0, 7);
    const [usage, company] = await Promise.all([
      this.prisma.usageMetering.findUnique({
        where: { company_id_period: { company_id: companyId, period } },
      }),
      this.prisma.company.findUnique({
        where: { id: companyId },
        include: { subscription: true },
      }),
    ]);
    const sub = company?.subscription;
    return {
      period,
      usage: {
        messagesSent: usage?.messages_sent ?? 0,
        contactsStored: usage?.contacts_stored ?? 0,
        templatesUsed: usage?.templates_used ?? 0,
        webhookCalls: usage?.webhook_calls ?? 0,
        conversationsOpened: usage?.conversations_opened ?? 0,
      },
      limits: sub
        ? {
            contactLimit: sub.contact_limit,
            templateLimit: sub.template_limit,
            userLimit: sub.user_limit,
          }
        : null,
    };
  }
}
