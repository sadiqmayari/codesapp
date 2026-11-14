import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { JobQueueService } from '../../../common/services/job-queue.service';
import { phoneVariants } from '../../../common/utils/contact-phone';
import { isReturned } from '../../../common/utils/shipment-outcome';
import { GrowthVersionService } from './growth-version.service';
import { CapiService } from './capi.service';
import { ShopifyOrderSyncService } from '../../integrations/shopify/shopify-order-sync.service';
import { GrowthMirrorService } from '../store/growth-mirror.service';
import { classify, credit, promoteKnownCampaign, DEFAULT_WINDOW, MODELS, RawTouch, Touch, WINDOWS } from '../attribution/attribution';
import { chunk, customerKey, localYmd, n, offsetMinutes, zoneOffset } from '../growth.util';
import { runsBackground } from '../../../common/utils/process-role';

export const FACTS_QUEUE = 'growth-facts';
const BATCH = 300;
const BATCH_PAUSE_MS = 400;
const TICK_MS = 10 * 60_000;
const SMOOTHING = 20; // Bayesian prior weight for per-city delivery rates

interface FactsJob {
  companyId: number;
  mode: 'incremental' | 'full';
  gids?: string[];
}

type Lifecycle = 'cancelled' | 'rto' | 'delivered' | 'in_transit' | 'confirmed' | 'unconfirmed';
const IN_FLIGHT = new Set(['booked', 'in_transit', 'out_for_delivery', 'picked_up', 'ready_for_pickup', 'attempted']);

interface BaseRow {
  gid: string;
  store_id: number | null;
  created: Date | null;
  created_row: Date;
  cancelled_at: Date | null;
  subtotal_price: unknown;
  total_discounts: unknown;
  total_price: unknown;
  total_shipping: unknown;
  total_tax: unknown;
  financial_status: string | null;
  payment_gateway: string | null;
  fulfillment_status: string | null;
  delivered_at: Date | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  manual_confirmed_at: Date | null;
  order_name: string | null;
  landing_site: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  ship_status: string | null;
  received_at: Date | null;
  booked_at: Date | null;
  courier_type: string | null;
  conf_status: string | null;
  conversation_id: number | null;
  ps_fees: unknown;
  ps_gross: unknown;
}

interface Ctx {
  offMin: number;
  offset: string;
  cityRate: Map<string, number>;
  globalRate: number;
  confirmRate: number;
  /** P(delivered | still unresolved N days after booking), settled history. [days, rate] ascending. */
  ageRate: Array<[number, number]>;
  shipAvg: Map<string, number>;
  shipGlobal: number;
  feeRatio: number;
  adById: Map<string, { platform: string; campaignId: string | null; adsetId: string | null }>;
  campaignByName: Map<string, string>; // `${platform}|${lower name}` → id
  campaignIds: Set<string>;
  adByName: Map<string, string>;
  campaignPlatformByName: Map<string, string>;
}

/**
 * Materializes one `growth_order_facts` row per order (+ attribution credits per
 * model × window). Every Growth dashboard reads these rows — one definition of
 * gross / net / lifecycle / COGS / expected net for the whole module.
 * Incremental every 10 min (by source updated_at), nightly full refresh,
 * plus on-demand after order webhooks.
 */
/** Days after booking before a parcel's outcome is treated as settled. */
export const SETTLE_DAYS = 21;

@Injectable()

