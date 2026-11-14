import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CacheService } from '../../../common/services/cache.service';
import { LlmService } from '../../ai/llm.service';
import { AiMeteringService } from '../../ai/ai-metering.service';
import { GrowthForecastService } from './growth-forecast.service';
import { GrowthQueryService } from './growth-query.service';
import { GrowthVersionService } from './growth-version.service';
import { GrowthMirrorService } from '../store/growth-mirror.service';
import { AdAccountsService } from './ad-accounts.service';
import { addDays, localYmd, n, offsetMinutes, zoneOffset } from '../growth.util';
import { pace } from '../attribution/target-math';

export interface TargetInput {
  month: string;
  storeId?: number | null;
  netSalesTarget: number | null;
  ordersTarget?: number | null;
  adBudget?: number | null;
}

export interface Lever {
  id: string;
  title: string;
  detail: string;
  /** Extra expected net sales by month end (base currency). */
  impact: number | null;
  link?: string;
}

const COACH_SYSTEM = `You are CodesApp Growth coach for a cash-on-delivery e-commerce store.
Use ONLY the numbers given. Never invent campaigns, figures or causes. Net sales = gross − discounts − cancelled − returned.
Write a short plan to reach the monthly net sales target, in plain words a store owner understands.`;

/**
 * Monthly NET sales target: storage, pacing (on expected net, so in-flight
 * orders are priced for cancellations/returns), and a coach — deterministic
 * levers computed from the tenant's own data, explained by the AI (or rules).
 */
@Injectable()
export class GrowthTargetService {
  private readonly logger = new Logger(GrowthTargetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly llm: LlmService,
    private readonly metering: AiMeteringService,
    private readonly forecast: GrowthForecastService,
    private readonly query: GrowthQueryService,
    private readonly version: GrowthVersionService,
    private readonly mirror: GrowthMirrorService,
    private readonly accounts: AdAccountsService,
  ) {}

