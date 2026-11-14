import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { PlatformRegistry } from '../platforms/platform-registry';
import { AdPlatformAuthError, AdPlatformRateLimitError } from '../platforms/ad-platform.types';
import { AttributionWindow, EntityLevel, EntityPatch } from '../platforms/ad-writer.types';
import { AdAccountsService } from './ad-accounts.service';
import { AdSyncService } from './ad-sync.service';
import { GrowthVersionService } from './growth-version.service';
import { GrowthMirrorService } from '../store/growth-mirror.service';
import { ymdCell } from '../store/growth-store';
import { fitResponse } from '../attribution/forecast-math';
import { addDays, n } from '../growth.util';

export type ChangeInput =
  | { kind: 'patch'; level: EntityLevel; entityId: string; patch: EntityPatch }
  | { kind: 'scale'; campaignId: string; pct: number };

interface Expanded {
  level: EntityLevel;
  entityId: string;
  patch: EntityPatch;
  /** Extra writes that must accompany this one (CBO bid amounts live on the ad sets). */
  children?: Array<{ entityId: string; patch: EntityPatch }>;
}

type EntityRow = Prisma.AdEntityGetPayload<object>;
type Actor = { companyId: number; userId: number | null };

const BUDGET_JUMP_WARN = 0.2;

/** Attribution spec JSON → our window id. */
function windowOf(spec: unknown): AttributionWindow | null {
  if (!Array.isArray(spec)) return null;
  const click = spec.find((s) => s?.event_type === 'CLICK_THROUGH')?.window_days;
  const view = spec.some((s) => s?.event_type === 'VIEW_THROUGH');
  if (click === 1) return '1d_click';
  if (click === 7 && view) return '7d_click_1d_view';
  if (click === 7) return '7d_click';
  return null;
}

/** The current value of every editable field, in EntityPatch shape (= undo payload). */
export function snapshotOf(e: EntityRow): EntityPatch {
  const num = (v: unknown) => (v == null ? null : Number(v));
  return {
    status: e.configured_status === 'ACTIVE' || e.configured_status === 'PAUSED' ? e.configured_status : undefined,
    name: e.name ?? undefined,
    ...(e.budget_owner === e.level && e.level !== 'ad'
      ? e.budget_type === 'lifetime'
        ? { lifetimeBudget: num(e.lifetime_budget) ?? undefined }
        : { dailyBudget: num(e.daily_budget) ?? undefined }
      : {}),
    bidStrategy: (e.bid_strategy as EntityPatch['bidStrategy']) ?? undefined,
    bidAmount: num(e.bid_amount),
    roasFloor: num(e.roas_floor),
    optimizationGoal: (e.optimization_goal as EntityPatch['optimizationGoal']) ?? undefined,
    conversionEvent: e.conversion_event ?? undefined,
    attributionWindow: windowOf(e.attribution_spec) ?? undefined,
    endTime: e.end_time ? e.end_time.toISOString() : null,
  };
}

/** Keep only the keys the change touches (before/after pairs in the log stay small). */
function pickKeys(src: EntityPatch, keys: Array<keyof EntityPatch>): EntityPatch {
  const out: EntityPatch = {};
  for (const k of keys) (out as Record<string, unknown>)[k] = (src as Record<string, unknown>)[k] ?? null;
  return out;
}

/**
 * Ad management — the ONLY path that changes anything on an ad platform.
 * preview → publish (one batch, logged) → undo. Created / duplicated objects are
 * paused on undo, never deleted.
 */
@Injectable()
export class AdManageService {
  private readonly logger = new Logger(AdManageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PlatformRegistry,
    private readonly accounts: AdAccountsService,
    private readonly sync: AdSyncService,
    private readonly version: GrowthVersionService,
    private readonly mirror: GrowthMirrorService,
  ) {}

