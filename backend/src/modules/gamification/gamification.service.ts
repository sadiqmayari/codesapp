import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { AnalyticsService } from '../analytics/analytics.service';
import {
  BadgeDef,
  BadgeMetric,
  DEFAULT_GAME_CONFIG,
  GAME_METRICS,
  GameConfig,
  GameMetric,
  PointsConfig,
  SpeedConfig,
} from './gamification.constants';
import { CreateContestDto, UpdateContestDto } from './dtos/contest.dto';
import { SetTargetDto, TARGET_PERIODS, TargetPeriod } from './dtos/target.dto';
import { UpdateGameConfigDto } from './dtos/config.dto';

const CONFIG_TTL_SEC = 300;

type Actor = { userId: number; companyId: number; role: string };

/** One agent's raw metrics from AnalyticsService.agentMetrics + derived fields. */
interface AgentMetric {
  userId: number;
  name: string;
  sent: number;
  conversations: number;
  medianRespSec: number | null;
  orders: number;
  orderValue: number;
  currency: string | null;
}

interface EnrichedAgent {
  userId: number;
  name: string;
  orders: number;
  orderValue: number;
  currency: string | null;
  chats: number;
  medianRespSec: number | null;
  conversionRate: number;
  cartsRecovered: number;
  points: number;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function num(v: unknown, fallback = 0): number {
  const x = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(x) ? x : fallback;
}

/** Standard competition ranking (ties share a rank; next rank skips). */
function rankOf(
  values: { userId: number; value: number }[],
  higherBetter: boolean,
): Map<number, number> {
  const sorted = [...values].sort((a, b) =>
    higherBetter ? b.value - a.value : a.value - b.value,
  );
  const map = new Map<number, number>();
  let rank = 0;
  let prev: number | undefined;
  let count = 0;
  for (const v of sorted) {
    count++;
    if (prev === undefined || v.value !== prev) {
      rank = count;
      prev = v.value;
    }
    map.set(v.userId, rank);
  }
  return map;
}

@Injectable()
export class GamificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly analytics: AnalyticsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Config (admin-configurable point weights + badges)
  // ---------------------------------------------------------------------------
  private configKey(companyId: number) {
    return `gamification:config:${companyId}`;
  }

  async getConfig(companyId: number): Promise<GameConfig> {
    const hit = this.cache.get<GameConfig>(this.configKey(companyId));
    if (hit) return hit;
    const rows = await this.prisma.$queryRawUnsafe<{ config: unknown }[]>(
      `SELECT config FROM gamification_settings WHERE company_id = ? LIMIT 1`,
      companyId,
    );
    const parsed = this.parseConfig(rows[0]?.config);
    this.cache.set(this.configKey(companyId), parsed, CONFIG_TTL_SEC);
    return parsed;
  }

  private parseConfig(stored: unknown): GameConfig {
    let obj: Record<string, unknown> = {};
    try {
      if (typeof stored === 'string') obj = JSON.parse(stored);
      else if (stored && typeof stored === 'object')
        obj = stored as Record<string, unknown>;
    } catch {
      obj = {};
    }
    const badges = Array.isArray(obj.badges)
      ? this.sanitizeBadges(obj.badges as Array<Record<string, unknown>>)
      : [];
    return {
      points: this.sanitizePoints({
        ...DEFAULT_GAME_CONFIG.points,
        ...((obj.points as object) ?? {}),
      }),
      speed: this.sanitizeSpeed({
        ...DEFAULT_GAME_CONFIG.speed,
        ...((obj.speed as object) ?? {}),
      }),
      badges: badges.length ? badges : DEFAULT_GAME_CONFIG.badges,
    };
  }

  private sanitizePoints(p: Record<string, unknown>): PointsConfig {
    const nn = (v: unknown, d: number) => {
      const x = Number(v);
      return Number.isFinite(x) && x >= 0 ? x : d;
    };
    const d = DEFAULT_GAME_CONFIG.points;
    return {
      perOrder: nn(p.perOrder, d.perOrder),
      perRevenue1000: nn(p.perRevenue1000, d.perRevenue1000),
      perChat: nn(p.perChat, d.perChat),
      perCartRecovered: nn(p.perCartRecovered, d.perCartRecovered),
      conversionBonusMax: nn(p.conversionBonusMax, d.conversionBonusMax),
      speedBonusMax: nn(p.speedBonusMax, d.speedBonusMax),
    };
  }

