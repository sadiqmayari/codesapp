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

    // Multi-Store: optional single-store drill-down. Must be part of the cache
    // key so "All stores" and a per-store view don't share a cache entry.
    const storeId =
      dto.storeId != null && Number.isFinite(Number(dto.storeId))
        ? Number(dto.storeId)
        : undefined;

    const paramHash = [
      from.toISOString(),
      to.toISOString(),
      granularity,
      compare ? 'cmp' : 'nocmp',
      storeId ? `store${storeId}` : 'allstores',
    ].join('|');

    return this.cached(companyId, 'orders', paramHash, async () => {
      const off = await this.tenantOffset(companyId);
      const [kCur, kPrev, byCourier, byAgent, trend, stores] = await Promise.all([
        this.orderKpis(companyId, from, to, storeId),
        compare
          ? this.orderKpis(companyId, prevFrom, prevTo, storeId)
          : Promise.resolve(null),
        this.ordersByCourier(companyId, from, to, storeId),
        this.agentOrders(companyId, from, to),
        this.ordersTrend(companyId, from, to, granularity, off, storeId),
        this.prisma.shopifyStore.findMany({
          where: { company_id: companyId, status: 'active' },
          orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
          select: { id: true, label: true, shop_domain: true, base_url: true, is_primary: true },
        }),
      ]);

      // Per-store split (side-by-side), computed only for multi-store tenants.
      // Each store reuses orderKpis so the split always reconciles to the
      // combined "All stores" totals above.
      const storeSplit =
        stores.length > 1
          ? await Promise.all(
              stores.map(async (s) => {
                const k = await this.orderKpis(companyId, from, to, s.id);
                return {
                  storeId: s.id,
                  label: s.label || s.shop_domain || s.base_url || 'Store',
                  isPrimary: s.is_primary,
                  orders: k.orders,
                  sales: k.sales,
                  shipped: k.shipped,
                  delivered: k.delivered,
                  deliveryRate:
                    k.shipped > 0 ? Math.round((k.delivered / k.shipped) * 1000) / 10 : null,
                  codOutstanding: k.codOutstanding,
                };
              }),
            )
          : [];

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
        // Multi-Store: side-by-side per-store KPIs (empty for single-store
        // tenants) + which store (if any) this payload is filtered to.
        multiStore: stores.length > 1,
        storeId: storeId ?? null,
        storeSplit,
      };
    });
  }

  /**
   * One-row order KPI aggregate for a window. TWO time semantics, deliberately:
   *  - SALES / ORDER cohort (sales, salesActive, orders, ordersNet) buckets on
   *    o.shopify_created_at — the order date.
   *  - DELIVERY lifecycle (shipped, delivered, failed, the delivered/failed
   *    amounts, COD) buckets on the SHIPMENT'S OWN EVENT DATE — booked_at for
   *    shipped, delivered_at for delivered, failed_at for failed. A parcel is
   *    booked/delivered days AFTER the order is placed, so bucketing these on the
   *    order date made "Today" read ~0 delivered and undercount shipped.
   */
  private async orderKpis(companyId: number, from: Date, to: Date, storeId?: number) {
    // Multi-Store: when a store is selected, filter the ORDER cohort directly
    // and restrict the shipment-based figures to parcels whose order is in that
    // store (via a join). `shopify_store_id` is a column on shopify_orders.
    const storeOrd = storeId ? 'AND o.shopify_store_id = ?' : '';
    // For the shipped count (no order join by default) we add one only when a
    // store is selected, so single-store/legacy behaviour is byte-identical.
    const shippedJoin = storeId
      ? 'JOIN shopify_orders o ON o.company_id = s.company_id AND o.shopify_order_gid = s.shopify_order_gid'
      : '';
    const [salesRows, shippedRows, deliveredRows, failedRows] = await Promise.all([
      // Sales + order cohort — by ORDER creation date.
      this.prisma.$queryRawUnsafe<Record<string, bigint | number | string | null>[]>(
        `SELECT
           COUNT(*)                                                    orders,
           SUM(o.cancelled_at IS NULL)                                 orders_active,
           SUM(o.cancelled_at IS NULL AND (s.status IS NULL OR s.status <> 'failed')) orders_net,
           COALESCE(SUM(o.total_price),0)                              sales,
           COALESCE(SUM(CASE WHEN o.cancelled_at IS NULL THEN o.total_price END),0) sales_active,
           MAX(o.currency)                                             currency
         FROM shopify_orders o
         LEFT JOIN shipments s
           ON s.company_id = o.company_id AND s.shopify_order_gid = o.shopify_order_gid
         WHERE o.company_id = ? AND o.shopify_created_at >= ? AND o.shopify_created_at <= ? ${storeOrd}`,
        ...[companyId, from, to, ...(storeId ? [storeId] : [])],
      ),
      // Shipped — parcels BOOKED in the window.
      this.prisma.$queryRawUnsafe<Record<string, bigint | number | null>[]>(
        `SELECT COUNT(*) shipped
           FROM shipments s
           ${shippedJoin}
          WHERE s.company_id = ? AND s.booked_at >= ? AND s.booked_at <= ? ${storeOrd}`,
        ...[companyId, from, to, ...(storeId ? [storeId] : [])],
      ),
      // Delivered (+ amount, COD) — parcels DELIVERED in the window.
      this.prisma.$queryRawUnsafe<Record<string, bigint | number | null>[]>(
        `SELECT
           COUNT(*)                                                                       delivered,
           COALESCE(SUM(o.total_price),0)                                                 delivered_amount,
           COALESCE(SUM(CASE WHEN s.courier_settled_at IS NULL     THEN o.total_outstanding END),0) cod_outstanding,
           COALESCE(SUM(CASE WHEN s.courier_settled_at IS NOT NULL THEN o.total_outstanding END),0) cod_collected
         FROM shipments s
         LEFT JOIN shopify_orders o
           ON o.company_id = s.company_id AND o.shopify_order_gid = s.shopify_order_gid
         WHERE s.company_id = ? AND s.status = 'delivered' AND s.delivered_at >= ? AND s.delivered_at <= ? ${storeOrd}`,
        ...[companyId, from, to, ...(storeId ? [storeId] : [])],
      ),
      // Failed (+ amount) — parcels that FAILED delivery in the window.
      this.prisma.$queryRawUnsafe<Record<string, bigint | number | null>[]>(
        `SELECT
           COUNT(*)                                                    failed,
           COALESCE(SUM(o.total_price),0)                              failed_amount
         FROM shipments s
         LEFT JOIN shopify_orders o
           ON o.company_id = s.company_id AND o.shopify_order_gid = s.shopify_order_gid
         WHERE s.company_id = ? AND s.status = 'failed' AND s.failed_at >= ? AND s.failed_at <= ? ${storeOrd}`,
        ...[companyId, from, to, ...(storeId ? [storeId] : [])],
      ),
    ]);
    const sRow = salesRows[0];
    const shRow = shippedRows[0];
    const dRow = deliveredRows[0];
    const fRow = failedRows[0];
    return {
      orders: n(sRow?.orders),
      ordersActive: n(sRow?.orders_active),
      ordersNet: n(sRow?.orders_net),
      delivered: n(dRow?.delivered),
      failed: n(fRow?.failed),
      shipped: n(shRow?.shipped),
      sales: Math.round(n(sRow?.sales) * 100) / 100,
      salesActive: Math.round(n(sRow?.sales_active) * 100) / 100,
      deliveredAmount: Math.round(n(dRow?.delivered_amount) * 100) / 100,
      failedAmount: Math.round(n(fRow?.failed_amount) * 100) / 100,
      codOutstanding: Math.round(n(dRow?.cod_outstanding) * 100) / 100,
      codCollected: Math.round(n(dRow?.cod_collected) * 100) / 100,
      currency: (sRow?.currency as string | null) ?? null,
    };
  }

  /** Delivered / failed / in-transit split per courier for the window. */
  private async ordersByCourier(companyId: number, from: Date, to: Date, storeId?: number) {
    const storeOrd = storeId ? 'AND o.shopify_store_id = ?' : '';
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
       WHERE s.company_id = ? AND s.created_at >= ? AND s.created_at <= ? ${storeOrd}
       GROUP BY s.courier_type
       ORDER BY delivered DESC`,
      ...[companyId, from, to, ...(storeId ? [storeId] : [])],
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
    storeId?: number,
  ) {
    const bucket =
      granularity === 'hour'
        ? `DATE_FORMAT(CONVERT_TZ(o.shopify_created_at, '+00:00', '${off}'), '%Y-%m-%d %H:00')`
        : `DATE(CONVERT_TZ(o.shopify_created_at, '+00:00', '${off}'))`;
    const storeOrd = storeId ? 'AND o.shopify_store_id = ?' : '';
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
       WHERE o.company_id = ? AND o.shopify_created_at >= ? AND o.shopify_created_at <= ? ${storeOrd}
       GROUP BY ${bucket}
       ORDER BY bucket`,
      ...[companyId, from, to, ...(storeId ? [storeId] : [])],
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

    const messageUserIds = new Set(rows.map((r) => n(r.userId)));
    const merged = rows.map((r) => {
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

    // An agent can create orders (a recovered cart, an off-chat order) without
    // sending a message in the window. Those wouldn't appear in the message-based
    // rows above, so add them here — otherwise their orders vanish from the
    // leaderboard entirely.
    for (const o of orderRows) {
      if (messageUserIds.has(o.userId)) continue;
      merged.push({
        userId: o.userId,
        name: o.name,
        sent: 0,
        conversations: 0,
        medianRespSec: null,
        orders: o.orders,
        orderValue: o.amount,
        currency: o.currency,
      });
    }
    return merged;
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
   * Orders recovered from the Abandoned Checkouts flow (`source='abandoned_cart'`)
   * ARE counted here: the agent who worked the cart and created the order did
   * real work and it belongs in their leaderboard total, exactly like an
   * inbox-created order. (The company-level abandoned "recovered revenue" KPI is
   * a separate figure and is unaffected — no double count in the leaderboard.)
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

  // ── Agent Performance report (owner/admin) ──────────────────────────────
  async agentsReport(companyId: number, dto: DateRangeDto) {
    const { from, to } = this.resolveRange(dto);
    return this.buildAgentsReport(companyId, from, to);
  }

  private async buildAgentsReport(companyId: number, from: Date, to: Date) {
    const [users, activity, callDistinct, created, delivery] = await Promise.all([
      this.prisma.$queryRawUnsafe<
        { id: number; name: string; role: string; status: string }[]
      >(
        `SELECT id, name, role, status FROM users WHERE company_id = ? AND role <> 'super_admin'`,
        companyId,
      ),
      this.prisma.$queryRawUnsafe<{ uid: number; action: string; c: bigint }[]>(
        `SELECT user_id uid, action, COUNT(*) c FROM agent_activity
          WHERE company_id = ? AND created_at >= ? AND created_at <= ?
          GROUP BY user_id, action`,
        companyId,
        from,
        to,
      ),
      // "Customers contacted" counts CALL LOGS only (the manual Log-call action),
      // NOT WhatsApp chats — those are already tracked on the leaderboard.
      this.prisma.$queryRawUnsafe<{ uid: number; contacted: bigint }[]>(
        `SELECT user_id uid,
                COUNT(DISTINCT COALESCE(order_gid, CONCAT('c-', contact_id))) contacted
           FROM agent_activity
          WHERE company_id = ? AND action = 'contact_logged'
            AND created_at >= ? AND created_at <= ?
          GROUP BY user_id`,
        companyId,
        from,
        to,
      ),
      this.prisma.$queryRawUnsafe<
        { uid: number; created: bigint; value: number | null; currency: string | null }[]
      >(
        `SELECT created_by_user_id uid, COUNT(*) created,
                COALESCE(SUM(order_total), 0) value, MAX(order_currency) currency
           FROM pending_order_hashes
          WHERE company_id = ? AND status = 'created' AND cancelled_at IS NULL
            AND created_by_user_id IS NOT NULL
            AND created_at >= ? AND created_at <= ?
          GROUP BY created_by_user_id`,
        companyId,
        from,
        to,
      ),
      this.prisma.$queryRawUnsafe<
        { uid: number; delivered: bigint; failed: bigint }[]
      >(
        // DISTINCT order_gid so a multi-shipment order (replacement parcel)
        // isn't double-counted by the join.
        `SELECT poh.created_by_user_id uid,
                COUNT(DISTINCT CASE WHEN s.status = 'delivered' THEN poh.order_gid END) delivered,
                COUNT(DISTINCT CASE WHEN s.status = 'failed'    THEN poh.order_gid END) failed
           FROM pending_order_hashes poh
           JOIN shipments s ON s.company_id = poh.company_id
             AND s.shopify_order_gid = poh.order_gid
          WHERE poh.company_id = ? AND poh.status = 'created'
            AND poh.created_by_user_id IS NOT NULL
            AND poh.created_at >= ? AND poh.created_at <= ?
          GROUP BY poh.created_by_user_id`,
        companyId,
        from,
        to,
      ),
    ]);

    type Row = {
      userId: number;
      name: string;
      role: string;
      confirmed: number;
      addressCorrected: number;
      cancelled: number;
      loggedContacts: number;
      customersContacted: number;
      ordersCreated: number;
      orderValue: number;
      currency: string | null;
      delivered: number;
      failed: number;
    };
    const info = new Map(users.map((u) => [n(u.id), { name: u.name, role: u.role }]));
    const map = new Map<number, Row>();
    const row = (uid: number): Row => {
      let r = map.get(uid);
      if (!r) {
        const meta = info.get(uid);
        r = {
          userId: uid,
          name: meta?.name ?? `User ${uid}`,
          role: meta?.role ?? 'agent',
          confirmed: 0,
          addressCorrected: 0,
          cancelled: 0,
          loggedContacts: 0,
          customersContacted: 0,
          ordersCreated: 0,
          orderValue: 0,
          currency: null,
          delivered: 0,
          failed: 0,
        };
        map.set(uid, r);
      }
      return r;
    };
    for (const u of users) row(n(u.id)); // seed the roster so 0-activity agents show
    for (const a of activity) {
      const r = row(n(a.uid));
      const c = n(a.c);
      if (a.action === 'order_confirmed') r.confirmed += c;
      else if (a.action === 'address_corrected') r.addressCorrected += c;
      else if (a.action === 'order_cancelled') r.cancelled += c;
      else if (a.action === 'contact_logged') r.loggedContacts += c;
    }
    for (const c of callDistinct) {
      const r = row(n(c.uid));
      r.customersContacted = n(c.contacted);
    }
    for (const c of created) {
      const r = row(n(c.uid));
      r.ordersCreated = n(c.created);
      r.orderValue = Math.round(n(c.value) * 100) / 100;
      r.currency = c.currency;
    }
    for (const d of delivery) {
      const r = row(n(d.uid));
      r.delivered = n(d.delivered);
      r.failed = n(d.failed);
    }

    const activeIds = new Set(
      users.filter((u) => u.status === 'active').map((u) => n(u.id)),
    );
    const rows = [...map.values()]
      .filter(
        (r) =>
          activeIds.has(r.userId) ||
          r.confirmed || r.addressCorrected || r.cancelled || r.loggedContacts ||
          r.customersContacted || r.ordersCreated,
      )
      .sort(
        (a, b) =>
          b.confirmed - a.confirmed ||
          b.ordersCreated - a.ordersCreated ||
          b.customersContacted - a.customersContacted,
      );

    const totals = rows.reduce(
      (t, r) => ({
        confirmed: t.confirmed + r.confirmed,
        addressCorrected: t.addressCorrected + r.addressCorrected,
        cancelled: t.cancelled + r.cancelled,
        loggedContacts: t.loggedContacts + r.loggedContacts,
        customersContacted: t.customersContacted + r.customersContacted,
        ordersCreated: t.ordersCreated + r.ordersCreated,
        orderValue: Math.round((t.orderValue + r.orderValue) * 100) / 100,
        delivered: t.delivered + r.delivered,
        failed: t.failed + r.failed,
      }),
      {
        confirmed: 0, addressCorrected: 0, cancelled: 0, loggedContacts: 0,
        customersContacted: 0, ordersCreated: 0, orderValue: 0,
        delivered: 0, failed: 0,
      },
    );
    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      rows,
      totals,
      currency: rows.find((r) => r.currency)?.currency ?? null,
    };
  }

  /** Recent action feed for one agent (drives the report drill-down). */
  async agentActivityFeed(companyId: number, userId: number, dto: DateRangeDto) {
    const { from, to } = this.resolveRange(dto);
    const rows = await this.prisma.$queryRawUnsafe<
      {
        action: string;
        order_name: string | null;
        order_gid: string | null;
        contact_id: number | null;
        created_at: Date;
      }[]
    >(
      `SELECT action, order_name, order_gid, contact_id, created_at
         FROM agent_activity
        WHERE company_id = ? AND user_id = ? AND created_at >= ? AND created_at <= ?
        ORDER BY id DESC LIMIT 100`,
      companyId,
      userId,
      from,
      to,
    );
    return rows.map((r) => ({
      action: r.action,
      orderName: r.order_name,
      orderGid: r.order_gid,
      contactId: r.contact_id,
      at: r.created_at,
    }));
  }

  /** CSV of the agents report (owner/admin export). */
  async agentsReportCsv(companyId: number, dto: DateRangeDto): Promise<string> {
    const { from, to } = this.resolveRange(dto);
    const { rows, totals } = await this.buildAgentsReport(companyId, from, to);
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      'Agent', 'Role', 'Orders confirmed', 'Addresses corrected', 'Orders cancelled',
      'Customers contacted (calls)', 'Calls logged',
      'Orders created', 'Order value', 'Delivered', 'Failed',
    ];
    const lines = [header.map(esc).join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.name, r.role, r.confirmed, r.addressCorrected, r.cancelled,
          r.customersContacted, r.loggedContacts,
          r.ordersCreated, r.orderValue, r.delivered, r.failed,
        ].map(esc).join(','),
      );
    }
    lines.push(
      [
        'TEAM TOTAL', '', totals.confirmed, totals.addressCorrected, totals.cancelled,
        totals.customersContacted, totals.loggedContacts,
        totals.ordersCreated, totals.orderValue, totals.delivered, totals.failed,
      ].map(esc).join(','),
    );
    return lines.join('\n');
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

  /** "+05:00" → 300 (minutes). */
  private offsetMinutes(offset: string): number {
    const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3]));
  }

  private static normalizeName(s: string): string {
    return (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /**
   * Per-product daily ad-spend ROAS report. Combines Meta ad spend
   * (ad_spend_daily, matched to products by campaign NAME) with net Shopify
   * sales (shopify_orders.line_items shredded via JSON_TABLE, EXCLUDING
   * cancelled orders and parcels physically returned/RTO-received, bucketed by
   * order date so daily spend vs daily sales line up for COD). "Today" = the
   * tenant-local current day; "Till Date" = month-to-date. Spend whose campaign
   * name matches no product title lands in an "Unmapped" row so totals stay
   * honest. Owner/admin only (routed with RolesGuard).
   */
  async productRoasReport(companyId: number, dto: DashboardDto = {}) {
    const offset = await this.tenantOffset(companyId);
    const offMin = this.offsetMinutes(offset);
    const storeId = dto.storeId ? Number(dto.storeId) : undefined;

    const now = new Date();
    const nowLocal = new Date(now.getTime() + offMin * 60000); // tenant wall clock
    const curMonth = `${nowLocal.getUTCFullYear()}-${String(
      nowLocal.getUTCMonth() + 1,
    ).padStart(2, '0')}`;
    const month =
      dto.month && /^\d{4}-\d{2}$/.test(dto.month) ? dto.month : curMonth;

    return this.cached(
      companyId,
      'product-roas',
      `${month}_${storeId ?? 'all'}`,
      async () => {
        const [my, mm] = month.split('-').map(Number);
        const isCurrent = month === curMonth;
        const daysInMonth = new Date(Date.UTC(my, mm, 0)).getUTCDate();
        const pad = (x: number) => String(x).padStart(2, '0');

        // tenant-local midnight → UTC instant
        const localMidnightUtc = (y: number, m0: number, d: number) =>
          new Date(Date.UTC(y, m0 - 1, d, 0, 0, 0) - offMin * 60000);

        const mtdStart = localMidnightUtc(my, mm, 1);
        const nextMonthStart = localMidnightUtc(my, mm + 1, 1);
        const mtdEnd = isCurrent ? now : nextMonthStart;

        const dayNo = isCurrent ? nowLocal.getUTCDate() : daysInMonth;
        const dayStart = localMidnightUtc(my, mm, dayNo);
        const dayEnd = isCurrent
          ? now
          : new Date(dayStart.getTime() + 86_400_000);
        const daysElapsed = Math.max(1, isCurrent ? dayNo : daysInMonth);

        // spend date strings (tenant-local calendar)
        const monthFirstDate = `${month}-01`;
        const todayDate = `${month}-${pad(dayNo)}`;
        const spendMtdUntil = isCurrent
          ? todayDate
          : `${month}-${pad(daysInMonth)}`;

        const storeClause = storeId ? ` AND o.shopify_store_id = ?` : '';

        type SalesRow = { title: string | null; units: unknown; value: unknown };
        const salesFor = async (from: Date, to: Date) => {
          const params: unknown[] = [companyId, from, to];
          if (storeId) params.push(storeId);
          const rows = await this.prisma.$queryRawUnsafe<SalesRow[]>(
            `SELECT li.title AS title,
                    SUM(li.qty) AS units,
                    SUM(li.qty * li.price) AS value
             FROM shopify_orders o
             JOIN JSON_TABLE(o.line_items, '$[*]' COLUMNS(
               title VARCHAR(255) PATH '$.title',
               qty INT PATH '$.quantity',
               price DECIMAL(12,2) PATH '$.price'
             )) li
             WHERE o.company_id = ?
               AND o.shopify_created_at >= ? AND o.shopify_created_at < ?
               AND o.cancelled_at IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM shipments s
                 WHERE s.company_id = o.company_id
                   AND s.shopify_order_gid = o.shopify_order_gid
                   AND s.received_at IS NOT NULL)
               ${storeClause}
             GROUP BY li.title`,
            ...params,
          );
          const map = new Map<string, { units: number; value: number }>();
          for (const r of rows) {
            const title = (r.title ?? '').trim();
            if (!title) continue;
            map.set(title, { units: n(r.units), value: n(r.value) });
          }
          return map;
        };

        type SpendRow = {
          campaignId: string;
          campaignName: string;
          spend: unknown;
          metaValue: unknown;
        };
        const spendFor = async (fromDate: string, toDate: string) => {
          return this.prisma.$queryRawUnsafe<SpendRow[]>(
            `SELECT campaign_id AS campaignId,
                    MAX(campaign_name) AS campaignName,
                    SUM(spend) AS spend,
                    SUM(meta_conversion_value) AS metaValue
             FROM ad_spend_daily
             WHERE company_id = ? AND spend_date >= ? AND spend_date <= ?
             GROUP BY campaign_id`,
            companyId,
            fromDate,
            toDate,
          );
        };

        const [
          salesToday,
          salesMtd,
          spendToday,
          spendMtd,
          targets,
          company,
          adCampaignRows,
          invProducts,
          invVariants,
        ] = await Promise.all([
          salesFor(dayStart, dayEnd),
          salesFor(mtdStart, mtdEnd),
          spendFor(todayDate, todayDate),
          spendFor(monthFirstDate, spendMtdUntil),
          this.prisma.productTarget.findMany({
            where: { company_id: companyId, period_month: month },
          }),
          this.prisma.company.findUnique({
            where: { id: companyId },
            select: { meta_ads_currency: true },
          }),
          this.prisma.adCampaign.findMany({
            where: { company_id: companyId },
            select: { campaign_id: true, advertised_handle: true },
          }),
          this.prisma.inventoryProduct.findMany({
            where: { company_id: companyId },
            select: { id: true, title: true, handle: true },
            take: 5000,
          }),
          this.prisma.inventoryVariant.findMany({
            where: { company_id: companyId },
            select: {
              shopify_variant_gid: true,
              product_id: true,
              is_bundle: true,
              bundle_components: true,
            },
            take: 20000,
          }),
        ]);

        // Campaign → advertised product (from the ad's destination link).
        const adCampaignMap = new Map<string, string>();
        for (const a of adCampaignRows) {
          if (a.advertised_handle)
            adCampaignMap.set(a.campaign_id, a.advertised_handle.toLowerCase());
        }
        // Inventory maps: handle→title (ad-link resolution) + bundle composition.
        const handleToTitle = new Map<string, string>();
        const productIdToTitle = new Map<number, string>();
        for (const p of invProducts) {
          productIdToTitle.set(p.id, p.title);
          if (p.handle) handleToTitle.set(p.handle.toLowerCase(), p.title);
        }
        const gidToProductId = new Map<string, number>();
        for (const v of invVariants) gidToProductId.set(v.shopify_variant_gid, v.product_id);
        // bundle product title → [{title, qty}] composition (display only).
        const bundleContains = new Map<string, { title: string; qty: number }[]>();
        for (const v of invVariants) {
          if (!v.is_bundle) continue;
          const bundleTitle = productIdToTitle.get(v.product_id);
          if (!bundleTitle) continue;
          const comps = Array.isArray(v.bundle_components)
            ? (v.bundle_components as { gid: string; quantity: number }[])
            : [];
          const list = comps
            .map((c) => {
              const pid = gidToProductId.get(c.gid);
              const t = pid != null ? productIdToTitle.get(pid) : null;
              return t ? { title: t, qty: Number(c.quantity) || 1 } : null;
            })
            .filter((x): x is { title: string; qty: number } => !!x);
          if (list.length) bundleContains.set(bundleTitle, list);
        }

        // ── Spend → product via UTM attribution ────────────────────────────
        // utm_campaign on a web order == the Meta campaign name. For each
        // campaign, split its spend across the products its attributed orders
        // actually sold, weighted by each product's share of that campaign's
        // attributed net revenue (computed over MTD for stability). Campaigns
        // with no attributed orders fall back to a campaign-name product match,
        // else land in the "Unattributed" row so ROAS totals stay honest.
        const attrParams: unknown[] = [companyId, mtdStart, mtdEnd];
        if (storeId) attrParams.push(storeId);
        const attrRows = await this.prisma.$queryRawUnsafe<
          { campaign: string | null; title: string | null; value: unknown }[]
        >(
          `SELECT o.utm_campaign AS campaign, li.title AS title,
                  SUM(li.qty * li.price) AS value
           FROM shopify_orders o
           JOIN JSON_TABLE(o.line_items, '$[*]' COLUMNS(
             title VARCHAR(255) PATH '$.title',
             qty INT PATH '$.quantity',
             price DECIMAL(12,2) PATH '$.price'
           )) li
           WHERE o.company_id = ?
             AND o.shopify_created_at >= ? AND o.shopify_created_at < ?
             AND o.cancelled_at IS NULL
             AND o.utm_campaign IS NOT NULL AND o.utm_campaign <> ''
             AND NOT EXISTS (
               SELECT 1 FROM shipments s
               WHERE s.company_id = o.company_id
                 AND s.shopify_order_gid = o.shopify_order_gid
                 AND s.received_at IS NOT NULL)
             ${storeClause}
           GROUP BY o.utm_campaign, li.title`,
          ...attrParams,
        );
        // campaign (name) -> (product -> attributed revenue)
        const attrByCampaign = new Map<string, Map<string, number>>();
        for (const r of attrRows) {
          const camp = (r.campaign ?? '').trim();
          const title = (r.title ?? '').trim();
          if (!camp || !title) continue;
          if (!attrByCampaign.has(camp)) attrByCampaign.set(camp, new Map());
          const m = attrByCampaign.get(camp)!;
          m.set(title, (m.get(title) ?? 0) + n(r.value));
        }

        // Name-match fallback (only for a campaign with no attribution yet).
        const productTitles = Array.from(
          new Set([...salesMtd.keys(), ...salesToday.keys()]),
        )
          .map((t) => ({ title: t, norm: AnalyticsService.normalizeName(t) }))
          .filter((p) => p.norm.length >= 3)
          .sort((a, b) => b.norm.length - a.norm.length);
        const nameMatch = (campaignName: string): string | null => {
          const norm = AnalyticsService.normalizeName(campaignName);
          for (const p of productTitles) if (norm.includes(p.norm)) return p.title;
          return null;
        };

        const UNMAPPED = 'Unattributed';
        // Resolve a campaign to products: (1) UTM-attributed order mix; else
        // (2) the ad-link advertised product; else (3) a campaign-name match;
        // else Unattributed.
        const resolveCampaign = (campaignId: string, campaignName: string) => {
          const shares = attrByCampaign.get((campaignName ?? '').trim());
          if (shares && shares.size) {
            let total = 0;
            for (const v of shares.values()) total += v;
            if (total > 0) return { shares, total };
          }
          const handle = adCampaignMap.get(campaignId);
          const advTitle = handle ? handleToTitle.get(handle) : undefined;
          if (advTitle) return { single: advTitle, advertised: true };
          const nm = nameMatch(campaignName ?? '');
          if (nm) return { single: nm, advertised: false };
          return { single: UNMAPPED, advertised: false };
        };

        interface CampAgg { spend: number; meta: number; advertised: boolean }
        const allocateRich = (spendRows: SpendRow[]) => {
          const spendByProd = new Map<string, number>();
          const metaByProd = new Map<string, number>();
          const campByProd = new Map<string, Map<string, CampAgg>>();
          const addN = (m: Map<string, number>, k: string, v: number) =>
            m.set(k, (m.get(k) ?? 0) + v);
          const addCamp = (prod: string, name: string, s: number, mv: number, adv: boolean) => {
            if (!campByProd.has(prod)) campByProd.set(prod, new Map());
            const cm = campByProd.get(prod)!;
            const cur = cm.get(name) ?? { spend: 0, meta: 0, advertised: adv };
            cur.spend += s;
            cur.meta += mv;
            cur.advertised = cur.advertised || adv;
            cm.set(name, cur);
          };
          for (const r of spendRows) {
            const spend = n(r.spend);
            const meta = n(r.metaValue);
            if (spend <= 0 && meta <= 0) continue;
            const reso = resolveCampaign(r.campaignId, r.campaignName);
            if ('shares' in reso && reso.shares) {
              for (const [prod, w] of reso.shares) {
                const frac = w / reso.total;
                addN(spendByProd, prod, spend * frac);
                addN(metaByProd, prod, meta * frac);
                addCamp(prod, r.campaignName ?? '', spend * frac, meta * frac, false);
              }
            } else {
              const prod = reso.single;
              addN(spendByProd, prod, spend);
              addN(metaByProd, prod, meta);
              addCamp(prod, r.campaignName ?? '', spend, meta, !!reso.advertised);
            }
          }
          return { spendByProd, metaByProd, campByProd };
        };
        const todayAlloc = allocateRich(spendToday);
        const mtdAlloc = allocateRich(spendMtd);
        const spendTodayByProd = todayAlloc.spendByProd;
        const spendMtdByProd = mtdAlloc.spendByProd;
        const metaMtdByProd = mtdAlloc.metaByProd;
        const campByProd = mtdAlloc.campByProd;

        const targetMap = new Map(
          targets.map((t) => [
            t.product_key,
            { value: Number(t.target_value), units: t.target_units },
          ]),
        );

        const keys = new Set<string>([
          ...salesMtd.keys(),
          ...salesToday.keys(),
          ...spendMtdByProd.keys(),
          ...spendTodayByProd.keys(),
          ...targetMap.keys(),
        ]);

        const div = (a: number, b: number) => (b > 0 ? a / b : null);

        const rows = Array.from(keys).map((key) => {
          const sT = salesToday.get(key) ?? { units: 0, value: 0 };
          const sM = salesMtd.get(key) ?? { units: 0, value: 0 };
          const adToday = spendTodayByProd.get(key) ?? 0;
          const adMtd = spendMtdByProd.get(key) ?? 0;
          const metaMtd = metaMtdByProd.get(key) ?? 0;
          const tgt = targetMap.get(key) ?? { value: 0, units: 0 };
          const contains = bundleContains.get(key);
          const campaigns = Array.from((campByProd.get(key) ?? new Map()).entries())
            .map(([name, c]) => ({
              name,
              spend: (c as CampAgg).spend,
              metaValue: (c as CampAgg).meta,
              metaRoas: div((c as CampAgg).meta, (c as CampAgg).spend),
              advertised: (c as CampAgg).advertised,
            }))
            .sort((a, b) => b.spend - a.spend)
            .slice(0, 8);
          return {
            product: key,
            unmapped: key === UNMAPPED,
            isBundle: !!contains,
            contains: contains ?? undefined,
            adSpendToday: adToday,
            salesValueToday: sT.value,
            salesUnitsToday: sT.units,
            roasToday: div(sT.value, adToday),
            adSpendMtd: adMtd,
            salesValueMtd: sM.value,
            salesUnitsMtd: sM.units,
            roasMtd: div(sM.value, adMtd),
            metaValueMtd: metaMtd,
            metaRoasMtd: div(metaMtd, adMtd),
            avgUnitValue: div(sM.value, sM.units),
            targetValue: tgt.value,
            targetUnits: tgt.units,
            achValue: sM.value,
            achUnits: sM.units,
            achValuePct: tgt.value > 0 ? (sM.value / tgt.value) * 100 : null,
            achUnitsPct: tgt.units > 0 ? (sM.units / tgt.units) * 100 : null,
            projectionValue: (sM.value / daysElapsed) * daysInMonth,
            projectionUnits: Math.round((sM.units / daysElapsed) * daysInMonth),
            campaigns,
          };
        });

        rows.sort((a, b) => {
          if (a.unmapped !== b.unmapped) return a.unmapped ? 1 : -1;
          return b.salesValueMtd - a.salesValueMtd;
        });

        const sum = (f: (r: (typeof rows)[number]) => number) =>
          rows.reduce((acc, r) => acc + f(r), 0);
        const tSpendToday = sum((r) => r.adSpendToday);
        const tSpendMtd = sum((r) => r.adSpendMtd);
        const tValToday = sum((r) => r.salesValueToday);
        const tValMtd = sum((r) => r.salesValueMtd);
        const tMetaMtd = sum((r) => r.metaValueMtd);
        const totals = {
          adSpendToday: tSpendToday,
          salesValueToday: tValToday,
          salesUnitsToday: sum((r) => r.salesUnitsToday),
          roasToday: div(tValToday, tSpendToday),
          adSpendMtd: tSpendMtd,
          salesValueMtd: tValMtd,
          salesUnitsMtd: sum((r) => r.salesUnitsMtd),
          roasMtd: div(tValMtd, tSpendMtd),
          metaConversionValue: tMetaMtd,
          metaRoas: div(tMetaMtd, tSpendMtd),
          targetValue: sum((r) => r.targetValue),
          targetUnits: sum((r) => r.targetUnits),
          projectionValue: sum((r) => r.projectionValue),
          projectionUnits: sum((r) => r.projectionUnits),
        };

        // ── Daily trend (spend + Meta value from ad_spend_daily, net sales from
        // shopify_orders) for the chart. Keyed by YYYY-MM-DD; FE derives ROAS.
        const trendSpendRows = await this.prisma.$queryRawUnsafe<
          { d: string; s: unknown; mv: unknown }[]
        >(
          `SELECT DATE_FORMAT(spend_date,'%Y-%m-%d') d,
                  SUM(spend) s, SUM(meta_conversion_value) mv
           FROM ad_spend_daily
           WHERE company_id = ? AND spend_date >= ? AND spend_date <= ?
           GROUP BY spend_date ORDER BY spend_date`,
          companyId,
          monthFirstDate,
          spendMtdUntil,
        );
        const trendSalesParams: unknown[] = [companyId, mtdStart, mtdEnd];
        if (storeId) trendSalesParams.push(storeId);
        const trendSalesRows = await this.prisma.$queryRawUnsafe<
          { d: string; v: unknown }[]
        >(
          `SELECT DATE(CONVERT_TZ(o.shopify_created_at,'+00:00','${offset}')) d,
                  SUM(li.qty * li.price) v
           FROM shopify_orders o
           JOIN JSON_TABLE(o.line_items, '$[*]' COLUMNS(
             qty INT PATH '$.quantity', price DECIMAL(12,2) PATH '$.price'
           )) li
           WHERE o.company_id = ?
             AND o.shopify_created_at >= ? AND o.shopify_created_at < ?
             AND o.cancelled_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM shipments s
               WHERE s.company_id = o.company_id
                 AND s.shopify_order_gid = o.shopify_order_gid
                 AND s.received_at IS NOT NULL)
             ${storeClause}
           GROUP BY d ORDER BY d`,
          ...trendSalesParams,
        );
        const trendMap = new Map<string, { spend: number; sales: number; metaValue: number }>();
        const tget = (d: string) => {
          if (!trendMap.has(d)) trendMap.set(d, { spend: 0, sales: 0, metaValue: 0 });
          return trendMap.get(d)!;
        };
        for (const r of trendSpendRows) {
          const e = tget(String(r.d));
          e.spend += n(r.s);
          e.metaValue += n(r.mv);
        }
        for (const r of trendSalesRows) tget(String(r.d)).sales += n(r.v);
        const trend = Array.from(trendMap.entries())
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([date, e]) => ({ date, ...e }));

        return {
          month,
          currency: company?.meta_ads_currency ?? null,
          daysElapsed,
          daysInMonth,
          generatedAt: now.toISOString(),
          totals,
          rows,
          trend,
        };
      },
    );
  }

  /**
   * Ad Report v3 — BLENDED store Ads & Profit dashboard (Triple-Whale summary).
   * Store-level only (no per-product attribution). Over an arbitrary [from,to]:
   * order-lifecycle funnel (placed→cancelled→confirmed→fulfilled→returned→net),
   * GROSS (pre-discount) vs NET (post-discount, delivered-kept) revenue, the
   * profit waterfall (−COGS −AdSpend −Shipping −Fees), MER / blended ROAS,
   * AOV, new customers / nCAC, and a daily trend. Owner/admin.
   */
  async adsSummary(companyId: number, dto: DashboardDto = {}) {
    const { from, to } = this.resolveOrdersRange(dto);
    const storeId = dto.storeId ? Number(dto.storeId) : undefined;
    const offset = await this.tenantOffset(companyId);
    return this.cached(
      companyId,
      'ads-summary',
      `${from.toISOString()}_${to.toISOString()}_${storeId ?? 'all'}`,
      async () => {
        const storeClause = storeId ? ' AND o.shopify_store_id = ?' : '';
        // Spend dates must be the TENANT-local calendar day, not the UTC slice of
        // a tenant-local-midnight instant (which rolls back a day for +offset tz
        // and pulled the wrong day's ad spend). Shift by the tenant offset first.
        const offMin = this.offsetMinutes(offset);
        const localYmd = (d: Date) =>
          new Date(d.getTime() + offMin * 60000).toISOString().slice(0, 10);
        const fromDate = localYmd(from);
        const toDate = localYmd(to);
        const spanDays = (to.getTime() - from.getTime()) / 86_400_000;
        const bucket =
          spanDays > 92
            ? `DATE_FORMAT(CONVERT_TZ(o.shopify_created_at,'+00:00','${offset}'),'%x-W%v')`
            : `DATE(CONVERT_TZ(o.shopify_created_at,'+00:00','${offset}'))`;

        // ── 1) Order lifecycle + gross/net/discount (one derived-table pass) ──
        const op: unknown[] = [companyId, companyId, from, to];
        if (storeId) op.push(storeId);
        const [agg] = await this.prisma.$queryRawUnsafe<
          Array<Record<string, unknown>>
        >(
          `SELECT
             COUNT(*) placedN, SUM(gross) grossSales, SUM(disc) discounts,
             SUM(cancelled) cancelledN, SUM(IF(cancelled,gross,0)) cancelledV,
             SUM(1-cancelled) confirmedN, SUM(IF(cancelled,0,gross)) confirmedV,
             SUM(ful) fulfilledN, SUM(IF(ful,gross,0)) fulfilledV,
             SUM(deliv) deliveredN, SUM(IF(deliv,gross,0)) deliveredV,
             SUM(ret) returnedN, SUM(IF(ret,gross,0)) returnedV,
             SUM(IF(cancelled=0 AND ret=0, gross, 0)) realizedGross,
             SUM(IF(cancelled=0 AND ret=0, netv, 0)) netSales,
             SUM(IF(cancelled=0 AND ret=0, 1, 0)) netN,
             SUM(shipcost) shippingCost
           FROM (
             SELECT
               COALESCE(o.subtotal_price + o.total_discounts, o.total_price, 0) gross,
               COALESCE(o.subtotal_price, o.total_price, 0) netv,
               COALESCE(o.total_discounts,0) disc,
               COALESCE(o.courier_invoice_amount,0) shipcost,
               (o.cancelled_at IS NOT NULL) cancelled,
               (o.fulfillment_status='fulfilled' OR s.ship_n>0) ful,
               COALESCE(s.has_delivered,0) deliv,
               COALESCE(s.has_returned,0) ret
             FROM shopify_orders o
             LEFT JOIN (
               SELECT company_id, shopify_order_gid,
                 MAX(status='delivered' OR delivered_at IS NOT NULL) has_delivered,
                 MAX(received_at IS NOT NULL) has_returned,
                 COUNT(*) ship_n
               FROM shipments WHERE company_id = ? GROUP BY company_id, shopify_order_gid
             ) s ON s.company_id=o.company_id AND s.shopify_order_gid=o.shopify_order_gid
             WHERE o.company_id = ? AND o.shopify_created_at >= ? AND o.shopify_created_at < ?${storeClause}
           ) t`,
          ...op,
        );

        // ── 2) COGS (delivered-kept basis) via line variant → inventory cost ──
        const [cogsRow] = await this.prisma.$queryRawUnsafe<
          Array<{ cogs: unknown }>
        >(
          `SELECT SUM(li.qty * COALESCE(iv.cost_price, iv.shopify_unit_cost, 0)) cogs
           FROM shopify_orders o
           JOIN JSON_TABLE(o.line_items, '$[*]' COLUMNS(
             qty INT PATH '$.quantity', variantId VARCHAR(120) PATH '$.variantId'
           )) li
           LEFT JOIN inventory_variants iv
             ON iv.company_id = o.company_id
             AND iv.shopify_variant_gid COLLATE utf8mb4_general_ci = li.variantId COLLATE utf8mb4_general_ci
           WHERE o.company_id = ? AND o.shopify_created_at >= ? AND o.shopify_created_at < ?
             AND o.cancelled_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.company_id=o.company_id
               AND s.shopify_order_gid=o.shopify_order_gid AND s.received_at IS NOT NULL)
             ${storeClause}`,
          companyId,
          from,
          to,
          ...(storeId ? [storeId] : []),
        );

        // ── 3) Ad spend + Meta value over the window ──
        const [spendRow] = await this.prisma.$queryRawUnsafe<
          Array<{ spend: unknown; metaValue: unknown }>
        >(
          `SELECT SUM(spend) spend, SUM(meta_conversion_value) metaValue
           FROM ad_spend_daily WHERE company_id = ? AND spend_date >= ? AND spend_date <= ?`,
          companyId,
          fromDate,
          toDate,
        );

        // ── 4) New customers (first-ever order inside the window) + their revenue ──
        const ncp: unknown[] = [companyId, companyId, from, to, from, to];
        if (storeId) ncp.push(storeId);
        const [newCustRow] = await this.prisma.$queryRawUnsafe<
          Array<{ newCust: unknown; newRev: unknown }>
        >(
          `SELECT COUNT(DISTINCT o.phone) newCust,
                  SUM(COALESCE(o.subtotal_price + o.total_discounts, o.total_price, 0)) newRev
           FROM shopify_orders o
           JOIN (SELECT phone, MIN(shopify_created_at) first_at FROM shopify_orders
                 WHERE company_id = ? AND phone IS NOT NULL AND phone <> '' GROUP BY phone) f
             ON f.phone = o.phone
           WHERE o.company_id = ? AND o.shopify_created_at >= ? AND o.shopify_created_at < ?
             AND f.first_at >= ? AND f.first_at < ?${storeClause}`,
          ...ncp,
        );

        // ── 5) Trend (gross/net/spend/meta per bucket) ──
        const tp: unknown[] = [companyId, from, to];
        if (storeId) tp.push(storeId);
        const trendSales = await this.prisma.$queryRawUnsafe<
          Array<{ d: string; g: unknown; nv: unknown }>
        >(
          `SELECT ${bucket} d,
                  SUM(COALESCE(o.subtotal_price + o.total_discounts, o.total_price, 0)) g,
                  SUM(IF(o.cancelled_at IS NULL AND NOT EXISTS (SELECT 1 FROM shipments s
                    WHERE s.company_id=o.company_id AND s.shopify_order_gid=o.shopify_order_gid
                    AND s.received_at IS NOT NULL),
                    COALESCE(o.subtotal_price, o.total_price, 0), 0)) nv
           FROM shopify_orders o
           WHERE o.company_id = ? AND o.shopify_created_at >= ? AND o.shopify_created_at < ?${storeClause}
           GROUP BY d ORDER BY d`,
          ...tp,
        );
        const trendSpend = await this.prisma.$queryRawUnsafe<
          Array<{ d: string; s: unknown; mv: unknown }>
        >(
          `SELECT ${
            spanDays > 92 ? "DATE_FORMAT(spend_date,'%x-W%v')" : 'spend_date'
          } d, SUM(spend) s, SUM(meta_conversion_value) mv
           FROM ad_spend_daily WHERE company_id = ? AND spend_date >= ? AND spend_date <= ?
           GROUP BY d ORDER BY d`,
          companyId,
          fromDate,
          toDate,
        );

        // ── assemble ──
        const g = (k: string) => n(agg?.[k]);
        const grossSales = g('grossSales');
        const discounts = g('discounts');
        const realizedGross = g('realizedGross');
        const netSales = g('netSales');
        const shippingCost = g('shippingCost');
        const adSpend = n(spendRow?.spend);
        const metaValue = n(spendRow?.metaValue);
        const cogs = n(cogsRow?.cogs);
        const feesCost = 0; // gateway fees: wired later from PaymentSettlement
        const grossProfit = netSales - cogs;
        const netProfit = grossProfit - adSpend - shippingCost - feesCost;
        const orders = g('placedN');
        const newCustomers = n(newCustRow?.newCust);
        const newRev = n(newCustRow?.newRev);
        const div = (a: number, b: number) => (b > 0 ? a / b : null);

        const summary = {
          grossSales,
          netSales,
          discounts,
          adSpend,
          mer: grossSales > 0 ? (adSpend / grossSales) * 100 : null,
          blendedRoasGross: div(grossSales, adSpend),
          blendedRoasNet: div(netSales, adSpend),
          metaRoas: div(metaValue, adSpend),
          cogs,
          grossProfit,
          grossMargin: netSales > 0 ? (grossProfit / netSales) * 100 : null,
          shippingCost,
          feesCost,
          netProfit,
          netMargin: grossSales > 0 ? (netProfit / grossSales) * 100 : null,
          contributionProfit: netProfit,
          orders,
          aov: div(grossSales, orders),
          newCustomers,
          newCustomerRoas: div(newRev, adSpend),
          ncac: div(adSpend, newCustomers),
        };

        const inTransitN = Math.max(0, g('fulfilledN') - g('deliveredN') - g('returnedN'));
        const inTransitV = Math.max(0, g('fulfilledV') - g('deliveredV') - g('returnedV'));
        const funnel = {
          placed: { orders, gross: grossSales },
          cancelled: { orders: g('cancelledN'), gross: g('cancelledV') },
          confirmed: { orders: g('confirmedN'), gross: g('confirmedV') },
          fulfilled: { orders: g('fulfilledN'), gross: g('fulfilledV') },
          inTransit: { orders: inTransitN, gross: inTransitV },
          delivered: { orders: g('deliveredN'), gross: g('deliveredV') },
          returned: { orders: g('returnedN'), gross: g('returnedV') },
          net: { orders: g('netN'), gross: realizedGross, value: netSales },
        };

        const waterfall = [
          { label: 'Gross Sales', value: grossSales, kind: 'abs' },
          { label: 'Cancelled/Returned', value: -(grossSales - realizedGross), kind: 'delta' },
          { label: 'Delivered-kept', value: realizedGross, kind: 'abs' },
          { label: 'Discounts', value: -(realizedGross - netSales), kind: 'delta' },
          { label: 'Net Sales', value: netSales, kind: 'abs' },
          { label: 'COGS', value: -cogs, kind: 'delta' },
          { label: 'Gross Profit', value: grossProfit, kind: 'abs' },
          { label: 'Ad Spend', value: -adSpend, kind: 'delta' },
          { label: 'Shipping', value: -shippingCost, kind: 'delta' },
          { label: 'Fees', value: -feesCost, kind: 'delta' },
          { label: 'Net Profit', value: netProfit, kind: 'abs' },
        ];

        const tmap = new Map<string, { gross: number; net: number; spend: number; metaValue: number }>();
        const tg = (d: string) => {
          if (!tmap.has(d)) tmap.set(d, { gross: 0, net: 0, spend: 0, metaValue: 0 });
          return tmap.get(d)!;
        };
        for (const r of trendSales) {
          const e = tg(String(r.d));
          e.gross += n(r.g);
          e.net += n(r.nv);
        }
        for (const r of trendSpend) {
          const e = tg(String(r.d));
          e.spend += n(r.s);
          e.metaValue += n(r.mv);
        }
        const trend = Array.from(tmap.entries())
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([date, e]) => ({ date, ...e }));

        const company = await this.prisma.company.findUnique({
          where: { id: companyId },
          select: { meta_ads_currency: true },
        });

        return {
          range: { from: from.toISOString(), to: to.toISOString(), spanDays: Math.round(spanDays) },
          currency: company?.meta_ads_currency ?? null,
          generatedAt: new Date().toISOString(),
          summary,
          funnel,
          waterfall,
          trend,
        };
      },
    );
  }

  /**
   * Per-PRODUCT inventory analytics dashboard (owner/admin). Reuses the proven
   * JSON_TABLE line-item shred + the `variantId → inventory_variants` COLLATE
   * join + `cost_price ?? shopify_unit_cost` COGS precedence, then layers on
   * stock-based retail KPIs (sell-through, turnover, GMROI, days-on-hand,
   * dead-stock, ABC/Pareto, star-product quadrant, reorder suggestions) that
   * no other analytics method computes. One cached call. `compare=true` adds a
   * previous equal-length window for sales-flow KPIs + per-product deltas.
   * Stock KPIs have no historical snapshot, so they carry no delta (prev=null).
   */
  async inventoryProductAnalytics(companyId: number, dto: DashboardDto = {}) {
    const { from, to } = this.resolveOrdersRange(dto);
    const offset = await this.tenantOffset(companyId);
    const storeId = dto.storeId ? Number(dto.storeId) : undefined;
    const compare = dto.compare === 'true';
    return this.cached(
      companyId,
      'inventory-product',
      `${from.toISOString()}_${to.toISOString()}_${storeId ?? 'all'}_${compare ? 'c' : 'n'}`,
      async () => {
        const periodMs = to.getTime() - from.getTime();
        const periodDays = Math.max(1, periodMs / 86_400_000);
        const prevFrom = new Date(from.getTime() - periodMs);
        const prevTo = from;
        const storeClauseO = storeId ? ' AND o.shopify_store_id = ?' : '';
        const storeClauseV = storeId ? ' AND v.shopify_store_id = ?' : '';

        // ── Universe: full catalogue (stock + cost), so zero-sale products show
        //    up for dead-stock / reorder. ──
        type UnivRow = {
          variant_gid: string;
          product_id: number | null;
          title: string | null;
          image: string | null;
          vendor: string | null;
          product_type: string | null;
          category: string | null;
          sku: string | null;
          price: unknown;
          cost: unknown;
          local_qty: number;
          reorder_level: number;
          is_bundle: number;
        };
        const univParams: unknown[] = [companyId];
        if (storeId) univParams.push(storeId);
        const universe = await this.prisma.$queryRawUnsafe<UnivRow[]>(
          `SELECT v.shopify_variant_gid AS variant_gid, v.product_id AS product_id,
                  p.title AS title, p.image_url AS image, p.vendor AS vendor,
                  p.product_type AS product_type, v.category AS category, v.sku AS sku,
                  v.price AS price,
                  COALESCE(v.cost_price, v.shopify_unit_cost) AS cost,
                  v.local_qty AS local_qty, v.reorder_level AS reorder_level,
                  v.is_bundle AS is_bundle
           FROM inventory_variants v
           JOIN inventory_products p ON p.id = v.product_id
           WHERE v.company_id = ?${storeClauseV}`,
          ...univParams,
        );

        // ── Sales per variant. excludeReturns=true → net (drop RTO'd orders);
        //    false → gross sold (return-rate denominator). ──
        type SaleRow = {
          variant_gid: string | null;
          title: string | null;
          units: unknown;
          value: unknown;
          discount: unknown;
        };
        const salesByVariant = async (f: Date, t: Date, excludeReturns: boolean) => {
          const params: unknown[] = [companyId, f, t];
          if (storeId) params.push(storeId);
          const retClause = excludeReturns
            ? `AND NOT EXISTS (SELECT 1 FROM shipments s
                 WHERE s.company_id = o.company_id
                   AND s.shopify_order_gid = o.shopify_order_gid
                   AND s.received_at IS NOT NULL)`
            : '';
          const rows = await this.prisma.$queryRawUnsafe<SaleRow[]>(
            `SELECT li.variantId AS variant_gid,
                    MAX(li.title) AS title,
                    SUM(li.qty) AS units,
                    SUM(li.qty * li.price) AS value,
                    SUM(li.disc) AS discount
             FROM shopify_orders o
             JOIN JSON_TABLE(o.line_items, '$[*]' COLUMNS(
               variantId VARCHAR(120) PATH '$.variantId',
               title VARCHAR(255) PATH '$.title',
               qty INT PATH '$.quantity',
               price DECIMAL(12,2) PATH '$.price',
               disc DECIMAL(12,2) PATH '$.lineDiscount'
             )) li
             WHERE o.company_id = ?
               AND o.shopify_created_at >= ? AND o.shopify_created_at < ?
               AND o.cancelled_at IS NULL
               ${retClause}
               ${storeClauseO}
             GROUP BY li.variantId`,
            ...params,
          );
          const map = new Map<
            string,
            { units: number; value: number; discount: number; title: string }
          >();
          for (const r of rows) {
            const gid = (r.variant_gid ?? '').trim();
            if (!gid) continue;
            map.set(gid, {
              units: n(r.units),
              value: n(r.value),
              discount: n(r.discount),
              title: (r.title ?? '').trim(),
            });
          }
          return map;
        };

        const [netMap, grossMap, prevNetMap, prevGrossMap] = await Promise.all([
          salesByVariant(from, to, true),
          salesByVariant(from, to, false),
          compare ? salesByVariant(prevFrom, prevTo, true) : Promise.resolve(new Map()),
          compare ? salesByVariant(prevFrom, prevTo, false) : Promise.resolve(new Map()),
        ]);

        // ── Trend (net revenue + units, tenant-local day / ISO-week > 92d). ──
        const weekly = periodDays > 92;
        const bucket = weekly ? `'%x-W%v'` : `'%Y-%m-%d'`;
        const trendParams: unknown[] = [companyId, from, to];
        if (storeId) trendParams.push(storeId);
        type TrendRow = { d: string; revenue: unknown; units: unknown };
        const trendRows = await this.prisma.$queryRawUnsafe<TrendRow[]>(
          `SELECT DATE_FORMAT(CONVERT_TZ(o.shopify_created_at,'+00:00','${offset}'), ${bucket}) d,
                  SUM(li.qty * li.price - li.disc) revenue,
                  SUM(li.qty) units
           FROM shopify_orders o
           JOIN JSON_TABLE(o.line_items, '$[*]' COLUMNS(
             qty INT PATH '$.quantity',
             price DECIMAL(12,2) PATH '$.price',
             disc DECIMAL(12,2) PATH '$.lineDiscount'
           )) li
           WHERE o.company_id = ?
             AND o.shopify_created_at >= ? AND o.shopify_created_at < ?
             AND o.cancelled_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM shipments s
               WHERE s.company_id = o.company_id
                 AND s.shopify_order_gid = o.shopify_order_gid
                 AND s.received_at IS NOT NULL)
             ${storeClauseO}
           GROUP BY d ORDER BY d`,
          ...trendParams,
        );
        const trend = trendRows.map((r) => ({
          d: String(r.d),
          revenue: Math.round(n(r.revenue)),
          units: n(r.units),
        }));

        // ── Aggregate variants → product ──
        interface Agg {
          key: string;
          productId: number | null;
          title: string;
          image: string | null;
          category: string | null;
          vendor: string | null;
          sku: string | null;
          price: number;
          cost: number;
          onHand: number;
          reorderLevel: number;
          isBundle: boolean;
          unitsNet: number;
          revGross: number; // SUM(qty*price), net of returns, before discount
          discount: number;
          cogs: number;
          unitsGross: number; // incl. returned (return-rate denominator)
          revPrev: number;
        }
        const byKey = new Map<string, Agg>();
        const consumed = new Set<string>();
        const keyFor = (productId: number | null, fallback: string) =>
          productId != null ? `p:${productId}` : `t:${fallback}`;
        const blank = (key: string, seed: Partial<Agg>): Agg => {
          let a = byKey.get(key);
          if (!a) {
            a = {
              key,
              productId: null,
              title: '(untitled)',
              image: null,
              category: null,
              vendor: null,
              sku: null,
              price: 0,
              cost: 0,
              onHand: 0,
              reorderLevel: 0,
              isBundle: false,
              unitsNet: 0,
              revGross: 0,
              discount: 0,
              cogs: 0,
              unitsGross: 0,
              revPrev: 0,
              ...seed,
            };
            byKey.set(key, a);
          }
          return a;
        };

        // Prev-window summary totals (independent of the universe, by gid cost).
        const gidCost = new Map<string, number>();
        let prevRevenueNet = 0;
        let prevUnits = 0;
        let prevCogs = 0;
        let prevGrossUnits = 0;

        for (const u of universe) {
          const k = keyFor(u.product_id, (u.title ?? u.variant_gid).trim());
          const a = blank(k, {
            productId: u.product_id,
            title: (u.title ?? '').trim() || '(untitled)',
            image: u.image,
            category: u.category,
            vendor: u.vendor,
            sku: u.sku,
          });
          a.onHand += Number(u.local_qty) || 0;
          const cost = n(u.cost);
          const price = n(u.price);
          if (!a.cost && cost) a.cost = cost;
          if (!a.price && price) a.price = price;
          if (!a.image && u.image) a.image = u.image;
          if (!a.sku && u.sku) a.sku = u.sku;
          if (!a.category && u.category) a.category = u.category;
          if (Number(u.is_bundle)) a.isBundle = true;
          a.reorderLevel = Math.max(a.reorderLevel, Number(u.reorder_level) || 0);
          gidCost.set(u.variant_gid, cost);

          const net = netMap.get(u.variant_gid);
          if (net) {
            a.unitsNet += net.units;
            a.revGross += net.value;
            a.discount += net.discount;
            a.cogs += net.units * cost;
            consumed.add(u.variant_gid);
          }
          const gross = grossMap.get(u.variant_gid);
          if (gross) {
            a.unitsGross += gross.units;
            consumed.add(u.variant_gid);
          }
          const prev = prevNetMap.get(u.variant_gid) as
            | { units: number; value: number; discount: number }
            | undefined;
          if (prev) a.revPrev += prev.value - prev.discount;
        }

        // Leftover sold variants not in the catalogue (deleted/unsynced product).
        // Attach as standalone rows keyed by title so totals match the table.
        for (const [gid, s] of netMap) {
          if (consumed.has(gid)) continue;
          const key = `t:${s.title || gid}`;
          const a = blank(key, { title: s.title || '(unlinked variant)' });
          a.unitsNet += s.units;
          a.revGross += s.value;
          a.discount += s.discount;
          const g = grossMap.get(gid);
          if (g) a.unitsGross += g.units;
        }

        // Prev summary totals (by gid, cost from current catalogue as proxy).
        if (compare) {
          for (const [gid, s] of prevNetMap as Map<
            string,
            { units: number; value: number; discount: number }
          >) {
            prevRevenueNet += s.value - s.discount;
            prevUnits += s.units;
            prevCogs += s.units * (gidCost.get(gid) ?? 0);
          }
          for (const [, s] of prevGrossMap as Map<
            string,
            { units: number }
          >) {
            prevGrossUnits += s.units;
          }
        }

        // ── Per-product derived metrics ──
        const rowsAll = Array.from(byKey.values()).map((a) => {
          const net = a.revGross - a.discount;
          const grossProfit = net - a.cogs;
          const margin = net > 0 ? (grossProfit / net) * 100 : 0;
          const stockValue = a.onHand * a.cost;
          const sellThrough =
            a.unitsNet + a.onHand > 0 ? (a.unitsNet / (a.unitsNet + a.onHand)) * 100 : 0;
          const returnedUnits = Math.max(0, a.unitsGross - a.unitsNet);
          const returnRate = a.unitsGross > 0 ? (returnedUnits / a.unitsGross) * 100 : 0;
          const velocity = a.unitsNet / periodDays;
          const daysOfCover = velocity > 0 ? a.onHand / velocity : null;
          const reorderFlag =
            !a.isBundle &&
            (a.onHand <= a.reorderLevel || (velocity > 0 && a.onHand / velocity < 14));
          const suggestedReorderQty =
            velocity > 0 ? Math.max(0, Math.ceil(velocity * 30 - a.onHand)) : 0;
          const revPrev = compare ? a.revPrev : null;
          const revDeltaPct =
            compare && a.revPrev > 0
              ? Math.round(((net - a.revPrev) / a.revPrev) * 1000) / 10
              : null;
          return {
            key: a.key,
            productId: a.productId,
            title: a.title,
            image: a.image,
            category: a.category,
            vendor: a.vendor,
            sku: a.sku,
            price: a.price,
            cost: a.cost,
            onHand: a.onHand,
            reorderLevel: a.reorderLevel,
            isBundle: a.isBundle,
            unitsSold: a.unitsNet,
            revenueGross: Math.round(a.revGross),
            discount: Math.round(a.discount),
            revenueNet: Math.round(net),
            cogs: Math.round(a.cogs),
            grossProfit: Math.round(grossProfit),
            margin: Math.round(margin * 10) / 10,
            stockValue: Math.round(stockValue),
            sellThrough: Math.round(sellThrough * 10) / 10,
            returnedUnits,
            returnRate: Math.round(returnRate * 10) / 10,
            velocityPerDay: Math.round(velocity * 100) / 100,
            daysOfCover: daysOfCover == null ? null : Math.round(daysOfCover),
            reorderFlag,
            suggestedReorderQty,
            revPrev: revPrev == null ? null : Math.round(revPrev),
            revDeltaPct,
            abcClass: 'C' as 'A' | 'B' | 'C',
            quadrant: 'dog' as 'star' | 'workhorse' | 'niche' | 'dog' | 'dead',
          };
        });

        // ── ABC / Pareto (by net revenue) ──
        const sorted = [...rowsAll].sort((a, b) => b.revenueNet - a.revenueNet);
        const totalRev = sorted.reduce((s, r) => s + Math.max(0, r.revenueNet), 0);
        let cum = 0;
        let aCount = 0;
        let bCount = 0;
        let cCount = 0;
        let aRev = 0;
        for (const r of sorted) {
          cum += Math.max(0, r.revenueNet);
          const share = totalRev > 0 ? (cum / totalRev) * 100 : 100;
          if (share <= 80) {
            r.abcClass = 'A';
            aCount++;
            aRev += r.revenueNet;
          } else if (share <= 95) {
            r.abcClass = 'B';
            bCount++;
          } else {
            r.abcClass = 'C';
            cCount++;
          }
        }

        // ── Star-product quadrant (revenue × margin, vs medians of sellers) ──
        const sellers = rowsAll.filter((r) => r.revenueNet > 0);
        const median = (xs: number[]) => {
          if (!xs.length) return 0;
          const s = [...xs].sort((a, b) => a - b);
          const m = Math.floor(s.length / 2);
          return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
        };
        const medRev = median(sellers.map((r) => r.revenueNet));
        const medMargin = median(sellers.map((r) => r.margin));
        for (const r of rowsAll) {
          if (r.revenueNet <= 0) {
            r.quadrant = r.onHand > 0 ? 'dead' : 'dog';
            continue;
          }
          const hiRev = r.revenueNet >= medRev;
          const hiMargin = r.margin >= medMargin;
          r.quadrant = hiRev && hiMargin ? 'star' : hiRev ? 'workhorse' : hiMargin ? 'niche' : 'dog';
        }

        // ── Category breakdown ──
        const catMap = new Map<string, { revenue: number; units: number; grossProfit: number }>();
        for (const r of rowsAll) {
          const key = (r.category || r.vendor || 'Uncategorised').trim() || 'Uncategorised';
          const e = catMap.get(key) ?? { revenue: 0, units: 0, grossProfit: 0 };
          e.revenue += r.revenueNet;
          e.units += r.unitsSold;
          e.grossProfit += r.grossProfit;
          catMap.set(key, e);
        }
        const categoryBreakdown = Array.from(catMap.entries())
          .map(([key, e]) => ({ key, revenue: Math.round(e.revenue), units: e.units, grossProfit: Math.round(e.grossProfit) }))
          .sort((a, b) => b.revenue - a.revenue);

        // ── Summary totals ──
        const revenueNet = rowsAll.reduce((s, r) => s + r.revenueNet, 0);
        const unitsSold = rowsAll.reduce((s, r) => s + r.unitsSold, 0);
        const cogs = rowsAll.reduce((s, r) => s + r.cogs, 0);
        const grossProfit = revenueNet - cogs;
        const grossMargin = revenueNet > 0 ? (grossProfit / revenueNet) * 100 : 0;
        const stockValue = rowsAll.reduce((s, r) => s + r.stockValue, 0);
        const onHandUnits = rowsAll.reduce((s, r) => s + r.onHand, 0);
        const totalReturned = rowsAll.reduce((s, r) => s + r.returnedUnits, 0);
        const totalGrossUnits = rowsAll.reduce((s, r) => s + r.unitsSold + r.returnedUnits, 0);
        const returnRate = totalGrossUnits > 0 ? (totalReturned / totalGrossUnits) * 100 : 0;
        const sellThrough =
          unitsSold + onHandUnits > 0 ? (unitsSold / (unitsSold + onHandUnits)) * 100 : 0;
        const turnover = stockValue > 0 ? (cogs * (365 / periodDays)) / stockValue : 0;
        const daysOnHand = turnover > 0 ? 365 / turnover : null;
        const gmroi = stockValue > 0 ? grossProfit / stockValue : 0;

        // Variant-level stock counts (out/low), non-bundle.
        let skus = 0;
        let outOfStock = 0;
        let lowStock = 0;
        for (const u of universe) {
          if (Number(u.is_bundle)) continue;
          skus++;
          const q = Number(u.local_qty) || 0;
          const rl = Number(u.reorder_level) || 0;
          if (q <= 0) outOfStock++;
          else if (q <= rl) lowStock++;
        }
        const deadRows = rowsAll.filter((r) => r.onHand > 0 && r.unitsSold === 0);
        const deadStockCount = deadRows.length;
        const deadStockValue = deadRows.reduce((s, r) => s + r.stockValue, 0);

        const prevGrossProfit = prevRevenueNet - prevCogs;
        const prevReturned = Math.max(0, prevGrossUnits - prevUnits);
        const prevReturnRate = prevGrossUnits > 0 ? (prevReturned / prevGrossUnits) * 100 : 0;
        const kpi = (value: number, prev: number | null) => {
          const v = Math.round(value * 100) / 100;
          if (prev == null) return { value: v, prev: null, deltaPct: null };
          const p = Math.round(prev * 100) / 100;
          const deltaPct = p > 0 ? Math.round(((v - p) / p) * 1000) / 10 : v > 0 ? null : 0;
          return { value: v, prev: p, deltaPct };
        };

        const company = await this.prisma.company.findUnique({
          where: { id: companyId },
          select: { meta_ads_currency: true },
        });

        // Keep the payload bounded for huge catalogues.
        const rows = sorted.slice(0, 2000);

        return {
          range: { from: from.toISOString(), to: to.toISOString(), periodDays: Math.round(periodDays) },
          currency: company?.meta_ads_currency ?? null,
          generatedAt: new Date().toISOString(),
          summary: {
            revenueNet: kpi(revenueNet, compare ? prevRevenueNet : null),
            unitsSold: kpi(unitsSold, compare ? prevUnits : null),
            grossProfit: kpi(grossProfit, compare ? prevGrossProfit : null),
            grossMargin: kpi(grossMargin, compare ? (prevRevenueNet > 0 ? (prevGrossProfit / prevRevenueNet) * 100 : 0) : null),
            cogs: kpi(cogs, compare ? prevCogs : null),
            returnRate: kpi(returnRate, compare ? prevReturnRate : null),
            sellThrough: kpi(sellThrough, null),
            turnover: kpi(turnover, null),
            daysOnHand: { value: daysOnHand == null ? null : Math.round(daysOnHand), prev: null, deltaPct: null },
            gmroi: kpi(gmroi, null),
            stockValue: kpi(stockValue, null),
            onHandUnits: kpi(onHandUnits, null),
            skus: kpi(skus, null),
            outOfStock: kpi(outOfStock, null),
            lowStock: kpi(lowStock, null),
            deadStockCount: kpi(deadStockCount, null),
            deadStockValue: kpi(deadStockValue, null),
          },
          abc: {
            aCount,
            bCount,
            cCount,
            aRevShare: totalRev > 0 ? Math.round((aRev / totalRev) * 1000) / 10 : 0,
          },
          rows,
          categoryBreakdown,
          trend,
        };
      },
    );
  }
}