  // ── access ────────────────────────────────────────────────────────────────
  async access(companyId: number) {
    const accs = await this.prisma.adAccount.findMany({ where: { company_id: companyId, status: 'active' } });
    const out = [];
    for (const a of accs) {
      if (!this.registry.canManage(a.platform)) {
        out.push({ accountId: a.id, platform: a.platform, name: a.name, canManage: false, missing: [], reason: 'Not available for this platform yet' });
        continue;
      }
      const token = await this.accounts.resolveToken(a);
      if (!token) {
        out.push({ accountId: a.id, platform: a.platform, name: a.name, canManage: false, missing: ['token'], reason: 'No token' });
        continue;
      }
      try {
        const r = await this.registry.writer(a.platform).checkWriteAccess(token);
        out.push({ accountId: a.id, platform: a.platform, name: a.name, canManage: r.ok, missing: r.missing, granted: r.granted, reason: r.ok ? null : `Missing ${r.missing.join(', ')}` });
      } catch (e) {
        out.push({ accountId: a.id, platform: a.platform, name: a.name, canManage: false, missing: [], reason: (e as Error).message });
      }
    }
    return out;
  }

  // ── lookups ───────────────────────────────────────────────────────────────
  private async entity(companyId: number, level: EntityLevel, id: string): Promise<EntityRow> {
    const e = await this.prisma.adEntity.findFirst({ where: { company_id: companyId, level, external_id: id } });
    if (!e) throw new NotFoundException(`That ${level === 'adset' ? 'ad set' : level} was not found — refresh and try again.`);
    return e;
  }

  private async children(companyId: number, campaignId: string) {
    return this.prisma.adEntity.findMany({ where: { company_id: companyId, level: 'adset', parent_external_id: campaignId } });
  }

  /** Expand a scale change into budget patches on whichever level owns the budget. */
  private async expand(companyId: number, changes: ChangeInput[]): Promise<Expanded[]> {
    const out: Expanded[] = [];
    for (const c of changes) {
      if (c.kind === 'patch') {
        out.push({ level: c.level, entityId: c.entityId, patch: c.patch });
        continue;
      }
      if (!Number.isFinite(c.pct) || c.pct <= -95 || c.pct > 500) throw new BadRequestException('Scale between −95% and +500%.');
      const camp = await this.entity(companyId, 'campaign', c.campaignId);
      const f = 1 + c.pct / 100;
      const scaled = (v: unknown) => Math.max(1, Math.round((Number(v) * f) / 10) * 10);
      if (camp.budget_owner === 'campaign') {
        out.push({
          level: 'campaign',
          entityId: camp.external_id,
          patch: camp.budget_type === 'lifetime' ? { lifetimeBudget: scaled(camp.lifetime_budget) } : { dailyBudget: scaled(camp.daily_budget) },
        });
      } else {
        for (const s of await this.children(companyId, camp.external_id)) {
          if (s.configured_status !== 'ACTIVE' || (s.daily_budget == null && s.lifetime_budget == null)) continue;
          out.push({
            level: 'adset',
            entityId: s.external_id,
            patch: s.budget_type === 'lifetime' ? { lifetimeBudget: scaled(s.lifetime_budget) } : { dailyBudget: scaled(s.daily_budget) },
          });
        }
      }
    }
    return out;
  }