  private sanitizeSpeed(s: Record<string, unknown>): SpeedConfig {
    const d = DEFAULT_GAME_CONFIG.speed;
    let fastSec = Number(s.fastSec);
    let slowSec = Number(s.slowSec);
    if (!Number.isFinite(fastSec) || fastSec < 0) fastSec = d.fastSec;
    if (!Number.isFinite(slowSec) || slowSec <= fastSec) slowSec = Math.max(fastSec + 1, d.slowSec);
    return { fastSec, slowSec };
  }

  private sanitizeBadges(raw: Array<Record<string, unknown>>): BadgeDef[] {
    const metrics: BadgeMetric[] = [...GAME_METRICS, 'medianRespSec'];
    const ops: BadgeDef['op'][] = ['<=', '>=', '==', '<', '>'];
    const out: BadgeDef[] = [];
    for (const b of raw) {
      const id = String(b.id ?? '').slice(0, 40);
      const label = String(b.label ?? '').slice(0, 60);
      const type = b.type === 'rank' ? 'rank' : 'metric';
      const metric = metrics.includes(b.metric as BadgeMetric)
        ? (b.metric as BadgeMetric)
        : null;
      const op = ops.includes(b.op as BadgeDef['op'])
        ? (b.op as BadgeDef['op'])
        : null;
      const threshold = Number(b.threshold);
      if (!id || !label || !metric || !op || !Number.isFinite(threshold)) continue;
      out.push({ id, label, type, metric, op, threshold });
    }
    return out;
  }

