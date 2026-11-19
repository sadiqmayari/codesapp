import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingService } from '../../common/services/platform-setting.service';
import { CacheService } from '../../common/services/cache.service';
import {
  AI_DEFAULT_CAP_KEY,
  AI_FALLBACK_PROVIDER_KEY,
  AI_KILL_SWITCH_KEY,
  AI_MODEL_KEY,
  AI_PRICE_MULTIPLIER_KEY,
  AI_PROVIDER_KEY,
  AiProviderName,
  DEFAULT_TIER_MODELS,
  MODEL_CATALOG,
  ModelTier,
} from '../ai/ai.constants';
import { LlmService } from '../ai/llm.service';
import { AiMeteringService } from '../ai/ai-metering.service';
import { AiProfileService } from '../ai/ai-profile.service';
import { PromptRegistryService, PROMPT_KEYS } from '../ai/prompt-registry.service';
import { INDUSTRIES, Industry } from '../ai/agent/packs';
import { resolveProfile } from '../ai/agent/profile';
import { AgentRuntimeService } from './agent-runtime.service';
import { TurnState } from './skills';
import { EVAL_CASES } from './evals';
import { emptyMemory, parseMemory } from './memory';
import { PROMPT_VERSION } from './prompt';

const period = () => new Date().toISOString().slice(0, 7);

/**
 * Super-admin AI Control Center: platform switches + models + pricing,
 * per-tenant overrides, cost explorer, quality (feedback / grounding /
 * shadow / evals), prompt overrides. Every write is audit-logged.
 */
@Injectable()
export class SuperAdminAiService {
  private readonly logger = new Logger(SuperAdminAiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingService,
    private readonly cache: CacheService,
    private readonly llm: LlmService,
    private readonly metering: AiMeteringService,
    private readonly profiles: AiProfileService,
    private readonly prompts: PromptRegistryService,
    private readonly runtime: AgentRuntimeService,
  ) {}

  private async audit(actorId: number | null, action: string, entityId: number | null, metadata: unknown) {
    await this.prisma.auditLog
      .create({
        data: {
          user_id: actorId,
          company_id: null,
          action,
          entity: 'ai',
          entity_id: entityId,
          metadata: metadata as Prisma.InputJsonValue,
        },
      })
      .catch((e: Error) => this.logger.warn(`audit failed: ${e.message}`));
  }

  // ── Platform ──────────────────────────────────────────────────────────

  async platform() {
    const g = (k: string, d: string) => this.settings.get(k, d);
    const models: Record<AiProviderName, Record<ModelTier, string>> = {
      anthropic: {
        fast: await g(AI_MODEL_KEY('anthropic', 'fast'), DEFAULT_TIER_MODELS.anthropic.fast),
        smart: await g(AI_MODEL_KEY('anthropic', 'smart'), DEFAULT_TIER_MODELS.anthropic.smart),
      },
      openai: {
        fast: await g(AI_MODEL_KEY('openai', 'fast'), DEFAULT_TIER_MODELS.openai.fast),
        smart: await g(AI_MODEL_KEY('openai', 'smart'), DEFAULT_TIER_MODELS.openai.smart),
      },
    };
    return {
      enabled: (await g(AI_KILL_SWITCH_KEY, 'on')) !== 'off',
      provider: await g(AI_PROVIDER_KEY, 'anthropic'),
      fallbackProvider: await g(AI_FALLBACK_PROVIDER_KEY, 'none'),
      autonomousTier: await this.settings.getAutonomousTier(),
      models,
      defaults: DEFAULT_TIER_MODELS,
      catalog: MODEL_CATALOG.map((m) => ({
        id: m.id,
        provider: m.provider,
        label: m.label,
        inUsdPerMTok: m.inMicros,
        outUsdPerMTok: m.outMicros,
      })),
      multiplier: await this.metering.getMultiplier(),
      defaultCapCents: await this.metering.getDefaultCapCents(),
      configured: this.llm.configuredProviders(),
      promptVersion: PROMPT_VERSION,
    };
  }

