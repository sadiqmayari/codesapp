import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { addDays, localParts, localTimeToInstant, monthBounds, MONTH_RE } from '../attendance/schedule';
import {
  AppliesTo,
  METRICS,
  Metric,
  OPS_KIND,
  PlanConfig,
  PlanResult,
  UserUnits,
  appliesToUser,
  computePlan,
  resolveAppliesTo,
  resolvePlanConfig,
} from './commission-math';
import { CommissionPlanDto, PreviewPlanDto } from './dto/commission-plan.dto';

const LOOKBACK_DAYS = 150; // orders attributed this far back can still earn (delivery lag) or reverse
const CHUNK = 500;
const NOT_TRACKED = ['owner', 'super_admin'];

type Member = { id: number; name: string; role: string };

export interface PlanStatement {
  planId: number;
  planName: string;
  metric: Metric;
  config: PlanConfig;
  rows: (PlanResult & { name: string; role: string })[];
  total: number;
}

/**
 * Commission engine. Plans live in commission_plans; per-user units come from
 * the order_attributions ledger + each order's outcome (placed / confirmed /
 * delivered / cancelled / returned). Everything is computed on demand for a
 * tenant month — approving payroll freezes the result in the payslip snapshot.
 */
@Injectable()
export class CommissionsService {
  private readonly log = new Logger(CommissionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── plans CRUD ──────────────────────────────────────────────────────────
  private view(p: { id: number; name: string; active: boolean; metric: string; config: unknown; applies_to: unknown; created_at: Date; updated_at: Date }) {
    const metric = (METRICS as readonly string[]).includes(p.metric) ? (p.metric as Metric) : 'orders';
    return {
      id: p.id,
      name: p.name,
      active: p.active,
      metric,
      config: resolvePlanConfig(metric, p.config),
      appliesTo: resolveAppliesTo(p.applies_to),
      createdAt: p.created_at.toISOString(),
      updatedAt: p.updated_at.toISOString(),
    };
  }

  async listPlans(companyId: number) {
    const rows = await this.prisma.commissionPlan.findMany({ where: { company_id: companyId }, orderBy: [{ active: 'desc' }, { id: 'asc' }] });
    return rows.map((r) => this.view(r));
  }

  private normalize(dto: CommissionPlanDto) {
    if (!(METRICS as readonly string[]).includes(dto.metric)) throw new BadRequestException('Unknown metric');
    const metric = dto.metric as Metric;
    const name = dto.name.trim().slice(0, 120);
    if (!name) throw new BadRequestException('Give the plan a name');
    return {
      name,
      metric,
      active: dto.active !== false,
      config: resolvePlanConfig(metric, dto.config) as unknown as Prisma.InputJsonValue,
      applies_to: resolveAppliesTo(dto.appliesTo) as unknown as Prisma.InputJsonValue,
    };
  }

  async createPlan(companyId: number, userId: number, dto: CommissionPlanDto) {
    const data = this.normalize(dto);
    const p = await this.prisma.commissionPlan.create({ data: { company_id: companyId, created_by_user_id: userId, ...data } });
    void this.backfillIfEmpty(companyId);
    return this.view(p);
  }

  async updatePlan(companyId: number, id: number, dto: CommissionPlanDto) {
    const existing = await this.prisma.commissionPlan.findFirst({ where: { id, company_id: companyId } });
    if (!existing) throw new NotFoundException('Plan not found');
    const p = await this.prisma.commissionPlan.update({ where: { id }, data: this.normalize(dto) });
    return this.view(p);
  }

  async deletePlan(companyId: number, id: number) {
    const res = await this.prisma.commissionPlan.deleteMany({ where: { id, company_id: companyId } });
    if (!res.count) throw new NotFoundException('Plan not found');
    return { ok: true };
  }

  // ── month window ─────────────────────────────────────────────────────────
  private async window(companyId: number, month: string) {
    if (!MONTH_RE.test(month)) throw new BadRequestException('month must be YYYY-MM');
    const c = await this.prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } });
    const tz = c?.timezone ?? null;
    const { from, to } = monthBounds(month);
    return {
      tz,
      start: localTimeToInstant(from, '00:00', tz),
      end: localTimeToInstant(addDays(to, 1), '00:00', tz),
    };
  }

  private async members(companyId: number): Promise<Member[]> {
    return this.prisma.user.findMany({
      where: { company_id: companyId, status: { not: 'suspended' }, role: { notIn: NOT_TRACKED as never } },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });
  }

  // ── units loading ────────────────────────────────────────────────────────
  private async opsUnits(companyId: number, kind: string, start: Date, end: Date) {
    const rows = await this.prisma.orderAttribution.groupBy({
      by: ['user_id'],
      where: { company_id: companyId, kind, at: { gte: start, lt: end } },
      _count: { _all: true },
      _sum: { value: true },
    });
    return new Map(rows.map((r) => [r.user_id, { count: r._count._all, value: Number(r._sum.value ?? 0) }]));
  }

  /** Earned − reversed orders per user for one sales plan. */
  private async orderUnits(companyId: number, cfg: PlanConfig, start: Date, end: Date) {
    const since = new Date(start.getTime() - LOOKBACK_DAYS * 86_400_000);
    const credit = await this.prisma.orderAttribution.findMany({
      where: { company_id: companyId, kind: cfg.creditTo, at: { gte: since, lt: end } },
      select: { order_gid: true, user_id: true, at: true, value: true, source: true },
    });
    const out = new Map<number, { count: number; value: number }>();
    if (!credit.length) return out;
    const gids = credit.map((c) => c.order_gid);

    const orders = new Map<string, { created: Date | null; cancelled: Date | null; manualConfirmed: Date | null; value: number | null }>();
    const ships = new Map<string, { delivered: Date | null; rtoAt: Date | null }>();
    const confirmedAt = new Map<string, Date>();
    const createdSource = new Map<string, string | null>();
    for (let i = 0; i < gids.length; i += CHUNK) {
      const part = gids.slice(i, i + CHUNK);
      const [os, ss, attrs, msgs] = await Promise.all([
        this.prisma.shopifyOrder.findMany({
          where: { company_id: companyId, shopify_order_gid: { in: part } },
          select: {
            shopify_order_gid: true, shopify_created_at: true, cancelled_at: true, manual_confirmed_at: true,
            subtotal_price: true, total_price: true, total_shipping: true, total_tax: true,
          },
        }),
        this.prisma.shipment.findMany({
          where: { company_id: companyId, shopify_order_gid: { in: part } },
          select: { shopify_order_gid: true, status: true, delivered_at: true, received_at: true, failed_at: true, cancelled_at: true, updated_at: true },
        }),
        this.prisma.orderAttribution.findMany({
          where: { company_id: companyId, order_gid: { in: part }, kind: { in: ['confirmed', 'created'] } },
          select: { order_gid: true, kind: true, at: true, source: true },
        }),
        cfg.earnOn === 'confirmed'
          ? this.prisma.shopifyOrderMessage.findMany({
              where: { company_id: companyId, shopify_order_gid: { in: part }, status: 'confirmed' },
              select: { shopify_order_gid: true, updated_at: true },
            })
          : Promise.resolve([] as { shopify_order_gid: string; updated_at: Date }[]),
      ]);
      for (const o of os) {
        const sub = o.subtotal_price != null ? Number(o.subtotal_price) : null;
        const total = o.total_price != null ? Number(o.total_price) : null;
        const value = sub ?? (total != null ? Math.max(0, total - Number(o.total_shipping ?? 0) - Number(o.total_tax ?? 0)) : null);
        orders.set(o.shopify_order_gid, { created: o.shopify_created_at, cancelled: o.cancelled_at, manualConfirmed: o.manual_confirmed_at, value });
      }
      for (const s of ss) {
        const rto = s.received_at != null || s.status === 'returned' || s.status === 'failed';
        ships.set(s.shopify_order_gid, {
          delivered: s.status === 'delivered' ? s.delivered_at ?? s.updated_at : null,
          rtoAt: rto ? s.failed_at ?? s.received_at ?? s.cancelled_at ?? s.updated_at : null,
        });
      }
      for (const a of attrs) {
        if (a.kind === 'confirmed') confirmedAt.set(a.order_gid, a.at);
        else createdSource.set(a.order_gid, a.source);
      }
      for (const m of msgs) if (!confirmedAt.has(m.shopify_order_gid)) confirmedAt.set(m.shopify_order_gid, m.updated_at);
    }

    for (const c of credit) {
      const o = orders.get(c.order_gid);
      const s = ships.get(c.order_gid);
      if (cfg.source !== 'any') {
        const src = createdSource.get(c.order_gid) ?? c.source ?? null;
        if (cfg.source === 'abandoned_cart' ? src !== 'abandoned_cart' : src === 'abandoned_cart') continue;
      }
      const earnAt =
        cfg.earnOn === 'placed'
          ? o?.created ?? (cfg.creditTo === 'created' ? c.at : null)
          : cfg.earnOn === 'confirmed'
            ? confirmedAt.get(c.order_gid) ?? o?.manualConfirmed ?? (cfg.creditTo === 'confirmed' ? c.at : null)
            : s?.delivered ?? null;
      if (!earnAt) continue;
      const reversals = [o?.cancelled ?? null, s?.rtoAt ?? null].filter((d): d is Date => !!d);
      const reversalAt = reversals.length ? new Date(Math.min(...reversals.map((d) => d.getTime()))) : null;
      const value = o?.value ?? (c.value != null ? Number(c.value) : 0);

      let sign = 0;
      if (earnAt >= start && earnAt < end) {
        // Taken back in the same month (or before it was earned) → never earned.
        if (!(cfg.reverse && reversalAt && reversalAt < end)) sign = 1;
      } else if (cfg.reverse && earnAt < start && reversalAt && reversalAt >= start && reversalAt < end && reversalAt >= earnAt) {
        sign = -1;
      }
      if (!sign) continue;
      const cur = out.get(c.user_id) ?? { count: 0, value: 0 };
      cur.count += sign;
      cur.value += sign * value;
      out.set(c.user_id, cur);
    }
    return out;
  }

  private async minutesWorked(companyId: number, month: string, ids: number[]) {
    const { from, to } = monthBounds(month);
    if (!ids.length) return new Map<number, number>();
    const rows = await this.prisma.attendanceRecord.findMany({
      where: {
        company_id: companyId,
        user_id: { in: ids },
        work_date: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) },
        check_in_at: { not: null },
        check_out_at: { not: null },
      },
      select: { user_id: true, check_in_at: true, check_out_at: true },
    });
    const m = new Map<number, number>();
    for (const r of rows) {
      const w = Math.max(0, Math.round((r.check_out_at!.getTime() - r.check_in_at!.getTime()) / 60000));
      m.set(r.user_id, (m.get(r.user_id) ?? 0) + w);
    }
    return m;
  }

  /** Run one plan (saved or draft) for a month. */
  private async runPlan(
    companyId: number,
    month: string,
    plan: { id: number; name: string; metric: Metric; config: PlanConfig; appliesTo: AppliesTo },
    ctx: { start: Date; end: Date; members: Member[]; minutes?: Map<number, number> },
  ): Promise<PlanStatement> {
    const eligible = ctx.members.filter((m) => appliesToUser(plan.appliesTo, m));
    const units =
      plan.metric === 'orders'
        ? await this.orderUnits(companyId, plan.config, ctx.start, ctx.end)
        : await this.opsUnits(companyId, OPS_KIND[plan.metric], ctx.start, ctx.end);
    const minutes =
      plan.config.calc.type === 'pool' && plan.config.calc.splitBy === 'hours'
        ? ctx.minutes ?? (await this.minutesWorked(companyId, month, eligible.map((m) => m.id)))
        : new Map<number, number>();
    const map = new Map<number, UserUnits>();
    for (const m of eligible) {
      const u = units.get(m.id);
      map.set(m.id, { count: u?.count ?? 0, value: Math.round((u?.value ?? 0) * 100) / 100, minutesWorked: minutes.get(m.id) ?? 0 });
    }
    const byId = new Map(eligible.map((m) => [m.id, m]));
    const rows = computePlan(plan.config, map)
      .map((r) => ({ ...r, name: byId.get(r.userId)?.name ?? 'Teammate', role: byId.get(r.userId)?.role ?? '' }))
      .sort((a, b) => b.amount - a.amount || b.units - a.units);
    return {
      planId: plan.id,
      planName: plan.name,
      metric: plan.metric,
      config: plan.config,
      rows,
      total: Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100,
    };
  }

  async statement(companyId: number, month: string, viewer?: { userId: number; role: string }) {
    const w = await this.window(companyId, month);
    const [plans, members] = await Promise.all([this.listPlans(companyId), this.members(companyId)]);
    const active = plans.filter((p) => p.active);
    const out: PlanStatement[] = [];
    for (const p of active) out.push(await this.runPlan(companyId, month, p, { ...w, members }));
    // HR managers never see admins' or their own earnings (owner manages those).
    if (viewer?.role === 'hr_manager') {
      for (const st of out) {
        st.rows = st.rows.filter((r) => r.role !== 'admin' && r.userId !== viewer.userId);
        st.total = Math.round(st.rows.reduce((t, r) => t + r.amount, 0) * 100) / 100;
      }
    }
    const perUser = new Map<number, { userId: number; name: string; role: string; total: number }>();
    for (const s of out) {
      for (const r of s.rows) {
        const cur = perUser.get(r.userId) ?? { userId: r.userId, name: r.name, role: r.role, total: 0 };
        cur.total = Math.round((cur.total + r.amount) * 100) / 100;
        perUser.set(r.userId, cur);
      }
    }
    return {
      month,
      plans: out,
      leaderboard: Array.from(perUser.values()).sort((a, b) => b.total - a.total),
      total: Math.round(out.reduce((s, p) => s + p.total, 0) * 100) / 100,
    };
  }

  async preview(companyId: number, dto: PreviewPlanDto) {
    if (!(METRICS as readonly string[]).includes(dto.metric)) throw new BadRequestException('Unknown metric');
    const metric = dto.metric as Metric;
    const month = dto.month && MONTH_RE.test(dto.month) ? dto.month : await this.lastMonth(companyId);
    const w = await this.window(companyId, month);
    const members = await this.members(companyId);
    const res = await this.runPlan(
      companyId,
      month,
      { id: 0, name: dto.name || 'Preview', metric, config: resolvePlanConfig(metric, dto.config), appliesTo: resolveAppliesTo(dto.appliesTo) },
      { ...w, members },
    );
    return { month, ...res };
  }

  private async lastMonth(companyId: number) {
    const c = await this.prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } });
    const today = localParts(new Date(), c?.timezone ?? null).dateStr;
    return addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
  }

  /** Per-user commission for payroll: Map<userId, {total, lines}>. */
  async forPayroll(companyId: number, month: string) {
    const plans = (await this.listPlans(companyId)).filter((p) => p.active);
    const out = new Map<number, { total: number; lines: { planId: number; planName: string; units: number; base: number; amount: number }[] }>();
    if (!plans.length) return out;
    const w = await this.window(companyId, month);
    const members = await this.members(companyId);
    for (const p of plans) {
      const s = await this.runPlan(companyId, month, p, { ...w, members });
      for (const r of s.rows) {
        if (!r.amount) continue;
        const cur = out.get(r.userId) ?? { total: 0, lines: [] };
        cur.lines.push({ planId: p.id, planName: p.name, units: r.units, base: r.units, amount: r.amount });
        cur.total = Math.round((cur.total + r.amount) * 100) / 100;
        out.set(r.userId, cur);
      }
    }
    return out;
  }

  /** A member's own earnings this month, per plan, with progress to the next tier/target. */
  async mine(companyId: number, user: { userId: number; role: string }, monthIn?: string) {
    const c = await this.prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } });
    const month = monthIn && MONTH_RE.test(monthIn) ? monthIn : localParts(new Date(), c?.timezone ?? null).dateStr.slice(0, 7);
    const w = await this.window(companyId, month);
    const me = await this.prisma.user.findFirst({ where: { id: user.userId, company_id: companyId }, select: { id: true, name: true, role: true } });
    if (!me) return { month, plans: [], total: 0 };
    const plans = (await this.listPlans(companyId)).filter((p) => p.active && appliesToUser(p.appliesTo, me));
    const members = await this.members(companyId);
    const out = [];
    for (const p of plans) {
      const s = await this.runPlan(companyId, month, p, { ...w, members });
      const row = s.rows.find((r) => r.userId === me.id);
      const x = row?.units ?? 0;
      let next: { at: number; label: string } | null = null;
      const calc = p.config.calc;
      if (calc.type === 'slab') {
        const t = calc.tiers.find((tier) => tier.from > x);
        if (t) next = { at: t.from, label: `${p.config.basis === 'value' ? `${t.rate}%` : t.rate} per unit` };
      } else if (calc.type === 'target_bonus') {
        const at = calc.repeat ? (Math.floor(x / calc.target) + 1) * calc.target : x < calc.target ? calc.target : 0;
        if (at) next = { at, label: `bonus ${calc.bonus}` };
      }
      out.push({
        planId: p.id,
        planName: p.name,
        metric: p.metric,
        basis: p.config.basis,
        units: x,
        amount: row?.amount ?? 0,
        detail: row?.detail ?? '',
        next,
        rank: row ? s.rows.findIndex((r) => r.userId === me.id) + 1 : null,
        of: s.rows.length,
      });
    }
    return { month, plans: out, total: Math.round(out.reduce((s, p) => s + p.amount, 0) * 100) / 100 };
  }

  // ── history backfill ─────────────────────────────────────────────────────
  private backfilling = new Set<number>();

  private async backfillIfEmpty(companyId: number) {
    const any = await this.prisma.orderAttribution.findFirst({ where: { company_id: companyId }, select: { id: true } });
    if (!any) await this.backfill(companyId).catch(() => undefined);
  }

  /**
   * Seed the ledger from what already exists: orders created by agents
   * (pending_order_hashes), confirmations (agent_activity), bookings
   * (shipments.created_by_user_id), dispatch (loadsheet batches) and return
   * receipts. Idempotent — the unique key skips rows already present.
   */
  async backfill(companyId: number) {
    if (this.backfilling.has(companyId)) return { started: false };
    this.backfilling.add(companyId);
    try {
      const run = (sql: string) => this.prisma.$executeRawUnsafe(sql, companyId);
      const created = await run(`
        INSERT IGNORE INTO order_attributions (company_id, order_gid, order_name, kind, user_id, source, value, at)
        SELECT poh.company_id, poh.order_gid, poh.order_name, 'created', poh.created_by_user_id, poh.source, poh.order_total, poh.created_at
          FROM pending_order_hashes poh
         WHERE poh.company_id = ? AND poh.created_by_user_id IS NOT NULL AND poh.order_gid IS NOT NULL AND poh.status = 'created'`).catch(
        async () =>
          // older schema without the raw source/order_total columns
          run(`
        INSERT IGNORE INTO order_attributions (company_id, order_gid, order_name, kind, user_id, at)
        SELECT poh.company_id, poh.order_gid, poh.order_name, 'created', poh.created_by_user_id, poh.created_at
          FROM pending_order_hashes poh
         WHERE poh.company_id = ? AND poh.created_by_user_id IS NOT NULL AND poh.order_gid IS NOT NULL`),
      );
      const confirmed = await run(`
        INSERT IGNORE INTO order_attributions (company_id, order_gid, order_name, kind, user_id, at)
        SELECT aa.company_id, aa.order_gid, MAX(aa.order_name), 'confirmed', MIN(aa.user_id), MIN(aa.created_at)
          FROM agent_activity aa
         WHERE aa.company_id = ? AND aa.action = 'order_confirmed' AND aa.order_gid IS NOT NULL
         GROUP BY aa.company_id, aa.order_gid`);
      const booked = await run(`
        INSERT IGNORE INTO order_attributions (company_id, order_gid, order_name, kind, user_id, at)
        SELECT s.company_id, s.shopify_order_gid, s.shopify_order_name, 'booked', s.created_by_user_id, COALESCE(s.booked_at, s.created_at)
          FROM shipments s
         WHERE s.company_id = ? AND s.created_by_user_id IS NOT NULL AND s.courier_type <> 'manual'`);
      const dispatched = await run(`
        INSERT IGNORE INTO order_attributions (company_id, order_gid, order_name, kind, user_id, at)
        SELECT s.company_id, s.shopify_order_gid, s.shopify_order_name, 'dispatched', lb.created_by_user_id, lb.created_at
          FROM shipments s JOIN loadsheet_batches lb ON lb.id = s.loadsheet_batch_id
         WHERE s.company_id = ? AND lb.created_by_user_id IS NOT NULL`);
      const received = await run(`
        INSERT IGNORE INTO order_attributions (company_id, order_gid, order_name, kind, user_id, at)
        SELECT s.company_id, s.shopify_order_gid, s.shopify_order_name, 'returned_received', s.received_by_user_id, s.received_at
          FROM shipments s
         WHERE s.company_id = ? AND s.received_by_user_id IS NOT NULL AND s.received_at IS NOT NULL`);
      this.log.log(`attribution backfill co=${companyId}: created=${created} confirmed=${confirmed} booked=${booked} dispatched=${dispatched} received=${received}`);
      return { started: true, created, confirmed, booked, dispatched, received };
    } finally {
      this.backfilling.delete(companyId);
    }
  }
}
