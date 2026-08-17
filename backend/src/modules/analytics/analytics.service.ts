import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { DateRangeDto } from './dtos/date-range.dto';
import { DashboardDto } from './dtos/dashboard.dto';
import { COURIER_DISPLAY_NAME } from '../couriers/couriers.constants';

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
// The orders board allows wider Custom ranges (year-over-year) than the
// messaging board — orders/shipments are far fewer rows than messages, so a
// larger scan is cheap. The preset comparisons (Today/Yesterday/Month) stay
// tiny; only an explicit Custom range approaches this cap.
const MAX_ORDERS_RANGE_DAYS = 400;
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

  /** Same as resolveRange but with the wider orders-board cap. */
  private resolveOrdersRange(dto: DateRangeDto): { from: Date; to: Date } {
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
    if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_ORDERS_RANGE_DAYS) {
      throw new BadRequestException(
        `Date range cannot exceed ${MAX_ORDERS_RANGE_DAYS} days`,
      );
    }
    return { from, to };
  }

  /**
   * The tenant's UTC offset as a MySQL "+05:00" string (from companies.timezone),
   * for CONVERT_TZ day/hour bucketing so per-day / per-hour breakdowns land on the
   * tenant's calendar day — not the DB's UTC day (a 04:00 PKT message was being
   * bucketed into the previous UTC day). Numeric offsets need NO MySQL tz tables
   * (named zones do). Falls back to '+00:00' (UTC, unchanged) when no tz is set.
   * Computed at "now" — exact for no-DST zones (Asia/Karachi); a DST tenant can be
   * off by 1h for buckets on the far side of a transition, an acceptable edge.
   */
  private async tenantOffset(companyId: number): Promise<string> {
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { timezone: true },
    });
    const tz = c?.timezone;
    if (!tz) return '+00:00';
    try {
      const at = new Date();
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(at)
        .reduce<Record<string, number>>((a, x) => {
          if (x.type !== 'literal') a[x.type] = Number(x.value);
          return a;
        }, {});
      const asUtc = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
      );
      const offMin = Math.round((asUtc - at.getTime()) / 60000);
      const sign = offMin >= 0 ? '+' : '-';
      const abs = Math.abs(offMin);
      const pad = (x: number) => String(x).padStart(2, '0');
      return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    } catch {
      return '+00:00';
    }
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
    const off = await this.tenantOffset(companyId);
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
             DATE(CONVERT_TZ(created_at, '+00:00', '${off}')) date,
             SUM(direction = 'outbound') sent,
             SUM(direction = 'outbound' AND status IN ('delivered','read')) delivered,
             SUM(direction = 'outbound' AND status = 'read') \`read\`,
             SUM(direction = 'inbound') replied
           FROM messages
           WHERE company_id = ? AND created_at >= ? AND created_at <= ?
           GROUP BY DATE(CONVERT_TZ(created_at, '+00:00', '${off}'))
           ORDER BY DATE(CONVERT_TZ(created_at, '+00:00', '${off}'))`,
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
    const off = await this.tenantOffset(companyId);
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
          `SELECT HOUR(CONVERT_TZ(created_at, '+00:00', '${off}')) hour, COUNT(*) c
           FROM messages
           WHERE company_id = ? AND broadcast_id = ?
             AND status IN ('delivered','read')
           GROUP BY HOUR(CONVERT_TZ(created_at, '+00:00', '${off}')) ORDER BY hour`,
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
    const off = await this.tenantOffset(companyId);
    return this.cached(
      companyId,
      'conversation-cost',
      `${from.toISOString()}_${to.toISOString()}`,
      async () => {
        const [row] = await this.prisma.$queryRawUnsafe<{ c: bigint }[]>(
          `SELECT COUNT(*) c FROM (
             SELECT c.contact_id, DATE(CONVERT_TZ(m.created_at, '+00:00', '${off}')) d
             FROM messages m
             JOIN conversations c ON c.id = m.conversation_id
             WHERE m.company_id = ? AND m.created_at >= ? AND m.created_at <= ?
             GROUP BY c.contact_id, DATE(CONVERT_TZ(m.created_at, '+00:00', '${off}'))
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

  // ────────────────────────────────────────────────────────────────────────
  // Orders analytics board (sales · delivery · courier · agent).
  //
  // Bucketed on shopify_orders.shopify_created_at (the order date, indexed via
  // [company_id, shopify_created_at]). Delivered/failed are driven by the
  // CodesApp courier status (shipments.status) — accurate for orders actually
  // booked & tracked through CodesApp couriers. Money lives on shopify_orders
  // (total_price = gross sale, total_outstanding = COD to collect); cancels are
  // the canonical shopify_orders.cancelled_at (NULL = live).
  // ────────────────────────────────────────────────────────────────────────
  async ordersAnalytics(companyId: number, dto: DashboardDto) {
    const { from, to } = this.resolveOrdersRange(dto);
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

    return this.cached(companyId, 'orders', paramHash, async () => {
      const off = await this.tenantOffset(companyId);
      const [kCur, kPrev, byCourier, byAgent, trend] = await Promise.all([
        this.orderKpis(companyId, from, to),
        compare
          ? this.orderKpis(companyId, prevFrom, prevTo)
          : Promise.resolve(null),
        this.ordersByCourier(companyId, from, to),
        this.agentOrders(companyId, from, to),
        this.ordersTrend(companyId, from, to, granularity, off),
      ]);

      const delta = (cur: number, prev: number | null) => {
        if (prev == null || !Number.isFinite(prev)) return null;
        if (prev === 0) return cur === 0 ? 0 : null; // undefined growth
        return Math.round(((cur - prev) / prev) * 1000) / 10; // 1 decimal %
      };
      const kpi = (key: keyof typeof kCur) => ({
        value: kCur[key] as number,
        prev: kPrev ? (kPrev[key] as number) : null,
        deltaPct: kPrev ? delta(kCur[key] as number, kPrev[key] as number) : null,
      });

      const shipped = kCur.shipped;
      const deliveryRate =
        shipped > 0 ? Math.round((kCur.delivered / shipped) * 1000) / 10 : null;

      return {
        range: {
          from: from.toISOString(),
          to: to.toISOString(),
          prevFrom: compare ? prevFrom.toISOString() : null,
          prevTo: compare ? prevTo.toISOString() : null,
          granularity,
          spanDays: Math.round(spanMs / 86_400_000),
        },
        currency: kCur.currency,
        kpis: {
          sales: kpi('sales'),
          salesActive: kpi('salesActive'),
          deliveredAmount: kpi('deliveredAmount'),
          failedAmount: kpi('failedAmount'),
          orders: kpi('orders'),
          ordersNet: kpi('ordersNet'),
          delivered: kpi('delivered'),
        },
        delivery: {
          shipped,
          delivered: kCur.delivered,
          failed: kCur.failed,
          deliveryRate, // delivered ÷ shipped, %
          codOutstanding: kCur.codOutstanding,
          codCollected: kCur.codCollected,
        },
        byCourier,
        byAgent,
        trend,
      };
    });
  }

  /** One-row order KPI aggregate for a window (SUM(condition) boolean-agg). */
  private async orderKpis(companyId: number, from: Date, to: Date) {
    const [row] = await this.prisma.$queryRawUnsafe<
      Record<string, bigint | number | string | null>[]
    >(
      `SELECT
         COUNT(*)                                                    orders,
         SUM(o.cancelled_at IS NULL)                                 orders_active,
         SUM(o.cancelled_at IS NULL AND (s.status IS NULL OR s.status <> 'failed')) orders_net,
         SUM(s.status = 'delivered')                                 delivered,
         SUM(s.status = 'failed')                                    failed,
         SUM(s.id IS NOT NULL)                                       shipped,
         COALESCE(SUM(o.total_price),0)                              sales,
         COALESCE(SUM(CASE WHEN o.cancelled_at IS NULL THEN o.total_price END),0)       sales_active,
         COALESCE(SUM(CASE WHEN s.status='delivered' THEN o.total_price END),0)         delivered_amount,
         COALESCE(SUM(CASE WHEN s.status='failed'    THEN o.total_price END),0)         failed_amount,
         COALESCE(SUM(CASE WHEN s.status='delivered' AND s.courier_settled_at IS NULL     THEN o.total_outstanding END),0) cod_outstanding,
         COALESCE(SUM(CASE WHEN s.status='delivered' AND s.courier_settled_at IS NOT NULL THEN o.total_outstanding END),0) cod_collected,
         MAX(o.currency)                                             currency
       FROM shopify_orders o
       LEFT JOIN shipments s
         ON s.company_id = o.company_id AND s.shopify_order_gid = o.shopify_order_gid
       WHERE o.company_id = ? AND o.shopify_created_at >= ? AND o.shopify_created_at <= ?`,
      companyId,
      from,
      to,
    );
    return {
      orders: n(row?.orders),
      ordersActive: n(row?.orders_active),
      ordersNet: n(row?.orders_net),
      delivered: n(row?.delivered),
      failed: n(row?.failed),
      shipped: n(row?.shipped),
      sales: Math.round(n(row?.sales) * 100) / 100,
      salesActive: Math.round(n(row?.sales_active) * 100) / 100,
      deliveredAmount: Math.round(n(row?.delivered_amount) * 100) / 100,
      failedAmount: Math.round(n(row?.failed_amount) * 100) / 100,
      codOutstanding: Math.round(n(row?.cod_outstanding) * 100) / 100,
      codCollected: Math.round(n(row?.cod_collected) * 100) / 100,
      currency: (row?.currency as string | null) ?? null,
    };
  }

  /** Delivered / failed / in-transit split per courier for the window. */
  private async ordersByCourier(companyId: number, from: Date, to: Date) {
    const rows = await this.prisma.$queryRawUnsafe<
      Record<string, bigint | number | string | null>[]
    >(
      `SELECT s.courier_type                                        courier,
         SUM(s.status = 'delivered')                                delivered,
         SUM(s.status = 'failed')                                   failed,
         SUM(s.status NOT IN ('delivered','failed','returned','cancelled')) in_transit,
         COALESCE(SUM(CASE WHEN s.status='delivered' THEN o.total_price END),0) delivered_amount,
         COALESCE(SUM(CASE WHEN s.status='delivered' AND s.courier_settled_at IS NULL THEN o.total_outstanding END),0) cod_outstanding
       FROM shipments s
       LEFT JOIN shopify_orders o
         ON o.company_id = s.company_id AND o.shopify_order_gid = s.shopify_order_gid
       WHERE s.company_id = ? AND s.created_at >= ? AND s.created_at <= ?
       GROUP BY s.courier_type
       ORDER BY delivered DESC`,
      companyId,
      from,
      to,
    );
    return rows.map((r) => {
      const code = String(r.courier ?? '');
      return {
        courier: code,
        courierName: COURIER_DISPLAY_NAME[code as never] ?? code,
        delivered: n(r.delivered),
        failed: n(r.failed),
        inTransit: n(r.in_transit),
        deliveredAmount: Math.round(n(r.delivered_amount) * 100) / 100,
        codOutstanding: Math.round(n(r.cod_outstanding) * 100) / 100,
      };
    });
  }

  /** Per-day (or per-hour) sales / orders / delivered series for the window. */
  private async ordersTrend(
    companyId: number,
    from: Date,
    to: Date,
    granularity: 'hour' | 'day',
    off: string,
  ) {
    const bucket =
      granularity === 'hour'
        ? `DATE_FORMAT(CONVERT_TZ(o.shopify_created_at, '+00:00', '${off}'), '%Y-%m-%d %H:00')`
        : `DATE(CONVERT_TZ(o.shopify_created_at, '+00:00', '${off}'))`;
    const rows = await this.prisma.$queryRawUnsafe<
      Record<string, bigint | number | string | null>[]
    >(
      `SELECT ${bucket} bucket,
         COUNT(*)                            orders,
         COALESCE(SUM(o.total_price),0)      sales,
         SUM(s.status = 'delivered')         delivered
       FROM shopify_orders o
       LEFT JOIN shipments s
         ON s.company_id = o.company_id AND s.shopify_order_gid = o.shopify_order_gid
       WHERE o.company_id = ? AND o.shopify_created_at >= ? AND o.shopify_created_at <= ?
       GROUP BY ${bucket}
       ORDER BY bucket`,
      companyId,
      from,
      to,
    );
    return rows.map((r) => ({
      bucket: String(r.bucket ?? ''),
      orders: n(r.orders),
      sales: Math.round(n(r.sales) * 100) / 100,
      delivered: n(r.delivered),
    }));
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
    // Bucket on the TENANT's local time (the frontend renders the bucket string
    // verbatim), so a 04:00 PKT message lands on the tenant's day/hour, not UTC's.
    const off = await this.tenantOffset(companyId);
    const local = `CONVERT_TZ(created_at, '+00:00', '${off}')`;
    const bucketExpr =
      granularity === 'hour'
        ? `DATE_FORMAT(${local}, '%Y-%m-%dT%H:00:00Z')`
        : `DATE_FORMAT(${local}, '%Y-%m-%d')`;
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
    const off = await this.tenantOffset(companyId);
    const local = `CONVERT_TZ(created_at, '+00:00', '${off}')`;
    const rows = await this.prisma.$queryRawUnsafe<
      { dow: number; hr: number; c: bigint }[]
    >(
      // MySQL DAYOFWEEK: 1=Sun..7=Sat → subtract 1 for 0-indexed Sun..Sat.
      // Day-of-week + hour computed in the tenant's timezone.
      `SELECT (DAYOFWEEK(${local})-1) dow, HOUR(${local}) hr, COUNT(*) c
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