  /** Mirror Meta's rules so we fail fast with a clear message. */
  private async validate(companyId: number, x: Expanded, e: EntityRow): Promise<void> {
    const p = x.patch;
    const what = e.name ?? x.entityId;
    const owns = e.budget_owner === e.level;
    if ((p.dailyBudget != null || p.lifetimeBudget != null) && !owns) {
      throw new BadRequestException(`“${what}”: the budget is set on the ${e.level === 'adset' ? 'campaign (Advantage+ campaign budget)' : 'ad sets'}.`);
    }
    if (p.dailyBudget != null && e.budget_type === 'lifetime') throw new BadRequestException(`“${what}” uses a lifetime budget.`);
    if (p.lifetimeBudget != null && e.budget_type === 'daily') throw new BadRequestException(`“${what}” uses a daily budget.`);
    for (const v of [p.dailyBudget, p.lifetimeBudget]) {
      if (v != null && (!Number.isFinite(v) || v <= 0 || v > 1e9)) throw new BadRequestException('Enter a budget greater than zero.');
    }
    if (p.bidStrategy && !owns) throw new BadRequestException(`“${what}”: the bid strategy is set where the budget is.`);
    if ((p.optimizationGoal || p.conversionEvent || p.attributionWindow) && e.level !== 'adset') {
      throw new BadRequestException('Performance goal, conversion event and attribution are ad set settings.');
    }
    const strategy = p.bidStrategy ?? (e.bid_strategy as EntityPatch['bidStrategy']);
    if (strategy === 'LOWEST_COST_WITH_MIN_ROAS') {
      const goals =
        e.level === 'adset'
          ? [p.optimizationGoal ?? e.optimization_goal]
          : (await this.children(companyId, e.external_id)).map((s) => s.optimization_goal);
      if (goals.some((g) => g !== 'VALUE')) throw new BadRequestException('A ROAS goal needs “Maximise value of conversions” on every ad set.');
      if (p.bidStrategy && p.roasFloor == null && e.roas_floor == null) throw new BadRequestException('Enter the ROAS goal.');
    }
    if ((p.bidStrategy === 'COST_CAP' || p.bidStrategy === 'LOWEST_COST_WITH_BID_CAP') && p.bidAmount == null && e.bid_amount == null) {
      throw new BadRequestException('Enter the cost goal / bid cap amount.');
    }
    if (p.name != null && (!p.name.trim() || p.name.length > 400)) throw new BadRequestException('Names must be 1–400 characters.');
  }

  // ── preview ───────────────────────────────────────────────────────────────
  async preview(companyId: number, changes: ChangeInput[]) {
    const items = await this.expand(companyId, changes);
    const out = [];
    for (const x of items) {
      const e = await this.entity(companyId, x.level, x.entityId);
      let error: string | null = null;
      try {
        await this.validate(companyId, x, e);
      } catch (err) {
        error = (err as Error).message;
      }
      const before = pickKeys(snapshotOf(e), Object.keys(x.patch) as Array<keyof EntityPatch>);
      out.push({
        level: x.level,
        entityId: x.entityId,
        entityName: e.name,
        before,
        after: x.patch,
        error,
        ...(await this.impact(companyId, e, x.patch)),
      });
    }
    return { items: out };
  }

  /** Spend Δ, expected-net Δ (response curve) and guard-rail warnings for one change. */
  private async impact(companyId: number, e: EntityRow, p: EntityPatch) {
    const warnings: string[] = [];
    const stats = await this.entityStats(companyId, e);
    let spendDeltaMonthly: number | null = null;
    let expectedNetDeltaMonthly: number | null = null;
    let roasAfter: number | null = null;
    const oldDaily = e.daily_budget != null ? Number(e.daily_budget) : null;
    if (p.dailyBudget != null && oldDaily) {
      const delta = p.dailyBudget - oldDaily;
      spendDeltaMonthly = delta * 30;
      const ratio = Math.abs(delta) / oldDaily;
      if (ratio > BUDGET_JUMP_WARN) {
        warnings.push(`A ${Math.round(ratio * 100)}% change can send it back into Meta's learning phase. Changes of ~20% every 2–3 days keep delivery steady.`);
      }
      if (stats.curve && stats.dailySpend > 0) {
        const { a, b } = stats.curve;
        // The response curve is fitted on the CAMPAIGN; any budget delta moves its daily spend.
        const base = stats.dailySpend;
        const next = Math.max(0, base + delta);
        expectedNetDeltaMonthly = (a * Math.pow(next, b) - a * Math.pow(base, b)) * 30;
        roasAfter = next > 0 ? (a * Math.pow(next, b)) / next : null;
      }
    }
    if (p.bidStrategy === 'COST_CAP' && p.bidAmount != null && stats.platformCpa && p.bidAmount < stats.platformCpa * 0.8) {
      warnings.push(
        `This cost goal is ${Math.round((1 - p.bidAmount / stats.platformCpa) * 100)}% below its recent cost per purchase in Meta (${Math.round(stats.platformCpa).toLocaleString()}). Expect limited delivery; around ${Math.round(stats.platformCpa * 0.95).toLocaleString()} is realistic.`,
      );
    }
    if (p.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS' && p.roasFloor != null && stats.platformRoas && p.roasFloor > stats.platformRoas * 1.15) {
      warnings.push(`A ${p.roasFloor.toFixed(2)}× goal is above the ${stats.platformRoas.toFixed(2)}× Meta has achieved here recently — delivery will be limited.`);
    }
    if (p.status === 'ACTIVE') warnings.push('Turning it on starts spending right away.');
    return { spendDeltaMonthly, expectedNetDeltaMonthly, roasAfter, warnings, stats: { platformCpa: stats.platformCpa, platformRoas: stats.platformRoas } };
  }

