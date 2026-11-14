import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CacheService } from '../../../common/services/cache.service';
import { GrowthQueryService } from './growth-query.service';
import { GrowthMirrorService } from '../store/growth-mirror.service';
import { GrowthVersionService } from './growth-version.service';
import { AdAccountsService } from './ad-accounts.service';
import { ymdCell } from '../store/growth-store';
import { addDays, dayList, localYmd, n, offsetMinutes, zoneOffset } from '../growth.util';
import { fitResponse, forecastSeries } from '../attribution/forecast-math';
import { GrowthFactsService, SETTLE_DAYS } from './growth-facts.service';
import { isoWeek } from '../growth.util';

@Injectable()
export class GrowthForecastService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly query: GrowthQueryService,
    private readonly mirror: GrowthMirrorService,
    private readonly version: GrowthVersionService,
    private readonly accounts: AdAccountsService,
    private readonly facts: GrowthFactsService,
  ) {}

  async forecast(companyId: number, storeId?: number) {
    const key = `growth:${companyId}:${this.version.get(companyId)}:forecast:${storeId ?? 'all'}`;
    const hit = this.cache.get<unknown>(key);
    if (hit) return hit;

    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } });
    const offMin = offsetMinutes(zoneOffset(company?.timezone ?? null));
    const today = localYmd(new Date(), offMin);
    const monthStart = `${today.slice(0, 7)}-01`;
    const nextMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 1));
    const monthEnd = addDays(nextMonth.toISOString().slice(0, 10), -1);
    const lastMonthStart = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 10);
    const histFrom = addDays(monthStart, -84);
    const days = await this.query.daily(companyId, histFrom < lastMonthStart ? histFrom : lastMonthStart, today, storeId);
    const complete = days.filter((d) => d.date < today);
    const horizon = dayList(today, monthEnd);

    const metric = (k: 'net' | 'expected' | 'spend' | 'gross') => {
      const fc = forecastSeries(complete.map((d) => ({ date: d.date, value: d[k] })), horizon);
      const todayActual = days.find((d) => d.date === today)?.[k] ?? 0;
      if (fc.length && fc[0].date === today) {
        // Today is partial: never project below what already happened.
        fc[0] = { ...fc[0], mid: Math.max(fc[0].mid, todayActual), lo: Math.max(fc[0].lo, todayActual), hi: Math.max(fc[0].hi, todayActual) };
      }
      const mtd = days.filter((d) => d.date >= monthStart && d.date < today).reduce((a, d) => a + d[k], 0);
      const sum = (f: 'mid' | 'lo' | 'hi') => mtd + fc.reduce((a, p) => a + p[f], 0);
      const dom = Number(today.slice(8, 10));
      const lastMonthDays = days.filter((d) => d.date >= lastMonthStart && d.date < monthStart);
      const lastSameDay = lastMonthDays.filter((d) => Number(d.date.slice(8, 10)) < dom).reduce((a, d) => a + d[k], 0);
      return {
        mtd: mtd + todayActual,
        projected: { p10: sum('lo'), p50: sum('mid'), p90: sum('hi') },
        lastMonthTotal: lastMonthDays.reduce((a, d) => a + d[k], 0),
        lastMonthToDate: lastSameDay + (lastMonthDays.find((d) => Number(d.date.slice(8, 10)) === dom)?.[k] ?? 0),
        daily: fc,
      };
    };

    const out = {
      today,
      month: today.slice(0, 7),
      monthStart,
      monthEnd,
      currency: await this.accounts.baseCurrency(companyId),
      actual: days
        .filter((d) => d.date >= monthStart && d.date <= today)
        .map((d) => ({ date: d.date, net: d.net, expected: d.expected, spend: d.spend, gross: d.gross })),
      net: metric('net'),
      expected: metric('expected'),
      spend: metric('spend'),
      gross: metric('gross'),
      simulator: await this.responseCurves(companyId, today),
      // Model check: what the delivery model would have predicted on the day
      // each settled order was placed vs what actually stayed (net).
      calibration: await this.calibration(companyId, today, storeId).catch(() => null),
    };
    this.cache.set(key, out, 600);
    return out;
  }

  /** Last 8 settled weeks: day-0 prediction (after-discount × keep × city delivery rate) vs actual net. */
  private async calibration(companyId: number, today: string, storeId?: number) {
    const model = await this.facts.deliveryModel(companyId);
    const to = addDays(today, -(SETTLE_DAYS + 3));
    const from = addDays(to, -55);
    const rows = await this.mirror.query(companyId,
      `SELECT order_date d, city, SUM(net) placed,
              SUM(CASE WHEN lifecycle NOT IN ('cancelled','rto') THEN net ELSE 0 END) kept
         FROM {facts}
        WHERE company_id = :co AND order_date >= :from AND order_date <= :to${storeId ? ' AND store_id = :store' : ''}
        GROUP BY order_date, city`,
      { co: ['Int32', companyId], from: ['Date', from], to: ['Date', to], ...(storeId ? { store: ['Int32', storeId] as ['Int32', number] } : {}) });
    const weeks = new Map<string, { predicted: number; actual: number }>();
    for (const r of rows) {
      const w = isoWeek(ymdCell(r.d));
      const city = r.city ? String(r.city) : null;
      const p = (city && model.cityRate.get(city)) || model.globalRate;
      const e = weeks.get(w) ?? { predicted: 0, actual: 0 };
      e.predicted += n(r.placed) * model.confirmRate * p;
      e.actual += n(r.kept);
      weeks.set(w, e);
    }
    const list = [...weeks.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([week, v]) => ({ week, predicted: Math.round(v.predicted), actual: Math.round(v.actual), errorPct: v.actual > 0 ? Math.round(((v.predicted - v.actual) / v.actual) * 1000) / 10 : null }));
    const P = list.reduce((a, w) => a + w.predicted, 0);
    const A = list.reduce((a, w) => a + w.actual, 0);
    return { weeks: list, errorPct: A > 0 ? Math.round(((P - A) / A) * 1000) / 10 : null, settleDays: SETTLE_DAYS };
  }

  /** Per-campaign spend → expected-revenue curves for the budget simulator. */
  private async responseCurves(companyId: number, today: string) {
    const from = addDays(today, -60);
    const base = { co: ['Int32', companyId] as ['Int32', number], from: ['Date', from] as ['Date', string], to: ['Date', addDays(today, -1)] as ['Date', string] };
    const [spend, rev] = await Promise.all([
      this.mirror.query(companyId,
        `SELECT campaign_id c, date d, SUM(spend_base) s FROM {ins}
          WHERE company_id = :co AND date >= :from AND date <= :to GROUP BY campaign_id, date`, base),
      this.mirror.query(companyId,
        `SELECT campaign_id c, order_date d, SUM(expected_net) v FROM {attr}
          WHERE company_id = :co AND model = 'last' AND win = 7 AND order_date >= :from AND order_date <= :to
            AND campaign_id IS NOT NULL GROUP BY campaign_id, order_date`, base),
    ]);
    const by = new Map<string, Map<string, [number, number]>>();
    const cell = (c: string, d: string) => {
      if (!by.has(c)) by.set(c, new Map());
      const m = by.get(c)!;
      if (!m.has(d)) m.set(d, [0, 0]);
      return m.get(d)!;
    };
    for (const r of spend) cell(String(r.c), ymdCell(r.d))[0] += n(r.s);
    for (const r of rev) cell(String(r.c), ymdCell(r.d))[1] += n(r.v);
    const names = new Map(
      (await this.prisma.adEntity.findMany({ where: { company_id: companyId, level: 'campaign' }, select: { external_id: true, name: true, status: true } }))
        .map((e) => [e.external_id, e]),
    );
    const out = [];
    for (const [c, m] of by) {
      const pts = [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
      const last14 = pts.slice(-14);
      const dailySpend = last14.reduce((a, p) => a + p[0], 0) / Math.max(1, last14.length);
      if (dailySpend <= 0) continue;
      const fit = fitResponse(pts);
      const e = names.get(c);
      out.push({
        campaignId: c,
        name: e?.name ?? c,
        status: e?.status ?? null,
        a: fit.a,
        b: fit.b,
        dailySpend,
        dailyExpected: fit.a * Math.pow(dailySpend, fit.b),
      });
    }
    return out.sort((x, y) => y.dailySpend - x.dailySpend).slice(0, 10);
  }
}
