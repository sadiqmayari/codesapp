import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { GrowthQueryService, RangeQuery } from './growth-query.service';
import { GrowthMirrorService } from '../store/growth-mirror.service';
import { AdAccountsService } from './ad-accounts.service';
import { n } from '../growth.util';

export interface Opportunity {
  id: string;
  kind: 'scale' | 'cut' | 'fatigue' | 'geo' | 'capi' | 'data' | 'setup';
  severity: 'good' | 'bad' | 'warn' | 'info';
  title: string;
  detail: string;
  /** Estimated monthly impact in base currency (null when not quantifiable). */
  impact: number | null;
  impactLabel: string;
  entityId?: string;
  /** One-click change the UI can stage (goes through AdManageService preview → publish). */
  action?:
    | { kind: 'scale'; campaignId: string; pct: number; label: string }
    | { kind: 'patch'; level: 'campaign' | 'adset' | 'ad'; entityId: string; patch: { status: 'PAUSED' }; label: string };
}

type CampaignRow = {
  id: string;
  name: string;
  level: string;
  spend: number;
  expected: number;
  expRoas: number | null;
  frequency: number | null;
  status: string | null;
  children: CampaignRow[];
};

/**
 * Deterministic opportunity rules (the AI only explains them — it never invents
 * them). Inputs: the last 14 days of campaigns + break-even ROAS + delivery
 * outcomes by city + data-coverage checks.
 */
