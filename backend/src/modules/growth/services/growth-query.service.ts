import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CacheService } from '../../../common/services/cache.service';
import { GrowthMirrorService } from '../store/growth-mirror.service';
import { Params, Row, ymdCell } from '../store/growth-store';
import { GrowthVersionService } from './growth-version.service';
import { AdAccountsService } from './ad-accounts.service';
import { CHANNEL_LABEL, Channel, MODELS, Model, PAID_CHANNELS, WINDOWS } from '../attribution/attribution';
import { addDays, dayList, div, isoWeek, n } from '../growth.util';

interface Node {
  level: 'campaign' | 'adset' | 'ad';
  id: string;
  platform: string;
  name: string;
  status: string | null;
  objective: string | null;
  dailyBudget: number | null;
  configuredStatus: string | null;
  budgetOwner: string | null;
  budgetType: string | null;
  lifetimeBudget: number | null;
  bidStrategy: string | null;
  bidAmount: number | null;
  roasFloor: number | null;
  optimizationGoal: string | null;
  thumb: string | null;
  matched: boolean;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  linkClicks: number;
  video3s: number;
  thruplay: number;
  platformPurchases: number;
  platformValue: number;
  messages: number;
  orders: number;
  net: number;
  expected: number;
  delivered: number;
  newCustomers: number;
  firstNet: number;
  lastNet: number;
  spark: number[];
  children: Node[];
}

export interface RangeQuery {
  from: string;
  to: string;
  compare?: 'prev' | 'yoy' | 'none';
  storeId?: number;
  model?: Model;
  win?: number;
}

const CACHE_TTL = 300;
const KEPT = "lifecycle NOT IN ('cancelled','rto')";
const LIFECYCLES = ['cancelled', 'unconfirmed', 'confirmed', 'in_transit', 'delivered', 'rto'] as const;
const CTWA_OBJECTIVES = /MESSAGES|ENGAGEMENT/i;

interface DayAgg {
  date: string;
  placed: number;
  orders: number;
  gross: number;
  grossNC: number;
  rtoGross: number;
  keptGross: number;
  net: number;
  realized: number;
  pending: number;
  expected: number;
  cogs: number;
  cogsExp: number;
  ship: number;
  shipEst: number;
  fees: number;
  newc: number;
  discounts: number;
  units: number;
  unitsNoCost: number;
  breakdown: number;
  delivered: number;
  rto: number;
  cancelled: number;
  /** After-discount value of cancelled / returned orders (the Gross → Net breakdown). */
  cancelledNet: number;
  rtoNet: number;
  spend: number;
  platformValue: number;
}

function emptyDay(date: string): DayAgg {
  return { date, placed: 0, orders: 0, gross: 0, grossNC: 0, rtoGross: 0, keptGross: 0, net: 0, realized: 0, pending: 0, expected: 0, cogs: 0, cogsExp: 0,
    ship: 0, shipEst: 0, fees: 0, newc: 0, discounts: 0, units: 0, unitsNoCost: 0, breakdown: 0, delivered: 0, rto: 0, cancelled: 0,
    cancelledNet: 0, rtoNet: 0, spend: 0, platformValue: 0 };
}

function sumDays(days: DayAgg[]): DayAgg {
  const t = emptyDay('total');
  for (const d of days) for (const k of Object.keys(t) as (keyof DayAgg)[]) if (k !== 'date') (t[k] as number) += d[k] as number;
  return t;
}

/** Headline KPIs from an aggregate — the ONE place these formulas live (mirrors metrics/catalog.ts). */
export function kpisOf(t: DayAgg) {
  const grossProfit = t.net - t.cogs;
  const netProfit = grossProfit - t.spend - t.ship - t.fees;
  const expectedProfit = t.expected - t.cogsExp - t.spend - t.ship - t.fees;
  const contribution = t.net - t.cogs - t.ship - t.fees;
  return {
    // Two headline numbers (common/utils/sales.ts): Gross = before discounts,
    // Net = Gross − discounts − cancelled − returned. The rest is breakdown.
    gross: t.gross,
    net: t.net,
    discounts: t.discounts,
    cancelledValue: t.cancelledNet,
    returnedValue: t.rtoNet,
    realized: t.realized,
    pending: t.pending,
    expected: t.expected,
    spend: t.spend,
    mer: t.gross > 0 ? (t.spend / t.gross) * 100 : null,
    roas: div(t.net, t.spend),
    expRoas: div(t.expected, t.spend),
    platformRoas: div(t.platformValue, t.spend),
    breakEvenRoas: contribution > 0 ? t.net / contribution : null,
    orders: t.orders,
    aov: div(t.grossNC, t.orders),
    newCustomers: t.newc,
    ncac: div(t.spend, t.newc),
    rtoRate: t.delivered + t.rto > 0 ? (t.rto / (t.delivered + t.rto)) * 100 : null,
    cancelRate: t.placed > 0 ? (t.cancelled / t.placed) * 100 : null,
    cogs: t.cogs,
    shipping: t.ship,
    fees: t.fees,
    grossProfit,
    netProfit,
    expectedProfit,
    netMargin: t.net > 0 ? (netProfit / t.net) * 100 : null,
  };
}

