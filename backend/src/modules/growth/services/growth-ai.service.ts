import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { CacheService } from '../../../common/services/cache.service';
import { LlmService } from '../../ai/llm.service';
import { AiMeteringService } from '../../ai/ai-metering.service';
import { AgentMessage, ToolDef } from '../../ai/providers/llm-provider.interface';
import { GrowthQueryService, RangeQuery } from './growth-query.service';
import { GrowthOpportunityService } from './growth-opportunity.service';
import { GrowthForecastService } from './growth-forecast.service';
import { GrowthVersionService } from './growth-version.service';
import { METRICS } from '../metrics/catalog';
import { MODELS, Model } from '../attribution/attribution';

export interface BriefAction {
  label: string;
  tone: 'good' | 'bad' | 'warn' | 'info';
}

export interface Brief {
  source: 'ai' | 'rules';
  headline: string;
  body: string;
  actions: BriefAction[];
  generatedAt: string;
}

export interface ChartSpec {
  type: 'line' | 'bar';
  title: string;
  x: string[];
  series: Array<{ name: string; data: number[] }>;
}

const SYSTEM = `You are CodesApp Growth, an e-commerce growth analyst for a cash-on-delivery store.
Rules:
- Use ONLY numbers returned by the tools or given in the facts. Never invent figures, campaigns or causes.
- "Expected" metrics already subtract predicted cancellations and returns (RTO); prefer them over platform-reported ROAS.
- Money is in the store currency given in the facts. Round sensibly (e.g. Rs 1.24M, Rs 48.2K).
- Be direct and specific: name the campaign, the number and the action. No fluff, no disclaimers.`;

const fmt = (v: number | null | undefined, cur = '') => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const s = a >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(0);
  return `${cur ? `${cur} ` : ''}${s}`;
};
const pctChange = (a: number | null, b: number | null) => (a != null && b ? ((a - b) / Math.abs(b)) * 100 : null);

/**
 * Growth AI: a daily narrative brief and "Ask Growth" chat. Numbers come from
 * the deterministic services (tool calls); the model only explains them.
 * Gated + metered like every other AI feature (feature 'growth'). When AI is
 * off or unavailable the brief falls back to a rules-based summary.
 */
@Injectable()
export class GrowthAiService {
  private readonly logger = new Logger(GrowthAiService.name);

  constructor(
    private readonly cache: CacheService,
    private readonly llm: LlmService,
    private readonly metering: AiMeteringService,
    private readonly query: GrowthQueryService,
    private readonly opps: GrowthOpportunityService,
    private readonly forecast: GrowthForecastService,
    private readonly version: GrowthVersionService,
  ) {}

  private async facts(companyId: number, q: RangeQuery) {
    const [ov, camps, opps] = await Promise.all([
      this.query.overview(companyId, { ...q, compare: 'prev' }),
      this.query.campaigns(companyId, q),
      this.opps.list(companyId, q),
    ]);
    const k = ov.kpis;
    const pick = (id: string) => ({ value: k[id]?.value ?? null, prev: k[id]?.prev ?? null });
    return {
      currency: ov.currency,
      range: ov.range,
      kpis: Object.fromEntries(['net', 'realized', 'expected', 'spend', 'roas', 'expRoas', 'platformRoas', 'breakEvenRoas',
        'orders', 'aov', 'newCustomers', 'ncac', 'rtoRate', 'netProfit', 'expectedProfit'].map((id) => [id, pick(id)])),
      topCampaigns: (camps.rows as Array<Record<string, unknown>>).slice(0, 8).map((c) => ({
        name: c.name, spend: c.spend, expRoas: c.expRoas, platformRoas: c.platformRoas, firstRoas: c.firstRoas,
        lastRoas: c.lastRoas, frequency: c.frequency, status: c.status,
      })),
      channels: ov.channels.slice(0, 6).map((c) => ({ channel: c.label, net: c.net, spend: c.spend, expRoas: c.expRoas })),
      opportunities: opps.slice(0, 6).map((o) => ({ title: o.title, detail: o.detail, impact: o.impact, kind: o.kind })),
      anomalies: ov.anomalies.slice(0, 5),
    };
  }