  async updateConfig(companyId: number, dto: UpdateGameConfigDto): Promise<GameConfig> {
    const current = await this.getConfig(companyId);
    const next: GameConfig = {
      points: this.sanitizePoints({ ...current.points, ...(dto.points ?? {}) }),
      speed: this.sanitizeSpeed({ ...current.speed, ...(dto.speed ?? {}) }),
      badges: dto.badges
        ? this.sanitizeBadges(dto.badges).length
          ? this.sanitizeBadges(dto.badges)
          : current.badges
        : current.badges,
    };
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO gamification_settings (company_id, config, updated_at)
       VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE config = VALUES(config), updated_at = NOW()`,
      companyId,
      JSON.stringify(next),
    );
    this.cache.del(this.configKey(companyId));
    return next;
  }

  // ---------------------------------------------------------------------------
  // Leaderboard
  // ---------------------------------------------------------------------------
  private async enrich(companyId: number, from: Date, to: Date, config: GameConfig) {
    const [metrics, cartsByUser] = await Promise.all([
      this.analytics.agentMetrics(companyId, from, to) as Promise<AgentMetric[]>,
      this.cartsRecoveredByUser(companyId, from, to),
    ]);
    const active = metrics.filter((m) => m.sent > 0 || m.orders > 0);
    return active.map<EnrichedAgent>((m) => {
      const chats = m.conversations;
      const conversionRate = chats > 0 ? m.orders / chats : 0;
      const cartsRecovered = cartsByUser.get(m.userId) ?? 0;
      return {
        userId: m.userId,
        name: m.name,
        orders: m.orders,
        orderValue: m.orderValue,
        currency: m.currency,
        chats,
        medianRespSec: m.medianRespSec,
        conversionRate,
        cartsRecovered,
        points: this.computePoints(m, conversionRate, cartsRecovered, config),
      };
    });
  }

  /**
   * Abandoned carts recovered per agent in the window: carts ASSIGNED to the
   * agent that then converted (converted_at within [from,to]). Raw query over
   * the shopify_abandoned_checkouts columns (not in schema.prisma). Tenant-scoped,
   * never throws.
   */
  private async cartsRecoveredByUser(
    companyId: number,
    from: Date,
    to: Date,
  ): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    try {
      const rows = await this.prisma.$queryRawUnsafe<
        Array<{ userId: number; n: bigint }>
      >(
        `SELECT assigned_user_id userId, COUNT(*) n
         FROM shopify_abandoned_checkouts
         WHERE company_id = ?
           AND assigned_user_id IS NOT NULL
           AND converted_at IS NOT NULL
           AND converted_at >= ? AND converted_at <= ?
         GROUP BY assigned_user_id`,
        companyId,
        from,
        to,
      );
      for (const r of rows) map.set(Number(r.userId), Number(r.n));
    } catch {
      /* column may not exist yet / best-effort */
    }
    return map;
  }

  private computePoints(
    m: AgentMetric,
    conversionRate: number,
    cartsRecovered: number,
    config: GameConfig,
  ): number {
    const p = config.points;
    const s = config.speed;
    let speedFactor = 0;
    if (m.medianRespSec != null) {
      const span = Math.max(1, s.slowSec - s.fastSec);
      speedFactor = clamp01((s.slowSec - m.medianRespSec) / span);
    }
    return (
      p.perOrder * m.orders +
      p.perRevenue1000 * (m.orderValue / 1000) +
      p.perChat * m.conversations +
      p.perCartRecovered * cartsRecovered +
      p.conversionBonusMax * conversionRate +
      p.speedBonusMax * speedFactor
    );
  }

  private metricValue(e: EnrichedAgent, metric: BadgeMetric): number | null {
    switch (metric) {
      case 'orders':
        return e.orders;
      case 'revenue':
        return e.orderValue;
      case 'chats':
        return e.chats;
      case 'conversion':
        return e.conversionRate;
      case 'carts':
        return e.cartsRecovered;
      case 'points':
        return e.points;
      case 'medianRespSec':
        return e.medianRespSec;
      default:
        return null;
    }
  }

  private buildRankMaps(agents: EnrichedAgent[]): Record<BadgeMetric, Map<number, number>> {
    const v = (metric: BadgeMetric, fallback: number) =>
      agents.map((a) => ({
        userId: a.userId,
        value: this.metricValue(a, metric) ?? fallback,
      }));
    return {
      orders: rankOf(v('orders', 0), true),
      revenue: rankOf(v('revenue', 0), true),
      chats: rankOf(v('chats', 0), true),
      conversion: rankOf(v('conversion', 0), true),
      carts: rankOf(v('carts', 0), true),
      points: rankOf(v('points', 0), true),
      // Lower response time is better; agents with no measured reply rank last.
      medianRespSec: rankOf(v('medianRespSec', Number.MAX_SAFE_INTEGER), false),
    };
  }

  private compare(a: number, op: BadgeDef['op'], b: number): boolean {
    switch (op) {
      case '<=':
        return a <= b;
      case '>=':
        return a >= b;
      case '==':
        return a === b;
      case '<':
        return a < b;
      case '>':
        return a > b;
      default:
        return false;
    }
  }

  private badgesFor(
    e: EnrichedAgent,
    rankMaps: Record<BadgeMetric, Map<number, number>>,
    config: GameConfig,
  ): Array<{ id: string; label: string }> {
    const out: Array<{ id: string; label: string }> = [];
    for (const badge of config.badges) {
      let value: number | null | undefined;
      if (badge.type === 'rank') value = rankMaps[badge.metric]?.get(e.userId);
      else value = this.metricValue(e, badge.metric);
      if (value == null) continue;
      if (this.compare(value, badge.op, badge.threshold))
        out.push({ id: badge.id, label: badge.label });
    }
    return out;
  }

  async leaderboard(companyId: number, from: Date, to: Date) {
    const config = await this.getConfig(companyId);
    const enriched = await this.enrich(companyId, from, to, config);
    const rankMaps = this.buildRankMaps(enriched);
    const rows = enriched
      .map((e) => ({
        userId: e.userId,
        name: e.name,
        rank: rankMaps.points.get(e.userId) ?? 0,
        points: Math.round(e.points),
        orders: e.orders,
        orderValue: Math.round(e.orderValue * 100) / 100,
        currency: e.currency,
        chats: e.chats,
        medianRespSec: e.medianRespSec,
        conversionRate: Math.round(e.conversionRate * 1000) / 1000,
        cartsRecovered: e.cartsRecovered,
        badges: this.badgesFor(e, rankMaps, config),
      }))
      .sort((a, b) => a.rank - b.rank || b.points - a.points);
    const currency = rows.find((r) => r.currency)?.currency ?? null;
    return { rows, currency };
  }

  // ---------------------------------------------------------------------------
  // Timezone-aware period windows (server-side; mirrors lib/utils.zonedStartOfDay)
  // ---------------------------------------------------------------------------
  private async companyTimezone(companyId: number): Promise<string | undefined> {
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { timezone: true },
    });
    const tz = c?.timezone ?? undefined;
    if (!tz) return undefined;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
      return tz;
    } catch {
      return undefined;
    }
  }

  /** UTC instant of tenant-timezone midnight for `date`. */
  private zonedStartOfDay(date: Date, tz?: string): Date {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const p = dtf.formatToParts(date).reduce<Record<string, number>>((a, x) => {
      if (x.type !== 'literal') a[x.type] = Number(x.value);
      return a;
    }, {});
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const offsetMs = asUtc - date.getTime();
    const startWallUtc = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
    return new Date(startWallUtc - offsetMs);
  }

  private periodRange(period: TargetPeriod, tz?: string): { from: Date; to: Date } {
    const now = new Date();
    const todayStart = this.zonedStartOfDay(now, tz);
    if (period === 'daily') return { from: todayStart, to: now };
    if (period === 'weekly') {
      // Week starts Monday (tenant tz).
      const wdShort = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'short',
      }).format(now);
      const idx = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wdShort);
      const back = idx < 0 ? 0 : idx;
      const from = this.zonedStartOfDay(
        new Date(todayStart.getTime() - back * 86_400_000),
        tz,
      );
      return { from, to: now };
    }
    // monthly — back to the 1st of the tenant-tz month.
    const dayOfMonth = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, day: 'numeric' }).format(now),
    );
    const from = this.zonedStartOfDay(
      new Date(todayStart.getTime() - (dayOfMonth - 1) * 86_400_000),
      tz,
    );
    return { from, to: now };
  }

  private projectMetric(e: EnrichedAgent, metric: GameMetric): number {
    switch (metric) {
      case 'orders':
        return e.orders;
      case 'revenue':
        return e.orderValue;
      case 'chats':
        return e.chats;
      case 'conversion':
        return e.conversionRate;
      case 'carts':
        return e.cartsRecovered;
      case 'points':
        return e.points;
      default:
        return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Contests
  // ---------------------------------------------------------------------------
  private contestStatus(startsAt: Date, endsAt: Date, now = new Date()): string {
    if (now < startsAt) return 'scheduled';
    if (now > endsAt) return 'ended';
    return 'active';
  }

  async contests(actor: Actor) {
    const companyId = actor.companyId;
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: number;
        name: string;
        description: string | null;
        metric: string;
        target_value: unknown;
        prize: string | null;
        starts_at: Date;
        ends_at: Date;
        created_by_user_id: number | null;
      }>
    >(
      `SELECT id, name, description, metric, target_value, prize,
              starts_at, ends_at, created_by_user_id
       FROM agent_contests
       WHERE company_id = ?
       ORDER BY ends_at DESC, id DESC
       LIMIT 100`,
      companyId,
    );
    if (!rows.length) return [];

    const config = await this.getConfig(companyId);
    // Compute standings per contest window (windows are usually few / shared).
    const out = [];
    for (const r of rows) {
      const startsAt = new Date(r.starts_at);
      const endsAt = new Date(r.ends_at);
      const status = this.contestStatus(startsAt, endsAt);
      const metric = (GAME_METRICS.includes(r.metric as GameMetric)
        ? r.metric
        : 'orders') as GameMetric;
      // Only compute standings for active/ended contests (scheduled = no data yet).
      let standings: Array<{ userId: number; name: string; value: number }> = [];
      if (status !== 'scheduled') {
        const enriched = await this.enrich(companyId, startsAt, endsAt, config);
        standings = enriched
          .map((e) => ({
            userId: e.userId,
            name: e.name,
            value: Math.round(this.projectMetric(e, metric) * 100) / 100,
          }))
          .sort((a, b) => b.value - a.value);
      }
      const mine = standings.find((s) => s.userId === actor.userId) ?? null;
      out.push({
        id: r.id,
        name: r.name,
        description: r.description,
        metric,
        targetValue: r.target_value == null ? null : num(r.target_value),
        prize: r.prize,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        status,
        leader: standings[0] ?? null,
        standings: standings.slice(0, 5),
        myValue: mine?.value ?? 0,
        myRank: mine ? standings.findIndex((s) => s.userId === actor.userId) + 1 : null,
      });
    }
    return out;
  }

  async createContest(actor: Actor, dto: CreateContestDto) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()))
      throw new BadRequestException('Invalid contest dates');
    if (endsAt <= startsAt)
      throw new BadRequestException('Contest end must be after its start');
    const status = this.contestStatus(startsAt, endsAt);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO agent_contests
         (company_id, name, description, metric, target_value, prize,
          starts_at, ends_at, status, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      actor.companyId,
      dto.name.trim(),
      dto.description?.trim() || null,
      dto.metric,
      dto.targetValue ?? null,
      dto.prize?.trim() || null,
      startsAt,
      endsAt,
      status,
      actor.userId,
    );
    return { ok: true };
  }

  async updateContest(actor: Actor, id: number, dto: UpdateContestDto) {
    const existing = await this.prisma.$queryRawUnsafe<
      Array<{ id: number; starts_at: Date; ends_at: Date }>
    >(
      `SELECT id, starts_at, ends_at FROM agent_contests
       WHERE id = ? AND company_id = ? LIMIT 1`,
      id,
      actor.companyId,
    );
    if (!existing.length) throw new NotFoundException('Contest not found');

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => {
      sets.push(`${col} = ?`);
      params.push(val);
    };
    if (dto.name !== undefined) push('name', dto.name.trim());
    if (dto.description !== undefined) push('description', dto.description?.trim() || null);
    if (dto.metric !== undefined) push('metric', dto.metric);
    if (dto.targetValue !== undefined) push('target_value', dto.targetValue ?? null);
    if (dto.prize !== undefined) push('prize', dto.prize?.trim() || null);

    const startsAt = dto.startsAt ? new Date(dto.startsAt) : new Date(existing[0].starts_at);
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : new Date(existing[0].ends_at);
    if (dto.startsAt !== undefined || dto.endsAt !== undefined) {
      if (endsAt <= startsAt)
        throw new BadRequestException('Contest end must be after its start');
      if (dto.startsAt !== undefined) push('starts_at', startsAt);
      if (dto.endsAt !== undefined) push('ends_at', endsAt);
    }
    // Keep the stored status in sync with the (possibly new) window.
    push('status', this.contestStatus(startsAt, endsAt));

    params.push(id, actor.companyId);
    await this.prisma.$executeRawUnsafe(
      `UPDATE agent_contests SET ${sets.join(', ')} WHERE id = ? AND company_id = ?`,
      ...params,
    );
    return { ok: true };
  }

  async deleteContest(actor: Actor, id: number) {
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM agent_contests WHERE id = ? AND company_id = ?`,
      id,
      actor.companyId,
    );
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Targets
  // ---------------------------------------------------------------------------
  async targets(actor: Actor) {
    const isAdmin = actor.role === 'owner' || actor.role === 'admin';
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: number;
        user_id: number;
        user_name: string | null;
        metric: string;
        target_value: unknown;
        period_type: string;
      }>
    >(
      `SELECT t.id, t.user_id, u.name user_name, t.metric, t.target_value, t.period_type
       FROM agent_targets t
       JOIN users u ON u.id = t.user_id
       WHERE t.company_id = ? AND t.active = 1
         ${isAdmin ? '' : 'AND t.user_id = ?'}
       ORDER BY u.name ASC, t.metric ASC`,
      ...(isAdmin ? [actor.companyId] : [actor.companyId, actor.userId]),
    );
    if (!rows.length) return [];