  async updatePlatform(
    actorId: number | null,
    b: {
      enabled?: boolean;
      provider?: string;
      fallbackProvider?: string;
      autonomousTier?: string;
      models?: Partial<Record<AiProviderName, Partial<Record<ModelTier, string>>>>;
      multiplier?: number;
      defaultCapCents?: number;
    },
  ) {
    const changes: Record<string, unknown> = {};
    if (typeof b.enabled === 'boolean') {
      await this.settings.set(AI_KILL_SWITCH_KEY, b.enabled ? 'on' : 'off');
      changes.enabled = b.enabled;
    }
    if (b.provider === 'anthropic' || b.provider === 'openai') {
      await this.settings.set(AI_PROVIDER_KEY, b.provider);
      changes.provider = b.provider;
    }
    if (b.fallbackProvider && ['none', 'anthropic', 'openai'].includes(b.fallbackProvider)) {
      await this.settings.set(AI_FALLBACK_PROVIDER_KEY, b.fallbackProvider);
      changes.fallbackProvider = b.fallbackProvider;
    }
    if (b.autonomousTier === 'fast' || b.autonomousTier === 'smart') {
      await this.settings.setAutonomousTier(b.autonomousTier);
      changes.autonomousTier = b.autonomousTier;
    }
    for (const p of ['anthropic', 'openai'] as AiProviderName[]) {
      for (const t of ['fast', 'smart'] as ModelTier[]) {
        const id = b.models?.[p]?.[t];
        if (typeof id === 'string' && /^[a-z0-9][a-z0-9._:-]{1,80}$/i.test(id.trim())) {
          await this.settings.set(AI_MODEL_KEY(p, t), id.trim());
          changes[`model.${p}.${t}`] = id.trim();
        }
      }
    }
    if (typeof b.multiplier === 'number') {
      if (!(b.multiplier >= 1 && b.multiplier <= 10)) throw new BadRequestException('Multiplier must be 1–10');
      await this.settings.set(AI_PRICE_MULTIPLIER_KEY, String(b.multiplier));
      changes.multiplier = b.multiplier;
    }
    if (typeof b.defaultCapCents === 'number') {
      if (!(b.defaultCapCents >= 0 && b.defaultCapCents <= 10_000_000)) throw new BadRequestException('Invalid cap');
      await this.settings.set(AI_DEFAULT_CAP_KEY, String(Math.floor(b.defaultCapCents)));
      changes.defaultCapCents = b.defaultCapCents;
    }
    await this.audit(actorId, 'super_admin.ai.platform', null, changes);
    return this.platform();
  }

  // ── Tenants ───────────────────────────────────────────────────────────