  async brief(companyId: number, q: RangeQuery): Promise<Brief> {
    const key = `growth:${companyId}:${this.version.get(companyId)}:brief:${q.from}:${q.to}:${q.storeId ?? ''}`;
    const hit = this.cache.get<Brief>(key);
    if (hit) return hit;
    const f = await this.facts(companyId, q);
    let brief = this.rulesBrief(f);
    try {
      await this.metering.assertAllowed(companyId);
      const res = await this.llm.complete({
        tier: 'fast',
        system: [{ text: SYSTEM }],
        userText:
          `Facts for ${f.range.from} → ${f.range.to} (kpis have value and previous-period value):\n${JSON.stringify(f)}\n\n` +
          'Write the Growth brief. Reply with JSON only: {"headline": "<max 12 words>", "body": "<2-4 sentences, max 90 words, ' +
          'what changed, the main driver, and the single most valuable next step>", "actions": [{"label": "<max 6 words>", ' +
          '"tone": "good|bad|warn|info"}] (2-4 actions, taken from the opportunities)}',
        maxTokens: 400,
        temperature: 0.2,
      });
      await this.metering.recordUsage(companyId, null, 'growth', res.provider, 'fast', res.usage);
      const parsed = JSON.parse(res.text.replace(/^```(?:json)?|```$/gm, '').trim()) as Partial<Brief>;
      if (parsed.headline && parsed.body) {
        brief = {
          source: 'ai',
          headline: String(parsed.headline).slice(0, 140),
          body: String(parsed.body).slice(0, 900),
          actions: (Array.isArray(parsed.actions) ? parsed.actions : [])
            .slice(0, 4)
            .map((a) => ({ label: String(a.label).slice(0, 60), tone: (['good', 'bad', 'warn', 'info'].includes(a.tone) ? a.tone : 'info') as BriefAction['tone'] })),
          generatedAt: new Date().toISOString(),
        };
      }
    } catch (e) {
      if (!(e instanceof ForbiddenException)) this.logger.debug(`brief AI fallback: ${(e as Error).message}`);
    }
    this.cache.set(key, brief, 3600);
    return brief;
  }