@Injectable()
export class GrowthOpportunityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly query: GrowthQueryService,
    private readonly mirror: GrowthMirrorService,
    private readonly accounts: AdAccountsService,
  ) {}

  async list(companyId: number, q: RangeQuery): Promise<Opportunity[]> {
    const [overview, camps, accountList] = await Promise.all([
      this.query.overview(companyId, { ...q, compare: 'none' }),
      this.query.campaigns(companyId, q),
      this.accounts.list(companyId),
    ]);
    const days = Math.max(1, overview.range.days);
    const monthly = (v: number) => (v / days) * 30;
    const be = (overview.kpis.breakEvenRoas?.value as number | null) ?? null;
    const totalSpend = (overview.kpis.spend?.value as number) ?? 0;
    const out: Opportunity[] = [];

    if (!accountList.accounts.length) {
      out.push({ id: 'setup:connect', kind: 'setup', severity: 'info', title: 'Connect an ad account',
        detail: 'Connect Meta Ads to see spend, ROAS and profit per campaign next to your orders.', impact: null, impactLabel: 'Setup' });
    }
    for (const a of accountList.accounts) {
      if (a.health === 'error') {
        out.push({ id: `setup:err:${a.id}`, kind: 'setup', severity: 'bad', title: `${a.name ?? a.externalId}: sync failing`,
          detail: a.lastError ?? 'The last sync failed.', impact: null, impactLabel: 'Fix' });
      }
      if (a.timezoneMismatch) {
        out.push({ id: `setup:tz:${a.id}`, kind: 'setup', severity: 'warn', title: `${a.name ?? a.externalId} uses a different timezone`,
          detail: `The ad account reports days in ${a.timezone}, your workspace uses another timezone, so daily spend and sales are offset by a few hours.`,
          impact: null, impactLabel: 'Check' });
      }
    }

    const rows = camps.rows as unknown as CampaignRow[];
    if (be != null) {
      for (const c of rows) {
        if (c.spend <= 0 || c.expRoas == null) continue;
        const share = totalSpend ? c.spend / totalSpend : 0;
        const freq = c.frequency ?? 0;
        if (c.expRoas >= be * 1.3 && freq < 2.5 && share >= 0.05 && /ACTIVE/i.test(c.status ?? 'ACTIVE')) {
          // +20% budget at the fitted elasticity (~0.7) keeps most of the return.
          const extraSpend = c.spend * 0.2;
          const gain = extraSpend * c.expRoas * 0.7 - extraSpend * (be > 0 ? 1 : 0);
          out.push({ id: `scale:${c.id}`, kind: 'scale', severity: 'good', entityId: c.id,
            title: `Scale ${c.name} by 20%`,
            detail: `Expected ROAS ${c.expRoas.toFixed(2)}× vs break-even ${be.toFixed(2)}×, frequency ${freq.toFixed(1)}. There is room before fatigue.`,
            impact: monthly(Math.max(0, gain)), impactLabel: 'expected net / mo',
            action: { kind: 'scale', campaignId: c.id, pct: 20, label: 'Stage +20% budget' } });
        } else if (c.expRoas < be * 0.85 && share >= 0.05) {
          const loss = c.spend - c.expected / be;
          out.push({ id: `cut:${c.id}`, kind: 'cut', severity: 'bad', entityId: c.id,
            title: `${c.name} is below break-even`,
            detail: `Expected ROAS ${c.expRoas.toFixed(2)}× vs break-even ${be.toFixed(2)}×. Cut budget or fix targeting before it loses more.`,
            impact: monthly(Math.max(0, loss)), impactLabel: 'saved / mo',
            action: c.expRoas < be * 0.6
              ? { kind: 'patch', level: 'campaign', entityId: c.id, patch: { status: 'PAUSED' }, label: 'Stage pause' }
              : { kind: 'scale', campaignId: c.id, pct: -30, label: 'Stage −30% budget' } });
        }
      }
    }

    const creatives = await this.query.creatives(companyId, q);
    for (const ad of creatives.rows.slice(0, 40) as Array<Record<string, unknown>>) {
      if (!ad.fatigued) continue;
      const t = ad.ctrTrend as { ctr: number; prevCtr: number; freq: number };
      out.push({ id: `fatigue:${ad.id}`, kind: 'fatigue', severity: 'warn', entityId: String(ad.id),
        title: `Refresh “${ad.name}”`,
        detail: `CTR fell from ${t.prevCtr.toFixed(2)}% to ${t.ctr.toFixed(2)}% week over week while frequency reached ${t.freq.toFixed(1)}.`,
        impact: monthly(n(ad.spend) * 0.1), impactLabel: 'spend at risk / mo',
        action: { kind: 'patch', level: 'ad', entityId: String(ad.id), patch: { status: 'PAUSED' }, label: 'Stage pause ad' } });
    }

    out.push(...(await this.geoRules(companyId, q, monthly)));

    const cov = overview.coverage;
    if (cov.unitsWithCostPct != null && cov.unitsWithCostPct < 95) {
      out.push({ id: 'data:cogs', kind: 'data', severity: 'warn', title: `${(100 - cov.unitsWithCostPct).toFixed(0)}% of units have no cost price`,
        detail: 'Profit is overstated until cost prices are filled in. Sync costs from Shopify or edit them in Inventory.', impact: null, impactLabel: 'Fix data' });
    }
    if (cov.breakdownPct != null && cov.breakdownPct < 90) {
      out.push({ id: 'data:breakdown', kind: 'data', severity: 'info', title: 'Some orders lack a discount breakdown',
        detail: `${(100 - cov.breakdownPct).toFixed(0)}% of orders were imported before discounts were captured. Run "Backfill order financials".`,
        impact: null, impactLabel: 'Fix data' });
    }
    if (cov.shippingEstimatedPct != null && cov.shippingEstimatedPct > 50) {
      out.push({ id: 'data:ship', kind: 'data', severity: 'info', title: 'Shipping cost is mostly estimated',
        detail: 'Upload courier invoices so profit uses the real charge per parcel instead of your average rate.', impact: null, impactLabel: 'Fix data' });
    }

    const metaAccounts = await this.prisma.adAccount.findMany({
      where: { company_id: companyId, platform: 'meta', status: 'active' },
      select: { capi_enabled: true },
    });
    if (metaAccounts.length && !metaAccounts.some((a) => a.capi_enabled)) {
      const rto = (overview.kpis.rtoRate?.value as number | null) ?? null;
      out.push({ id: 'capi:delivered', kind: 'capi', severity: 'info',
        title: 'Send delivered orders back to Meta',
        detail: `Meta optimises for placed orders${rto != null ? `, ${rto.toFixed(0)}% of which come back` : ''}. Turn on delivered-purchase events so it learns which buyers actually pay.`,
        impact: null, impactLabel: '+8–15% ROAS typical' });
    }

    const rank = { bad: 0, good: 1, warn: 2, info: 3 } as const;
    return out.sort((a, b) => (b.impact ?? -1) - (a.impact ?? -1) || rank[a.severity] - rank[b.severity]);
  }

  /** Cities whose RTO rate on ad-driven orders is far above the store average. */
  private async geoRules(companyId: number, q: RangeQuery, monthly: (v: number) => number): Promise<Opportunity[]> {
    const rows = await this.mirror.query(companyId,
      `SELECT lt_campaign_id c, city, COUNT(*) o, SUM(lifecycle = 'rto') r, SUM(lifecycle = 'delivered') d, SUM(net) v
         FROM {facts}
        WHERE company_id = :co AND order_date >= :from AND order_date <= :to AND lt_campaign_id IS NOT NULL AND city IS NOT NULL
        GROUP BY lt_campaign_id, city`,
      { co: ['Int32', companyId], from: ['Date', q.from], to: ['Date', q.to] });
    let D = 0;
    let R = 0;
    for (const r of rows) {
      D += n(r.d);
      R += n(r.r);
    }
    const base = D + R ? R / (D + R) : 0;
    const bad = rows
      .filter((r) => n(r.d) + n(r.r) >= 15 && n(r.r) / (n(r.d) + n(r.r)) >= base + 0.15)
      .map((r) => ({ city: String(r.city), rate: n(r.r) / (n(r.d) + n(r.r)), lost: n(r.v) * (n(r.r) / Math.max(1, n(r.o))) }))
      .sort((a, b) => b.lost - a.lost)
      .slice(0, 5);
    if (!bad.length) return [];
    const total = bad.reduce((a, b) => a + b.lost, 0);
    return [{
      id: 'geo:rto', kind: 'geo', severity: 'bad',
      title: `High RTO from ${bad.map((b) => cap(b.city)).slice(0, 3).join(', ')}`,
      detail: `${bad.map((b) => `${cap(b.city)} ${(b.rate * 100).toFixed(0)}%`).join(' · ')} returned, vs ${(base * 100).toFixed(0)}% overall. Exclude these cities or require an advance payment there.`,
      impact: monthly(total), impactLabel: 'returned / mo',
    }];
  }
}

function cap(s: string) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