    const tz = await this.companyTimezone(actor.companyId);
    const config = await this.getConfig(actor.companyId);
    // Compute agent metrics once per distinct period window, then reuse.
    const distinctPeriods = Array.from(
      new Set(rows.map((r) => r.period_type)),
    ).filter((p): p is TargetPeriod => (TARGET_PERIODS as string[]).includes(p));
    const byPeriod = new Map<TargetPeriod, Map<number, EnrichedAgent>>();
    for (const period of distinctPeriods) {
      const { from, to } = this.periodRange(period, tz);
      const enriched = await this.enrich(actor.companyId, from, to, config);
      byPeriod.set(period, new Map(enriched.map((e) => [e.userId, e])));
    }

    return rows.map((r) => {
      const metric = (GAME_METRICS.includes(r.metric as GameMetric)
        ? r.metric
        : 'orders') as GameMetric;
      const period = (TARGET_PERIODS as string[]).includes(r.period_type)
        ? (r.period_type as TargetPeriod)
        : 'monthly';
      const agent = byPeriod.get(period)?.get(r.user_id);
      const current = agent
        ? Math.round(this.projectMetric(agent, metric) * 100) / 100
        : 0;
      const target = num(r.target_value);
      return {
        id: r.id,
        userId: r.user_id,
        userName: r.user_name,
        metric,
        periodType: period,
        targetValue: target,
        current,
        pct: target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0,
      };
    });
  }

  async setTarget(actor: Actor, dto: SetTargetDto) {
    // Guard: the target user must belong to this company.
    const user = await this.prisma.user.findFirst({
      where: { id: dto.userId, company_id: actor.companyId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('Agent not found');
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO agent_targets
         (company_id, user_id, metric, target_value, period_type, active,
          created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, NOW())
       ON DUPLICATE KEY UPDATE target_value = VALUES(target_value), active = 1`,
      actor.companyId,
      dto.userId,
      dto.metric,
      dto.targetValue,
      dto.periodType,
      actor.userId,
    );
    return { ok: true };
  }

  async deleteTarget(actor: Actor, id: number) {
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM agent_targets WHERE id = ? AND company_id = ?`,
      id,
      actor.companyId,
    );
    return { ok: true };
  }
}