  async tenants() {
    const p = period();
    const since = new Date(Date.now() - 30 * 86400000);
    const [companies, usage, profiles, handoffs, fb, replies, errors] = await Promise.all([
      this.prisma.company.findMany({
        select: {
          activation_status: true,
          id: true,
          company_name: true,
          ai_enabled: true,
          ai_admin_disabled: true,
          ai_admin_cap_cents: true,
          ai_monthly_cap_cents: true,
          ai_autoreply_enabled: true,
          ai_autonomous_tier: true,
          ai_premium_locked: true,
          subscription: { select: { ai_enabled: true, plan_name: true } },
        },
        orderBy: { id: 'asc' },
      }),
      this.prisma.usageMetering.findMany({
        where: { period: p },
        select: { company_id: true, ai_requests: true, ai_cost_micros: true },
      }),
      this.prisma.aiAgentProfile.findMany({ select: { company_id: true, industry: true, engine: true } }),
      this.prisma.event.groupBy({
        by: ['company_id'],
        where: { type: 'conversation.handoff', actor_type: 'AI', created_at: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.aiFeedback.groupBy({
        by: ['company_id', 'rating'],
        where: { created_at: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.message.groupBy({
        by: ['company_id'],
        where: { sent_by_ai: true, created_at: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.event.groupBy({
        by: ['company_id'],
        where: { type: 'tool.failed', created_at: { gte: since } },
        _count: { _all: true },
      }),
    ]);
    const multiplier = await this.metering.getMultiplier();
    const defaultCap = await this.metering.getDefaultCapCents();
    return companies.map((c) => {
      const u = usage.find((x) => x.company_id === c.id);
      const pr = profiles.find((x) => x.company_id === c.id);
      const cost = Number(u?.ai_cost_micros ?? 0n);
      const up = fb.find((f) => f.company_id === c.id && f.rating === 1)?._count._all ?? 0;
      const down = fb.find((f) => f.company_id === c.id && f.rating === -1)?._count._all ?? 0;
      const rep = replies.find((r) => r.company_id === c.id)?._count._all ?? 0;
      const ho = handoffs.find((h) => h.company_id === c.id)?._count._all ?? 0;
      return {
        id: c.id,
        name: c.company_name,
        plan: c.subscription?.plan_name ?? null,
        status: c.activation_status,
        planAi: !!c.subscription?.ai_enabled,
        tenantAi: c.ai_enabled,
        adminDisabled: c.ai_admin_disabled,
        adminCapCents: c.ai_admin_cap_cents,
        tenantCapCents: c.ai_monthly_cap_cents,
        defaultCapCents: defaultCap,
        autoReplyAll: c.ai_autoreply_enabled,
        tier: c.ai_autonomous_tier,
        premiumLocked: c.ai_premium_locked,
        industry: pr?.industry ?? 'ecommerce',
        engine: pr?.engine ?? 'v2',
        requests: u?.ai_requests ?? 0,
        costUsd: Math.round(cost / 10000) / 100,
        billedUsd: Math.round((cost * multiplier) / 10000) / 100,
        aiReplies30d: rep,
        handoffs30d: ho,
        handoffPct: rep ? Math.round((ho / rep) * 100) : null,
        downPct: up + down ? Math.round((down / (up + down)) * 100) : null,
        toolFailures30d: errors.find((e) => e.company_id === c.id)?._count._all ?? 0,
      };
    });
  }

  async updateTenant(
    actorId: number | null,
    companyId: number,
    b: { adminDisabled?: boolean; adminCapCents?: number | null; engine?: string; premiumLocked?: boolean; industry?: string },
  ) {
    const co = await this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
    if (!co) throw new NotFoundException('Client not found');
    const data: Prisma.CompanyUpdateInput = {};
    if (typeof b.adminDisabled === 'boolean') data.ai_admin_disabled = b.adminDisabled;
    if (b.adminCapCents === null) data.ai_admin_cap_cents = null;
    else if (typeof b.adminCapCents === 'number' && b.adminCapCents >= 0) data.ai_admin_cap_cents = Math.floor(b.adminCapCents);
    if (typeof b.premiumLocked === 'boolean') data.ai_premium_locked = b.premiumLocked;
    if (Object.keys(data).length) await this.prisma.company.update({ where: { id: companyId }, data });
    if (b.engine && ['v1', 'shadow', 'v2'].includes(b.engine)) {
      await this.profiles.save(companyId, { engine: b.engine });
      // A fresh brain must not inherit shadow-mode memory.
      if (b.engine === 'v2') {
        await this.prisma.conversation.updateMany({
          where: { company_id: companyId, ai_memory: { not: Prisma.DbNull } },
          data: { ai_memory: Prisma.DbNull },
        });
      }
    }
    if (b.industry && INDUSTRIES.includes(b.industry as Industry)) {
      await this.profiles.save(companyId, { industry: b.industry });
    }
    this.cache.del(this.cache.subscriptionKey(companyId));
    this.profiles.invalidate(companyId);
    await this.audit(actorId, 'super_admin.ai.tenant', companyId, b);
    return { ok: true };
  }

  // ── Costs ─────────────────────────────────────────────────────────────

  async costs(months: number) {
    const from = new Date();
    from.setUTCMonth(from.getUTCMonth() - Math.max(0, months - 1), 1);
    from.setUTCHours(0, 0, 0, 0);
    const rows = await this.prisma.$queryRaw<
      Array<{ company_id: number; period: string; feature: string; model: string; calls: bigint; micros: unknown; billed: unknown }>
    >`SELECT company_id, period, feature, model, COUNT(*) AS calls, SUM(cost_micros) AS micros,
             SUM(cost_micros * COALESCE(multiplier_x1000, 1500) / 1000) AS billed
        FROM ai_usage_log WHERE created_at >= ${from}
        GROUP BY company_id, period, feature, model`;
    const names = await this.prisma.company.findMany({ select: { id: true, company_name: true } });
    const nm = new Map(names.map((n) => [n.id, n.company_name]));
    return rows.map((r) => ({
      companyId: r.company_id,
      company: nm.get(r.company_id) ?? `#${r.company_id}`,
      period: r.period,
      feature: r.feature,
      model: r.model,
      calls: Number(r.calls),
      costUsd: Math.round(Number(r.micros ?? 0) / 10000) / 100,
      billedUsd: Math.round(Number(r.billed ?? 0) / 10000) / 100,
    }));
  }

  // ── Quality ───────────────────────────────────────────────────────────

  async quality() {
    const since = new Date(Date.now() - 30 * 86400000);
    const [ungrounded, failures, down, shadow, v2Replies, evals] = await Promise.all([
      this.prisma.event.groupBy({
        by: ['company_id'],
        where: { type: 'ai.reply.ungrounded_price', created_at: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.event.groupBy({
        by: ['company_id'],
        where: { type: 'tool.failed', created_at: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.aiFeedback.findMany({
        where: { rating: -1, created_at: { gte: since } },
        orderBy: { created_at: 'desc' },
        take: 30,
      }),
      this.prisma.event.groupBy({
        by: ['company_id'],
        where: { type: 'ai.shadow', created_at: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.event.groupBy({
        by: ['company_id'],
        where: { type: 'ai.reply', created_at: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.aiEvalRun.findMany({ orderBy: { created_at: 'desc' }, take: 40 }),
    ]);
    const msgs = down.length
      ? await this.prisma.message.findMany({
          where: { id: { in: down.map((d) => d.message_id) } },
          select: { id: true, content: true },
        })
      : [];
    const names = await this.prisma.company.findMany({ select: { id: true, company_name: true } });
    const nm = new Map(names.map((n) => [n.id, n.company_name]));
    return {
      ungrounded: ungrounded.map((u) => ({ company: nm.get(u.company_id), companyId: u.company_id, count: u._count._all })),
      toolFailures: failures.map((u) => ({ company: nm.get(u.company_id), companyId: u.company_id, count: u._count._all })),
      shadow: shadow.map((s) => ({
        company: nm.get(s.company_id),
        companyId: s.company_id,
        shadowTurns: s._count._all,
        v2Replies: v2Replies.find((v) => v.company_id === s.company_id)?._count._all ?? 0,
      })),
      downvoted: down.map((d) => ({
        company: nm.get(d.company_id),
        conversationId: d.conversation_id,
        reason: d.reason,
        comment: d.comment,
        message: msgs.find((m) => m.id === d.message_id)?.content?.slice(0, 300) ?? '',
        at: d.created_at,
      })),
      evals: evals.map((e) => ({
        id: e.id,
        pack: e.pack,
        promptVersion: e.prompt_version,
        model: e.model,
        cases: e.cases,
        passed: e.passed,
        at: e.created_at,
        costUsd: Math.round(Number(e.cost_micros) / 10000) / 100,
      })),
    };
  }

  /** Shadow comparison for one tenant: what v1 sent vs what v2 would have sent. */
  async shadowSamples(companyId: number) {
    const ev = await this.prisma.event.findMany({
      where: { company_id: companyId, type: 'ai.shadow' },
      orderBy: { id: 'desc' },
      take: 40,
      select: { aggregate_id: true, payload: true, created_at: true },
    });
    const out: Array<Record<string, unknown>> = [];
    for (const e of ev) {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      const ids = Array.isArray(payload.turnMessageIds) ? (payload.turnMessageIds as number[]) : [];
      const lastId = ids[ids.length - 1];
      const [customer, v1] = await Promise.all([
        lastId
          ? this.prisma.message.findMany({ where: { id: { in: ids } }, select: { content: true, message_type: true } })
          : Promise.resolve([] as Array<{ content: string | null; message_type: string }>),
        lastId
          ? this.prisma.message.findFirst({
              where: { conversation_id: Number(e.aggregate_id), direction: 'outbound', id: { gt: lastId } },
              orderBy: { id: 'asc' },
              select: { content: true },
            })
          : Promise.resolve(null),
      ]);
      out.push({
        conversationId: Number(e.aggregate_id),
        at: e.created_at,
        customer: customer.map((c) => c.content || `(${c.message_type})`).join('\n'),
        v1: v1?.content ?? null,
        v2: payload.reply ?? (payload.handoff ? `[handoff] ${JSON.stringify(payload.handoff)}` : null),
        v2Tools: payload.tools ?? [],
      });
    }
    return out;
  }

  // ── Prompts ───────────────────────────────────────────────────────────

  listPrompts() {
    return this.prompts.list().then((rows) => ({ keys: PROMPT_KEYS, rows }));
  }
  async draftPrompt(actorId: number | null, key: string, body: string, by: string) {
    const row = await this.prompts.createDraft(key, body, by);
    await this.audit(actorId, 'super_admin.ai.prompt_draft', row.id, { key });
    return row;
  }
  async setPromptStatus(actorId: number | null, id: number, status: 'live' | 'retired' | 'draft') {
    const r = await this.prompts.setStatus(id, status);
    await this.audit(actorId, 'super_admin.ai.prompt_status', id, { status });
    return r;
  }

  // ── Evals ─────────────────────────────────────────────────────────────

  /**
   * Run a pack's golden conversations against a tenant's data (knowledge,
   * catalogue, bookings config) with the pack's defaults layered in. Dry-run:
   * nothing is sent or created. Cost is recorded on the run (not billed).
   */
  async runEval(actorId: number | null, pack: Industry, companyId: number) {
    const cases = EVAL_CASES[pack];
    if (!cases) throw new BadRequestException('Unknown pack');
    const base = await this.profiles.loadForStore(companyId, null);
    const stores = await this.prisma.shopifyStore.findMany({
      where: { company_id: companyId, status: 'active' },
      select: { id: true, label: true, shop_domain: true },
      orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
    });
    const storeId = stores[0]?.id ?? null;
    const profile =
      base.profile.industry === pack
        ? base.profile
        : { ...resolveProfile({ industry: pack, country_code: base.profile.countryCode }), engine: base.profile.engine };
    const results: Array<Record<string, unknown>> = [];
    let passed = 0;
    let cost = 0;
    let model = '';
    for (const c of cases) {
      const lastAi = c.messages.map((m) => m.role).lastIndexOf('ai');
      const turn = c.messages.slice(lastAi + 1).filter((m) => m.role === 'customer');
      const st: TurnState = {
        companyId,
        conversationId: null,
        contactId: null,
        contactName: null,
        contactPhone: null,
        storeId,
        stores: stores.map((s) => ({ id: s.id, label: s.label || s.shop_domain })),
        bundle: { ...base, profile },
        memory: c.memory ? parseMemory(c.memory) : emptyMemory(),
        latestTurnText: turn.map((m) => m.text).join('\n'),
        turnHasImage: false,
        dryRun: true,
        transactionsAllowed: true,
        autoOrder: true,
        open: true,
        tz: base.timezone || 'Asia/Karachi',
        progress: false,
        systemReply: null,
        handoff: null,
        endConversation: false,
        seen: new Map(),
        sources: [],
        tools: [],
        corpus: '',
        orderPlaced: null,
        bookingMade: null,
        leadSaved: false,
      };
      const r = await this.runtime.think(st, {
        transcript: c.messages.map((m) => `${m.role === 'customer' ? 'Customer' : 'Agent'}: ${m.text}`).join('\n'),
        images: [],
        tier: 'fast',
        contactLine: '',
        feature: 'eval',
        meter: false,
        hasStore: stores.length > 0,
      });
      cost += Number((r.trace as { costMicros?: number }).costMicros ?? 0);
      model = String((r.trace as { model?: string }).model ?? model);
      const called = new Set(st.tools.map((t) => t.name));
      const reply = st.systemReply ?? r.text ?? '';
      const fails: string[] = [];
      for (const anyOf of c.mustCall ?? []) {
        if (!anyOf.some((t) => called.has(t))) fails.push(`expected one of: ${anyOf.join(' / ')}`);
      }
      for (const t of c.mustNotCall ?? []) if (called.has(t)) fails.push(`must not call ${t}`);
      const handedOff = !!st.handoff || called.has('handoff');
      if (c.expectHandoff === true && !handedOff) fails.push('expected handoff');
      if (c.expectSystemReply && !st.systemReply) fails.push('expected system summary');
      for (const re of c.replyMatches ?? []) if (!re.test(reply)) fails.push(`reply should match ${re}`);
      for (const re of c.replyMustNot ?? []) if (re.test(reply)) fails.push(`reply must not match ${re}`);
      if (r.error) fails.push(`error: ${r.error}`);
      if (!fails.length) passed++;
      results.push({ id: c.id, ok: !fails.length, fails, tools: [...called], reply: reply.slice(0, 600) });
    }
    const run = await this.prisma.aiEvalRun.create({
      data: {
        pack,
        prompt_version: PROMPT_VERSION,
        model: model.slice(0, 64) || 'unknown',
        cases: cases.length,
        passed,
        results: results as Prisma.InputJsonValue,
        cost_micros: BigInt(Math.round(cost)),
      },
    });
    await this.audit(actorId, 'super_admin.ai.eval', run.id, { pack, companyId, passed, cases: cases.length });
    return { id: run.id, pack, cases: cases.length, passed, results };
  }

  evalRun(id: number) {
    return this.prisma.aiEvalRun.findUnique({ where: { id } });
  }
}