export class GrowthFactsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GrowthFactsService.name);
  private timer?: ReturnType<typeof setInterval>;
  private lastFullDay = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobQueueService,
    private readonly version: GrowthVersionService,
    private readonly capi: CapiService,
    private readonly mirror: GrowthMirrorService,
    private readonly orderSync: ShopifyOrderSyncService,
  ) {}

  onModuleInit() {
    this.jobs.registerWorker(FACTS_QUEUE, (p) => this.handle(p as FactsJob), 1, 3600);
    if (!runsBackground()) return; // APP_ROLE=web: the worker container schedules.
    this.timer = setInterval(() => void this.tick().catch((e) => this.logger.warn(`tick: ${e}`)), TICK_MS);
    setTimeout(() => void this.tick().catch(() => undefined), 120_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    const companies = await this.prisma.$queryRawUnsafe<Array<{ company_id: number }>>(
      'SELECT DISTINCT company_id FROM shopify_orders',
    );
    const today = new Date().toISOString().slice(0, 10);
    // Nightly full refresh (~02:00 PKT) — refreshes delivery probabilities, is_new.
    const full = new Date().getUTCHours() === 21 && this.lastFullDay !== today;
    if (full) this.lastFullDay = today;
    for (const c of companies) {
      await this.enqueue(c.company_id, full ? 'full' : 'incremental');
      // Nightly: re-fetch Shopify journeys for recent orders that still have no
      // touchpoints (Shopify builds journeys hours after the order).
      if (full) await this.orderSync.backfillAttribution(c.company_id, 3).catch(() => undefined);
    }
  }

  enqueue(companyId: number, mode: 'incremental' | 'full' = 'incremental', delayMs = 0) {
    return this.jobs.enqueue(FACTS_QUEUE, { companyId, mode } satisfies FactsJob, {
      dedupKey: `growth:facts:${companyId}:${mode}`,
      maxAttempts: 2,
      delayMs,
    });
  }

  private async handle(job: FactsJob) {
    const t0 = Date.now();
    let gids: string[];
    if (job.gids?.length) {
      gids = job.gids;
    } else if (job.mode === 'full') {
      gids = await this.allGids(job.companyId);
    } else {
      gids = await this.changedGids(job.companyId);
    }
    if (!gids.length) return;
    const ctx = await this.context(job.companyId);
    const parts = chunk(gids, BATCH);
    for (const part of parts) {
      await this.build(job.companyId, part, ctx);
      // Breathe between batches so a full rebuild never monopolises MariaDB
      // (the shared VPS has been OOM-killing mariadbd under load spikes).
      if (parts.length > 1) await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
    }
    this.version.bump(job.companyId, job.mode === 'full' ? 'rebuild' : 'order');
    await this.mirror.enqueue(job.companyId, 'facts');
    this.logger.log(`company ${job.companyId}: ${job.mode} facts for ${gids.length} orders in ${Date.now() - t0}ms`);
  }

  private async allGids(companyId: number): Promise<string[]> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ gid: string }>>(
      'SELECT shopify_order_gid gid FROM shopify_orders WHERE company_id = ? ORDER BY id',
      companyId,
    );
    return rows.map((r) => r.gid);
  }

  /** Orders whose order / shipment / confirmation row changed since the last build. */
  private async changedGids(companyId: number): Promise<string[]> {
    const [wm] = await this.prisma.$queryRawUnsafe<Array<{ m: Date | null; c: bigint }>>(
      'SELECT MAX(updated_at) m, COUNT(*) c FROM growth_order_facts WHERE company_id = ?',
      companyId,
    );
    if (!wm?.m || n(wm.c) === 0) return this.allGids(companyId);
    const since = new Date(wm.m.getTime() - 10 * 60_000);
    const [a, b, c] = await Promise.all([
      this.prisma.$queryRawUnsafe<Array<{ gid: string }>>(
        'SELECT shopify_order_gid gid FROM shopify_orders WHERE company_id = ? AND updated_at >= ?',
        companyId,
        since,
      ),
      this.prisma.$queryRawUnsafe<Array<{ gid: string }>>(
        'SELECT shopify_order_gid gid FROM shipments WHERE company_id = ? AND updated_at >= ?',
        companyId,
        since,
      ),
      this.prisma.$queryRawUnsafe<Array<{ gid: string }>>(
        'SELECT shopify_order_gid gid FROM shopify_order_messages WHERE company_id = ? AND updated_at >= ?',
        companyId,
        since,
      ),
    ]);
    return [...new Set([...a, ...b, ...c].map((r) => r.gid))];
  }

  /** City rate scaled by how long the parcel has been out (late parcels are mostly returns). */
  private ageAdjusted(pCity: number, bookedAt: Date | null, now: Date, ctx: Ctx): number {
    if (!bookedAt || !ctx.ageRate.length) return pCity;
    const days = (now.getTime() - new Date(bookedAt).getTime()) / 86_400_000;
    const base = ctx.ageRate[0][1];
    let rate = base;
    for (const [b, v] of ctx.ageRate) if (days >= b) rate = v;
    if (base <= 0) return pCity;
    return Math.min(0.99, Math.max(0.05, pCity * (rate / base)));
  }

  /** The delivery model (settled city rates + pre-shipping keep rate) — for calibration / coaching. */
  async deliveryModel(companyId: number) {
    const c = await this.context(companyId);
    return { cityRate: c.cityRate, globalRate: c.globalRate, confirmRate: c.confirmRate };
  }

  /** Company-wide rates used to price every order in this run. */
  private async context(companyId: number): Promise<Ctx> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } });
    const offset = zoneOffset(company?.timezone ?? null);
    const ageRowsP = this.prisma.$queryRawUnsafe<Array<{ b: unknown; d: unknown; r: unknown }>>(
      // A parcel still out after N days is much more likely to be coming back:
      // settled history says ~85% delivered at day 0 but ~32% at day 8.
      `SELECT k.b,
              SUM(s.status = 'delivered' AND s.delivered_at >= s.booked_at + INTERVAL k.b DAY) d,
              SUM(((s.status IN ('returned','failed') OR s.received_at IS NOT NULL)
                     AND COALESCE(s.received_at, s.failed_at, s.updated_at) >= s.booked_at + INTERVAL k.b DAY)
                  OR (s.status = 'cancelled' AND s.received_at IS NULL
                     AND COALESCE(s.cancelled_at, s.updated_at) >= s.booked_at + INTERVAL k.b DAY)) r
         FROM shipments s
         JOIN (SELECT 0 b UNION ALL SELECT 3 UNION ALL SELECT 5 UNION ALL SELECT 8 UNION ALL SELECT 12) k
        WHERE s.company_id = ? AND s.booked_at >= NOW() - INTERVAL 180 DAY AND s.booked_at < NOW() - INTERVAL ${SETTLE_DAYS} DAY
        GROUP BY k.b ORDER BY k.b`,
      companyId,
    ).catch(() => [] as Array<{ b: unknown; d: unknown; r: unknown }>);
    const [cityRows, confRow, shipRows, feeRow, entities] = await Promise.all([
      this.prisma.$queryRawUnsafe<Array<{ c: string | null; d: unknown; r: unknown; x: unknown }>>(
        // SETTLED parcels only (booked 21–180 days ago). Deliveries resolve in
        // ~4 days but returns take ~14, so recent parcels look better than they
        // are (survivorship bias → expected net was ~4-6 pts too optimistic).
        // A booking cancelled without a receipt (order dropped after booking)
        // counts as a loss too.
        `SELECT LOWER(TRIM(o.city)) c,
                SUM(s.status = 'delivered') d,
                SUM(s.status IN ('returned','failed') OR s.received_at IS NOT NULL) r,
                SUM(s.status = 'cancelled' AND s.received_at IS NULL) x
           FROM shipments s
           JOIN shopify_orders o ON o.company_id = s.company_id AND o.shopify_order_gid = s.shopify_order_gid
          WHERE s.company_id = ? AND s.booked_at >= NOW() - INTERVAL 180 DAY AND s.booked_at < NOW() - INTERVAL ${SETTLE_DAYS} DAY
          GROUP BY c`,
        companyId,
      ),
      this.prisma.$queryRawUnsafe<Array<{ kept: unknown; total: unknown }>>(
        // "Kept" = not cancelled BEFORE booking. Anything that reached a courier
        // (delivered, returned, or booking cancelled later) is priced by the city
        // delivery rate instead — receiving a return also sets cancelled_at, so
        // counting it here too double-penalised unconfirmed orders.
        `SELECT SUM(o.cancelled_at IS NULL OR EXISTS (SELECT 1 FROM shipments sb WHERE sb.company_id = o.company_id
                  AND sb.shopify_order_gid = o.shopify_order_gid AND sb.booked_at IS NOT NULL)) kept,
                COUNT(*) total FROM shopify_orders o
          WHERE o.company_id = ? AND o.shopify_created_at BETWEEN NOW() - INTERVAL 120 DAY AND NOW() - INTERVAL ${SETTLE_DAYS} DAY`,
        companyId,
      ),
      this.prisma.$queryRawUnsafe<Array<{ c: string; a: unknown }>>(
        // Courier fee = shippingCharge + fuel + GST + SST from settlement statement
        // lines (courier_invoice_amount is the COD COLLECTED, not the fee).
        `SELECT ci.courier_type c, AVG(COALESCE(jt.sc,0) + COALESCE(jt.fs,0) + COALESCE(jt.gst,0) + COALESCE(jt.sst,0)) a
           FROM courier_invoices ci
           JOIN JSON_TABLE(ci.\x60lines\x60, '$[*]' COLUMNS(
                 orderName VARCHAR(64) PATH '$.orderName',
                 sc DECIMAL(12,2) PATH '$.shippingCharge', fs DECIMAL(12,2) PATH '$.fuelSurcharge',
                 gst DECIMAL(12,2) PATH '$.gst', sst DECIMAL(12,2) PATH '$.sst')) jt
          WHERE ci.company_id = ? AND ci.is_rollup = 0 AND ci.created_at >= NOW() - INTERVAL 180 DAY
            AND (COALESCE(jt.sc,0) + COALESCE(jt.fs,0) + COALESCE(jt.gst,0) + COALESCE(jt.sst,0)) > 0
          GROUP BY ci.courier_type`,
        companyId,
      ),
      this.prisma.$queryRawUnsafe<Array<{ f: unknown; g: unknown }>>(
        'SELECT SUM(fees) f, SUM(gross) g FROM payment_settlements WHERE company_id = ? AND gross > 0',
        companyId,
      ),
      this.prisma.adEntity.findMany({
        where: { company_id: companyId },
        select: { platform: true, level: true, external_id: true, parent_external_id: true, campaign_id: true, name: true },
      }),
    ]);

    let D = 0;
    let R = 0;
    for (const r of cityRows) {
      D += n(r.d);
      R += n(r.r) + n(r.x);
    }
    const globalRate = D + R > 0 ? D / (D + R) : 0.8;
    const cityRate = new Map<string, number>();
    for (const r of cityRows) {
      if (!r.c) continue;
      const d = n(r.d);
      const rr = n(r.r) + n(r.x);
      cityRate.set(r.c, (d + SMOOTHING * globalRate) / (d + rr + SMOOTHING));
    }
    const kept = n(confRow[0]?.kept);
    const total = n(confRow[0]?.total);
    const shipAvg = new Map(shipRows.map((r) => [String(r.c), n(r.a)]));
    const shipVals = [...shipAvg.values()].filter((v) => v > 0);
    const adById = new Map<string, { platform: string; campaignId: string | null; adsetId: string | null }>();
    const campaignByName = new Map<string, string>();
    const campaignIds = new Set<string>();
    const adByName = new Map<string, string>();
    const campaignPlatformByName = new Map<string, string>();
    for (const e of entities) {
      if (e.level === 'campaign' && e.name) campaignPlatformByName.set(e.name.trim().toLowerCase(), e.platform);
      if (e.level === 'ad') {
        adById.set(e.external_id, { platform: e.platform, campaignId: e.campaign_id, adsetId: e.parent_external_id });
        if (e.name) {
          adByName.set(`${e.platform}|${e.name.trim().toLowerCase()}`, e.external_id);
          if (e.campaign_id) adByName.set(`${e.platform}|${e.campaign_id}|${e.name.trim().toLowerCase()}`, e.external_id);
        }
      } else if (e.level === 'campaign') {
        campaignIds.add(e.external_id);
        if (e.name) campaignByName.set(`${e.platform}|${e.name.trim().toLowerCase()}`, e.external_id);
      }
    }
    const ageRate: Array<[number, number]> = [];
    for (const r of await ageRowsP) {
      const d = n(r.d);
      const rr = n(r.r);
      if (d + rr >= 30) ageRate.push([n(r.b), d / (d + rr)]);
    }
    return {
      offMin: offsetMinutes(offset),
      offset,
      cityRate,
      globalRate,
      ageRate,
      confirmRate: total > 50 ? kept / total : 0.88,
      shipAvg,
      shipGlobal: shipVals.length ? shipVals.reduce((a, b) => a + b, 0) / shipVals.length : 0,
      feeRatio: n(feeRow[0]?.g) > 0 ? n(feeRow[0]?.f) / n(feeRow[0]?.g) : 0,
      adById,
      campaignByName,
      campaignIds,
      adByName,
      campaignPlatformByName,
    };
  }

  private lifecycle(r: BaseRow, payment: string): Lifecycle {
    // Return FIRST: receiving a return cancels + archives the Shopify order, so
    // checking cancelled_at first mislabelled ~93% of returns as 'cancelled'.
    const st = r.ship_status;
    if (isReturned({ status: st, received_at: r.received_at })) return 'rto';
    if (r.cancelled_at) return 'cancelled';
    if (st === 'delivered' || (!st && r.delivered_at)) return 'delivered';
    if ((st && IN_FLIGHT.has(st)) || r.fulfillment_status === 'fulfilled' || r.fulfillment_status === 'partial') {
      return 'in_transit';
    }
    if (r.conf_status === 'confirmed' || r.manual_confirmed_at || st === 'address_issue' || st === 'cancelled' || payment === 'prepaid') {
      return 'confirmed';
    }
    return 'unconfirmed';
  }

  /** Build + write facts and attribution for one batch of order gids. */
  async build(companyId: number, gids: string[], ctx: Ctx): Promise<void> {
    if (!gids.length) return;
    const ph = gids.map(() => '?').join(',');
    const base = await this.prisma.$queryRawUnsafe<BaseRow[]>(
      `SELECT o.shopify_order_gid gid, o.shopify_store_id store_id, o.shopify_created_at created, o.created_at created_row,
              o.cancelled_at, o.subtotal_price, o.total_discounts, o.total_price, o.total_shipping, o.total_tax,
              o.financial_status, o.payment_gateway, o.fulfillment_status, o.delivered_at, o.city, o.phone, o.email,
              o.manual_confirmed_at, o.order_name, o.landing_site,
              o.utm_source, o.utm_medium, o.utm_campaign, o.utm_content,
              s.status ship_status, s.received_at, s.booked_at, s.courier_type,
              som.status conf_status, som.conversation_id,
              ps.fees ps_fees, ps.gross ps_gross
         FROM shopify_orders o
         LEFT JOIN shipments s ON s.company_id = o.company_id AND s.shopify_order_gid = o.shopify_order_gid
         LEFT JOIN shopify_order_messages som ON som.company_id = o.company_id AND som.shopify_order_gid = o.shopify_order_gid
         LEFT JOIN payment_settlements ps ON ps.id = o.payment_settlement_id
        WHERE o.company_id = ? AND o.shopify_order_gid IN (${ph})`,
      companyId,
      ...gids,
    );
    if (!base.length) return;
    const present = base.map((b) => b.gid);
    const ph2 = present.map(() => '?').join(',');

    // ── Real courier fees from settlement statements (one per order) ──
    const names = [...new Set(base.map((b) => b.order_name).filter((x): x is string => !!x))];
    const shipFee = new Map<string, number>();
    for (const part of chunk(names, 500)) {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ n: string; f: unknown }>>(
        `SELECT jt.orderName n, MAX(COALESCE(jt.sc,0) + COALESCE(jt.fs,0) + COALESCE(jt.gst,0) + COALESCE(jt.sst,0)) f
           FROM courier_invoices ci
           JOIN JSON_TABLE(ci.\x60lines\x60, '$[*]' COLUMNS(
                 orderName VARCHAR(64) PATH '$.orderName',
                 sc DECIMAL(12,2) PATH '$.shippingCharge', fs DECIMAL(12,2) PATH '$.fuelSurcharge',
                 gst DECIMAL(12,2) PATH '$.gst', sst DECIMAL(12,2) PATH '$.sst')) jt
          WHERE ci.company_id = ? AND ci.is_rollup = 0
            AND jt.orderName COLLATE utf8mb4_general_ci IN (${part.map(() => '?').join(',')})
          GROUP BY jt.orderName`,
        companyId,
        ...part,
      );
      for (const r of rows) shipFee.set(r.n, n(r.f));
    }

    // ── COGS (bundles fall back to their components' cost) ──
    const lines = await this.prisma.$queryRawUnsafe<
      Array<{ gid: string; qty: unknown; cost: unknown; is_bundle: number | boolean | null; comps: unknown }>
    >(
      `SELECT o.shopify_order_gid gid, li.qty, COALESCE(iv.cost_price, iv.shopify_unit_cost) cost,
              iv.is_bundle, iv.bundle_components comps
         FROM shopify_orders o
         JOIN JSON_TABLE(o.line_items, '$[*]' COLUMNS(
                qty INT PATH '$.quantity', variantId VARCHAR(120) PATH '$.variantId')) li
         LEFT JOIN inventory_variants iv
           ON iv.company_id = o.company_id
          AND iv.shopify_variant_gid COLLATE utf8mb4_general_ci = li.variantId COLLATE utf8mb4_general_ci
        WHERE o.company_id = ? AND o.shopify_order_gid IN (${ph2})`,
      companyId,
      ...present,
    );
    const compGids = new Set<string>();
    const parseComps = (c: unknown): Array<{ gid?: string; quantity?: number }> => {
      if (!c) return [];
      try {
        const v = typeof c === 'string' ? JSON.parse(c) : c;
        return Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    };
    for (const l of lines) {
      if (l.cost == null && l.is_bundle) for (const c of parseComps(l.comps)) if (c.gid) compGids.add(c.gid);
    }
    const compCost = new Map<string, number | null>();
    if (compGids.size) {
      const cs = await this.prisma.inventoryVariant.findMany({
        where: { company_id: companyId, shopify_variant_gid: { in: [...compGids] } },
        select: { shopify_variant_gid: true, cost_price: true, shopify_unit_cost: true },
      });
      for (const c of cs) {
        const v = c.cost_price ?? c.shopify_unit_cost;
        compCost.set(c.shopify_variant_gid, v == null ? null : Number(v));
      }
    }
    const cogs = new Map<string, { cogs: number; units: number; noCost: number }>();
    for (const l of lines) {
      const e = cogs.get(l.gid) ?? { cogs: 0, units: 0, noCost: 0 };
      const qty = n(l.qty);
      e.units += qty;
      let unit: number | null = l.cost == null ? null : n(l.cost);
      if (unit == null && l.is_bundle) {
        const comps = parseComps(l.comps);
        let sum = 0;
        let ok = comps.length > 0;
        for (const c of comps) {
          const cc = c.gid ? compCost.get(c.gid) : null;
          if (cc == null) ok = false;
          else sum += cc * (c.quantity ?? 1);
        }
        unit = ok ? sum : null;
      }
      if (unit == null) e.noCost += qty;
      else e.cogs += unit * qty;
      cogs.set(l.gid, e);
    }

    // ── Touchpoints: journey/landing rows + Click-to-WhatsApp conversations ──
    const tps = await this.prisma.orderTouchpoint.findMany({
      where: { company_id: companyId, order_gid: { in: present } },
      orderBy: { seq: 'asc' },
    });
    const tpBy = new Map<string, typeof tps>();
    for (const t of tps) tpBy.set(t.order_gid, [...(tpBy.get(t.order_gid) ?? []), t]);

    const convIds = [...new Set(base.map((b) => b.conversation_id).filter((x): x is number => !!x))];
    const convRef = new Map<number, { ad: string; at: Date }>();
    if (convIds.length) {
      const cs = await this.prisma.conversation.findMany({
        where: { company_id: companyId, id: { in: convIds }, referral_source_id: { not: null } },
        select: { id: true, referral_source_id: true, referral_at: true, created_at: true },
      });
      for (const c of cs) convRef.set(c.id, { ad: c.referral_source_id!, at: c.referral_at ?? c.created_at });
    }
    // Orders without a confirmation-message link: match the buyer's phone to a referred chat.
    const phoneRef = new Map<string, { ad: string; at: Date }[]>();
    const noConv = base.filter((b) => !b.conversation_id && b.phone);
    if (noConv.length) {
      const variants = [...new Set(noConv.flatMap((b) => phoneVariants(b.phone)))].filter(Boolean);
      if (variants.length) {
        const cs = await this.prisma.conversation.findMany({
          where: { company_id: companyId, referral_source_id: { not: null }, contact: { phone: { in: variants } } },
          select: { referral_source_id: true, referral_at: true, created_at: true, contact: { select: { phone: true } } },
          take: 5000,
        });
        for (const c of cs) {
          const k = c.contact.phone.replace(/\D/g, '').slice(-10);
          phoneRef.set(k, [...(phoneRef.get(k) ?? []), { ad: c.referral_source_id!, at: c.referral_at ?? c.created_at }]);
        }
      }
    }

    // ── Assemble rows ──
    const version = BigInt(Date.now());
    const now = new Date();
    type Fact = {
      gid: string;
      store_id: number | null;
      order_date: string;
      order_month: string;
      created_at: Date;
      lifecycle: Lifecycle;
      payment: string;
      gross: number;
      net: number;
      discounts: number;
      cogs: number;
      units: number;
      units_no_cost: number;
      ship_cost: number;
      ship_estimated: boolean;
      fees: number;
      has_breakdown: boolean;
      p_deliver: number;
      city: string | null;
      courier: string | null;
      customer_key: string | null;
      touches: Touch[];
    };
    const facts: Fact[] = [];
    for (const r of base) {
      const created = r.created ?? r.created_row;
      const fin = (r.financial_status ?? '').toLowerCase();
      const gw = (r.payment_gateway ?? '').toLowerCase();
      const payment =
        fin === 'partially_paid'
          ? 'partial'
          : (fin === 'paid' || fin === 'partially_refunded' || fin === 'refunded') && !/cash|cod|manual/.test(gw)
            ? 'prepaid'
            : 'cod';
      const life = this.lifecycle(r, payment);
      const hasBreakdown = r.subtotal_price != null;
      const net = hasBreakdown
        ? n(r.subtotal_price)
        : Math.max(0, n(r.total_price) - n(r.total_shipping) - n(r.total_tax));
      const discounts = n(r.total_discounts);
      const city = r.city?.trim().toLowerCase() || null;
      const pCity = (city && ctx.cityRate.get(city)) || ctx.globalRate;
      const p =
        life === 'delivered'
          ? 1
          : life === 'rto' || life === 'cancelled'
            ? 0
            : payment === 'prepaid'
              ? Math.max(pCity, 0.97)
              : life === 'in_transit'
                ? this.ageAdjusted(pCity, r.booked_at, now, ctx)
                : life === 'confirmed'
                  ? pCity * 0.97
                  : pCity * ctx.confirmRate;
      const shipped = life === 'in_transit' || life === 'delivered' || life === 'rto';
      const invoiced = r.order_name ? shipFee.get(r.order_name) ?? 0 : 0;
      const shipEst = !invoiced && shipped ? ctx.shipAvg.get(r.courier_type ?? '') || ctx.shipGlobal : 0;
      const fees =
        n(r.ps_gross) > 0
          ? (n(r.total_price) * n(r.ps_fees)) / n(r.ps_gross)
          : payment === 'prepaid'
            ? n(r.total_price) * ctx.feeRatio
            : 0;
      const c = cogs.get(r.gid) ?? { cogs: 0, units: 0, noCost: 0 };
      const day = localYmd(created, ctx.offMin);

      facts.push({
        gid: r.gid,
        store_id: r.store_id,
        order_date: day,
        order_month: day.slice(0, 7),
        created_at: created,
        lifecycle: life,
        payment,
        gross: net + discounts,
        net,
        discounts,
        cogs: life === 'cancelled' || life === 'rto' ? 0 : c.cogs,
        units: c.units,
        units_no_cost: c.noCost,
        ship_cost: invoiced || shipEst,
        ship_estimated: !invoiced && shipEst > 0,
        fees: life === 'cancelled' ? 0 : fees,
        has_breakdown: hasBreakdown,
        p_deliver: Math.round(p * 10_000) / 10_000,
        city: city?.slice(0, 128) ?? null,
        courier: r.courier_type,
        customer_key: customerKey(r.phone, r.email),
        touches: this.touchesFor(r, created, tpBy.get(r.gid) ?? [], convRef, phoneRef, ctx),
      });
    }

    // ── New-customer flag + acquisition cohort (first non-cancelled order) ──
    const keys = [...new Set(facts.map((f) => f.customer_key).filter((k): k is string => !!k))];
    const firstAt = new Map<string, Date>();
    for (const part of chunk(keys, 500)) {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ k: string; m: Date }>>(
        `SELECT customer_key k, MIN(created_at) m FROM growth_order_facts
          WHERE company_id = ? AND lifecycle <> 'cancelled' AND customer_key IN (${part.map(() => '?').join(',')})
            AND order_gid NOT IN (${ph2})
          GROUP BY customer_key`,
        companyId,
        ...part,
        ...present,
      );
      for (const r of rows) firstAt.set(r.k, r.m);
    }
    for (const f of facts) {
      if (!f.customer_key || f.lifecycle === 'cancelled') continue;
      const cur = firstAt.get(f.customer_key);
      if (!cur || f.created_at < cur) firstAt.set(f.customer_key, f.created_at);
    }

    // Previous lifecycle → detect orders that just became DELIVERED (for CAPI).
    const prevRows = await this.prisma.$queryRawUnsafe<Array<{ g: string; l: string }>>(
      `SELECT order_gid g, lifecycle l FROM growth_order_facts WHERE company_id = ? AND order_gid IN (${ph2})`,
      companyId,
      ...present,
    );
    const prevLife = new Map(prevRows.map((r) => [r.g, r.l]));

    // ── Write facts ──
    const cols = [
      'company_id', 'order_gid', 'store_id', 'order_date', 'order_month', 'cohort_month', 'created_at', 'lifecycle',
      'payment', 'gross', 'net', 'discounts', 'cogs', 'units', 'units_no_cost', 'ship_cost', 'ship_estimated', 'fees',
      'has_breakdown', 'p_deliver', 'city', 'courier', 'customer_key', 'is_new', 'ft_channel', 'ft_platform',
      'ft_campaign_id', 'lt_channel', 'lt_platform', 'lt_campaign_id', 'touches', 'days_to_convert', 'version', 'updated_at',
    ];
    const attrRows: unknown[][] = [];
    const factRows: unknown[][] = facts.map((f) => {
      const first = f.customer_key ? firstAt.get(f.customer_key) : undefined;
      const isNew = !!first && f.lifecycle !== 'cancelled' && first.getTime() === f.created_at.getTime();
      const cohort = first ? localYmd(first, ctx.offMin).slice(0, 7) : null;
      const ft = credit(f.touches, f.created_at, 'first', DEFAULT_WINDOW)[0];
      const lt = credit(f.touches, f.created_at, 'last', DEFAULT_WINDOW)[0];
      const inWin = f.touches.filter(
        (t) => t.occurredAt.getTime() >= f.created_at.getTime() - DEFAULT_WINDOW * 86_400_000 && t.occurredAt <= f.created_at,
      );
      const dtc = inWin.length
        ? Math.max(0, Math.floor((f.created_at.getTime() - Math.min(...inWin.map((t) => t.occurredAt.getTime()))) / 86_400_000))
        : null;
      const expected = f.net * f.p_deliver;
      const delivered = f.lifecycle === 'delivered' ? f.net : 0;
      for (const m of MODELS) {
        for (const w of WINDOWS) {
          for (const c of credit(f.touches, f.created_at, m, w)) {
            attrRows.push([
              companyId, f.gid, f.order_date, m, w, c.channel, c.platform, c.campaignId, c.adsetId, c.adId, c.credit,
              round2(f.net * c.credit), round2(expected * c.credit), round2(delivered * c.credit), isNew, version,
            ]);
          }
        }
      }
      return [
        companyId, f.gid, f.store_id, f.order_date, f.order_month, cohort, f.created_at, f.lifecycle, f.payment,
        round2(f.gross), round2(f.net), round2(f.discounts), round2(f.cogs), f.units, f.units_no_cost, round2(f.ship_cost),
        f.ship_estimated, round2(f.fees), f.has_breakdown, f.p_deliver, f.city, f.courier?.slice(0, 32) ?? null,
        f.customer_key, isNew, ft.channel, ft.platform, ft.campaignId, lt.channel, lt.platform, lt.campaignId,
        inWin.length, dtc, version, now,
      ];
    });

    const upd = cols.filter((c) => c !== 'company_id' && c !== 'order_gid').map((c) => `${c} = VALUES(${c})`).join(', ');
    for (const part of chunk(factRows, 150)) {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO growth_order_facts (${cols.join(',')}) VALUES ${part
          .map(() => `(${cols.map(() => '?').join(',')})`)
          .join(',')} ON DUPLICATE KEY UPDATE ${upd}`,
        ...part.flat(),
      );
    }

    const recent = Date.now() - 90 * 86_400_000;
    const newlyDelivered = facts
      .filter((f) => f.lifecycle === 'delivered' && prevLife.has(f.gid) && prevLife.get(f.gid) !== 'delivered' && f.created_at.getTime() >= recent)
      .map((f) => f.gid);
    if (newlyDelivered.length) await this.capi.enqueue(companyId, newlyDelivered).catch(() => undefined);

    const acols = ['company_id', 'order_gid', 'order_date', 'model', 'win', 'channel', 'platform', 'campaign_id', 'adset_id',
      'ad_id', 'credit', 'net', 'expected_net', 'delivered', 'is_new', 'version'];
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM growth_attribution WHERE company_id = ? AND order_gid IN (${ph2})`,
      companyId,
      ...present,
    );
    for (const part of chunk(attrRows, 300)) {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO growth_attribution (${acols.join(',')}) VALUES ${part
          .map(() => `(${acols.map(() => '?').join(',')})`)
          .join(',')}`,
        ...part.flat(),
      );
    }
  }

  private touchesFor(
    r: BaseRow,
    created: Date,
    rows: Array<{
      occurred_at: Date;
      source: string;
      utm_source: string | null;
      utm_medium: string | null;
      utm_campaign: string | null;
      utm_content: string | null;
      landing_page: string | null;
      referrer: string | null;
    }>,
    convRef: Map<number, { ad: string; at: Date }>,
    phoneRef: Map<string, { ad: string; at: Date }[]>,
    ctx: Ctx,
  ): Touch[] {
    const raw: RawTouch[] = rows.map((t) => ({
      occurredAt: t.occurred_at,
      source: t.source === 'landing_site' ? 'landing_site' : 'shopify_journey',
      utmSource: t.utm_source,
      utmMedium: t.utm_medium,
      utmCampaign: t.utm_campaign,
      utmContent: t.utm_content,
      landingPage: t.landing_page,
      referrer: t.referrer,
    }));
    if (!raw.length && (r.utm_campaign || r.utm_source || r.landing_site)) {
      raw.push({
        occurredAt: created,
        source: 'landing_site',
        utmSource: r.utm_source,
        utmMedium: r.utm_medium,
        utmCampaign: r.utm_campaign,
        utmContent: r.utm_content,
        landingPage: r.landing_site,
      });
    }
    const refs: { ad: string; at: Date }[] = [];
    const cr = r.conversation_id ? convRef.get(r.conversation_id) : undefined;
    if (cr) refs.push(cr);
    else if (r.phone) refs.push(...(phoneRef.get(r.phone.replace(/\D/g, '').slice(-10)) ?? []));
    for (const ref of refs) {
      if (ref.at.getTime() <= created.getTime() + 60_000) raw.push({ occurredAt: ref.at, source: 'ctwa', adRef: ref.ad });
    }

    return raw.map((t) => {
      // A UTM naming a campaign of a connected ad account = paid on that platform.
      const campName = (t.utmCampaign ?? '').trim().toLowerCase();
      const known = t.source === 'ctwa' || !campName ? null : ctx.campaignPlatformByName.get(campName) ?? null;
      const c = promoteKnownCampaign(classify(t), known);
      let campaignId: string | null = null;
      let adsetId: string | null = null;
      let adId: string | null = null;
      if (t.source === 'ctwa' && t.adRef) {
        const ad = ctx.adById.get(t.adRef);
        adId = t.adRef.slice(0, 64);
        campaignId = ad?.campaignId ?? null;
        adsetId = ad?.adsetId ?? null;
      } else if (c.platform) {
        const content = (t.utmContent ?? '').trim();
        const contentKey = content.toLowerCase();
        const camp = (t.utmCampaign ?? '').trim();
        // 1) campaign by id or exact name
        if (camp) {
          campaignId = ctx.campaignIds.has(camp)
            ? camp
            : ctx.campaignByName.get(`${c.platform}|${camp.toLowerCase()}`) ?? `name:${camp.slice(0, 59)}`;
        }
        // 2) ad by id, else by name INSIDE that campaign, else by name anywhere
        const adKey =
          (ctx.adById.has(content) ? content : null) ??
          (campaignId && !campaignId.startsWith('name:') ? ctx.adByName.get(`${c.platform}|${campaignId}|${contentKey}`) : undefined) ??
          ctx.adByName.get(`${c.platform}|${contentKey}`) ??
          null;
        const ad = adKey ? ctx.adById.get(adKey) : undefined;
        if (ad && adKey) {
          adId = adKey;
          adsetId = ad.adsetId;
          campaignId = ad.campaignId ?? campaignId;
        }
      }
      return { ...c, occurredAt: t.occurredAt, campaignId, adsetId, adId };
    });
  }
}

function round2(v: number) {
  return Math.round(v * 100) / 100;
}