  /** Deterministic brief — used when AI is off, capped or unavailable. */
  private rulesBrief(f: Awaited<ReturnType<GrowthAiService['facts']>>): Brief {
    const cur = f.currency ?? '';
    const net = f.kpis.net as { value: number | null; prev: number | null };
    const spend = f.kpis.spend as { value: number | null; prev: number | null };
    const er = f.kpis.expRoas as { value: number | null; prev: number | null };
    const be = (f.kpis.breakEvenRoas as { value: number | null }).value;
    const ch = pctChange(net.value, net.prev);
    const top = f.opportunities[0];
    const parts = [
      `Net sales ${ch == null ? 'were' : ch >= 0 ? `rose ${ch.toFixed(1)}% to` : `fell ${Math.abs(ch).toFixed(1)}% to`} ${fmt(net.value, cur)} on ${fmt(spend.value, cur)} of ad spend.`,
      er.value != null ? `Expected ROAS is ${er.value.toFixed(2)}×${be ? ` against a break-even of ${be.toFixed(2)}×` : ''}.` : '',
      top ? `${top.title}.` : '',
    ].filter(Boolean);
    return {
      source: 'rules',
      headline: er.value != null && be ? (er.value >= be ? 'Ads are profitable this period' : 'Ads are below break-even') : 'Store performance summary',
      body: parts.join(' '),
      actions: f.opportunities.slice(0, 3).map((o) => ({
        label: o.title.slice(0, 60),
        tone: (o.kind === 'scale' ? 'good' : o.kind === 'cut' || o.kind === 'geo' ? 'bad' : o.kind === 'fatigue' ? 'warn' : 'info') as BriefAction['tone'],
      })),
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Ask Growth ──────────────────────────────────────────────────────────────
  private tools(): ToolDef[] {
    const range = {
      from: { type: 'string', description: 'Start day YYYY-MM-DD (store timezone)' },
      to: { type: 'string', description: 'End day YYYY-MM-DD inclusive' },
    };
    return [
      { name: 'get_overview', description: 'Headline KPIs (value + previous period), lifecycle funnel, profit waterfall and channels for a range.',
        inputSchema: { type: 'object', properties: range, required: ['from', 'to'] } },
      { name: 'get_daily', description: 'Daily series for one metric: net, realized, expected, spend, gross, orders, roas, newCustomers.',
        inputSchema: { type: 'object', properties: { ...range, metric: { type: 'string' } }, required: ['from', 'to', 'metric'] } },
      { name: 'get_campaigns', description: 'Campaigns with spend, expected/first-click/last-click/platform ROAS, CPA, frequency and CTR.',
        inputSchema: { type: 'object', properties: { ...range, model: { type: 'string', enum: MODELS }, limit: { type: 'number' } }, required: ['from', 'to'] } },
      { name: 'get_attribution', description: 'Net sales per channel and campaign under every attribution model, plus journeys and days-to-convert.',
        inputSchema: { type: 'object', properties: range, required: ['from', 'to'] } },
      { name: 'get_opportunities', description: 'Ranked, rule-based recommendations (scale / cut / fatigue / RTO cities / data gaps) with monthly impact.',
        inputSchema: { type: 'object', properties: range, required: ['from', 'to'] } },
      { name: 'get_forecast', description: 'Month-to-date and projected month-end net, expected net, spend and gross (p10/p50/p90).',
        inputSchema: { type: 'object', properties: {} } },
    ];
  }

  private async runTool(companyId: number, name: string, input: Record<string, unknown>, storeId?: number): Promise<unknown> {
    const r: RangeQuery = { from: String(input.from ?? ''), to: String(input.to ?? ''), storeId };
    switch (name) {
      case 'get_overview': {
        const o = await this.query.overview(companyId, { ...r, compare: 'prev' });
        return { currency: o.currency, kpis: o.kpis, lifecycle: o.lifecycle, waterfall: o.waterfall, channels: o.channels, anomalies: o.anomalies };
      }
      case 'get_daily': {
        const o = await this.query.overview(companyId, { ...r, compare: 'none' });
        const m = String(input.metric ?? 'net') as keyof (typeof o.series)[number];
        return o.series.map((d) => ({ date: d.date, value: d[m] ?? null }));
      }
      case 'get_campaigns': {
        const model = (MODELS as string[]).includes(String(input.model)) ? (input.model as Model) : 'last';
        const c = await this.query.campaigns(companyId, { ...r, model });
        const limit = Math.min(25, Math.max(1, Number(input.limit) || 10));
        return (c.rows as Array<Record<string, unknown>>).slice(0, limit).map(({ children: _c, spark: _s, ...rest }) => rest);
      }
      case 'get_attribution': {
        const a = await this.query.attribution(companyId, r);
        return { channels: a.channels, campaigns: a.campaigns.slice(0, 15), lag: a.lag, ctwa: a.ctwa };
      }
      case 'get_opportunities':
        return this.opps.list(companyId, r);
      case 'get_forecast': {
        const f = (await this.forecast.forecast(companyId, storeId)) as Record<string, unknown>;
        const strip = (m: Record<string, unknown>) => ({ mtd: m.mtd, projected: m.projected, lastMonthTotal: m.lastMonthTotal, lastMonthToDate: m.lastMonthToDate });
        return { month: f.month, today: f.today, net: strip(f.net as Record<string, unknown>), expected: strip(f.expected as Record<string, unknown>),
          spend: strip(f.spend as Record<string, unknown>), gross: strip(f.gross as Record<string, unknown>) };
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  }

  async ask(
    companyId: number,
    userId: number,
    question: string,
    ctx: RangeQuery,
    history: Array<{ role: 'user' | 'assistant'; text: string }> = [],
  ): Promise<{ answer: string; chart: ChartSpec | null }> {
    const qText = question.trim();
    if (!qText) throw new BadRequestException('Ask a question');
    await this.metering.assertAllowed(companyId);
    const system = [
      { text: SYSTEM },
      {
        text:
          `The user is looking at ${ctx.from} → ${ctx.to}. Today is ${new Date().toISOString().slice(0, 10)}. ` +
          `Metric definitions: ${METRICS.map((m) => `${m.id}=${m.formula}`).join('; ')}.\n` +
          'Answer in at most 120 words. If a chart would help, end with a fenced block ```chart {"type":"line|bar","title":"…",' +
          '"x":["…"],"series":[{"name":"…","data":[1,2]}]}``` using only tool data (max 3 series, max 60 points).',
      },
    ];
    const messages: AgentMessage[] = [
      ...history.slice(-6).map((h) => (h.role === 'user' ? { role: 'user' as const, text: h.text } : { role: 'assistant' as const, text: h.text })),
      { role: 'user', text: qText.slice(0, 1000) },
    ];
    let text = '';
    for (let round = 0; round < 5; round++) {
      const res = await this.llm.completeWithTools({ tier: 'smart', system, messages, tools: this.tools(), maxTokens: 900, temperature: 0.1 });
      await this.metering.recordUsage(companyId, userId, 'growth', res.provider, 'smart', res.usage);
      if (res.stop !== 'tool_use' || !res.toolCalls.length) {
        text = res.text ?? '';
        break;
      }
      messages.push({ role: 'assistant', text: res.text, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        let content: string;
        try {
          content = JSON.stringify(await this.runTool(companyId, call.name, call.input, ctx.storeId)).slice(0, 24_000);
        } catch (e) {
          content = JSON.stringify({ error: (e as Error).message });
        }
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
      }
    }
    let chart: ChartSpec | null = null;
    const m = /```chart\s*([\s\S]*?)```/.exec(text);
    if (m) {
      try {
        const c = JSON.parse(m[1]) as ChartSpec;
        if (Array.isArray(c.x) && Array.isArray(c.series)) {
          chart = {
            type: c.type === 'bar' ? 'bar' : 'line',
            title: String(c.title ?? '').slice(0, 80),
            x: c.x.slice(0, 60).map(String),
            series: c.series.slice(0, 3).map((s) => ({ name: String(s.name).slice(0, 40), data: (s.data ?? []).slice(0, 60).map((v) => Number(v) || 0) })),
          };
        }
      } catch {
        /* ignore a malformed chart block */
      }
      text = text.replace(m[0], '').trim();
    }
    return { answer: text || 'I could not find an answer in your data for that question.', chart };
  }
}