@Injectable()
export class GrowthQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly mirror: GrowthMirrorService,
    private readonly version: GrowthVersionService,
    private readonly accounts: AdAccountsService,
  ) {}

  // ── helpers ────────────────────────────────────────────────────────────────
  private validate(q: RangeQuery) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.from) || !/^\d{4}-\d{2}-\d{2}$/.test(q.to)) {
      throw new BadRequestException('from/to must be YYYY-MM-DD');
    }
    if (q.from > q.to) throw new BadRequestException('`from` must be on or before `to`');
    if (dayList(q.from, q.to).length > 731) throw new BadRequestException('Range cannot exceed 2 years');
  }

  private compareRange(q: RangeQuery): { from: string; to: string } | null {
    const mode = q.compare ?? 'prev';
    if (mode === 'none') return null;
    const len = dayList(q.from, q.to).length;
    if (mode === 'yoy') {
      const shift = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`.replace('-02-29', '-02-28');
      return { from: shift(q.from), to: shift(q.to) };
    }
    return { from: addDays(q.from, -len), to: addDays(q.from, -1) };
  }

  private async cached<T>(companyId: number, route: string, q: object, fn: () => Promise<T>): Promise<T> {
    const key = `growth:${companyId}:${this.version.get(companyId)}:${route}:${JSON.stringify(q)}`;
    const hit = this.cache.get<T>(key);
    if (hit !== undefined) return hit;
    const v = await fn();
    this.cache.set(key, v, CACHE_TTL);
    return v;
  }

  private q<T extends Row = Row>(companyId: number, sql: string, params: Params) {
    return this.mirror.query<T>(companyId, sql, params);
  }

  /** Ad accounts whose spend counts for this store filter (unmapped accounts count for every store). */
  private async accountScope(companyId: number, storeId?: number): Promise<string> {
    if (!storeId) return '';
    const accs = await this.prisma.adAccount.findMany({
      where: { company_id: companyId, status: 'active' },
      select: { id: true, store_id: true },
    });
    const mapped = accs.filter((a) => a.store_id != null);
    if (!mapped.length) return '';
    const ids = accs.filter((a) => a.store_id === storeId || a.store_id == null).map((a) => Number(a.id)).filter(Number.isInteger);
    return ids.length ? ` AND account_id IN (${ids.join(',')})` : ' AND 1 = 0';
  }

  /** Daily aggregates (zero-filled) for a tenant-local day range. */
  private async days(companyId: number, from: string, to: string, storeId?: number): Promise<DayAgg[]> {
    const p: Params = { co: ['Int32', companyId], from: ['Date', from], to: ['Date', to] };
    if (storeId) p.store = ['Int32', storeId];
    const storeSql = storeId ? ' AND store_id = :store' : '';
    const [facts, spend] = await Promise.all([
      this.q(companyId,
        `SELECT order_date d, lifecycle, COUNT(*) c, SUM(gross) gross, SUM(net) net, SUM(discounts) disc, SUM(cogs) cogs,
                SUM(cogs * p_deliver) cogs_exp, SUM(ship_cost) ship, SUM(ship_cost * ship_estimated) ship_est, SUM(fees) fees,
                SUM(is_new) newc, SUM(net * p_deliver) expected, SUM(units) units, SUM(units_no_cost) unc, SUM(has_breakdown) bd
           FROM {facts}
          WHERE company_id = :co AND order_date >= :from AND order_date <= :to${storeSql}
          GROUP BY order_date, lifecycle`, p),
      this.q(companyId,
        `SELECT date d, SUM(spend_base) s, SUM(purchase_value_base) v
           FROM {ins}
          WHERE company_id = :co AND date >= :from AND date <= :to${await this.accountScope(companyId, storeId)}
          GROUP BY date`, { co: p.co, from: p.from, to: p.to }),
    ]);
    const map = new Map(dayList(from, to).map((d) => [d, emptyDay(d)]));
    for (const r of facts) {
      const e = map.get(ymdCell(r.d));
      if (!e) continue;
      const life = String(r.lifecycle);
      const c = n(r.c);
      e.placed += c;
      e.gross += n(r.gross);
      e.discounts += n(r.disc);
      e.expected += n(r.expected);
      e.cogsExp += n(r.cogs_exp);
      e.ship += n(r.ship);
      e.shipEst += n(r.ship_est);
      e.fees += n(r.fees);
      e.units += n(r.units);
      e.unitsNoCost += n(r.unc);
      e.breakdown += n(r.bd);
      if (life === 'cancelled') {
        e.cancelled += c;
        e.cancelledNet += n(r.net);
        continue;
      }
      e.orders += c;
      e.grossNC += n(r.gross);
      e.newc += n(r.newc);
      if (life === 'rto') {
        e.rto += c;
        e.rtoGross += n(r.gross);
        e.rtoNet += n(r.net);
        continue;
      }
      e.keptGross += n(r.gross);
      e.net += n(r.net);
      e.cogs += n(r.cogs);
      if (life === 'delivered') {
        e.realized += n(r.net);
        e.delivered += c;
      } else e.pending += n(r.net);
    }
    for (const r of spend) {
      const e = map.get(ymdCell(r.d));
      if (!e) continue;
      e.spend += n(r.s);
      e.platformValue += n(r.v);
    }
    return [...map.values()];
  }

  // ── Overview ───────────────────────────────────────────────────────────────
  async overview(companyId: number, q: RangeQuery) {
    this.validate(q);
    return this.cached(companyId, 'overview', q, async () => {
      const cmp = this.compareRange(q);
      const model = q.model ?? 'last';
      const win = q.win ?? 28;
      const [cur, prev, lifecycle, channels, currency] = await Promise.all([
        this.days(companyId, q.from, q.to, q.storeId),
        cmp ? this.days(companyId, cmp.from, cmp.to, q.storeId) : Promise.resolve(null),
        this.lifecycleTotals(companyId, q),
        this.channelTotals(companyId, q, model, win),
        this.accounts.baseCurrency(companyId),
      ]);
      const t = sumDays(cur);
      const pt = prev ? sumDays(prev) : null;
      const kpis = this.kpiPair(t, pt);
      const bucketWeekly = cur.length > 92;
      const series = (bucketWeekly ? this.weekly(cur) : cur).map((d, i) => ({
        date: d.date,
        gross: d.gross,
        net: d.net,
        realized: d.realized,
        expected: d.expected,
        spend: d.spend,
        platformValue: d.platformValue,
        orders: d.orders,
        newCustomers: d.newc,
        roas: div(d.net, d.spend),
        prevNet: prev && !bucketWeekly ? prev[i]?.net ?? null : null,
        prevSpend: prev && !bucketWeekly ? prev[i]?.spend ?? null : null,
      }));
      return {
        range: { from: q.from, to: q.to, days: cur.length, granularity: bucketWeekly ? 'week' : 'day' },
        compare: cmp,
        currency,
        store: this.mirror.storeFor(companyId),
        generatedAt: new Date().toISOString(),
        coverage: {
          breakdownPct: t.placed ? (t.breakdown / t.placed) * 100 : null,
          unitsWithCostPct: t.units ? ((t.units - t.unitsNoCost) / t.units) * 100 : null,
          shippingEstimatedPct: t.ship ? (t.shipEst / t.ship) * 100 : null,
        },
        kpis,
        series,
        lifecycle,
        waterfall: this.waterfall(t),
        channels,
        anomalies: this.anomalies(cur),
      };
    });
  }

  private kpiPair(t: DayAgg, pt: DayAgg | null) {
    const a = kpisOf(t);
    const b = pt ? kpisOf(pt) : null;
    const out: Record<string, { value: number | null; prev: number | null }> = {};
    for (const k of Object.keys(a) as (keyof typeof a)[]) out[k] = { value: a[k], prev: b ? b[k] : null };
    return out;
  }

  private weekly(days: DayAgg[]): DayAgg[] {
    const m = new Map<string, DayAgg[]>();
    for (const d of days) {
      const w = isoWeek(d.date);
      m.set(w, [...(m.get(w) ?? []), d]);
    }
    return [...m.entries()].map(([w, list]) => ({ ...sumDays(list), date: w }));
  }

  private waterfall(t: DayAgg) {
    const k = kpisOf(t);
    return [
      { label: 'Gross sales', value: t.gross, kind: 'total' },
      { label: 'Discounts', value: -t.discounts, kind: 'delta' },
      { label: 'Cancelled', value: -t.cancelledNet, kind: 'delta' },
      { label: 'Returned (RTO)', value: -t.rtoNet, kind: 'delta' },
      { label: 'Net sales', value: t.net, kind: 'total' },
      { label: 'COGS', value: -t.cogs, kind: 'delta' },
      { label: 'Gross profit', value: k.grossProfit, kind: 'total' },
      { label: 'Ad spend', value: -t.spend, kind: 'delta' },
      { label: 'Shipping', value: -t.ship, kind: 'delta' },
      { label: 'Payment fees', value: -t.fees, kind: 'delta' },
      { label: 'Net profit', value: k.netProfit, kind: 'total' },
    ];
  }

  private async lifecycleTotals(companyId: number, q: RangeQuery) {
    const p: Params = { co: ['Int32', companyId], from: ['Date', q.from], to: ['Date', q.to] };
    if (q.storeId) p.store = ['Int32', q.storeId];
    const rows = await this.q(companyId,
      `SELECT lifecycle, COUNT(*) c, SUM(net) v, SUM(gross) g
         FROM {facts} WHERE company_id = :co AND order_date >= :from AND order_date <= :to${q.storeId ? ' AND store_id = :store' : ''}
        GROUP BY lifecycle`, p);
    const out: Record<string, { orders: number; value: number; gross: number }> = {};
    for (const l of LIFECYCLES) out[l] = { orders: 0, value: 0, gross: 0 };
    let po = 0;
    let pv = 0;
    let pg = 0;
    for (const r of rows) {
      const l = String(r.lifecycle);
      out[l] = { orders: n(r.c), value: n(r.v), gross: n(r.g) };
      po += n(r.c);
      pv += n(r.v);
      pg += n(r.g);
    }
    return { placed: { orders: po, value: pv, gross: pg }, ...out };
  }

  /** Net / expected / orders per channel under a model + window, plus channel spend. */
  async channelTotals(companyId: number, q: RangeQuery, model: Model, win: number) {
    const p: Params = {
      co: ['Int32', companyId], from: ['Date', q.from], to: ['Date', q.to],
      model: ['String', model], win: ['Int32', win],
    };
    const [rows, spend] = await Promise.all([
      this.q(companyId,
        `SELECT channel, SUM(credit) orders, SUM(net) net, SUM(expected_net) expected, SUM(delivered) delivered,
                SUM(credit * is_new) newc
           FROM {attr} WHERE company_id = :co AND model = :model AND win = :win AND order_date >= :from AND order_date <= :to
          GROUP BY channel`, p),
      this.spendByChannel(companyId, q),
    ]);
    const map = new Map<string, { channel: string; label: string; orders: number; net: number; expected: number; delivered: number; newCustomers: number; spend: number }>();
    const get = (c: string) => {
      if (!map.has(c)) map.set(c, { channel: c, label: CHANNEL_LABEL[c as Channel] ?? c, orders: 0, net: 0, expected: 0, delivered: 0, newCustomers: 0, spend: 0 });
      return map.get(c)!;
    };
    for (const r of rows) {
      const e = get(String(r.channel));
      e.orders += n(r.orders);
      e.net += n(r.net);
      e.expected += n(r.expected);
      e.delivered += n(r.delivered);
      e.newCustomers += n(r.newc);
    }
    for (const [c, s] of spend) get(c).spend += s;
    return [...map.values()]
      .map((c) => ({ ...c, paid: PAID_CHANNELS.has(c.channel as Channel), roas: div(c.net, c.spend), expRoas: div(c.expected, c.spend) }))
      .sort((a, b) => b.net - a.net);
  }

  /** Spend per channel: Meta campaigns optimised for messages count as WhatsApp (CTWA). */
  private async spendByChannel(companyId: number, q: RangeQuery): Promise<Map<string, number>> {
    const rows = await this.q(companyId,
      `SELECT platform, campaign_id, SUM(spend_base) s, SUM(messaging_started) m, SUM(purchases) pu
         FROM {ins} WHERE company_id = :co AND date >= :from AND date <= :to${await this.accountScope(companyId, q.storeId)}
        GROUP BY platform, campaign_id`,
      { co: ['Int32', companyId], from: ['Date', q.from], to: ['Date', q.to] });
    const objectives = await this.campaignObjectives(companyId);
    const out = new Map<string, number>();
    for (const r of rows) {
      const platform = String(r.platform);
      let ch = `${platform}_ads`;
      if (platform === 'meta') {
        const obj = objectives.get(String(r.campaign_id)) ?? '';
        if (CTWA_OBJECTIVES.test(obj) || (n(r.m) > 0 && n(r.pu) === 0)) ch = 'whatsapp_ctwa';
      }
      out.set(ch, (out.get(ch) ?? 0) + n(r.s));
    }
    return out;
  }

  private async campaignObjectives(companyId: number) {
    const rows = await this.prisma.adEntity.findMany({
      where: { company_id: companyId, level: 'campaign' },
      select: { external_id: true, objective: true },
    });
    return new Map(rows.map((r) => [r.external_id, r.objective ?? '']));
  }

  /** Robust z-score (median/MAD) on daily spend and expected ROAS. */
  private anomalies(days: DayAgg[]) {
    const out: Array<{ date: string; metric: string; value: number; typical: number; direction: 'up' | 'down' }> = [];
    if (days.length < 10) return out;
    const check = (metric: string, vals: Array<number | null>) => {
      const v = vals.filter((x): x is number => x != null && Number.isFinite(x));
      if (v.length < 8) return;
      const med = median(v);
      const mad = median(v.map((x) => Math.abs(x - med))) || 0;
      if (mad === 0) return;
      vals.forEach((x, i) => {
        if (x == null) return;
        const z = (0.6745 * (x - med)) / mad;
        if (Math.abs(z) >= 3.5) out.push({ date: days[i].date, metric, value: x, typical: med, direction: z > 0 ? 'up' : 'down' });
      });
    };
    check('spend', days.map((d) => (d.spend > 0 ? d.spend : null)));
    check('expRoas', days.map((d) => (d.spend > 0 ? d.expected / d.spend : null)));
    check('net', days.map((d) => d.net));
    return out;
  }

  // ── Campaigns (campaign → ad set → ad) ──────────────────────────────────────
  async campaigns(companyId: number, q: RangeQuery) {
    this.validate(q);
    return this.cached(companyId, 'campaigns', q, async () => {
      const model = q.model ?? 'last';
      const win = q.win ?? 28;
      const base: Params = { co: ['Int32', companyId], from: ['Date', q.from], to: ['Date', q.to] };
      const scope = await this.accountScope(companyId, q.storeId);
      const sparkFrom = addDays(q.to, -13);
      const [ins, spark, attr, entities] = await Promise.all([
        this.q(companyId,
          `SELECT platform, campaign_id, adset_id, ad_id, SUM(spend_base) spend, SUM(impressions) impr, SUM(reach) reach,
                  SUM(clicks) clicks, SUM(link_clicks) lc, SUM(video_3s) v3, SUM(thruplay) tp, SUM(purchases) pu,
                  SUM(purchase_value_base) pv, SUM(messaging_started) msg
             FROM {ins} WHERE company_id = :co AND date >= :from AND date <= :to${scope}
            GROUP BY platform, campaign_id, adset_id, ad_id`, base),
        this.q(companyId,
          `SELECT campaign_id, date d, SUM(spend_base) s FROM {ins}
            WHERE company_id = :co AND date >= :sf AND date <= :to${scope} GROUP BY campaign_id, date`,
          { ...base, sf: ['Date', sparkFrom] }),
        this.q(companyId,
          `SELECT model, campaign_id, adset_id, ad_id, SUM(credit) orders, SUM(net) net, SUM(expected_net) exp,
                  SUM(delivered) del, SUM(credit * is_new) newc
             FROM {attr}
            WHERE company_id = :co AND win = :win AND model IN (:m, 'first', 'last') AND order_date >= :from AND order_date <= :to
              AND campaign_id IS NOT NULL
            GROUP BY model, campaign_id, adset_id, ad_id`,
          { ...base, win: ['Int32', win], m: ['String', model] }),
        this.prisma.adEntity.findMany({
          where: { company_id: companyId },
          select: { level: true, external_id: true, name: true, status: true, objective: true, daily_budget: true,
            creative_thumb_url: true, platform: true, parent_external_id: true, campaign_id: true,
            configured_status: true, budget_owner: true, budget_type: true, lifetime_budget: true, bid_strategy: true,
            bid_amount: true, roas_floor: true, optimization_goal: true, start_time: true },
        }),
      ]);
      const ent = new Map(entities.map((e) => [`${e.level}:${e.external_id}`, e]));
      const newNode = (level: 'campaign' | 'adset' | 'ad', id: string, platform: string): Node => {
        const e = ent.get(`${level}:${id}`);
        return {
          level, id, platform,
          name: e?.name ?? (id.startsWith('name:') ? id.slice(5) : id.startsWith('c:') ? id.slice(2) : id),
          status: e?.status ?? null, objective: e?.objective ?? null,
          dailyBudget: e?.daily_budget != null ? Number(e.daily_budget) : null,
          configuredStatus: e?.configured_status ?? null,
          budgetOwner: e?.budget_owner ?? null,
          budgetType: e?.budget_type ?? null,
          lifetimeBudget: e?.lifetime_budget != null ? Number(e.lifetime_budget) : null,
          bidStrategy: e?.bid_strategy ?? null,
          bidAmount: e?.bid_amount != null ? Number(e.bid_amount) : null,
          roasFloor: e?.roas_floor != null ? Number(e.roas_floor) : null,
          optimizationGoal: e?.optimization_goal ?? null,
          thumb: e?.creative_thumb_url ?? null,
          matched: !!e,
          spend: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, video3s: 0, thruplay: 0, platformPurchases: 0,
          platformValue: 0, messages: 0,
          orders: 0, net: 0, expected: 0, delivered: 0, newCustomers: 0, firstNet: 0, lastNet: 0,
          spark: [],
          children: [],
        };
      };
      const camps = new Map<string, Node>();
      const sets = new Map<string, Node>();
      const ads = new Map<string, Node>();
      const nodeFor = (platform: string, c: string, s: string | null, a: string | null) => {
        let cn = camps.get(c);
        if (!cn) camps.set(c, (cn = newNode('campaign', c, platform)));
        let sn: Node | undefined;
        if (s) {
          sn = sets.get(s);
          if (!sn) {
            sets.set(s, (sn = newNode('adset', s, platform)));
            cn.children.push(sn);
          }
        }
        let an: Node | undefined;
        if (a && !a.startsWith('c:') && sn) {
          an = ads.get(a);
          if (!an) {
            ads.set(a, (an = newNode('ad', a, platform)));
            sn.children.push(an);
          }
        }
        return [cn, sn, an].filter((x): x is Node => !!x);
      };
      for (const r of ins) {
        for (const node of nodeFor(String(r.platform), String(r.campaign_id), r.adset_id ? String(r.adset_id) : null, String(r.ad_id))) {
          node.spend += n(r.spend);
          node.impressions += n(r.impr);
          node.reach += n(r.reach);
          node.clicks += n(r.clicks);
          node.linkClicks += n(r.lc);
          node.video3s += n(r.v3);
          node.thruplay += n(r.tp);
          node.platformPurchases += n(r.pu);
          node.platformValue += n(r.pv);
          node.messages += n(r.msg);
        }
      }
      for (const r of attr) {
        const c = String(r.campaign_id);
        const platform = camps.get(c)?.platform ?? ent.get(`campaign:${c}`)?.platform ?? 'meta';
        const nodes = nodeFor(platform, c, r.adset_id ? String(r.adset_id) : null, r.ad_id ? String(r.ad_id) : null);
        const m = String(r.model);
        for (const node of nodes) {
          if (m === model) {
            node.orders += n(r.orders);
            node.net += n(r.net);
            node.expected += n(r.exp);
            node.delivered += n(r.del);
            node.newCustomers += n(r.newc);
          }
          if (m === 'first') node.firstNet += n(r.net);
          if (m === 'last') node.lastNet += n(r.net);
        }
      }
      // Live or just-created objects with no spend yet still belong in the table
      // (a campaign duplicated / created from CodesApp must be editable right away).
      const recent = Date.now() - 30 * 86_400_000;
      const byKey = (lvl: string, id: string) => ent.get(`${lvl}:${id}`);
      for (const e of entities) {
        if (e.platform == null) continue;
        const fresh = e.start_time != null && e.start_time.getTime() >= recent;
        if (e.configured_status !== 'ACTIVE' && !fresh) continue;
        if (e.level === 'campaign') {
          if (!camps.has(e.external_id)) nodeFor(e.platform, e.external_id, null, null);
        } else if (e.level === 'adset' && e.parent_external_id && byKey('campaign', e.parent_external_id)) {
          if (!sets.has(e.external_id)) nodeFor(e.platform, e.parent_external_id, e.external_id, null);
        } else if (e.level === 'ad' && e.parent_external_id && e.campaign_id) {
          if (!ads.has(e.external_id)) nodeFor(e.platform, e.campaign_id, e.parent_external_id, e.external_id);
        }
      }
      const sparkDays = dayList(sparkFrom, q.to);
      const sparkMap = new Map<string, Map<string, number>>();
      for (const r of spark) {
        const c = String(r.campaign_id);
        if (!sparkMap.has(c)) sparkMap.set(c, new Map());
        sparkMap.get(c)!.set(ymdCell(r.d), n(r.s));
      }
      const finish = (x: Node): Record<string, unknown> => ({
        ...x,
        ctr: x.impressions ? (x.linkClicks / x.impressions) * 100 : null,
        cpm: x.impressions ? (x.spend / x.impressions) * 1000 : null,
        cpc: x.linkClicks ? x.spend / x.linkClicks : null,
        cpa: x.orders >= 0.5 ? x.spend / x.orders : null,
        frequency: x.reach ? x.impressions / x.reach : null,
        hookRate: x.impressions && x.video3s ? (x.video3s / x.impressions) * 100 : null,
        holdRate: x.video3s ? (x.thruplay / x.video3s) * 100 : null,
        roas: div(x.net, x.spend),
        expRoas: div(x.expected, x.spend),
        platformRoas: div(x.platformValue, x.spend),
        firstRoas: div(x.firstNet, x.spend),
        lastRoas: div(x.lastNet, x.spend),
        spark: x.level === 'campaign' ? sparkDays.map((d) => sparkMap.get(x.id)?.get(d) ?? 0) : [],
        children: x.children.sort((a, b) => b.spend - a.spend || b.net - a.net).map(finish),
      });
      const rows = [...camps.values()].sort((a, b) => b.spend - a.spend || b.net - a.net).map(finish);
      return { model, win, rows, currency: await this.accounts.baseCurrency(companyId) };
    });
  }

  // ── Attribution ────────────────────────────────────────────────────────────
  async attribution(companyId: number, q: RangeQuery) {
    this.validate(q);
    return this.cached(companyId, 'attribution', q, async () => {
      const win = q.win ?? 28;
      const base: Params = { co: ['Int32', companyId], from: ['Date', q.from], to: ['Date', q.to] };
      const [byModel, journey, lag, touches, ctwaChats, entities] = await Promise.all([
        this.q(companyId,
          `SELECT model, channel, campaign_id, SUM(credit) orders, SUM(net) net, SUM(expected_net) exp
             FROM {attr} WHERE company_id = :co AND win = :win AND order_date >= :from AND order_date <= :to
            GROUP BY model, channel, campaign_id`, { ...base, win: ['Int32', win] }),
        this.q(companyId,
          `SELECT ft_channel f, lt_channel l, COUNT(*) c, SUM(net) v FROM {facts}
            WHERE company_id = :co AND order_date >= :from AND order_date <= :to AND ${KEPT}
            GROUP BY ft_channel, lt_channel`, base),
        this.q(companyId,
          `SELECT days_to_convert d, COUNT(*) c FROM {facts}
            WHERE company_id = :co AND order_date >= :from AND order_date <= :to AND days_to_convert IS NOT NULL
            GROUP BY days_to_convert`, base),
        this.q(companyId,
          `SELECT touches t, COUNT(*) c FROM {facts}
            WHERE company_id = :co AND order_date >= :from AND order_date <= :to GROUP BY touches`, base),
        this.prisma.conversation.count({
          where: {
            company_id: companyId,
            referral_source_id: { not: null },
            referral_at: { gte: new Date(`${q.from}T00:00:00Z`), lte: new Date(`${q.to}T23:59:59Z`) },
          },
        }),
        this.prisma.adEntity.findMany({
          where: { company_id: companyId, level: 'campaign' },
          select: { external_id: true, name: true, platform: true },
        }),
      ]);
      const names = new Map(entities.map((e) => [e.external_id, e.name ?? e.external_id]));

      // Channel × model matrix
      const channels = new Map<string, Record<string, number>>();
      const camps = new Map<string, { id: string; name: string; channel: string; byModel: Record<string, number> }>();
      for (const r of byModel) {
        const ch = String(r.channel);
        const m = String(r.model);
        const row = channels.get(ch) ?? {};
        row[m] = (row[m] ?? 0) + n(r.net);
        channels.set(ch, row);
        if (r.campaign_id) {
          const id = String(r.campaign_id);
          const c = camps.get(id) ?? {
            id, channel: ch, byModel: {},
            name: names.get(id) ?? (id.startsWith('name:') ? `${id.slice(5)} (UTM)` : id),
          };
          c.byModel[m] = (c.byModel[m] ?? 0) + n(r.net);
          camps.set(id, c);
        }
      }
      const ctwaOrders = byModel
        .filter((r) => String(r.model) === 'last' && String(r.channel) === 'whatsapp_ctwa')
        .reduce((a, r) => a + n(r.orders), 0);
      const ctwaDelivered = await this.q(companyId,
        `SELECT SUM(credit) o, SUM(delivered) d FROM {attr}
          WHERE company_id = :co AND win = :win AND model = 'last' AND channel = 'whatsapp_ctwa'
            AND order_date >= :from AND order_date <= :to AND delivered > 0`, { ...base, win: ['Int32', win] });
      const msgs = await this.q(companyId,
        `SELECT SUM(messaging_started) m, SUM(link_clicks) lc FROM {ins}
          WHERE company_id = :co AND date >= :from AND date <= :to AND platform = 'meta' AND messaging_started > 0`, base);

      return {
        win,
        models: MODELS,
        windows: WINDOWS,
        channels: [...channels.entries()]
          .map(([channel, byM]) => ({ channel, label: CHANNEL_LABEL[channel as Channel] ?? channel, byModel: byM }))
          .sort((a, b) => (b.byModel.last ?? 0) - (a.byModel.last ?? 0)),
        campaigns: [...camps.values()].sort((a, b) => (b.byModel.last ?? 0) - (a.byModel.last ?? 0)).slice(0, 25),
        journey: journey.map((r) => ({
          from: String(r.f ?? 'unknown'), to: String(r.l ?? 'unknown'), orders: n(r.c), net: n(r.v),
        })),
        lag: bucketLag(lag.map((r) => [n(r.d), n(r.c)])),
        touches: touches.map((r) => ({ touches: n(r.t), orders: n(r.c) })).sort((a, b) => a.touches - b.touches),
        ctwa: {
          adClicks: n(msgs[0]?.lc),
          chatsStarted: n(msgs[0]?.m),
          chatsInInbox: ctwaChats,
          orders: ctwaOrders,
          delivered: n(ctwaDelivered[0]?.o),
          deliveredValue: n(ctwaDelivered[0]?.d),
        },
        labels: CHANNEL_LABEL,
      };
    });
  }

  // ── Customers (cohorts) ──────────────────────────────────────────────────────
  async customers(companyId: number, q: RangeQuery) {
    this.validate(q);
    return this.cached(companyId, 'customers', q, async () => {
      const fromMonth = q.from.slice(0, 7);
      const p: Params = { co: ['Int32', companyId], fm: ['String', fromMonth], from: ['Date', q.from], to: ['Date', q.to] };
      const [cells, sizes, nvr, spendRows] = await Promise.all([
        this.q(companyId,
          `SELECT cohort_month c, order_month m, SUM(net) v FROM {facts}
            WHERE company_id = :co AND ${KEPT} AND cohort_month IS NOT NULL AND cohort_month >= :fm
            GROUP BY cohort_month, order_month`, p),
        this.q(companyId,
          `SELECT cohort_month c, COUNT(*) s FROM {facts}
            WHERE company_id = :co AND is_new = 1 AND cohort_month >= :fm GROUP BY cohort_month`, p),
        this.q(companyId,
          `SELECT order_date d, is_new nw, SUM(net) v, COUNT(*) c FROM {facts}
            WHERE company_id = :co AND ${KEPT} AND order_date >= :from AND order_date <= :to
            GROUP BY order_date, is_new`, p),
        this.q(companyId,
          `SELECT SUM(spend_base) s FROM {ins} WHERE company_id = :co AND date >= :from AND date <= :to`, p),
      ]);
      const size = new Map(sizes.map((r) => [String(r.c), n(r.s)]));
      const cohorts = [...size.keys()].sort();
      const monthIdx = (a: string, b: string) =>
        (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));
      const grid: Array<{ cohort: string; size: number; values: number[] }> = cohorts.map((c) => ({ cohort: c, size: size.get(c) ?? 0, values: [] }));
      for (const r of cells) {
        const row = grid.find((g) => g.cohort === String(r.c));
        if (!row) continue;
        const k = monthIdx(row.cohort, String(r.m));
        if (k < 0 || k > 23) continue;
        while (row.values.length <= k) row.values.push(0);
        row.values[k] += n(r.v);
      }
      // cumulative revenue per customer
      for (const g of grid) {
        let run = 0;
        g.values = g.values.map((v) => (run += v) / (g.size || 1));
      }
      const days = new Map(dayList(q.from, q.to).map((d) => [d, { date: d, newNet: 0, returningNet: 0, newOrders: 0, returningOrders: 0 }]));
      for (const r of nvr) {
        const e = days.get(ymdCell(r.d));
        if (!e) continue;
        if (n(r.nw)) {
          e.newNet += n(r.v);
          e.newOrders += n(r.c);
        } else {
          e.returningNet += n(r.v);
          e.returningOrders += n(r.c);
        }
      }
      const series = [...days.values()];
      const newCust = series.reduce((a, d) => a + d.newOrders, 0);
      const spend = n(spendRows[0]?.s);
      const ncac = div(spend, newCust);
      const mature = grid.filter((g) => g.values.length >= 3);
      const ltv90 = mature.length ? mature.reduce((a, g) => a + g.values[2] * g.size, 0) / mature.reduce((a, g) => a + g.size, 0) : null;
      const ltv0 = grid.length ? grid.reduce((a, g) => a + (g.values[0] ?? 0) * g.size, 0) / Math.max(1, grid.reduce((a, g) => a + g.size, 0)) : null;
      return {
        cohorts: grid,
        series,
        newCustomers: newCust,
        returningShare: series.reduce((a, d) => a + d.returningNet, 0) / Math.max(1, series.reduce((a, d) => a + d.returningNet + d.newNet, 0)) * 100,
        ncac,
        ltv90,
        ltvToCac: ltv90 != null && ncac ? ltv90 / ncac : null,
        paybackDays: ncac && ltv0 && ltv90 && ltv90 > ltv0 ? estimatePayback(ncac, ltv0, ltv90) : ltv0 && ncac && ltv0 >= ncac ? 0 : null,
      };
    });
  }

  // ── Creatives (ad level) ───────────────────────────────────────────────────
  async creatives(companyId: number, q: RangeQuery) {
    const c = await this.campaigns(companyId, q);
    type R = Record<string, unknown> & { level: string; children: R[]; spend: number };
    const ads: R[] = [];
    const walk = (rows: R[], campaign: string) => {
      for (const r of rows) {
        if (r.level === 'ad') ads.push({ ...r, campaign, children: [] });
        walk(r.children ?? [], r.level === 'campaign' ? String(r.name) : campaign);
      }
    };
    walk(c.rows as unknown as R[], '');
    // Fatigue: CTR last 7 days vs the 7 days before.
    const recent = await this.adCtrSplit(companyId, q.to);
    return {
      model: c.model,
      currency: c.currency,
      rows: ads
        .filter((a) => a.spend > 0)
        .sort((a, b) => b.spend - a.spend)
        .map((a) => {
          const f = recent.get(String(a.id));
          const fatigued = !!f && f.prevCtr > 0 && f.ctr < f.prevCtr * 0.75 && f.freq > 2.5;
          return { ...a, ctrTrend: f ?? null, fatigued };
        }),
    };
  }

  private async adCtrSplit(companyId: number, to: string) {
    const rows = await this.q(companyId,
      `SELECT ad_id, date >= :mid recent, SUM(impressions) i, SUM(link_clicks) c, SUM(reach) r FROM {ins}
        WHERE company_id = :co AND date >= :from AND date <= :to GROUP BY ad_id, date >= :mid`,
      { co: ['Int32', companyId], from: ['Date', addDays(to, -13)], mid: ['Date', addDays(to, -6)], to: ['Date', to] });
    const out = new Map<string, { ctr: number; prevCtr: number; freq: number }>();
    for (const r of rows) {
      const id = String(r.ad_id);
      const e = out.get(id) ?? { ctr: 0, prevCtr: 0, freq: 0 };
      const ctr = n(r.i) ? (n(r.c) / n(r.i)) * 100 : 0;
      if (n(r.recent)) {
        e.ctr = ctr;
        e.freq = n(r.r) ? n(r.i) / n(r.r) : 0;
      } else e.prevCtr = ctr;
      out.set(id, e);
    }
    return out;
  }

  /** Daily aggregates for other services (forecast, AI, opportunities). */
  daily(companyId: number, from: string, to: string, storeId?: number) {
    return this.days(companyId, from, to, storeId);
  }

  totals(days: DayAgg[]) {
    return kpisOf(sumDays(days));
  }
}

function median(v: number[]) {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function bucketLag(rows: Array<[number, number]>) {
  const buckets: Array<[string, number, number]> = [['Same day', 0, 0], ['1 day', 1, 1], ['2–3 days', 2, 3], ['4–7 days', 4, 7], ['8–14 days', 8, 14], ['15–28 days', 15, 28], ['29+ days', 29, 9999]];
  const total = rows.reduce((a, r) => a + r[1], 0) || 1;
  return buckets.map(([label, lo, hi]) => {
    const c = rows.filter(([d]) => d >= lo && d <= hi).reduce((a, r) => a + r[1], 0);
    return { label, orders: c, pct: (c / total) * 100 };
  });
}

/** Months until cumulative revenue per customer covers nCAC (linear between M0 and M2), in days. */
function estimatePayback(ncac: number, ltv0: number, ltv90: number) {
  if (ltv0 >= ncac) return 0;
  const perDay = (ltv90 - ltv0) / 60;
  return perDay > 0 ? Math.round((ncac - ltv0) / perDay) : null;
}
