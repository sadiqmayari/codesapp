import { ForbiddenException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { CompanyStatusService } from '../../common/services/company-status.service';
import { EventStoreService } from '../../common/services/event-store.service';
import { PlatformSettingService } from '../../common/services/platform-setting.service';
import { resolveAiCapabilities, resolveAutoReply } from '../../common/utils/ai-capabilities';
import { AiService } from '../ai/ai.service';
import { AiMeteringService } from '../ai/ai-metering.service';
import { AiProfileService, AgentProfileBundle } from '../ai/ai-profile.service';
import { LlmService } from '../ai/llm.service';
import { PromptRegistryService } from '../ai/prompt-registry.service';
import { isOpenAt } from '../ai/agent/profile';
import { AgentMessage, ImageInput } from '../ai/providers/llm-provider.interface';
import { InboxService } from '../inbox/inbox.service';
import { InboxGateway } from '../inbox/inbox.gateway';
import { SendMessageType } from '../inbox/dto/send-message.dto';
import { AiAgentService as LegacyAgentService } from '../integrations/shopify/ai-agent.service';
import { AgentHandoffService, HandoffCategory } from './handoff.service';
import { AgentSkills, TurnState } from './skills';
import { AgentMemory, emptyMemory, isStopWord, parseMemory } from './memory';
import { buildSystem, PROMPT_VERSION } from './prompt';

export interface AgentJob {
  companyId: number;
  conversationId: number;
  messageId: number;
  force?: boolean;
}

/** Max model round-trips per turn (tool steps + final answer). */
const MAX_STEPS = 6;

/** Deterministic "asks for a human" (the model also catches other phrasings). */
const ASKS_HUMAN =
  /\b(human|real person|agent|representative|customer care|talk to (someone|a person)|call me|insaan|banda|kisi (se|bande se) baat|agent se baat|manager)\b|انسان|کسی سے بات|ایجنٹ/i;

export interface TurnResult {
  reply: string | null;
  systemReply: boolean;
  handoff: { reason: string; category: HandoffCategory } | null;
  memory: AgentMemory;
  trace: Record<string, unknown>;
}

/**
 * AI Agent v2 runtime — the ONE brain (replaces v1's triage → specialists →
 * topic episodes). Per turn:
 *   preflight (mute / pause / human replied / window / opt-out / cap / hours)
 *   → merge every unanswered customer message into one turn
 *   → deterministic rules (payment slip, handoff keywords, no-progress)
 *   → resolve the chat's store → load profile (+ store overrides)
 *   → ONE tool loop over the skills the tenant enabled, with working memory
 *   → guards (grounding observe, empty/refusal → handoff) → send ONCE
 *   → trace event (`ai.reply`, idempotent per turn) → follow-up if new
 *     messages arrived during the run.
 *
 * Engines (ai_agent_profiles.engine): 'v2' (this), 'shadow' (v1 replies, v2
 * runs dry and logs `ai.shadow`), 'v1' (legacy only). The same core serves
 * the Settings Playground (dryRun, no conversation).
 */
@Injectable()
export class AgentRuntimeService implements OnModuleInit {
  private readonly logger = new Logger(AgentRuntimeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobQueue: JobQueueService,
    private readonly companyStatus: CompanyStatusService,
    private readonly events: EventStoreService,
    private readonly platformSetting: PlatformSettingService,
    private readonly ai: AiService,
    private readonly metering: AiMeteringService,
    private readonly profiles: AiProfileService,
    private readonly llm: LlmService,
    private readonly prompts: PromptRegistryService,
    private readonly inbox: InboxService,
    private readonly gateway: InboxGateway,
    private readonly skills: AgentSkills,
    private readonly handoffs: AgentHandoffService,
    private readonly legacy: LegacyAgentService,
  ) {}

  onModuleInit(): void {
    // 240s lease: a turn = up to 6 model calls + commerce round-trips.
    this.jobQueue.registerWorker('ai-agent', (p) => this.process(p as AgentJob), 4, 240);
  }

  // ── Job entry ─────────────────────────────────────────────────────────

  async process(job: AgentJob): Promise<void> {
    const started = new Date();
    if (!(await this.companyStatus.isActive(job.companyId))) return;
    const convo = await this.prisma.conversation.findFirst({
      where: { id: job.conversationId, company_id: job.companyId, deleted_at: null },
      select: {
        id: true,
        ai_autoreply: true,
        ai_paused_until: true,
        ai_awaiting_payment_at: true,
        ai_memory: true,
        ai_store_id: true,
        last_shopify_store_id: true,
        last_whatsapp_number_id: true,
        window_expires_at: true,
        contact: {
          select: { id: true, name: true, phone: true, status: true, tags: true },
        },
        company: {
          select: {
            ai_autoreply_enabled: true,
            ai_auto_order_enabled: true,
            ai_auto_order_all_enabled: true,
            ai_autonomous_tier: true,
            ai_premium_locked: true,
            ai_vision_enabled: true,
            ai_voice_enabled: true,
            order_fixed_store_id: true,
          },
        },
      },
    });
    if (!convo || !convo.company) return;
    const co = convo.company;

    // ── Preflight (re-checked at RUN time, not enqueue time) ──
    if (!resolveAutoReply(convo.ai_autoreply, co.ai_autoreply_enabled, job.force)) return;
    if (convo.contact?.status === 'blocked') return;
    if (convo.window_expires_at && convo.window_expires_at.getTime() < Date.now()) return;
    if (convo.ai_paused_until && convo.ai_paused_until.getTime() > Date.now()) return;

    const bundle0 = await this.profiles.load(job.companyId);
    const pauseMin = bundle0.profile.handoff.humanReplyPauseMin;
    if (pauseMin > 0) {
      const lastHuman = await this.prisma.message.findFirst({
        where: {
          conversation_id: convo.id,
          company_id: job.companyId,
          direction: 'outbound',
          user_id: { not: null },
        },
        orderBy: { timestamp: 'desc' },
        select: { timestamp: true },
      });
      if (lastHuman && Date.now() - lastHuman.timestamp.getTime() < pauseMin * 60_000) return;
    }
    if (await this.metering.blockReason(job.companyId)) return;

    // ── The unanswered turn (every inbound message since our last reply) ──
    const lastOut = await this.prisma.message.findFirst({
      where: { conversation_id: convo.id, company_id: job.companyId, direction: 'outbound' },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true },
    });
    const turn = await this.prisma.message.findMany({
      where: {
        conversation_id: convo.id,
        company_id: job.companyId,
        direction: 'inbound',
        ...(lastOut ? { timestamp: { gt: lastOut.timestamp } } : {}),
      },
      orderBy: { timestamp: 'asc' },
      take: 20,
      select: { id: true, message_type: true, content: true, transcription: true },
    });
    if (!turn.length) return;
    const lastInboundId = turn[turn.length - 1].id;
    const turnKey = `ai-turn:${convo.id}:${lastInboundId}`;
    const already = await this.prisma.event.findFirst({
      where: { company_id: job.companyId, idempotency_key: turnKey },
      select: { id: true },
    });
    if (already) return;

    const engine = bundle0.profile.engine;
    if (engine === 'v1' || engine === 'shadow') {
      await this.legacy.processJob(job);
      await this.events.append({
        companyId: job.companyId,
        aggregateType: 'CONVERSATION',
        aggregateId: convo.id,
        type: 'ai.turn',
        actorType: 'AI',
        idempotencyKey: turnKey,
        payload: { engine },
      });
      if (engine === 'shadow') {
        await this.runConversationTurn(job, convo, turn, bundle0, true).catch((e) =>
          this.logger.warn(`shadow turn failed (convo ${convo.id}): ${e instanceof Error ? e.message : String(e)}`),
        );
      }
      return;
    }

    await this.runConversationTurn(job, convo, turn, bundle0, false);
    await this.events.append({
      companyId: job.companyId,
      aggregateType: 'CONVERSATION',
      aggregateId: convo.id,
      type: 'ai.turn',
      actorType: 'AI',
      idempotencyKey: turnKey,
      payload: { engine: 'v2' },
    });

    // Messages that arrived while we were thinking → one follow-up turn.
    const newer = await this.prisma.message.findFirst({
      where: {
        conversation_id: convo.id,
        company_id: job.companyId,
        direction: 'inbound',
        id: { gt: lastInboundId },
        created_at: { gte: started },
      },
      select: { id: true },
    });
    if (newer) {
      await this.jobQueue
        .enqueue(
          'ai-agent',
          { companyId: job.companyId, conversationId: convo.id, messageId: newer.id, force: job.force },
          {
            delayMs: 3000,
            serialKey: `conv:ai-agent:${convo.id}`,
            dedupKey: `ai-agent:followup:${convo.id}:${newer.id}`,
          },
        )
        .catch(() => undefined);
    }
  }

  // ── Conversation turn ─────────────────────────────────────────────────

  private async runConversationTurn(
    job: AgentJob,
    convo: {
      id: number;
      ai_memory: Prisma.JsonValue;
      ai_awaiting_payment_at: Date | null;
      ai_store_id: number | null;
      last_shopify_store_id: number | null;
      last_whatsapp_number_id: number | null;
      contact: { id: number; name: string | null; phone: string; tags: Prisma.JsonValue } | null;
      company: {
        ai_auto_order_enabled: boolean;
        ai_auto_order_all_enabled: boolean;
        ai_autoreply_enabled: boolean;
        ai_autonomous_tier: string | null;
        ai_premium_locked: boolean;
        ai_vision_enabled: boolean;
        ai_voice_enabled: boolean;
        order_fixed_store_id: number | null;
      } | null;
      ai_autoreply: boolean | null;
    },
    turn: Array<{ id: number; message_type: string; content: string | null; transcription: string | null }>,
    bundle0: AgentProfileBundle,
    dryRun: boolean,
  ): Promise<void> {
    const co = convo.company!;
    const memory = parseMemory(convo.ai_memory);
    const turnText = turn
      .map((m) => m.content?.trim() || m.transcription?.trim() || `(${m.message_type})`)
      .join('\n');
    const turnHasImage = turn.some((m) => m.message_type === 'image' || m.message_type === 'document');
    if (turn.every((m) => isStopWord(m.content ?? ''))) return;

    const p0 = bundle0.profile;
    const tz = bundle0.timezone || 'Asia/Karachi';
    const open = isOpenAt(p0.hours, new Date(), tz);
    const cfg = p0.handoff;
    const doHandoff = async (reason: string, category: HandoffCategory, message?: string) => {
      await this.handoffs.handoff({
        companyId: job.companyId,
        conversationId: convo.id,
        reason,
        category,
        cfg,
        open,
        message,
        dryRun,
      });
      if (!dryRun) {
        await this.saveMemory(convo.id, { ...memory, noProgress: 0 });
      }
      await this.trace(job, convo.id, turn, dryRun, { handoff: { reason, category } });
    };

    // Closed + away-only → one away message per closed period.
    if (!open && p0.hours.offHoursMode === 'away_only') {
      const last = memory.awaySentAt ? new Date(memory.awaySentAt).getTime() : 0;
      if (Date.now() - last > 8 * 3600_000) {
        await this.send(job.companyId, convo.id, p0.hours.awayMessage, dryRun);
        memory.awaySentAt = new Date().toISOString();
        if (!dryRun) await this.saveMemory(convo.id, memory);
      }
      return;
    }

    // Payment slip awaited → acknowledge + human verification.
    if ((memory.stage === 'awaiting_payment' || convo.ai_awaiting_payment_at) && turnHasImage) {
      memory.stage = 'done';
      if (!dryRun) {
        await this.prisma.conversation
          .update({ where: { id: convo.id }, data: { ai_awaiting_payment_at: null } })
          .catch(() => undefined);
      }
      if (cfg.paymentSlip) {
        await doHandoff(
          'payment slip received — verify and place the prepaid order',
          'payment_slip',
          'Thank you! We have received your payment slip — our team will verify it and confirm your order shortly.',
        );
        return;
      }
    }

    // Deterministic handoff rules.
    const lower = turnText.toLowerCase();
    const kw = cfg.keywords.find((k) => k && lower.includes(k.toLowerCase()));
    if (kw) {
      await doHandoff(`keyword "${kw}"`, 'keyword');
      return;
    }
    if (cfg.asksHuman && p0.skills.handoff.enabled && ASKS_HUMAN.test(turnText)) {
      await doHandoff('customer asked for a human', 'asked_human');
      return;
    }
    if (cfg.noProgressTurns > 0 && memory.noProgress >= cfg.noProgressTurns) {
      await doHandoff(`${memory.noProgress} AI replies without progress`, 'no_progress');
      return;
    }

    // Store resolution: fixed order store → chat's store → last order store →
    // the number's store → single store → (multi-brand) ask.
    const stores = await this.prisma.shopifyStore.findMany({
      where: { company_id: job.companyId, status: 'active' },
      select: { id: true, label: true, shop_domain: true, is_primary: true },
      orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
    });
    let numberStore: number | null = null;
    if (convo.last_whatsapp_number_id) {
      const n = await this.prisma.whatsAppNumber.findFirst({
        where: { id: convo.last_whatsapp_number_id, company_id: job.companyId },
        select: { default_store_id: true },
      });
      numberStore = n?.default_store_id ?? null;
    }
    const valid = (id: number | null | undefined) => (id && stores.some((s) => s.id === id) ? id : null);
    const storeId =
      valid(co.order_fixed_store_id) ??
      valid(convo.ai_store_id) ??
      valid(convo.last_shopify_store_id) ??
      valid(numberStore) ??
      (stores.length === 1 ? stores[0].id : null);
    const bundle = await this.profiles.loadForStore(job.companyId, storeId);

    const caps = resolveAiCapabilities(co, await this.platformSetting.getAutonomousTier());
    const ctx = await this.ai.agentTranscript(job.companyId, convo.id);
    const autoOrder =
      co.ai_auto_order_enabled &&
      (convo.ai_autoreply === true || co.ai_auto_order_all_enabled === true);

    const st: TurnState = {
      companyId: job.companyId,
      conversationId: convo.id,
      contactId: convo.contact?.id ?? null,
      contactName: convo.contact?.name ?? null,
      contactPhone: convo.contact?.phone ?? null,
      storeId,
      stores: stores.map((s) => ({ id: s.id, label: s.label || s.shop_domain })),
      bundle,
      memory,
      latestTurnText: turnText,
      turnHasImage,
      dryRun,
      transactionsAllowed: open || p0.hours.offHoursMode === 'full',
      autoOrder,
      open,
      tz,
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
    const tags = Array.isArray(convo.contact?.tags)
      ? (convo.contact!.tags as unknown[]).filter((t) => typeof t === 'string')
      : [];
    const result = await this.think(st, {
      transcript: ctx.transcript,
      images: caps.vision ? ctx.images : [],
      tier: caps.tier,
      contactLine: tags.length ? `Customer tags: ${tags.join(', ')}.` : '',
      feature: dryRun ? 'shadow' : 'agent',
      meter: !dryRun,
      hasStore: stores.length > 0,
    });

    if (result.error) {
      if (result.error === 'forbidden') return;
      if (!dryRun) {
        await doHandoff('AI could not complete this turn', 'error');
      }
      return;
    }

    if (st.handoff) {
      await doHandoff(st.handoff.reason, st.handoff.category, st.handoff.message);
      memory.noProgress = 0;
      if (!dryRun) await this.saveMemory(convo.id, memory);
      return;
    }

    const reply = st.systemReply ?? result.text;
    if (!reply) {
      if (!dryRun) await doHandoff('AI produced no reply', 'model');
      else await this.trace(job, convo.id, turn, true, { empty: true, ...result.trace });
      return;
    }

    let messageId: number | null = null;
    if (!dryRun) {
      messageId = await this.send(job.companyId, convo.id, reply, false);
      memory.noProgress = st.progress ? 0 : memory.noProgress + 1;
      memory.updatedAt = new Date().toISOString();
      await this.saveMemory(convo.id, memory);
      if (st.endConversation && !st.orderPlaced) {
        await this.prisma.conversation
          .update({ where: { id: convo.id }, data: { status: 'resolved', ai_closed_at: new Date() } })
          .catch(() => undefined);
        this.gateway.emitToCompany(job.companyId, 'conversation.updated', { conversationId: convo.id });
      }
    }
    await this.observeGrounding(job.companyId, convo.id, reply, st, dryRun);
    await this.trace(job, convo.id, turn, dryRun, {
      ...result.trace,
      reply: dryRun ? reply : undefined,
      messageId,
      systemReply: !!st.systemReply,
      memoryStage: memory.stage,
      orderPlaced: st.orderPlaced,
      bookingMade: st.bookingMade,
    });
  }

  // ── The model loop (shared by conversations, shadow and playground) ─────

  async think(
    st: TurnState,
    opts: {
      transcript: string;
      images: ImageInput[];
      tier: 'fast' | 'smart';
      contactLine: string;
      feature: 'agent' | 'shadow' | 'playground' | 'eval';
      meter: boolean;
      hasStore: boolean;
    },
  ): Promise<{ text: string | null; error?: 'forbidden' | 'failed'; trace: Record<string, unknown> }> {
    const p = st.bundle.profile;
    const tools = this.skills.toolsFor(st, opts.hasStore);
    const [core, pack] = await Promise.all([
      this.prompts.get('agent.core'),
      this.prompts.get(`pack.${p.industry}`),
    ]);
    const nowLocal = new Intl.DateTimeFormat('en-GB', {
      timeZone: st.tz,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date());
    const system = buildSystem({
      profile: p,
      brandName: st.bundle.brandName,
      coreOverride: core?.body,
      packOverride: pack?.body,
      tools: tools.map((t) => t.name),
      stores: st.stores,
      storeLabel: st.storeId ? st.stores.find((s) => s.id === st.storeId)?.label ?? null : null,
      autoOrder: st.autoOrder,
      open: st.open,
      transactionsAllowed: st.transactionsAllowed,
      nowLocal,
      memory: st.memory,
      knownCustomer: { name: st.contactName },
    });
    const promptVersion = [PROMPT_VERSION, core ? `core-${core.version}` : '', pack ? `pack-${pack.version}` : '']
      .filter(Boolean)
      .join('+');
    const userText =
      `${opts.contactLine}\n\nConversation (most recent last):\n${opts.transcript}\n\n` +
      `The customer's latest message(s) — reply to these:\n<customer_data>\n${st.latestTurnText}\n</customer_data>`;

    const messages: AgentMessage[] = [{ role: 'user', text: userText }];
    let text: string | null = null;
    let costMicros = 0;
    let model = '';
    let provider = '';
    let latency = 0;

    const loop = async (): Promise<void> => {
      for (let step = 0; step < MAX_STEPS; step++) {
        const last = step === MAX_STEPS - 1;
        if (opts.meter) await this.metering.assertAllowed(st.companyId);
        const res = await this.llm.completeWithTools({
          tier: opts.tier,
          system,
          messages,
          tools,
          toolChoice: last ? 'none' : 'auto',
          images: step === 0 ? opts.images : undefined,
          maxTokens: 900,
          temperature: 0.3,
          effort: 'low',
        });
        model = res.modelId;
        provider = res.provider;
        latency += res.latencyMs;
        costMicros += this.metering.computeCostMicros(res.provider, opts.tier, res.usage, res.modelId);
        if (opts.meter) {
          await this.metering.recordUsage(st.companyId, null, opts.feature, res.provider, opts.tier, res.usage, {
            modelId: res.modelId,
            latencyMs: res.latencyMs,
            conversationId: st.conversationId,
            promptVersion,
          });
        }
        if (res.refused) {
          st.handoff = st.handoff ?? { reason: 'model declined to answer', category: 'sensitive' };
          return;
        }
        if (!last && res.stop === 'tool_use' && res.toolCalls.length) {
          messages.push({ role: 'assistant', text: res.text, toolCalls: res.toolCalls, raw: res.raw });
          for (const tc of res.toolCalls) {
            const out = await this.skills.execute(st, tc.name, tc.input ?? {});
            messages.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: out });
          }
          // A deterministic outcome needs no further model text.
          if (st.systemReply || st.handoff) return;
          continue;
        }
        text = this.sanitize(res.text ?? '', st.corpus);
        return;
      }
    };

    try {
      await loop();
    } catch (e) {
      if (e instanceof ForbiddenException) return { text: null, error: 'forbidden', trace: {} };
      this.logger.warn(
        `agent turn failed once (company ${st.companyId}, convo ${st.conversationId}): ${
          e instanceof Error ? e.message : String(e)
        } — retrying`,
      );
      try {
        await new Promise((r) => setTimeout(r, 2500));
        messages.splice(1);
        await loop();
      } catch (e2) {
        if (e2 instanceof ForbiddenException) return { text: null, error: 'forbidden', trace: {} };
        this.logger.error(
          `agent turn failed (company ${st.companyId}, convo ${st.conversationId}): ${
            e2 instanceof Error ? e2.message : String(e2)
          }`,
        );
        return { text: null, error: 'failed', trace: { tools: st.tools } };
      }
    }
    return {
      text,
      trace: {
        model,
        provider,
        tier: opts.tier,
        promptVersion,
        latencyMs: latency,
        costMicros,
        tools: st.tools,
        sources: st.sources.slice(0, 8),
        storeId: st.storeId,
        open: st.open,
      },
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** WhatsApp-safe output: no markdown images/links/headings; drop invented URLs. */
  sanitize(text: string, corpus: string): string {
    let s = text || '';
    s = s.replace(/!\[[^\]]*\]\(([^)]*)\)/g, '');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1: $2');
    s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
    s = s.replace(/__([^_\n]+)__/g, '_$1_');
    s = s.replace(/<\/?(customer_data|knowledge)>/g, '');
    s = s.replace(/(?:•\s*)?(?:link\s*[:：]\s*)?https?:\/\/[^\s)]+/gi, (m) => {
      const url = m.replace(/^.*?(https?:\/\/)/i, '$1').trim();
      return corpus.includes(url) ? m : '';
    });
    return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  private async send(
    companyId: number,
    conversationId: number,
    content: string,
    dryRun: boolean,
  ): Promise<number | null> {
    if (dryRun) return null;
    try {
      const msg = await this.inbox.sendMessage(
        companyId,
        conversationId,
        { type: SendMessageType.text, content },
        undefined,
        { sentByAi: true },
      );
      return msg?.id ?? null;
    } catch (e) {
      this.logger.warn(
        `agent send failed (convo ${conversationId}): ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  private async saveMemory(conversationId: number, m: AgentMemory): Promise<void> {
    await this.prisma.conversation
      .update({
        where: { id: conversationId },
        data: { ai_memory: { ...m, updatedAt: new Date().toISOString() } as unknown as Prisma.InputJsonValue },
      })
      .catch(() => undefined);
  }

  /** Observe-only: a price in the reply that no tool result / summary contains. */
  private async observeGrounding(
    companyId: number,
    conversationId: number,
    reply: string,
    st: TurnState,
    dryRun: boolean,
  ): Promise<void> {
    if (dryRun || st.systemReply) return;
    const sym = st.bundle.profile.currencySymbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:${sym}|rs\\.?|pkr|₨|aed|sar|\\$|£|€|₹)\\s*([\\d][\\d,]*)`, 'gi');
    const found = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(reply))) {
      const d = m[1].replace(/\D/g, '');
      if (d.length >= 2) found.add(d);
    }
    if (!found.size) return;
    const allowed = new Set(
      [...st.corpus.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((x) => x[0].replace(/\D/g, '').replace(/^(\d+?)0*$/, '$1')),
    );
    const allowedRaw = new Set([...st.corpus.matchAll(/\d[\d,]*/g)].map((x) => x[0].replace(/\D/g, '')));
    const bad = [...found].filter((d) => !allowedRaw.has(d) && !allowed.has(d));
    if (!bad.length) return;
    await this.events.append({
      companyId,
      aggregateType: 'CONVERSATION',
      aggregateId: conversationId,
      type: 'ai.reply.ungrounded_price',
      actorType: 'AI',
      payload: { prices: bad },
    });
  }

  private async trace(
    job: AgentJob,
    conversationId: number,
    turn: Array<{ id: number }>,
    dryRun: boolean,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.events.append({
      companyId: job.companyId,
      aggregateType: 'CONVERSATION',
      aggregateId: conversationId,
      type: dryRun ? 'ai.shadow' : 'ai.reply',
      actorType: 'AI',
      payload: { ...payload, turnMessageIds: turn.map((t) => t.id) } as Record<string, unknown>,
    });
  }

  // ── Playground (Settings → AI Agent) ─────────────────────────────────

  /**
   * Chat with your own agent: the REAL prompt, skills and knowledge, but in
   * dry-run (no messages sent, orders/bookings/tickets simulated). The caller
   * holds the transcript + memory between turns.
   */
  async playground(
    companyId: number,
    input: {
      messages: Array<{ role: 'customer' | 'ai'; text: string }>;
      memory?: unknown;
      storeId?: number | null;
    },
  ): Promise<{ reply: string | null; memory: AgentMemory; trace: Record<string, unknown>; handoff: unknown }> {
    await this.metering.assertAllowed(companyId);
    const msgs = (input.messages ?? []).slice(-30).filter((m) => m && typeof m.text === 'string');
    const lastAi = msgs.map((m) => m.role).lastIndexOf('ai');
    const turnMsgs = msgs.slice(lastAi + 1).filter((m) => m.role === 'customer');
    if (!turnMsgs.length) {
      return { reply: null, memory: parseMemory(input.memory), trace: {}, handoff: null };
    }
    const transcript = msgs
      .map((m) => `${m.role === 'customer' ? 'Customer' : 'Agent'}: ${m.text.slice(0, 2000)}`)
      .join('\n');
    const stores = await this.prisma.shopifyStore.findMany({
      where: { company_id: companyId, status: 'active' },
      select: { id: true, label: true, shop_domain: true },
      orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
    });
    const storeId =
      input.storeId && stores.some((s) => s.id === input.storeId)
        ? input.storeId
        : stores.length === 1
          ? stores[0].id
          : null;
    const bundle = await this.profiles.loadForStore(companyId, storeId);
    const co = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { ai_autonomous_tier: true, ai_premium_locked: true, ai_auto_order_enabled: true },
    });
    const tz = bundle.timezone || 'Asia/Karachi';
    const open = isOpenAt(bundle.profile.hours, new Date(), tz);
    const memory = input.memory ? parseMemory(input.memory) : emptyMemory();
    const st: TurnState = {
      companyId,
      conversationId: null,
      contactId: null,
      contactName: null,
      contactPhone: null,
      storeId,
      stores: stores.map((s) => ({ id: s.id, label: s.label || s.shop_domain })),
      bundle,
      memory,
      latestTurnText: turnMsgs.map((m) => m.text).join('\n'),
      turnHasImage: false,
      dryRun: true,
      transactionsAllowed: open || bundle.profile.hours.offHoursMode === 'full',
      autoOrder: co?.ai_auto_order_enabled ?? false,
      open,
      tz,
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
    const tier = resolveAiCapabilities(co ?? {}, await this.platformSetting.getAutonomousTier()).tier;
    const r = await this.think(st, {
      transcript,
      images: [],
      tier,
      contactLine: '(Playground test — this is the business owner testing the agent.)',
      feature: 'playground',
      meter: true,
      hasStore: stores.length > 0,
    });
    if (st.handoff) {
      const msg =
        st.handoff.message ??
        (open ? bundle.profile.handoff.messageInHours : bundle.profile.handoff.messageOffHours);
      return { reply: msg, memory: st.memory, trace: { ...r.trace, handoff: st.handoff }, handoff: st.handoff };
    }
    return {
      reply: st.systemReply ?? r.text,
      memory: st.memory,
      trace: { ...r.trace, systemReply: !!st.systemReply },
      handoff: null,
    };
  }
}
