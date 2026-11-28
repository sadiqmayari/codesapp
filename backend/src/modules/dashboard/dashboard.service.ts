import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { FeatureService } from '../../common/services/feature.service';
import { PlatformSettingService } from '../../common/services/platform-setting.service';
import { AiMeteringService } from '../ai/ai-metering.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { InvoiceGeneratorService } from '../billing/invoice-generator.service';
import { resolveEffectiveLimits } from '../../common/utils/effective-limits';
import { MODULE_REGISTRY } from '../../common/features/feature.constants';
import { afterDiscountSql, keptOrderSql, salesSelectSql, salesFromRow } from '../../common/utils/sales';
import { rtoSql } from '../../common/utils/shipment-outcome';
import { buildBrief, median, tenantUtcOffset, type BriefSignals } from './dashboard-math';

const n = (v: unknown): number => {
  if (v == null) return 0;
  const x = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(x) ? x : 0;
};
const DAY = 86_400_000;
/** Settled-parcel window: returns take ~14 days, so a parcel booked < 21 days ago is still open. */
const SETTLE_DAYS = 21;
const CACHE_S = 60;

export interface DashboardLayout {
  hidden: string[];
}

/**
 * Dashboard v3 read model. Combines existing data only (sales rule = common/utils/sales.ts,
 * returns rule = common/utils/shipment-outcome.ts, limits = effective-limits.ts, modules =
 * FeatureService). Every section is best-effort: a failing query returns null for that
 * section, never a 5xx for the whole dashboard.
 */
@Injectable()
export class DashboardService {
  private readonly log = new Logger(DashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly features: FeatureService,
    private readonly platform: PlatformSettingService,
    private readonly aiMetering: AiMeteringService,
    private readonly analytics: AnalyticsService,
  ) {}

  // ───────────────────────── helpers ─────────────────────────