  /** Last-30-day platform CPA/ROAS + the campaign's spend→expected-net curve (60 days). */
  async entityStats(companyId: number, e: EntityRow) {
    const col = e.level === 'campaign' ? 'campaign_id' : e.level === 'adset' ? 'adset_id' : 'ad_id';
    const to = new Date().toISOString().slice(0, 10);
    const [row] = await this.prisma.$queryRawUnsafe<Array<{ s: unknown; p: unknown; v: unknown }>>(
      `SELECT SUM(spend_base) s, SUM(purchases) p, SUM(purchase_value_base) v FROM ad_insights_daily
        WHERE company_id = ? AND ${col} = ? AND date >= ?`,
      companyId,
      e.external_id,
      addDays(to, -30),
    );
    const spend30 = n(row?.s);
    const platformCpa = n(row?.p) > 0 ? spend30 / n(row?.p) : null;
    const platformRoas = spend30 > 0 ? n(row?.v) / spend30 : null;
    const campaignId = e.campaign_id ?? e.external_id;
    const base = { co: ['Int32', companyId] as ['Int32', number], c: ['String', campaignId] as ['String', string], from: ['Date', addDays(to, -60)] as ['Date', string], to: ['Date', addDays(to, -1)] as ['Date', string] };
    const [sp, rv] = await Promise.all([
      this.mirror.query(companyId, 'SELECT date d, SUM(spend_base) s FROM {ins} WHERE company_id = :co AND campaign_id = :c AND date >= :from AND date <= :to GROUP BY date', base),
      this.mirror.query(companyId, "SELECT order_date d, SUM(expected_net) v FROM {attr} WHERE company_id = :co AND campaign_id = :c AND model = 'last' AND win = 7 AND order_date >= :from AND order_date <= :to GROUP BY order_date", base),
    ]);
    const byDay = new Map<string, [number, number]>();
    for (const r of sp) byDay.set(ymdCell(r.d), [n(r.s), 0]);
    for (const r of rv) {
      const k = ymdCell(r.d);
      const cur = byDay.get(k) ?? [0, 0];
      cur[1] += n(r.v);
      byDay.set(k, cur);
    }
    const pts = [...byDay.values()];
    const last14 = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-14).map(([, v]) => v[0]);
    const dailySpend = last14.length ? last14.reduce((a, b) => a + b, 0) / last14.length : 0;
    const curve = pts.length >= 7 ? fitResponse(pts) : null;
    return { platformCpa, platformRoas, dailySpend, curve };
  }

  // ── publish ───────────────────────────────────────────────────────────────
  async publish(actor: Actor, changes: ChangeInput[]) {
    const items = await this.expand(actor.companyId, changes);
    if (!items.length) throw new BadRequestException('Nothing to publish.');
    if (items.length > 50) throw new BadRequestException('Publish at most 50 changes at once.');
    const rows: Array<{ x: Expanded; e: EntityRow }> = [];
    for (const x of items) {
      const e = await this.entity(actor.companyId, x.level, x.entityId);
      await this.validate(actor.companyId, x, e);
      // CBO + cost/ROAS goal: the amount is set on each ad set.
      if (x.level === 'campaign' && (x.patch.bidAmount != null || x.patch.roasFloor != null)) {
        const kids = await this.children(actor.companyId, e.external_id);
        x.children = kids.map((k) => ({
          entityId: k.external_id,
          patch: { ...(x.patch.bidAmount != null ? { bidAmount: x.patch.bidAmount } : {}), ...(x.patch.roasFloor != null ? { roasFloor: x.patch.roasFloor } : {}) },
        }));
        x.patch = { ...x.patch, bidAmount: undefined, roasFloor: undefined };
      }
      rows.push({ x, e });
    }
    const batchId = randomUUID();
    const userName = await this.userName(actor.userId);
    const results = [];
    const touchedAccounts = new Set<number>();
    for (const { x, e } of rows) {
      const before = pickKeys(snapshotOf(e), Object.keys(x.patch).filter((k) => (x.patch as Record<string, unknown>)[k] !== undefined) as Array<keyof EntityPatch>);
      const log = await this.prisma.adChangeLog.create({
        data: {
          company_id: actor.companyId,
          account_id: e.account_id,
          user_id: actor.userId,
          user_name: userName,
          platform: e.platform,
          level: x.level,
          entity_id: x.entityId,
          entity_name: e.name,
          action: this.actionOf(x.patch),
          before: before as Prisma.InputJsonValue,
          after: x.patch as Prisma.InputJsonValue,
          batch_id: batchId,
        },
      });
      try {
        await this.apply(e, x.level, x.patch);
        for (const ch of x.children ?? []) {
          const ce = await this.entity(actor.companyId, 'adset', ch.entityId);
          await this.apply(ce, 'adset', ch.patch);
        }
        await this.prisma.adChangeLog.update({ where: { id: log.id }, data: { result: 'ok' } });
        results.push({ logId: log.id, entityId: x.entityId, entityName: e.name, ok: true });
        touchedAccounts.add(e.account_id);
      } catch (err) {
        const msg = this.messageOf(err);
        await this.prisma.adChangeLog.update({ where: { id: log.id }, data: { result: 'failed', error: msg.slice(0, 1000) } });
        results.push({ logId: log.id, entityId: x.entityId, entityName: e.name, ok: false, error: msg });
      }
    }
    this.version.bump(actor.companyId, 'spend');
    for (const a of touchedAccounts) void this.sync.refreshEntities(a);
    return { batchId, results, ok: results.every((r) => r.ok) };
  }

  /** Write to the platform, then mirror the new values locally right away. */
  private async apply(e: EntityRow, level: EntityLevel, patch: EntityPatch) {
    const acc = await this.prisma.adAccount.findUnique({ where: { id: e.account_id } });
    if (!acc) throw new NotFoundException('Ad account not found');
    const token = await this.accounts.resolveToken(acc);
    if (!token) throw new AdPlatformAuthError('No token for this ad account. Reconnect it in Connections.', 'token');
    await this.registry.writer(acc.platform).update(token, level, e.external_id, patch, acc.currency);
    const d: Prisma.AdEntityUpdateInput = { updated_at: new Date() };
    if (patch.status) {
      d.configured_status = patch.status;
      d.status = patch.status === 'PAUSED' ? 'PAUSED' : e.status === 'PAUSED' || e.status === 'CAMPAIGN_PAUSED' || e.status === 'ADSET_PAUSED' ? 'ACTIVE' : e.status;
    }
    if (patch.name != null) d.name = patch.name.trim().slice(0, 512);
    if (patch.dailyBudget != null) d.daily_budget = patch.dailyBudget;
    if (patch.lifetimeBudget != null) d.lifetime_budget = patch.lifetimeBudget;
    if (patch.bidStrategy) d.bid_strategy = patch.bidStrategy;
    if (patch.bidAmount !== undefined) d.bid_amount = patch.bidAmount;
    if (patch.roasFloor !== undefined) d.roas_floor = patch.roasFloor;
    if (patch.optimizationGoal) d.optimization_goal = patch.optimizationGoal;
    if (patch.conversionEvent) d.conversion_event = patch.conversionEvent;
    if (patch.endTime !== undefined) d.end_time = patch.endTime ? new Date(patch.endTime) : null;
    await this.prisma.adEntity.update({ where: { id: e.id }, data: d });
  }

  private actionOf(p: EntityPatch): string {
    if (p.status) return p.status === 'PAUSED' ? 'pause' : 'resume';
    if (p.dailyBudget != null || p.lifetimeBudget != null) return 'budget';
    if (p.bidStrategy || p.bidAmount != null || p.roasFloor != null) return 'bid';
    if (p.optimizationGoal || p.conversionEvent || p.attributionWindow) return 'optimization';
    if (p.name != null) return 'rename';
    if (p.endTime !== undefined) return 'schedule';
    return 'edit';
  }

  private messageOf(err: unknown): string {
    if (err instanceof AdPlatformAuthError || err instanceof AdPlatformRateLimitError) return err.message;
    return (err as Error)?.message ?? 'The change failed.';
  }

  private async userName(userId: number | null) {
    if (!userId) return null;
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    return u?.name ?? null;
  }

  // ── duplicate ─────────────────────────────────────────────────────────────
  async duplicate(actor: Actor, level: EntityLevel, entityId: string) {
    const e = await this.entity(actor.companyId, level, entityId);
    const acc = await this.prisma.adAccount.findUnique({ where: { id: e.account_id } });
    const token = acc ? await this.accounts.resolveToken(acc) : null;
    if (!acc || !token) throw new BadRequestException('No token for this ad account.');
    const batchId = randomUUID();
    const log = await this.prisma.adChangeLog.create({
      data: {
        company_id: actor.companyId, account_id: acc.id, user_id: actor.userId, user_name: await this.userName(actor.userId),
        platform: acc.platform, level, entity_id: entityId, entity_name: e.name, action: 'duplicate',
        before: Prisma.JsonNull, after: {}, batch_id: batchId,
      },
    });
    try {
      const newId = await this.registry.writer(acc.platform).copy(token, level, entityId);
      await this.prisma.adChangeLog.update({ where: { id: log.id }, data: { result: 'ok', after: { newIds: [newId], level, paused: true } } });
      void this.sync.refreshEntities(acc.id);
      return { newId, logId: log.id };
    } catch (err) {
      const msg = this.messageOf(err);
      await this.prisma.adChangeLog.update({ where: { id: log.id }, data: { result: 'failed', error: msg.slice(0, 1000) } });
      throw new BadRequestException(msg);
    }
  }

  // ── log + undo ────────────────────────────────────────────────────────────
  async log(companyId: number, opts: { entityId?: string; limit?: number }) {
    const rows = await this.prisma.adChangeLog.findMany({
      where: { company_id: companyId, ...(opts.entityId ? { entity_id: opts.entityId } : {}) },
      orderBy: { id: 'desc' },
      take: Math.min(200, opts.limit ?? 100),
    });
    return rows.map((r) => ({
      id: r.id,
      batchId: r.batch_id,
      action: r.action,
      level: r.level,
      entityId: r.entity_id,
      entityName: r.entity_name,
      userName: r.user_name,
      before: r.before,
      after: r.after,
      result: r.result,
      error: r.error,
      undoOfId: r.undo_of_id,
      undoneAt: r.undone_at,
      createdAt: r.created_at,
      canUndo: r.result === 'ok' && !r.undone_at && r.action !== 'undo',
    }));
  }

  async undo(actor: Actor, target: { logId?: number; batchId?: string }) {
    const where: Prisma.AdChangeLogWhereInput = { company_id: actor.companyId, result: 'ok', undone_at: null, action: { not: 'undo' } };
    if (target.logId) where.id = target.logId;
    else if (target.batchId) where.batch_id = target.batchId;
    else throw new BadRequestException('Nothing to undo.');
    const rows = await this.prisma.adChangeLog.findMany({ where, orderBy: { id: 'desc' } });
    if (!rows.length) throw new BadRequestException('Already undone, or nothing to undo.');
    const batchId = randomUUID();
    const results = [];
    for (const r of rows) {
      try {
        if (r.action === 'duplicate' || r.action === 'create') {
          // Never delete: pause what was created.
          const after = (r.after ?? {}) as { newIds?: string[]; level?: EntityLevel; campaignId?: string };
          const acc = await this.prisma.adAccount.findUnique({ where: { id: r.account_id } });
          const token = acc ? await this.accounts.resolveToken(acc) : null;
          if (!acc || !token) throw new Error('No token for this ad account.');
          const ids = after.campaignId ? [after.campaignId] : after.newIds ?? [];
          const level: EntityLevel = after.campaignId ? 'campaign' : after.level ?? (r.level as EntityLevel);
          for (const id of ids) await this.registry.writer(acc.platform).update(token, level, id, { status: 'PAUSED' }, acc.currency);
        } else {
          const e = await this.entity(actor.companyId, r.level as EntityLevel, r.entity_id);
          const before = (r.before ?? {}) as EntityPatch;
          const patch: EntityPatch = {};
          for (const [k, v] of Object.entries(before)) if (v !== null && v !== undefined) (patch as Record<string, unknown>)[k] = v;
          if (Object.keys(patch).length) await this.apply(e, r.level as EntityLevel, patch);
        }
        await this.prisma.adChangeLog.update({ where: { id: r.id }, data: { undone_at: new Date() } });
        await this.prisma.adChangeLog.create({
          data: {
            company_id: actor.companyId, account_id: r.account_id, user_id: actor.userId, user_name: await this.userName(actor.userId),
            platform: r.platform, level: r.level, entity_id: r.entity_id, entity_name: r.entity_name, action: 'undo',
            before: r.after ?? Prisma.JsonNull, after: r.before ?? Prisma.JsonNull, batch_id: batchId, result: 'ok', undo_of_id: r.id,
          },
        });
        results.push({ logId: r.id, ok: true });
      } catch (err) {
        results.push({ logId: r.id, ok: false, error: this.messageOf(err) });
      }
    }
    this.version.bump(actor.companyId, 'spend');
    for (const a of new Set(rows.map((r) => r.account_id))) void this.sync.refreshEntities(a);
    return { results, ok: results.every((r) => r.ok) };
  }

  /** Settings of one entity for the inspector (+ its children's goals for CBO checks). */
  async settings(companyId: number, level: EntityLevel, entityId: string) {
    const e = await this.entity(companyId, level, entityId);
    const kids = level === 'campaign' ? await this.children(companyId, e.external_id) : [];
    const stats = await this.entityStats(companyId, e);
    return {
      level,
      entityId,
      name: e.name,
      platform: e.platform,
      accountId: e.account_id,
      snapshot: snapshotOf(e),
      status: e.status,
      objective: e.objective,
      budgetOwner: e.budget_owner,
      budgetType: e.budget_type,
      destinationType: e.destination_type,
      campaignId: e.campaign_id,
      childGoals: kids.map((k) => ({ id: k.external_id, name: k.name, optimizationGoal: k.optimization_goal })),
      stats: { platformCpa: stats.platformCpa, platformRoas: stats.platformRoas, dailySpend: stats.dailySpend },
    };
  }
}
