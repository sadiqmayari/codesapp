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
// Headroom over the 90-day UI preset: timezone-anchored day boundaries make a
// "90 days" range span up to ~91 days (start-of-day-90-days-ago → now), so a
// hard 90 cap would reject the largest preset. 100 leaves room without allowing
// abusively huge scans.
const MAX_RANGE_DAYS = 100;
const DEFAULT_RANGE_DAYS = 30;
// Response-time cutoff. Gaps longer than this are overnight / next-day /
// abandoned-chat replies, NOT a measure of agent responsiveness — counting them
// made the "avg response" read as hours when agents actually reply in minutes.
// We only count reply gaps within this window and report the MEDIAN (robust to
// the remaining long tail) instead of the mean.
const RESPONSE_WINDOW_SEC = 6 * 3600; // 6 hours

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

  async overview(companyId: number, dto: DateRangeDto = {}) {
    const { from, to } = this.resolveRange(dto);
    return this.cached(
      companyId,
      'overview',
      `${from.toISOString()}_${to.toISOString()}`,
      async () => {
        // Current-state figures (all-time snapshots) — not scoped to the range:
        // a lifetime contact count / live conversation state has no "today".
        const [contacts] = await this.prisma.$queryRawUnsafe<{ c: bigint }[]>(
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

        // Activity figures — scoped to the selected range so the rate tiles and
        // the "conversations in range" count follow the Today/7d/30d tabs.
        const [msgs] = await this.prisma.$queryRawUnsafe<
          {
            sent: bigint;
            delivered: bigint;
            read: bigint;
            inbound: bigint;
          }[]
        >(
          `SELECT
             SUM(direction = 'outbound') sent,
             SUM(direction = 'outbound' AND status IN ('delivered','read')) delivered,
             SUM(direction = 'outbound' AND status = 'read') \`read\`,
             SUM(direction = 'inbound') inbound
           FROM messages
           WHERE company_id = ? AND created_at >= ? AND created_at <= ?`,
          companyId,
          from,
          to,
        );
        const [bots] = await this.prisma.$queryRawUnsafe<{ c: bigint }[]>(
          `SELECT COUNT(*) c FROM audit_logs
           WHERE company_id = ? AND action = 'bot.executed'
             AND created_at >= ? AND created_at <= ?`,
          companyId,
          from,
          to,
        );

        const sent = n(msgs?.sent);
        const delivered = n(msgs?.delivered);
        const read = n(msgs?.read);
        const inbound = n(msgs?.inbound);
        const botExec = n(bots?.c);

        // Reply rate = of conversations we messaged outbound IN THIS RANGE, how
        // many the customer replied to (within the range). (An inbound/sent
        // ratio could exceed 100% since one customer sends many inbound msgs.)
        const [conv] = await this.prisma.$queryRawUnsafe<
          { out_convos: bigint; replied: bigint; started: bigint }[]
        >(
          `SELECT COUNT(*) out_convos, SUM(has_in) replied, COUNT(*) started FROM (
             SELECT conversation_id, MAX(direction = 'inbound') has_in
             FROM messages
             WHERE company_id = ? AND created_at >= ? AND created_at <= ?
             GROUP BY conversation_id
             HAVING MAX(direction = 'outbound') = 1
           ) t`,
          companyId,
          from,
          to,
        );
        // Distinct conversations with any activity in the range (replaces the
        // old fixed "this month" count).
        const [activeInRange] = await this.prisma.$queryRawUnsafe<
          { c: bigint }[]
        >(
          `SELECT COUNT(DISTINCT conversation_id) c FROM messages
           WHERE company_id = ? AND created_at >= ? AND created_at <= ?`,
          companyId,
          from,
          to,
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
          // Kept key name for FE compatibility; now = conversations active in
          // the selected range (label updated on the frontend).
          messagesThisMonth: n(activeInRange?.c),
          deliveryRate: pct(delivered, sent),
          readRate: pct(read, delivered),
          replyRate: pct(n(conv?.replied), n(conv?.out_convos)),
          botHandledPct: pct(botExec, inbound),
        };
      },
    );
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

  /** Range-aware + cached wrapper over agentOrders for the dashboard card. */
  async agentOrdersRange(companyId: number, dto: DateRangeDto) {
    const { from, to } = this.resolveRange(dto);
    const orders = await this.cached(
      companyId,
      'agent-orders',
      `${from.toISOString()}_${to.toISOString()}`,
      () => this.agentOrders(companyId, from, to),
    );
    const totals = orders.reduce(
      (acc, a) => ({ orders: acc.orders + a.orders, amount: acc.amount + a.amount }),
      { orders: 0, amount: 0 },
    );
    const currency = orders.find((a) => a.currency)?.currency ?? null;
    return {
      agents: orders,
      totalOrders: totals.orders,
      totalAmount: Math.round(totals.amount * 100) / 100,
      currency,
    };
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
      // First-response latency: for each inbound in the window, the gap to the
      // FIRST outbound that follows it on the same conversation. We report the
      // MEDIAN of gaps within RESPONSE_WINDOW_SEC — averaging every gap with no
      // cap let overnight / next-day / never-really-answered replies dominate,
      // so the tile read as hours. NULL when nobody was answered in-window.
      this.prisma.$queryRawUnsafe<{ avg_sec: number | null }[]>(
        `SELECT MEDIAN(gap) OVER () avg_sec FROM (
           SELECT TIMESTAMPDIFF(SECOND, m.created_at, (
             SELECT MIN(m2.created_at) FROM messages m2
               WHERE m2.conversation_id = m.conversation_id
                 AND m2.direction='outbound'
                 AND m2.created_at > m.created_at
           )) gap
           FROM messages m
           WHERE m.company_id=? AND m.direction='inbound'
             AND m.created_at >= ? AND m.created_at <= ?
         ) t WHERE gap BETWEEN 0 AND ${RESPONSE_WINDOW_SEC}
         LIMIT 1`,
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
   * Per-agent response time = the MEDIAN gap for genuine replies (an outbound
   * whose immediately-preceding message on the conversation is inbound), for
   * gaps within RESPONSE_WINDOW_SEC. Attributed to the REAL human sender
   * (`messages.user_id`), so AI-auto/bot sends (user_id NULL) don't count as an
   * agent's response. (The old query averaged EVERY inbound→outbound gap with no
   * cap, so an overnight or days-later reply counted as a multi-hour "response"
   * and read as hours; median-within-window reads in minutes, as it should.)
   *
   * Orders per agent = orders the agent actually CREATED, sourced from
   * `pending_order_hashes` (the idempotency row written the moment an agent
   * submits the Create-order modal — the true "agent created this" record, and
   * present even for orders that never got a confirmation WhatsApp message).
   * `order_total` is summed for per-agent order value.
   */
  private async agentLeaderboard(companyId: number, from: Date, to: Date) {
    // Thin wrapper over the shared `agentMetrics` engine — kept for the
    // Analytics dashboard payload. Field names (`avgResponseSec`,
    // `conversations`) preserved for the existing UI; zero-activity agents are
    // hidden here (the gamification layer keeps them and decides separately).
    const metrics = await this.agentMetrics(companyId, from, to);
    return metrics
      .map((m) => ({
        userId: m.userId,
        name: m.name,
        sent: m.sent,
        conversations: m.conversations,
        avgResponseSec: m.medianRespSec,
        orders: m.orders,
        orderValue: m.orderValue,
        currency: m.currency,
      }))
      .filter((a) => a.sent > 0);
  }

  /**
   * Shared per-agent metric engine (public — consumed by the leaderboard above
   * AND the GamificationModule). Returns EVERY agent with an attributed
   * outbound in the window, merged with the orders they created. Returns:
   * `{ userId, name, sent, conversations, medianRespSec, orders, orderValue, currency }`.
   * No `sent>0`/activity filter is applied here — callers decide who to hide.
   */
  async agentMetrics(companyId: number, from: Date, to: Date) {
    const [rows, orderRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<
        {
          userId: number;
          name: string;
          sent: bigint;
          convos: bigint;
          median_resp_sec: number | null;
        }[]
      >(
        // Inner-most CTE scans ALL messages of conversations that had an
        // outbound in the window (so LAG can see a preceding inbound that landed
        // just before `from`); the middle WHERE keeps only outbound-in-window
        // rows. MEDIAN is window-only in MariaDB (and COUNT(DISTINCT) can't be a
        // window fn), so we attach the per-agent median (constant across the
        // partition) to each row via a window, then GROUP BY to count sent /
        // distinct convos and pick the median with MAX (it's the same value).
        `SELECT u.id userId, u.name name, agg.sent, agg.convos, agg.median_resp_sec
         FROM (
           SELECT attributed_user_id,
                  COUNT(*) sent,
                  COUNT(DISTINCT conversation_id) convos,
                  MAX(median_resp_sec) median_resp_sec
           FROM (
             SELECT seq.conversation_id,
                    seq.attributed_user_id,
                    MEDIAN(
                      CASE WHEN seq.prev_dir = 'inbound'
                             AND TIMESTAMPDIFF(SECOND, seq.prev_ts, seq.created_at)
                                 BETWEEN 0 AND ${RESPONSE_WINDOW_SEC}
                           THEN TIMESTAMPDIFF(SECOND, seq.prev_ts, seq.created_at)
                      END
                    ) OVER (PARTITION BY seq.attributed_user_id) median_resp_sec
             FROM (
               SELECT m.conversation_id,
                      m.created_at,
                      m.direction,
                      m.user_id attributed_user_id,
                      LAG(m.created_at) OVER w prev_ts,
                      LAG(m.direction)  OVER w prev_dir
               FROM messages m
               WHERE m.company_id = ?
                 AND m.conversation_id IN (
                   SELECT DISTINCT conversation_id FROM messages
                   WHERE company_id = ? AND direction = 'outbound'
                     AND created_at >= ? AND created_at <= ?
                 )
               WINDOW w AS (PARTITION BY m.conversation_id ORDER BY m.created_at, m.id)
             ) seq
             WHERE seq.direction = 'outbound'
               AND seq.created_at >= ? AND seq.created_at <= ?
               AND seq.attributed_user_id IS NOT NULL
           ) z
           GROUP BY attributed_user_id
         ) agg
         JOIN users u ON u.id = agg.attributed_user_id
         WHERE u.company_id = ? AND u.role <> 'super_admin'
         ORDER BY agg.sent DESC, u.name ASC`,
        companyId,
        companyId,
        from,
        to,
        from,
        to,
        companyId,
      ),
      this.agentOrders(companyId, from, to),
    ]);

    const ordersByUser = new Map<
      number,
      { orders: number; amount: number; currency: string | null }
    >();
    for (const o of orderRows) ordersByUser.set(o.userId, o);

    return rows.map((r) => {
      const o = ordersByUser.get(n(r.userId));
      return {
        userId: n(r.userId),
        name: r.name,
        sent: n(r.sent),
        conversations: n(r.convos),
        // Robust median response time in seconds (null when no in-window reply).
        medianRespSec:
          r.median_resp_sec == null ? null : Math.round(n(r.median_resp_sec)),
        orders: o?.orders ?? 0,
        orderValue: o?.amount ?? 0,
        currency: o?.currency ?? null,
      };
    });
  }

  /**
   * Orders created by each agent in the window, with total order value.
   * Sourced from `pending_order_hashes` — the row written the instant an agent
   * submits the Create-order modal (`created_by_user_id` = the creator), which
   * is the authoritative "an agent created this order" record. Only `created`
   * rows count (a real order exists). `order_total` is captured at completion
   * (raw column, no Prisma model field) → summed here; orders placed before that
   * capture shipped contribute to the count but 0 to the value.
   *
   * Orders cancelled or voided on Shopify (`cancelled_at` stamped by
   * `applyOrderCancellationState`) are excluded from BOTH the count and the
   * amount — the row is kept as a record, it just stops counting.
   *
   * Orders created from the Abandoned Checkouts flow (`source='abandoned_cart'`)
   * are ALSO excluded here — they're counted separately under the abandoned-cart
   * "recovered" stat, never mixed into regular per-agent order counts.
   */
  async agentOrders(companyId: number, from: Date, to: Date) {
    const rows = await this.prisma.$queryRawUnsafe<
      {
        userId: number;
        name: string;
        orders: bigint;
        amount: number | null;
        currency: string | null;
      }[]
    >(
      `SELECT u.id userId, u.name name,
              COUNT(*) orders,
              COALESCE(SUM(poh.order_total), 0) amount,
              MAX(poh.order_currency) currency
       FROM pending_order_hashes poh
       JOIN users u ON u.id = poh.created_by_user_id
       WHERE poh.company_id = ?
         AND poh.status = 'created'
         AND poh.cancelled_at IS NULL
         AND (poh.source IS NULL OR poh.source <> 'abandoned_cart')
         AND poh.created_by_user_id IS NOT NULL
         AND poh.created_at >= ? AND poh.created_at <= ?
         AND u.role <> 'super_admin'
       GROUP BY u.id, u.name
       ORDER BY orders DESC, amount DESC`,
      companyId,
      from,
      to,
    );
    return rows.map((r) => ({
      userId: n(r.userId),
      name: r.name,
      orders: n(r.orders),
      amount: Math.round(n(r.amount) * 100) / 100,
      currency: r.currency,
    }));
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
    // contacts/templates = LIVE stored counts (cumulative vs the plan cap);
    // messages/webhooks/conversations = this-month consumption counters.
    const [usage, company, contactsStored, templatesUsed, usersActive] =
      await Promise.all([
        this.prisma.usageMetering.findUnique({
          where: { company_id_period: { company_id: companyId, period } },
        }),
        this.prisma.company.findUnique({
          where: { id: companyId },
          include: { subscription: true },
        }),
        this.prisma.contact.count({
          where: { company_id: companyId, deleted_at: null },
        }),
        this.prisma.template.count({
          where: { company_id: companyId, deleted_at: null },
        }),
        // Seats in use = non-super-admin users that aren't suspended (mirrors
        // what PlanGuard counts against user_limit). Drives the dashboard's
        // "Users" usage bar, which previously had no current value to show.
        this.prisma.user.count({
          where: {
            company_id: companyId,
            role: { not: 'super_admin' },
            status: { not: 'suspended' },
          },
        }),
      ]);
    const sub = company?.subscription;
    return {
      period,
      usage: {
        messagesSent: usage?.messages_sent ?? 0,
        contactsStored,
        templatesUsed,
        usersActive,
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

  /**
   * Click-to-WhatsApp ad attribution: per ad/post that drove chats, how many
   * conversations + unique contacts it produced and how many Shopify orders came
   * out of those chats. Grouped by `conversations.referral_source_id` (the ad/post
   * id captured first-touch), joined to shopify_order_messages for order counts.
   */
  async adAttribution(companyId: number) {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        sourceId: string;
        headline: string | null;
        sourceType: string | null;
        sourceUrl: string | null;
        chats: bigint;
        contacts: bigint;
        orders: bigint;
        firstAt: Date | null;
        lastAt: Date | null;
      }>
    >(
      `SELECT
         c.referral_source_id AS sourceId,
         JSON_UNQUOTE(JSON_EXTRACT(MAX(c.referral), '$.headline'))    AS headline,
         JSON_UNQUOTE(JSON_EXTRACT(MAX(c.referral), '$.source_type')) AS sourceType,
         JSON_UNQUOTE(JSON_EXTRACT(MAX(c.referral), '$.source_url'))  AS sourceUrl,
         COUNT(DISTINCT c.id)         AS chats,
         COUNT(DISTINCT c.contact_id) AS contacts,
         COUNT(DISTINCT som.id)       AS orders,
         MIN(c.referral_at)           AS firstAt,
         MAX(c.referral_at)           AS lastAt
       FROM conversations c
       LEFT JOIN shopify_order_messages som
         ON som.conversation_id = c.id AND som.company_id = c.company_id
       WHERE c.company_id = ?
         AND c.referral_source_id IS NOT NULL
         AND c.deleted_at IS NULL
       GROUP BY c.referral_source_id
       ORDER BY chats DESC
       LIMIT 200`,
      companyId,
    );
    return rows.map((r) => ({
      sourceId: r.sourceId,
      headline: r.headline,
      sourceType: r.sourceType,
      sourceUrl: r.sourceUrl,
      chats: Number(r.chats),
      contacts: Number(r.contacts),
      orders: Number(r.orders),
      firstAt: r.firstAt,
      lastAt: r.lastAt,
    }));
  }
}