  private async safe<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      this.log.warn(`dashboard ${label} failed: ${(e as Error).message}`);
      return null;
    }
  }

  private async cached<T>(key: string, fn: () => Promise<T>, ttl = CACHE_S): Promise<T> {
    const hit = this.cache.get<T>(key);
    if (hit !== undefined) return hit;
    const v = await fn();
    this.cache.set(key, v, ttl);
    return v;
  }

  private async company(companyId: number) {
    return this.prisma.company.findUnique({
      where: { id: companyId },
      include: { subscription: true },
    });
  }

  // ───────────────────────── manager ─────────────────────────

  async manager(companyId: number, from: Date, to: Date) {
    const key = `dash:${companyId}:mgr:${from.toISOString()}:${to.toISOString()}`;
    return this.cached(key, async () => {
      const co = await this.prisma.company.findUnique({
        where: { id: companyId },
        select: { timezone: true },
      });
      const off = tenantUtcOffset(co?.timezone ?? null);
      const mods = await this.features.modules(companyId);
      const spanMs = Math.max(DAY / 24, to.getTime() - from.getTime());
      const prevTo = new Date(from.getTime() - 1);
      const prevFrom = new Date(prevTo.getTime() - spanMs);

      const [needs, sparks, ads, quality, flow, heat, target, hotspots, cod, convo, unconfirmedOld] =
        await Promise.all([
          this.safe('needs', () => this.needs(companyId, mods.tickets)),
          this.safe('sparks', () => this.sparks(companyId, off)),
          mods.growth ? this.safe('ads', () => this.adSpend(companyId, from, to, prevFrom, prevTo)) : Promise.resolve(null),
          this.safe('quality', () => this.deliveryQuality(companyId)),
          this.safe('flow', () => this.orderFlow(companyId)),
          this.safe('heat', () => this.heatmap(companyId, off)),
          this.safe('target', () => this.monthTarget(companyId, co?.timezone ?? null)),
          this.safe('hotspots', () => this.returnHotspots(companyId)),
          this.safe('cod', () => this.codReceivable(companyId)),
          this.safe('convo', () => this.conversations(companyId, from, to, prevFrom, prevTo)),
          this.safe('unconfirmed', () => this.unconfirmedOlderThan(companyId, DAY)),
        ]);

      const signals: BriefSignals = {
        hotspot: hotspots?.cities[0] ?? null,
        storeRtoRate: hotspots?.storeRate ?? null,
        unconfirmedOld: unconfirmedOld ?? 0,
        target: target ?? null,
        roas: ads?.roas ?? null,
        unreadOldestMin: needs?.unreadOldestMin ?? null,
        unread: needs?.unread ?? 0,
        deliveryRate: quality?.deliveryRate ?? null,
        deliveryRatePrev: quality?.deliveryRatePrev ?? null,
      };

      return {
        needs: needs ? { ...needs, unconfirmedOld: unconfirmedOld ?? 0 } : null,
        sparks,
        ads,
        quality,
        flow,
        heat,
        target,
        hotspots,
        cod,
        conversations: convo,
        brief: buildBrief(signals),
        modules: mods,
      };
    });
  }

  private async needs(companyId: number, ticketsOn: boolean) {
    const [u] = await this.prisma.$queryRawUnsafe<{ c: bigint; oldest: Date | null }[]>(
      `SELECT COUNT(*) c, MIN(last_message_at) oldest FROM conversations
        WHERE company_id = ? AND deleted_at IS NULL AND unread_count > 0 AND status <> 'resolved'`,
      companyId,
    );
    let overdueTickets: number | null = null;
    if (ticketsOn) {
      const [t] = await this.prisma.$queryRawUnsafe<{ c: bigint }[]>(
        `SELECT COUNT(*) c FROM support_tickets
          WHERE company_id = ? AND status IN ('open','in_progress','awaiting_customer')
            AND created_at < ?`,
        companyId,
        new Date(Date.now() - 2 * DAY),
      );
      overdueTickets = n(t?.c);
    }
    const oldest = u?.oldest ? new Date(u.oldest) : null;
    return {
      unread: n(u?.c),
      unreadOldestMin: oldest ? Math.max(0, Math.round((Date.now() - oldest.getTime()) / 60000)) : null,
      overdueTickets,
    };
  }

  /** Placed & not confirmed, not cancelled, never booked, older than `ageMs` (last 14 days). */
  private async unconfirmedOlderThan(companyId: number, ageMs: number) {
    const [r] = await this.prisma.$queryRawUnsafe<{ c: bigint }[]>(
      `SELECT COUNT(*) c FROM shopify_orders o
        WHERE o.company_id = ? AND o.cancelled_at IS NULL AND o.archived_at IS NULL
          AND o.shopify_created_at >= ? AND o.shopify_created_at < ?
          AND o.manual_confirmed_at IS NULL
          AND COALESCE(o.financial_status,'') NOT IN ('paid','partially_paid')
          AND o.shopify_order_gid NOT IN (SELECT m.shopify_order_gid FROM shopify_order_messages m
                WHERE m.company_id = o.company_id AND m.status IN ('confirmed','cancelled'))
          AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.company_id = o.company_id
                AND s.shopify_order_gid = o.shopify_order_gid)`,
      companyId,
      new Date(Date.now() - 14 * DAY),
      new Date(Date.now() - ageMs),
    );
    return n(r?.c);
  }

  /** Last 14 tenant days: gross, net, orders, AOV per day (oldest first). */
  private async sparks(companyId: number, off: string) {
    const since = new Date(Date.now() - 14 * DAY);
    const rows = await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT DATE(CONVERT_TZ(o.shopify_created_at,'+00:00','${off}')) d, ${salesSelectSql('o')}
         FROM shopify_orders o
        WHERE o.company_id = ? AND o.shopify_created_at >= ?
        GROUP BY d ORDER BY d`,
      companyId,
      since,
    );
    return rows.map((r) => {
      const s = salesFromRow(r);
      const d = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10);
      return {
        day: d,
        gross: Math.round(s.gross),
        net: Math.round(s.net),
        orders: s.orders,
        aov: s.keptOrders > 0 ? Math.round(s.net / s.keptOrders) : 0,
      };
    });
  }

  private async adSpend(companyId: number, from: Date, to: Date, prevFrom: Date, prevTo: Date) {
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const sum = async (a: Date, b: Date) => {
      const [r] = await this.prisma.$queryRawUnsafe<{ spend: unknown; c: bigint }[]>(
        `SELECT COALESCE(SUM(spend_base),0) spend, COUNT(*) c FROM ad_insights_daily
          WHERE company_id = ? AND date >= ? AND date <= ?`,
        companyId,
        day(a),
        day(b),
      );
      return { spend: n(r?.spend), rows: n(r?.c) };
    };
    const net = async (a: Date, b: Date) => {
      const [r] = await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT ${salesSelectSql('o')} FROM shopify_orders o
          WHERE o.company_id = ? AND o.shopify_created_at >= ? AND o.shopify_created_at <= ?`,
        companyId,
        a,
        b,
      );
      return salesFromRow(r).net;
    };
    const [cur, prev, netCur, daily] = await Promise.all([
      sum(from, to),
      sum(prevFrom, prevTo),
      net(from, to),
      this.prisma.$queryRawUnsafe<{ d: Date; spend: unknown }[]>(
        `SELECT date d, COALESCE(SUM(spend_base),0) spend FROM ad_insights_daily
          WHERE company_id = ? AND date >= ? GROUP BY date ORDER BY date`,
        companyId,
        day(new Date(Date.now() - 14 * DAY)),
      ),
    ]);
    if (cur.rows === 0 && prev.rows === 0) return null; // no ad account connected
    return {
      spend: Math.round(cur.spend),
      spendPrev: Math.round(prev.spend),
      roas: cur.spend > 0 ? Math.round((netCur / cur.spend) * 100) / 100 : null,
      daily: daily.map((r) => Math.round(n(r.spend))),
    };
  }

  /** Delivery + return rate on SETTLED parcels (booked 21–51 days ago) vs the 30 days before. */
  private async deliveryQuality(companyId: number) {
    const win = async (fromDays: number, toDays: number) => {
      const [r] = await this.prisma.$queryRawUnsafe<{ delivered: bigint; rto: bigint; total: bigint }[]>(
        `SELECT SUM(s.status = 'delivered' AND s.received_at IS NULL) delivered,
                SUM(${rtoSql('s')}) rto, COUNT(*) total
           FROM shipments s
          WHERE s.company_id = ? AND s.courier_type <> 'manual'
            AND s.booked_at >= ? AND s.booked_at < ?
            AND (s.status NOT IN ('cancelled','address_issue') OR s.received_at IS NOT NULL)`,
        companyId,
        new Date(Date.now() - toDays * DAY),
        new Date(Date.now() - fromDays * DAY),
      );
      const d = n(r?.delivered);
      const t = n(r?.rto);
      const resolved = d + t;
      return {
        deliveryRate: resolved > 0 ? Math.round((d / resolved) * 1000) / 10 : null,
        rtoRate: resolved > 0 ? Math.round((t / resolved) * 1000) / 10 : null,
        resolved,
      };
    };
    const [cur, prev] = await Promise.all([
      win(SETTLE_DAYS, SETTLE_DAYS + 30),
      win(SETTLE_DAYS + 30, SETTLE_DAYS + 60),
    ]);
    return {
      deliveryRate: cur.deliveryRate,
      deliveryRatePrev: prev.deliveryRate,
      rtoRate: cur.rtoRate,
      rtoRatePrev: prev.rtoRate,
      parcels: cur.resolved,
    };
  }

  /** Orders placed in the last 30 days and where they ended up (one row per order). */
  private async orderFlow(companyId: number) {
    // Shipments via correlated EXISTS (unique index company_id+gid → fast);
    // confirmations via IN (materialised once). A derived-table join or an
    // EXISTS on shopify_order_messages without a gid index took ~160–190 s on
    // 9k orders (Sois), see ERRORS "[Dashboard] order flow took minutes".
    const has = (cond: string) =>
      `EXISTS (SELECT 1 FROM shipments s WHERE s.company_id = o.company_id AND s.shopify_order_gid = o.shopify_order_gid AND ${cond})`;
    const booked = has('s.booked_at IS NOT NULL');
    const rtoCond = has(rtoSql("s"));
    const [r] = await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT COUNT(*) placed,
              SUM(o.manual_confirmed_at IS NOT NULL OR COALESCE(o.financial_status,'') IN ('paid','partially_paid')
                  OR ${booked}
                  OR o.shopify_order_gid IN (SELECT mx.shopify_order_gid FROM shopify_order_messages mx
                                              WHERE mx.company_id = ? AND mx.status = 'confirmed')) confirmed,
              SUM(${booked}) shipped,
              SUM(${has("s.status = 'delivered' AND s.received_at IS NULL")}) delivered,
              SUM(${rtoCond}) rto,
              SUM(o.cancelled_at IS NOT NULL AND NOT ${booked}) cancelled_pre,
              COALESCE(SUM(CASE WHEN ${rtoCond} THEN ${afterDiscountSql('o')} ELSE 0 END),0) rto_value
         FROM shopify_orders o
        WHERE o.company_id = ? AND o.shopify_created_at >= ?`,
      companyId,
      companyId,
      new Date(Date.now() - 30 * DAY),
    );
    const placed = n(r?.placed);
    const shipped = n(r?.shipped);
    const delivered = n(r?.delivered);
    const rto = n(r?.rto);
    return {
      placed,
      confirmed: n(r?.confirmed),
      shipped,
      delivered,
      rto,
      rtoValue: Math.round(n(r?.rto_value)),
      cancelledBeforeBooking: n(r?.cancelled_pre),
      inTransit: Math.max(0, shipped - delivered - rto),
    };
  }

  /** Inbound messages by weekday × hour (tenant clock), last 28 days. d: 0 = Monday. */
  private async heatmap(companyId: number, off: string) {
    const rows = await this.prisma.$queryRawUnsafe<{ d: number; h: number; c: bigint }[]>(
      `SELECT WEEKDAY(CONVERT_TZ(created_at,'+00:00','${off}')) d,
              HOUR(CONVERT_TZ(created_at,'+00:00','${off}')) h, COUNT(*) c
         FROM messages
        WHERE company_id = ? AND created_at >= ? AND direction = 'inbound'
        GROUP BY d, h`,
      companyId,
      new Date(Date.now() - 28 * DAY),
    );
    const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    let max = 0;
    let peak: { d: number; h: number; c: number } | null = null;
    for (const r of rows) {
      const d = n(r.d);
      const h = n(r.h);
      const c = n(r.c);
      if (d < 0 || d > 6 || h < 0 || h > 23) continue;
      grid[d][h] = c;
      if (c > max) {
        max = c;
        peak = { d, h, c };
      }
    }
    return { grid, max, peak, weeks: 4 };
  }

  /** This tenant month's NET target (sales_targets, all stores) + pace. */
  private async monthTarget(companyId: number, tz: string | null) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date())
      .reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
    const month = `${parts.year}-${parts.month}`;
    const today = Number(parts.day);
    const daysInMonth = new Date(Date.UTC(Number(parts.year), Number(parts.month), 0)).getUTCDate();
    const t = await this.prisma.salesTarget.findFirst({
      where: { company_id: companyId, month, store_id: 0 },
      select: { net_sales_target: true },
    });
    const target = n(t?.net_sales_target);
    if (!target) return { month, target: null, net: null, pct: null, projected: null, neededPerDay: null, onTrack: null };
    const off = tenantUtcOffset(tz);
    const sign = off.startsWith('-') ? -1 : 1;
    const [hh, mm] = off.slice(1).split(':').map(Number);
    const startUtc = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, 1) - sign * (hh * 60 + mm) * 60000);
    const [r] = await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${salesSelectSql('o')} FROM shopify_orders o WHERE o.company_id = ? AND o.shopify_created_at >= ?`,
      companyId,
      startUtc,
    );
    const net = Math.round(salesFromRow(r).net);
    const elapsed = Math.max(1, today);
    const projected = Math.round((net / elapsed) * daysInMonth);
    const daysLeft = Math.max(1, daysInMonth - today + 1);
    return {
      month,
      target: Math.round(target),
      net,
      pct: Math.round((net / target) * 1000) / 10,
      projected,
      neededPerDay: Math.max(0, Math.round((target - net) / daysLeft)),
      onTrack: projected >= target,
    };
  }

  /** Cities returning well above the store's average, on settled parcels (21–180 days). */
  private async returnHotspots(companyId: number) {
    const rows = await this.prisma.$queryRawUnsafe<{ city: string; courier: string; resolved: bigint; rto: bigint }[]>(
      `SELECT LOWER(TRIM(o.city)) city, s.courier_type courier,
              SUM((s.status = 'delivered' AND s.received_at IS NULL) OR ${rtoSql('s')}) resolved,
              SUM(${rtoSql('s')}) rto
         FROM shipments s
         JOIN shopify_orders o ON o.company_id = s.company_id AND o.shopify_order_gid = s.shopify_order_gid
        WHERE s.company_id = ? AND s.courier_type <> 'manual'
          AND s.booked_at >= ? AND s.booked_at < ?
          AND o.city IS NOT NULL AND TRIM(o.city) <> ''
        GROUP BY city, courier`,
      companyId,
      new Date(Date.now() - 180 * DAY),
      new Date(Date.now() - SETTLE_DAYS * DAY),
    );
    const byCity = new Map<string, { resolved: number; rto: number; couriers: { courier: string; resolved: number; rate: number }[] }>();
    let allRes = 0;
    let allRto = 0;
    for (const r of rows) {
      const res = n(r.resolved);
      const rto = n(r.rto);
      allRes += res;
      allRto += rto;
      const c = byCity.get(r.city) ?? { resolved: 0, rto: 0, couriers: [] };
      c.resolved += res;
      c.rto += rto;
      if (res >= 10) c.couriers.push({ courier: String(r.courier), resolved: res, rate: Math.round(((res - rto) / res) * 1000) / 10 });
      byCity.set(r.city, c);
    }
    const storeRate = allRes > 0 ? Math.round((allRto / allRes) * 1000) / 10 : null;
    if (storeRate == null) return { storeRate: null, cities: [] };
    const cities = [...byCity.entries()]
      .filter(([, c]) => c.resolved >= 15)
      .map(([city, c]) => {
        const rate = Math.round((c.rto / c.resolved) * 1000) / 10;
        const best = c.couriers.sort((a, b) => b.rate - a.rate)[0] ?? null;
        return {
          city: city.replace(/\b\w/g, (m) => m.toUpperCase()),
          parcels: c.resolved,
          rtoRate: rate,
          bestCourier: best && c.couriers.length > 1 ? { courier: best.courier, deliveryRate: best.rate } : null,
        };
      })
      .filter((c) => c.rtoRate >= storeRate + 5)
      .sort((a, b) => b.rtoRate * b.parcels - a.rtoRate * a.parcels)
      .slice(0, 5);
    return { storeRate, cities };
  }

  /** Delivered COD still to be paid by the courier. */
  private async codReceivable(companyId: number) {
    const [r] = await this.prisma.$queryRawUnsafe<{ amt: unknown; c: bigint; oldest: Date | null }[]>(
      `SELECT COALESCE(SUM(o.total_outstanding),0) amt, COUNT(*) c, MIN(s.delivered_at) oldest
         FROM shipments s
         JOIN shopify_orders o ON o.company_id = s.company_id AND o.shopify_order_gid = s.shopify_order_gid
        WHERE s.company_id = ? AND s.status = 'delivered' AND s.received_at IS NULL
          AND s.courier_settled_at IS NULL AND s.courier_type <> 'manual' AND o.total_outstanding > 0`,
      companyId,
    );
    const oldest = r?.oldest ? new Date(r.oldest) : null;
    return {
      amount: Math.round(n(r?.amt)),
      parcels: n(r?.c),
      oldestDays: oldest ? Math.floor((Date.now() - oldest.getTime()) / DAY) : null,
    };
  }

  /** First-reply time (human replies after a customer message, capped at 6 h). */
  private async replyTimes(companyId: number, from: Date, to: Date, userId?: number) {
    const rows = await this.prisma.$queryRawUnsafe<{ sec: bigint | number }[]>(
      `SELECT TIMESTAMPDIFF(SECOND, prev_ts, ts) sec FROM (
         SELECT m.direction dir, m.timestamp ts, m.user_id uid, m.sent_by_ai ai,
                LAG(m.direction) OVER (PARTITION BY m.conversation_id ORDER BY m.timestamp) prev_dir,
                LAG(m.timestamp) OVER (PARTITION BY m.conversation_id ORDER BY m.timestamp) prev_ts
           FROM messages m
          WHERE m.company_id = ? AND m.created_at >= ? AND m.created_at <= ?
       ) t
       WHERE dir = 'outbound' AND prev_dir = 'inbound' AND uid IS NOT NULL AND ai = 0
         ${userId ? 'AND uid = ?' : ''}
         AND TIMESTAMPDIFF(SECOND, prev_ts, ts) BETWEEN 0 AND 21600
       LIMIT 20000`,
      ...[companyId, new Date(from.getTime() - 6 * 3600_000), to, ...(userId ? [userId] : [])],
    );
    return median(rows.map((r) => n(r.sec)));
  }

  private async conversations(companyId: number, from: Date, to: Date, prevFrom: Date, prevTo: Date) {
    const [ov, frt, frtPrev, ai] = await Promise.all([
      this.analytics.overview(companyId, { from: from.toISOString(), to: to.toISOString() }),
      this.replyTimes(companyId, from, to),
      this.replyTimes(companyId, prevFrom, prevTo),
      this.prisma.$queryRawUnsafe<{ ai: bigint; total: bigint }[]>(
        `SELECT SUM(sent_by_ai = 1) ai, COUNT(*) total FROM messages
          WHERE company_id = ? AND created_at >= ? AND created_at <= ? AND direction = 'outbound' AND broadcast_id IS NULL`,
        companyId,
        from,
        to,
      ),
    ]);
    const aiRow = ai[0];
    const out = n(aiRow?.total);
    return {
      chats: ov.messagesThisMonth,
      openChats: ov.openChats,
      deliveredRate: ov.deliveryRate,
      readRate: ov.readRate,
      replyRate: ov.replyRate,
      aiShare: out > 0 ? Math.round((n(aiRow?.ai) / out) * 1000) / 10 : null,
      firstReplySec: frt,
      firstReplySecPrev: frtPrev,
    };
  }

  // ───────────────────────── activity feed ─────────────────────────

  async activity(companyId: number, before?: Date) {
    const until = before ?? new Date();
    const since = new Date(until.getTime() - 3 * DAY);
    const q = <T>(sql: string, ...p: unknown[]) =>
      this.safe('activity', () => this.prisma.$queryRawUnsafe<T[]>(sql, ...p)).then((r) => r ?? []);
    const [acts, orders, delivered, booked, received] = await Promise.all([
      q<{ at: Date; action: string; order_name: string | null; name: string | null }>(
        `SELECT a.created_at at, a.action, a.order_name, u.name FROM agent_activity a
           LEFT JOIN users u ON u.id = a.user_id
          WHERE a.company_id = ? AND a.created_at > ? AND a.created_at < ? AND a.action <> 'contact_logged'
          ORDER BY a.created_at DESC LIMIT 30`,
        companyId, since, until,
      ),
      q<{ at: Date; order_name: string | null; amt: unknown; currency: string | null; source: string | null }>(
        `SELECT o.shopify_created_at at, o.order_name, ${afterDiscountSql('o')} amt, o.currency, o.source
           FROM shopify_orders o
          WHERE o.company_id = ? AND o.shopify_created_at > ? AND o.shopify_created_at < ?
          ORDER BY o.shopify_created_at DESC LIMIT 30`,
        companyId, since, until,
      ),
      q<{ dd: string; courier: string; c: bigint; at: Date }>(
        `SELECT DATE(s.delivered_at) dd, s.courier_type courier, COUNT(*) c, MAX(s.delivered_at) at
           FROM shipments s WHERE s.company_id = ? AND s.delivered_at > ? AND s.delivered_at < ?
          GROUP BY dd, courier, HOUR(s.delivered_at) ORDER BY at DESC LIMIT 20`,
        companyId, since, until,
      ),
      q<{ at: Date; courier: string; c: bigint; name: string | null }>(
        `SELECT MAX(s.booked_at) at, s.courier_type courier, COUNT(*) c, MAX(u.name) name
           FROM shipments s LEFT JOIN users u ON u.id = s.created_by_user_id
          WHERE s.company_id = ? AND s.booked_at > ? AND s.booked_at < ?
          GROUP BY s.courier_type, s.created_by_user_id, DATE(s.booked_at), HOUR(s.booked_at)
          ORDER BY at DESC LIMIT 20`,
        companyId, since, until,
      ),
      q<{ at: Date; order_name: string | null; name: string | null }>(
        `SELECT s.received_at at, s.shopify_order_name order_name, u.name
           FROM shipments s LEFT JOIN users u ON u.id = s.received_by_user_id
          WHERE s.company_id = ? AND s.received_at > ? AND s.received_at < ?
          ORDER BY s.received_at DESC LIMIT 20`,
        companyId, since, until,
      ),
    ]);
    const COURIER: Record<string, string> = {
      trax: 'Trax', leopards: 'Leopards', postex: 'PostEx', rocket: 'Rocket', mnp: 'M&P',
      rapidxpk: 'RapidXpk', tcs: 'TCS', manual: 'Manual',
    };
    const ACT: Record<string, string> = {
      order_confirmed: 'confirmed',
      address_corrected: 'fixed the address on',
      order_cancelled: 'cancelled',
    };
    type Ev = { at: string; kind: string; who: string; what: string; ref: string | null };
    const ev: Ev[] = [];
    for (const a of acts)
      ev.push({ at: new Date(a.at).toISOString(), kind: 'agent', who: a.name ?? 'A teammate', what: ACT[a.action] ?? a.action.replace(/_/g, ' '), ref: a.order_name });
    for (const o of orders)
      ev.push({
        at: new Date(o.at).toISOString(),
        kind: 'order',
        who: o.source === 'codesapp' ? 'Order from chat' : 'New order',
        what: `${o.currency ?? ''} ${Math.round(n(o.amt)).toLocaleString('en-US')}`.trim(),
        ref: o.order_name,
      });
    for (const d of delivered)
      ev.push({ at: new Date(d.at).toISOString(), kind: 'courier', who: COURIER[d.courier] ?? d.courier, what: `delivered ${n(d.c)} parcel${n(d.c) === 1 ? '' : 's'}`, ref: null });
    for (const b of booked)
      ev.push({ at: new Date(b.at).toISOString(), kind: 'booking', who: b.name ?? 'Team', what: `booked ${n(b.c)} parcel${n(b.c) === 1 ? '' : 's'} on ${COURIER[b.courier] ?? b.courier}`, ref: null });
    for (const r of received)
      ev.push({ at: new Date(r.at).toISOString(), kind: 'return', who: r.name ?? 'Returns desk', what: 'received a return', ref: r.order_name });
    ev.sort((a, b) => (a.at < b.at ? 1 : -1));
    return { events: ev.slice(0, 30) };
  }

  // ───────────────────────── agent "me" ─────────────────────────

  async me(companyId: number, userId: number) {
    return this.cached(`dash:${companyId}:me:${userId}`, async () => {
      const now = Date.now();
      const co = await this.prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } });
      const tz = co?.timezone ?? null;
      const off = tenantUtcOffset(tz);
      const sign = off.startsWith('-') ? -1 : 1;
      const [hh, mm] = off.slice(1).split(':').map(Number);
      const offMs = sign * (hh * 60 + mm) * 60000;
      const localNow = new Date(now + offMs);
      const dayStart = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) - offMs);
      const monthAgo = new Date(dayStart.getTime() - 30 * DAY);

      const [queue, chats, today, avg, frt, frtTeam, curRow] = await Promise.all([
        this.safe('me.queue', () => this.myQueue(companyId, userId)),
        this.safe('me.chats', () => this.myChats(companyId, userId)),
        this.safe('me.today', () => this.myCounts(companyId, userId, dayStart, new Date(now))),
        this.safe('me.avg', () => this.myCounts(companyId, userId, monthAgo, dayStart)),
        this.safe('me.frt', () => this.replyTimes(companyId, new Date(now - 7 * DAY), new Date(now), userId)),
        this.safe('me.frtTeam', () => this.replyTimes(companyId, new Date(now - 7 * DAY), new Date(now))),
        this.safe('me.cur', () =>
          this.prisma.shopifyOrder.findFirst({
            where: { company_id: companyId, currency: { not: null } },
            orderBy: { id: 'desc' },
            select: { currency: true },
          }),
        ),
      ]);
      const per = (v: number | undefined) => (v == null ? null : Math.round((v / 30) * 10) / 10);
      return {
        queue,
        nextUp: chats?.next ?? null,
        chats: chats?.list ?? [],
        today,
        avg30: avg ? { replies: per(avg.replies), confirmed: per(avg.confirmed), created: per(avg.created) } : null,
        firstReplySec: frt,
        teamFirstReplySec: frtTeam,
        currency: curRow?.currency ?? null,
      };
    }, 30);
  }

  private async myQueue(companyId: number, userId: number) {
    const [r] = await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT SUM(assigned_user_id = ? AND unread_count > 0) mine,
              SUM(assigned_user_id = ? AND unread_count > 0 AND last_message_at < ?) waiting,
              SUM(assigned_user_id IS NULL AND unread_count > 0) pool,
              SUM(assigned_user_id = ?) assigned_open
         FROM conversations
        WHERE company_id = ? AND deleted_at IS NULL AND status <> 'resolved'`,
      userId, userId, new Date(Date.now() - 3600_000), userId, companyId,
    );
    return {
      myUnread: n(r?.mine),
      waitingOver1h: n(r?.waiting),
      pool: n(r?.pool),
      assignedOpen: n(r?.assigned_open),
    };
  }

  /** My chats (assigned to me) + the next one to answer (mine first, else the pool). */
  private async myChats(companyId: number, userId: number) {
    const pick = (where: string, limit: number, ...p: unknown[]) =>
      this.prisma.$queryRawUnsafe<{ id: number; name: string | null; phone: string | null; last: string | null; at: Date | null; unread: number; contact_id: number }[]>(
        `SELECT c.id, ct.name, ct.phone, c.last_message last, c.last_message_at at, c.unread_count unread, c.contact_id
           FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
          WHERE c.company_id = ? AND c.deleted_at IS NULL AND c.status <> 'resolved' AND ${where}
          ORDER BY (c.unread_count > 0) DESC, c.last_message_at ASC LIMIT ${limit}`,
        companyId,
        ...p,
      );
    const mine = await pick('c.assigned_user_id = ?', 6, userId);
    let nextRow = mine.find((c) => n(c.unread) > 0) ?? null;
    if (!nextRow) nextRow = (await pick('c.assigned_user_id IS NULL AND c.unread_count > 0', 1))[0] ?? null;
    const wait = (at: Date | null) => (at ? Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 60000)) : null);
    let next = null;
    if (nextRow) {
      const digits = (nextRow.phone ?? '').replace(/\D/g, '').slice(-10);
      const hist = digits.length >= 9
        ? await this.safe('me.hist', () => this.prisma.$queryRawUnsafe<{ c: bigint; net: unknown; city: string | null }[]>(
            `SELECT COUNT(*) c, COALESCE(SUM(CASE WHEN ${keptOrderSql('o')} THEN ${afterDiscountSql('o')} ELSE 0 END),0) net, MAX(o.city) city
               FROM shopify_orders o WHERE o.company_id = ? AND o.phone LIKE ?`,
            companyId,
            `%${digits}`,
          ))
        : null;
      const h = hist?.[0];
      next = {
        conversationId: nextRow.id,
        name: nextRow.name || nextRow.phone || 'Customer',
        phone: nextRow.phone,
        lastMessage: nextRow.last,
        waitingMin: wait(nextRow.at),
        fromPool: !mine.some((c) => c.id === nextRow!.id),
        orders: h ? n(h.c) : 0,
        lifetimeNet: h ? Math.round(n(h.net)) : 0,
        city: h?.city ?? null,
      };
    }
    return {
      next,
      list: mine.slice(0, 5).map((c) => ({
        conversationId: c.id,
        name: c.name || c.phone || 'Customer',
        lastMessage: c.last,
        unread: n(c.unread),
        waitingMin: n(c.unread) > 0 ? wait(c.at) : null,
      })),
    };
  }

  private async myCounts(companyId: number, userId: number, from: Date, to: Date) {
    const [[m], [a], [o]] = await Promise.all([
      this.prisma.$queryRawUnsafe<{ c: bigint }[]>(
        `SELECT COUNT(DISTINCT conversation_id) c FROM messages
          WHERE company_id = ? AND user_id = ? AND direction = 'outbound' AND created_at >= ? AND created_at < ?`,
        companyId, userId, from, to,
      ),
      this.prisma.$queryRawUnsafe<{ confirmed: bigint }[]>(
        `SELECT SUM(action = 'order_confirmed') confirmed FROM agent_activity
          WHERE company_id = ? AND user_id = ? AND created_at >= ? AND created_at < ?`,
        companyId, userId, from, to,
      ),
      this.prisma.$queryRawUnsafe<{ c: bigint }[]>(
        `SELECT COUNT(*) c FROM order_attributions
          WHERE company_id = ? AND user_id = ? AND kind = 'created' AND at >= ? AND at < ?`,
        companyId, userId, from, to,
      ).catch(() => [{ c: 0n }]),
    ]);
    return { replies: n(m?.c), confirmed: n(a?.confirmed), created: n(o?.c) };
  }

  // ───────────────────────── plan & access ─────────────────────────

  async planAccess(companyId: number) {
    return this.cached(`dash:${companyId}:plan`, async () => {
      const co = await this.company(companyId);
      if (!co) return null;
      const sub = co.subscription;
      const [contacts, templates, seats, stores, numbers, modsFull, platformAction, unpaid, aiUsage, aiCeilingDefault] =
        await Promise.all([
          this.prisma.contact.count({ where: { company_id: companyId, deleted_at: null } }),
          this.prisma.template.count({ where: { company_id: companyId, deleted_at: null } }),
          this.prisma.user.count({ where: { company_id: companyId, role: { not: 'super_admin' }, status: { not: 'suspended' } } }),
          this.prisma.shopifyStore.count({ where: { company_id: companyId } }).catch(() => 0),
          this.prisma.whatsAppNumber.count({ where: { company_id: companyId } }).catch(() => 0),
          this.features.companyModules(companyId),
          this.platform.getUsageLimitAction(),
          this.prisma.invoice.aggregate({
            where: { company_id: companyId, status: { in: ['pending', 'overdue'] } },
            _count: true,
            _sum: { amount: true },
          }),
          this.safe('ai', () => this.aiMetering.getMonthlyUsage(companyId)),
          this.safe('aiDefault', () => this.aiMetering.getDefaultCapCents()),
        ]);

      // Pre-multi-number / pre-multi-store tenants keep their connection on the
      // company row (companies.phone_number_id / shopify_admin_token_encrypted)
      // with no whatsapp_numbers / shopify_stores row — count that as one, or
      // the setup checklist tells a connected tenant to "Connect WhatsApp".
      const numbersUsed = numbers > 0 ? numbers : co.phone_number_id ? 1 : 0;
      const storesUsed = stores > 0 ? stores : co.shopify_admin_token_encrypted ? 1 : 0;

      const limits = sub
        ? (() => {
            const eff = resolveEffectiveLimits(sub, co);
            const row = (key: string, label: string, used: number, limit: number, plan: number) => ({
              key, label, used, limit, planLimit: plan, custom: limit !== plan,
            });
            return [
              row('contacts', 'Contacts', contacts, eff.contact_limit, sub.contact_limit),
              row('templates', 'Templates', templates, eff.template_limit, sub.template_limit),
              row('seats', 'Team seats', seats, eff.user_limit, sub.user_limit),
              row('stores', 'Shopify stores', storesUsed, eff.shopify_store_limit, sub.shopify_store_limit ?? 1),
              row('numbers', 'WhatsApp numbers', numbersUsed,eff.whatsapp_number_limit, sub.whatsapp_number_limit ?? 1),
            ];
          })()
        : [];

      const ownAction = co.usage_limit_action === 'block' || co.usage_limit_action === 'warn_only' ? co.usage_limit_action : null;

      const raw = (co.feature_overrides && typeof co.feature_overrides === 'object' ? co.feature_overrides : {}) as Record<string, unknown>;
      const modules = MODULE_REGISTRY.filter((m) => !m.parent || modsFull.modules[m.parent])
        .map((m) => ({
          key: m.key,
          label: m.label,
          group: m.group,
          on: !!modsFull.modules[m.key],
          note: m.key === 'calls' && modsFull.callsMaxAgents ? `${modsFull.callsMaxAgents} seats` : null,
          setByCodesApp: raw[m.key] === 'on' || raw[m.key] === 'off',
        }));

      let cycle: { start: string; end: string } | null = null;
      if (co.activated_at) {
        const idx = InvoiceGeneratorService.cycleIndex(co.activated_at, new Date());
        if (idx >= 0) {
          cycle = {
            start: InvoiceGeneratorService.cycleStart(co.activated_at, idx).toISOString(),
            end: InvoiceGeneratorService.cycleStart(co.activated_at, idx + 1).toISOString(),
          };
        }
      }

      const aiOn = !!(sub?.ai_enabled && co.ai_enabled && !co.ai_admin_disabled);
      const ceiling = co.ai_admin_cap_cents ?? aiCeilingDefault ?? 0;
      const ai = sub?.ai_enabled
        ? {
            on: aiOn,
            adminDisabled: !!co.ai_admin_disabled,
            spentCents: aiUsage?.billedCents ?? 0,
            tenantCapCents: co.ai_monthly_cap_cents && co.ai_monthly_cap_cents > 0 ? co.ai_monthly_cap_cents : null,
            ceilingCents: ceiling || null,
            ceilingCustom: co.ai_admin_cap_cents != null,
            effectiveCapCents: aiUsage?.capCents ?? null,
          }
        : null;

      const overrides: string[] = [];
      for (const l of limits) if (l.custom) overrides.push(`${l.label.toLowerCase()} ${l.limit.toLocaleString('en-US')} (plan ${l.planLimit.toLocaleString('en-US')})`);
      if (ownAction) overrides.push(ownAction === 'warn_only' ? 'over-limit set to warn only' : 'over-limit set to block');
      if (ai?.ceilingCustom && ai.ceilingCents) overrides.push(`AI ceiling $${(ai.ceilingCents / 100).toFixed(0)}`);
      if (co.grace_until && co.grace_until > new Date()) overrides.push(`payment grace until ${co.grace_until.toISOString().slice(0, 10)}`);

      return {
        plan: sub?.plan_name ?? null,
        status: co.activation_status,
        cycle,
        graceUntil: co.grace_until && co.grace_until > new Date() ? co.grace_until.toISOString() : null,
        unpaid: { count: unpaid._count, amount: n(unpaid._sum.amount) },
        limits,
        usageLimitAction: { value: ownAction ?? platformAction, custom: !!ownAction },
        ai,
        modules,
        overrides,
      };
    });
  }

  // ───────────────────────── layout ─────────────────────────

  async getLayout(companyId: number, userId: number) {
    const [u, c] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { dashboard_layout: true } }),
      this.prisma.company.findUnique({ where: { id: companyId }, select: { dashboard_default: true } }),
    ]);
    const clean = (v: unknown): DashboardLayout | null => {
      if (!v || typeof v !== 'object') return null;
      const h = (v as { hidden?: unknown }).hidden;
      return { hidden: Array.isArray(h) ? h.filter((x): x is string => typeof x === 'string').slice(0, 40) : [] };
    };
    const mine = clean(u?.dashboard_layout);
    const team = clean(c?.dashboard_default);
    return { layout: mine ?? team ?? { hidden: [] }, own: !!mine, teamDefault: team };
  }

  async setLayout(companyId: number, userId: number, layout: DashboardLayout | null, asTeamDefault: boolean) {
    const value = layout ? { hidden: [...new Set(layout.hidden)].slice(0, 40) } : null;
    if (asTeamDefault) {
      await this.prisma.company.update({ where: { id: companyId }, data: { dashboard_default: value ?? Prisma.DbNull } });
    } else {
      await this.prisma.user.update({
        where: { id: userId },
        // null = forget my layout and follow the team default
        data: { dashboard_layout: value ?? Prisma.DbNull },
      });
    }
    return this.getLayout(companyId, userId);
  }
}