  private async today(companyId: number) {
    const c = await this.prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } });
    return localYmd(new Date(), offsetMinutes(zoneOffset(c?.timezone ?? null)));
  }

  async get(companyId: number, month: string, storeId?: number | null) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new BadRequestException('month must be YYYY-MM');
    const t = await this.prisma.salesTarget.findUnique({
      where: { company_id_month_store_id: { company_id: companyId, month, store_id: storeId ?? 0 } },
    });
    return t
      ? { month, storeId: t.store_id || null, netSalesTarget: Number(t.net_sales_target), ordersTarget: t.orders_target, adBudget: t.ad_budget == null ? null : Number(t.ad_budget), updatedAt: t.updated_at }
      : { month, storeId: storeId ?? null, netSalesTarget: null, ordersTarget: null, adBudget: null, updatedAt: null };
  }

  async set(companyId: number, userId: number, dto: TargetInput) {
    if (!/^\d{4}-\d{2}$/.test(dto.month)) throw new BadRequestException('month must be YYYY-MM');
    const key = { company_id: companyId, month: dto.month, store_id: dto.storeId ?? 0 };
    if (dto.netSalesTarget == null || dto.netSalesTarget <= 0) {
      await this.prisma.salesTarget.deleteMany({ where: key });
    } else {
      if (dto.netSalesTarget > 1e12) throw new BadRequestException('Target too large');
      const data = {
        net_sales_target: dto.netSalesTarget,
        orders_target: dto.ordersTarget ?? null,
        ad_budget: dto.adBudget ?? null,
        updated_by: userId,
      };
      await this.prisma.salesTarget.upsert({
        where: { company_id_month_store_id: key },
        create: { ...key, ...data },
        update: data,
      });
    }
    this.version.bump(companyId, 'target');
    return this.status(companyId, dto.month, dto.storeId ?? undefined);
  }

  /** Target + pacing for a month (current month = projected, past month = final). */
  async status(companyId: number, month: string, storeId?: number) {
    const target = await this.get(companyId, month, storeId);
    const today = await this.today(companyId);
    const cur = today.slice(0, 7);
    if (month !== cur) {
      // Past / future month: actuals only.
      const from = `${month}-01`;
      const to = addDays(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10), -1);
      const t = month < cur ? this.query.totals(await this.query.daily(companyId, from, to < today ? to : today, storeId)) : null;
      return {
        target,
        current: false,
        actual: t ? { net: t.net, expected: t.expected, gross: t.gross } : null,
        pacing: target.netSalesTarget && t
          ? pace({ target: target.netSalesTarget, soFar: t.expected, daysLeft: 0, p10: t.expected, p50: t.expected, p90: t.expected, recentPerDay: 0 })
          : null,
      };
    }
    const fc = (await this.forecast.forecast(companyId, storeId)) as {
      monthEnd: string;
      actual: Array<{ date: string; net: number; expected: number }>;
      expected: { mtd: number; projected: { p10: number; p50: number; p90: number } };
      net: { mtd: number };
      gross: { mtd: number };
    };
    const daysLeft = Math.max(0, Math.round((Date.parse(`${fc.monthEnd}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) + 1);
    const done = fc.actual.filter((d) => d.date < today).slice(-7);
    const recentPerDay = done.length ? done.reduce((a, d) => a + d.expected, 0) / done.length : 0;
    // Pace on EXPECTED net (in-flight orders priced for cancels + returns): the
    // number that will actually stand once everything settles.
    const soFar = fc.expected.mtd;
    return {
      target,
      current: true,
      actual: { net: fc.net.mtd, expected: fc.expected.mtd, gross: fc.gross.mtd },
      pacing: target.netSalesTarget
        ? pace({ target: target.netSalesTarget, soFar, daysLeft: Math.max(0, daysLeft - 1), ...fc.expected.projected, recentPerDay })
        : null,
    };
  }

  /** Deterministic levers from the tenant's own data (+ AI plan when allowed). */
  async coach(companyId: number, month: string, storeId?: number) {
    const st = await this.status(companyId, month, storeId);
    if (!st.current || !st.pacing) return { ...st, levers: [], plan: null };
    const key = `growth:${companyId}:${this.version.get(companyId)}:coach:${month}:${storeId ?? 0}:${st.target.netSalesTarget}`;
    const hit = this.cache.get<unknown>(key);
    if (hit) return hit;

    const p = st.pacing;
    const daysLeft = p.daysLeft;
    const cur = await this.accounts.baseCurrency(companyId);
    const fc = (await this.forecast.forecast(companyId, storeId)) as {
      simulator: Array<{ campaignId: string; name: string; status: string | null; a: number; b: number; dailySpend: number; dailyExpected: number }>;
    };
    const today = await this.today(companyId);
    const ov = await this.query.overview(companyId, { from: addDays(today, -30), to: addDays(today, -1), compare: 'none', storeId });
    const be = (ov.kpis.breakEvenRoas?.value as number | null) ?? null;
    const levers: Lever[] = [];

    // 1) Scale campaigns whose MARGINAL expected return still beats break-even.
    const scale = fc.simulator
      .filter((c) => /ACTIVE|ENABLE/i.test(c.status ?? 'ACTIVE') && c.dailySpend > 0)
      .map((c) => {
        const s = c.dailySpend;
        const add = s * 0.2;
        const gain = (c.a * Math.pow(s + add, c.b) - c.a * Math.pow(s, c.b)) * daysLeft;
        const marginal = c.b * c.a * Math.pow(s, c.b - 1);
        return { c, add, gain, marginal };
      })
      .filter((x) => x.gain > 0 && (be == null || x.marginal >= be))
      .sort((a, b) => b.gain - a.gain)
      .slice(0, 2);
    if (scale.length) {
      const gain = scale.reduce((a, x) => a + x.gain, 0);
      const cost = scale.reduce((a, x) => a + x.add * daysLeft, 0);
      levers.push({
        id: 'scale',
        title: `Scale ${scale.map((x) => x.c.name).join(' and ')} by 20%`,
        detail: `Their next rupee still returns above break-even${be ? ` (${be.toFixed(2)}×)` : ''}. About ${Math.round(cost).toLocaleString()} more spend over ${daysLeft} days.`,
        impact: gain,
        link: '/growth/campaigns',
      });
    }

    // 2) High-RTO cities (returns cost the whole order value).
    const rows = await this.mirror.query(companyId,
      `SELECT city, COUNT(*) o, SUM(lifecycle = 'rto') r, SUM(lifecycle = 'delivered') d, SUM(net) v
         FROM {facts} WHERE company_id = :co AND order_date >= :from AND order_date <= :to AND city IS NOT NULL
        GROUP BY city`,
      { co: ['Int32', companyId], from: ['Date', addDays(today, -90)], to: ['Date', addDays(today, -21)] });
    let D = 0;
    let R = 0;
    for (const r of rows) {
      D += n(r.d);
      R += n(r.r);
    }
    const base = D + R ? R / (D + R) : 0;
    const bad = rows
      .filter((r) => n(r.d) + n(r.r) >= 15 && n(r.r) / (n(r.d) + n(r.r)) >= base + 0.15)
      .map((r) => ({ city: String(r.city), rate: n(r.r) / (n(r.d) + n(r.r)), lostPerDay: (n(r.v) * (n(r.r) / Math.max(1, n(r.o)))) / 69 }))
      .sort((a, b) => b.lostPerDay - a.lostPerDay)
      .slice(0, 3);
    if (bad.length) {
      levers.push({
        id: 'rto',
        title: `Cut returns from ${bad.map((b) => b.city.replace(/\b\w/g, (c) => c.toUpperCase())).join(', ')}`,
        detail: `${bad.map((b) => `${(b.rate * 100).toFixed(0)}%`).join(' / ')} of parcels come back vs ${(base * 100).toFixed(0)}% overall. Ask for an advance there, or exclude them from prospecting ads.`,
        impact: bad.reduce((a, b) => a + b.lostPerDay, 0) * daysLeft * 0.5,
        link: '/growth/campaigns/new',
      });
    }

    // 3) Unconfirmed orders waiting for a call.
    const [unc, conf] = await Promise.all([
      this.mirror.query(companyId,
        `SELECT COUNT(*) c, SUM(net) v, AVG(p_deliver) p FROM {facts}
          WHERE company_id = :co AND lifecycle = 'unconfirmed' AND order_date >= :from`,
        { co: ['Int32', companyId], from: ['Date', addDays(today, -7)] }).then((r) => r[0]),
      this.mirror.query(companyId,
        `SELECT AVG(p_deliver) p FROM {facts}
          WHERE company_id = :co AND lifecycle = 'confirmed' AND order_date >= :from`,
        { co: ['Int32', companyId], from: ['Date', addDays(today, -14)] }).then((r) => r[0]),
    ]);
    if (unc && n(unc.c) > 0 && conf && n(conf.p) > 0) {
      // Value of moving them from "unconfirmed" to "confirmed" delivery odds.
      const lift = n(unc.v) * Math.max(0, n(conf.p) - n(unc.p));
      levers.push({
        id: 'confirm',
        title: `Confirm ${n(unc.c)} waiting order${n(unc.c) === 1 ? '' : 's'}`,
        detail: `Confirmed orders are delivered far more often. Calling them lifts expected net on ${Math.round(n(unc.v)).toLocaleString()} of open orders.`,
        impact: lift,
        link: '/orders/fulfillment',
      });
    }

    // 4) Order value.
    const aov = (ov.kpis.aov?.value as number | null) ?? null;
    if (aov) {
      const orders30 = (ov.kpis.orders?.value as number | null) ?? 0;
      const perDay = orders30 / 30;
      levers.push({
        id: 'aov',
        title: 'Lift order value with bundles',
        detail: `Average order is ${Math.round(aov).toLocaleString()}. Offering a 2-pack in replies and ads on just 10% of orders adds roughly this much.`,
        impact: perDay * daysLeft * 0.1 * aov * 0.6,
      });
    }

    levers.sort((a, b) => (b.impact ?? 0) - (a.impact ?? 0));
    const closes = levers.reduce((a, l) => a + (l.impact ?? 0), 0);

    let plan: { source: 'ai' | 'rules'; text: string } = {
      source: 'rules',
      text: p.gap <= 0
        ? `On track: projected ${Math.round(p.projected.p50).toLocaleString()} vs target ${Math.round(p.target).toLocaleString()}. Keep spend steady and protect delivery rate.`
        : `You need about ${Math.round(p.needPerDay).toLocaleString()} expected net a day for ${p.daysLeft} days (recent pace ${Math.round(p.recentPerDay).toLocaleString()}). The moves below are worth about ${Math.round(closes).toLocaleString()} of the ${Math.round(p.gap).toLocaleString()} gap.`,
    };
    try {
      await this.metering.assertAllowed(companyId);
      const res = await this.llm.complete({
        tier: 'fast',
        system: [{ text: COACH_SYSTEM }],
        userText:
          `Currency: ${cur ?? ''}. Month ${month}. Pacing (expected net, after predicted cancels/returns): ${JSON.stringify(p)}.\n` +
          `Levers (impact = extra expected net by month end): ${JSON.stringify(levers.map(({ title, detail, impact }) => ({ title, detail, impact: impact == null ? null : Math.round(impact) })))}\n\n` +
          'Write 2-3 sentences, max 70 words: where they will land, what the gap is, and the order to pull the levers in. No bullet points, no markdown.',
        maxTokens: 220,
        temperature: 0.2,
      });
      await this.metering.recordUsage(companyId, null, 'growth', res.provider, 'fast', res.usage);
      const text = res.text.trim();
      if (text) plan = { source: 'ai', text: text.slice(0, 700) };
    } catch (e) {
      if (!(e instanceof ForbiddenException)) this.logger.debug(`coach AI fallback: ${(e as Error).message}`);
    }
    const out = { ...st, currency: cur, levers, closes, plan, generatedAt: new Date().toISOString() };
    this.cache.set(key, out, 6 * 3600);
    return out;
  }
}
