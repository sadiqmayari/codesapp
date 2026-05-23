import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { DateRangeDto } from './dtos/date-range.dto';
import { DashboardDto } from './dtos/dashboard.dto';

const CACHE_TTL_SEC = 300;
// The new /dashboard endpoint is range-aware so it caches shorter — recent
// activity should move the dial quickly once metrics actually mean what they
// say.
const DASHBOARD_CACHE_TTL_SEC = 60;
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

  /**
   * Comprehensive analytics — replaces the patchwork of overview/funnel/agents
   * /conversation-cost calls with ONE range-aware payload. Everything respects
   * `from`/`to`. With `compare=true`, every KPI carries the previous-period
   * value (same window length ending at `from`) so the UI can render deltas
   * Power-BI-style.
   *
   * Definitions (consistent across the payload):
   *  - "sent"      = outbound messages created in the window
   *  - "delivered" = outbound where status IN (delivered, read)
   *  - "read"      = outbound where status = read
   *  - "received"  = inbound messages created in the window
   *  - "replied conversations" = conversations with ≥1 outbound + ≥1 inbound in the window
   *  - "first-response latency" = AVG seconds from each inbound to the FIRST
   *    outbound that follows it on the same conversation (NULL if no reply).
   */
  async dashboard(companyId: number, dto: DashboardDto) {
    const { from, to } = this.resolveRange(dto);
    const spanMs = to.getTime() - from.getTime();
    const prevTo = new Date(from.getTime() - 1);
    const prevFrom = new Date(prevTo.getTime() - spanMs);
    const granularity: 'hour' | 'day' =
      dto.granularity === 'hour' || spanMs <= 2 * 86_400_000 ? 'hour' : 'day';
    const compare = dto.compare !== 'false';

    const paramHash = [
      from.toISOString(),
      to.toISOString(),
      granularity,
      compare ? 'cmp' : 'nocmp',
    ].join('|');

    return this.cachedShort(companyId, 'dashboard', paramHash, async () => {
      const [
        kCur,
        kPrev,
        trend,
        funnelTotals,
        statusBreakdown,
        heatmap,
        agents,
        topContacts,
        cost,
        usagePayload,
      ] = await Promise.all([
        this.kpisForWindow(companyId, from, to),
        compare
          ? this.kpisForWindow(companyId, prevFrom, prevTo)
          : Promise.resolve(null),
        this.trendSeries(companyId, from, to, granularity),
        this.funnelTotals(companyId, from, to),
        this.statusBreakdown(companyId, from, to),
        this.hourlyHeatmap(companyId, from, to),
        this.agentLeaderboard(companyId, from, to),
        this.topContacts(companyId, from, to, 10),
        this.conversationCost(companyId, { from: from.toISOString(), to: to.toISOString() }),
        this.usage(companyId),
      ]);

      const delta = (cur: number, prev: number | null) => {
        if (prev == null || !Number.isFinite(prev)) return null;
        if (prev === 0) return cur === 0 ? 0 : null; // undefined growth
        return Math.round(((cur - prev) / prev) * 1000) / 10; // 1 decimal %
      };
      const kpi = (key: keyof typeof kCur) => ({
        value: kCur[key],
        prev: kPrev ? kPrev[key] : null,
        deltaPct: kPrev ? delta(kCur[key], kPrev[key]) : null,
      });

      return {
        range: {
          from: from.toISOString(),
          to: to.toISOString(),
          prevFrom: compare ? prevFrom.toISOString() : null,
          prevTo: compare ? prevTo.toISOString() : null,
          granularity,
          spanDays: Math.round(spanMs / 86_400_000),
        },
        kpis: {
          messagesSent: kpi('sent'),
          messagesReceived: kpi('received'),
          activeConversations: kpi('activeConversations'),
          uniqueContactsEngaged: kpi('uniqueContacts'),
          newContacts: kpi('newContacts'),
          deliveryRate: kpi('deliveryRate'),
          readRate: kpi('readRate'),
          replyRate: kpi('replyRate'),
          avgFirstResponseSec: kpi('avgFirstResponseSec'),
          botHandledPct: kpi('botHandledPct'),
        },
        trend,
        funnel: funnelTotals,
        statusBreakdown,
        hourlyHeatmap: heatmap,
        agents,
        topContacts,
        cost,
        usage: usagePayload,
      };
    });
  }

  /** All point-in-window KPIs in one Promise.all so cur+prev parallelize cleanly. */
  private async kpisForWindow(companyId: number, from: Date, to: Date) {
    const [
      msgAgg,
      convoAgg,
      newContactRow,
      uniqueContactsRow,
      replyRow,
      botRow,
      firstRespRow,
    ] = await Promise.all([
      this.prisma.$queryRawUnsafe<
        {
          sent: bigint;
          delivered: bigint;
          read: bigint;
          received: bigint;
        }[]
      >(
        `SELECT
           SUM(direction='outbound') sent,
           SUM(direction='outbound' AND status IN ('delivered','read')) delivered,
           SUM(direction='outbound' AND status='read') \`read\`,
           SUM(direction='inbound') received
         FROM messages
         WHERE company_id=? AND created_at >= ? AND created_at <= ?`,
        companyId,
        from,
        to,
      ),
      this.prisma.$queryRawUnsafe<{ active: bigint }[]>(
        `SELECT COUNT(DISTINCT conversation_id) active
         FROM messages
         WHERE company_id=? AND created_at >= ? AND created_at <= ?`,
        companyId,
        from,
        to,
      ),
      this.prisma.$queryRawUnsafe<{ c: bigint }[]>(
        `SELECT COUNT(*) c FROM contacts
         WHERE company_id=? AND deleted_at IS NULL
           AND created_at >= ? AND created_at <= ?`,
        companyId,
        from,
        to,
      ),
      this.prisma.$queryRawUnsafe<{ c: bigint }[]>(
        `SELECT COUNT(DISTINCT c.contact_id) c
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.company_id=? AND m.created_at >= ? AND m.created_at <= ?`,
        companyId,
        from,
        to,
      ),
      // Reply rate = conversations with ≥1 outbound AND ≥1 inbound in window
      // / conversations with ≥1 outbound in window.
      this.prisma.$queryRawUnsafe<
        { out_convos: bigint; replied: bigint }[]
      >(
        `SELECT COUNT(*) out_convos, SUM(has_in) replied FROM (
           SELECT conversation_id,
                  MAX(direction='inbound') has_in,
                  MAX(direction='outbound') has_out
           FROM messages
           WHERE company_id=? AND created_at >= ? AND created_at <= ?
           GROUP BY conversation_id
         ) t WHERE has_out=1`,
        companyId,
        from,
        to,
      ),
      // Bot-handled %: DISTINCT inbound messages a bot fired on, divided by
      // inbound messages — both in window. We pull the inbound message id
      // out of `audit_logs.metadata.messageId` (the bot engine stores it
      // when writing the `bot.executed` row), so two rules matching the SAME
      // inbound only count as one handled message — using COUNT(*) inflated
      // the ratio whenever multiple bots matched one message.
      // (Pre-fix audit rows were silently dropped because of the user_id=0 FK
      // bug — see ERRORS.md — so for any range before the audit migration
      // landed on prod this stays near zero.)
      this.prisma.$queryRawUnsafe<{ c: bigint }[]>(
        `SELECT COUNT(DISTINCT JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.messageId'))) c
         FROM audit_logs
         WHERE company_id=? AND action='bot.executed'
           AND created_at >= ? AND created_at <= ?
           AND JSON_EXTRACT(metadata, '$.messageId') IS NOT NULL`,
        companyId,
        from,
        to,
      ),
      // REAL first-response latency: for each inbound message in the window,
      // the FIRST outbound on the same conversation that comes after it. Avg
      // those gaps (seconds). NULL when the customer was never answered.
      this.prisma.$queryRawUnsafe<{ avg_sec: number | null }[]>(
        `SELECT AVG(TIMESTAMPDIFF(SECOND, in_ts, out_ts)) avg_sec FROM (
           SELECT m.created_at in_ts,
             (SELECT MIN(m2.created_at) FROM messages m2
                WHERE m2.conversation_id = m.conversation_id
                  AND m2.direction='outbound'
                  AND m2.created_at > m.created_at
             ) out_ts
           FROM messages m
           WHERE m.company_id=? AND m.direction='inbound'
             AND m.created_at >= ? AND m.created_at <= ?
         ) t WHERE out_ts IS NOT NULL`,
        companyId,
        from,
        to,
      ),
    ]);

    const sent = n(msgAgg[0]?.sent);
    const delivered = n(msgAgg[0]?.delivered);
    const read = n(msgAgg[0]?.read);
    const received = n(msgAgg[0]?.received);
    const activeConversations = n(convoAgg[0]?.active);
    const newContacts = n(newContactRow[0]?.c);
    const uniqueContacts = n(uniqueContactsRow[0]?.c);
    const outConvos = n(replyRow[0]?.out_convos);
    const replied = n(replyRow[0]?.replied);
    const botExec = n(botRow[0]?.c);
    const avgFirstResponseSec = Math.round(n(firstRespRow[0]?.avg_sec));

    const pct = (a: number, b: number) =>
      b > 0
        ? Math.min(100, Math.max(0, Math.round((a / b) * 10000) / 100))
        : 0;

    return {
      sent,
      received,
      delivered,
      read,
      activeConversations,
      newContacts,
      uniqueContacts,
      deliveryRate: pct(delivered, sent),
      readRate: pct(read, delivered),
      replyRate: pct(replied, outConvos),
      botHandledPct: pct(botExec, received),
      avgFirstResponseSec,
    };
  }

  private async trendSeries(
    companyId: number,
    from: Date,
    to: Date,
    granularity: 'hour' | 'day',
  ) {
    const bucketExpr =
      granularity === 'hour'
        ? `DATE_FORMAT(created_at, '%Y-%m-%dT%H:00:00Z')`
        : `DATE_FORMAT(created_at, '%Y-%m-%d')`;
    const rows = await this.prisma.$queryRawUnsafe<
      {
        bucket: string;
        sent: bigint;
        received: bigint;
        delivered: bigint;
        read: bigint;
      }[]
    >(
      `SELECT ${bucketExpr} bucket,
         SUM(direction='outbound') sent,
         SUM(direction='inbound') received,
         SUM(direction='outbound' AND status IN ('delivered','read')) delivered,
         SUM(direction='outbound' AND status='read') \`read\`
       FROM messages
       WHERE company_id=? AND created_at >= ? AND created_at <= ?
       GROUP BY bucket ORDER BY bucket`,
      companyId,
      from,
      to,
    );
    return rows.map((r) => ({
      bucket: r.bucket,
      sent: n(r.sent),
      received: n(r.received),
      delivered: n(r.delivered),
      read: n(r.read),
    }));
  }

  private async funnelTotals(companyId: number, from: Date, to: Date) {
    const [r] = await this.prisma.$queryRawUnsafe<
      {
        sent: bigint;
        delivered: bigint;
        read: bigint;
        replied: bigint;
      }[]
    >(
      `SELECT
         SUM(direction='outbound') sent,
         SUM(direction='outbound' AND status IN ('delivered','read')) delivered,
         SUM(direction='outbound' AND status='read') \`read\`,
         (SELECT COUNT(DISTINCT conversation_id) FROM messages
           WHERE company_id=? AND direction='inbound'
             AND created_at >= ? AND created_at <= ?
             AND conversation_id IN (
               SELECT DISTINCT conversation_id FROM messages
               WHERE company_id=? AND direction='outbound'
                 AND created_at >= ? AND created_at <= ?
             )) replied
       FROM messages
       WHERE company_id=? AND created_at >= ? AND created_at <= ?`,
      companyId,
      from,
      to,
      companyId,
      from,
      to,
      companyId,
      from,
      to,
    );
    return {
      sent: n(r?.sent),
      delivered: n(r?.delivered),
      read: n(r?.read),
      replied: n(r?.replied),
    };
  }

  /** Conversations whose last_message_at lands in the window, grouped by status. */
  private async statusBreakdown(companyId: number, from: Date, to: Date) {
    const rows = await this.prisma.$queryRawUnsafe<
      { status: string; c: bigint }[]
    >(
      `SELECT status, COUNT(*) c FROM conversations
       WHERE company_id=? AND deleted_at IS NULL
         AND last_message_at >= ? AND last_message_at <= ?
       GROUP BY status`,
      companyId,
      from,
      to,
    );
    const out = { open: 0, pending: 0, resolved: 0 } as Record<string, number>;
    for (const r of rows) out[r.status] = n(r.c);
    return out;
  }

  /** Inbound messages by (day-of-week, hour-of-day) — when customers reach out. */
  private async hourlyHeatmap(companyId: number, from: Date, to: Date) {
    const rows = await this.prisma.$queryRawUnsafe<
      { dow: number; hr: number; c: bigint }[]
    >(
      // MySQL DAYOFWEEK: 1=Sun..7=Sat → subtract 1 for 0-indexed Sun..Sat.
      `SELECT (DAYOFWEEK(created_at)-1) dow, HOUR(created_at) hr, COUNT(*) c
       FROM messages
       WHERE company_id=? AND direction='inbound'
         AND created_at >= ? AND created_at <= ?
       GROUP BY dow, hr`,
      companyId,
      from,
      to,
    );
    return rows.map((r) => ({ dow: n(r.dow), hour: n(r.hr), count: n(r.c) }));
  }

  /**
   * Per-agent attribution. Prefers `messages.user_id` (the real sender — set
   * on every outbound message after the `20260530000000_message_user_id`
   * migration landed) and falls back to `conversations.assigned_user_id` for
   * older messages whose `user_id` is still NULL. Without the fallback, the
   * leaderboard would be empty for the entire pre-migration history.
   *
   * Per-agent avg response time = avg gap from "most recent inbound on the
   * same conversation before this outbound" → this outbound. NULL when no
   * preceding inbound (e.g. business-initiated chats).
   */
  private async agentLeaderboard(companyId: number, from: Date, to: Date) {
    const rows = await this.prisma.$queryRawUnsafe<
      {
        userId: number;
        name: string;
        sent: bigint;
        convos: bigint;
        avg_resp_sec: number | null;
      }[]
    >(
      `SELECT u.id userId, u.name name,
         COALESCE(s.sent, 0) sent,
         COALESCE(s.convos, 0) convos,
         s.avg_resp_sec
       FROM users u
       LEFT JOIN (
         SELECT COALESCE(m.user_id, c.assigned_user_id) attributed_user_id,
                COUNT(m.id) sent,
                COUNT(DISTINCT m.conversation_id) convos,
                AVG(TIMESTAMPDIFF(SECOND,
                  (SELECT MAX(m2.created_at) FROM messages m2
                     WHERE m2.conversation_id = m.conversation_id
                       AND m2.direction='inbound'
                       AND m2.created_at < m.created_at),
                  m.created_at
                )) avg_resp_sec
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE m.company_id = ?
           AND m.direction = 'outbound'
           AND m.created_at >= ? AND m.created_at <= ?
         GROUP BY COALESCE(m.user_id, c.assigned_user_id)
         HAVING attributed_user_id IS NOT NULL
       ) s ON s.attributed_user_id = u.id
       WHERE u.company_id = ? AND u.role <> 'super_admin'
       ORDER BY sent DESC, name ASC`,
      companyId,
      from,
      to,
      companyId,
    );
    return rows
      .map((r) => ({
        userId: n(r.userId),
        name: r.name,
        sent: n(r.sent),
        conversations: n(r.convos),
        avgResponseSec:
          r.avg_resp_sec == null ? null : Math.round(n(r.avg_resp_sec)),
      }))
      // Hide agents with truly nothing in the window — keeps the table tight.
      .filter((a) => a.sent > 0);
  }

  private async topContacts(
    companyId: number,
    from: Date,
    to: Date,
    limit: number,
  ) {
    const rows = await this.prisma.$queryRawUnsafe<
      {
        id: number;
        name: string;
        phone: string;
        messages: bigint;
        last_at: Date | null;
      }[]
    >(
      `SELECT ct.id, ct.name, ct.phone,
              COUNT(m.id) messages, MAX(m.created_at) last_at
       FROM contacts ct
       JOIN conversations cv ON cv.contact_id = ct.id AND cv.company_id = ?
       JOIN messages m ON m.conversation_id = cv.id
        AND m.created_at >= ? AND m.created_at <= ?
       WHERE ct.company_id = ? AND ct.deleted_at IS NULL
       GROUP BY ct.id, ct.name, ct.phone
       ORDER BY messages DESC, last_at DESC
       LIMIT ?`,
      companyId,
      from,
      to,
      companyId,
      limit,
    );
    return rows.map((r) => ({
      contactId: n(r.id),
      name: r.name,
      phone: r.phone,
      messages: n(r.messages),
      lastSeenAt: r.last_at ? r.last_at.toISOString() : null,
    }));
  }

  private async cachedShort<T>(
    companyId: number,
    route: string,
    paramHash: string,
    producer: () => Promise<T>,
  ): Promise<T> {
    const key = `analytics:${companyId}:${route}:${paramHash}`;
    const hit = this.cache.get<T>(key);
    if (hit !== undefined) return hit;
    const fresh = await producer();
    this.cache.set(key, fresh, DASHBOARD_CACHE_TTL_SEC);
    return fresh;
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
