'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import { SaCard, SaPageHeader, SaSpinner } from '../_components/sa-ui';

export const dynamic = 'force-dynamic';

type Tab = 'platform' | 'tenants' | 'costs' | 'quality' | 'prompts' | 'evals';
const TABS: Array<[Tab, string]> = [
  ['platform', 'Platform'],
  ['tenants', 'Tenants'],
  ['costs', 'Costs'],
  ['quality', 'Quality'],
  ['prompts', 'Prompts & packs'],
  ['evals', 'Evals'],
];
const PACKS = ['ecommerce', 'clinic', 'real_estate', 'education', 'restaurant', 'services', 'travel', 'generic'];

interface Platform {
  enabled: boolean;
  provider: 'anthropic' | 'openai';
  fallbackProvider: string;
  autonomousTier: 'fast' | 'smart';
  models: Record<'anthropic' | 'openai', Record<'fast' | 'smart', string>>;
  defaults: Record<'anthropic' | 'openai', Record<'fast' | 'smart', string>>;
  catalog: Array<{ id: string; provider: string; label: string; inUsdPerMTok: number; outUsdPerMTok: number }>;
  multiplier: number;
  defaultCapCents: number;
  configured: Record<'anthropic' | 'openai', boolean>;
  promptVersion: string;
}
interface TenantRow {
  id: number;
  name: string;
  plan: string | null;
  status: string;
  planAi: boolean;
  tenantAi: boolean;
  adminDisabled: boolean;
  adminCapCents: number | null;
  tenantCapCents: number | null;
  defaultCapCents: number;
  autoReplyAll: boolean;
  tier: string | null;
  premiumLocked: boolean;
  industry: string;
  engine: 'v1' | 'shadow' | 'v2';
  requests: number;
  costUsd: number;
  billedUsd: number;
  aiReplies30d: number;
  handoffs30d: number;
  handoffPct: number | null;
  downPct: number | null;
  toolFailures30d: number;
}
interface CostRow {
  companyId: number;
  company: string;
  period: string;
  feature: string;
  model: string;
  calls: number;
  costUsd: number;
  billedUsd: number;
}

const money = (n: number) => `$${n.toFixed(2)}`;
const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 };

export default function SuperAdminAiPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('platform');
  const [error, setError] = useState('');

  const call = useCallback(
    async <T,>(url: string, opts: Parameters<typeof apiFetch>[1] = {}): Promise<T | null> => {
      try {
        return await apiFetch<T>(url, { ...opts, noOnboardingRedirect: true });
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          router.replace('/super-admin/login');
          return null;
        }
        setError(e instanceof ApiError ? e.userMessage : 'Request failed');
        return null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- router wrapper identity is unstable (CLAUDE.md)
    [],
  );

  return (
    <div className="sa-content">
      <SaPageHeader
        title="AI Control Center"
        subtitle="Run AI across every tenant: platform switches, models and pricing, per-tenant overrides, costs, quality and prompts."
        actions={
          <div className="sa-seg">
            {TABS.map(([k, l]) => (
              <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => { setTab(k); setError(''); }}>
                {l}
              </button>
            ))}
          </div>
        }
      />
      {error && <div className="sa-alert-error">{error}</div>}
      {tab === 'platform' && <PlatformTab call={call} />}
      {tab === 'tenants' && <TenantsTab call={call} />}
      {tab === 'costs' && <CostsTab call={call} />}
      {tab === 'quality' && <QualityTab call={call} />}
      {tab === 'prompts' && <PromptsTab call={call} />}
      {tab === 'evals' && <EvalsTab call={call} />}
    </div>
  );
}

type Call = <T>(url: string, opts?: Parameters<typeof apiFetch>[1]) => Promise<T | null>;

function PlatformTab({ call }: { call: Call }) {
  const [p, setP] = useState<Platform | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    call<Platform>('/super-admin/ai/platform').then(setP);
  }, [call]);
  if (!p) return <SaSpinner />;
  const set = (x: Partial<Platform>) => {
    setP({ ...p, ...x });
    setSaved(false);
  };
  const setModel = (prov: 'anthropic' | 'openai', tier: 'fast' | 'smart', id: string) =>
    set({ models: { ...p.models, [prov]: { ...p.models[prov], [tier]: id } } });
  const save = async () => {
    setSaving(true);
    const r = await call<Platform>('/super-admin/ai/platform', {
      method: 'PATCH',
      body: {
        enabled: p.enabled,
        provider: p.provider,
        fallbackProvider: p.fallbackProvider,
        autonomousTier: p.autonomousTier,
        models: p.models,
        multiplier: p.multiplier,
        defaultCapCents: p.defaultCapCents,
      },
    });
    if (r) {
      setP(r);
      setSaved(true);
    }
    setSaving(false);
  };
  const priceOf = (id: string) => p.catalog.find((c) => c.id === id);

  return (
    <>
      <div className="sa-grid-2">
        <SaCard title="Platform switches">
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, marginBottom: 12 }}>
            <input type="checkbox" checked={p.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
            <b>AI enabled platform-wide</b>
            <span className={`sa-pill ${p.enabled ? 'good' : 'crit'}`}>{p.enabled ? 'live' : 'KILLED'}</span>
          </label>
          <p className="sa-faint" style={{ fontSize: 12, marginTop: -6, marginBottom: 14 }}>
            Off = every AI feature for every tenant pauses (replies, copilot, transcription, indexing). Takes up to 5 minutes to reach all processes.
          </p>
          <div className="sa-grid-2" style={{ gap: 10 }}>
            <div>
              <span style={lbl}>Primary provider</span>
              <select className="sa-select" value={p.provider} onChange={(e) => set({ provider: e.target.value as Platform['provider'] })}>
                <option value="anthropic">Anthropic {p.configured.anthropic ? '' : '(no key!)'}</option>
                <option value="openai">OpenAI {p.configured.openai ? '' : '(no key!)'}</option>
              </select>
            </div>
            <div>
              <span style={lbl}>Failover provider</span>
              <select className="sa-select" value={p.fallbackProvider} onChange={(e) => set({ fallbackProvider: e.target.value })}>
                <option value="none">None</option>
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
              </select>
            </div>
            <div>
              <span style={lbl}>Default autonomous tier</span>
              <select className="sa-select" value={p.autonomousTier} onChange={(e) => set({ autonomousTier: e.target.value as 'fast' | 'smart' })}>
                <option value="fast">Fast</option>
                <option value="smart">Smart</option>
              </select>
            </div>
            <div>
              <span style={lbl}>Prompt version</span>
              <div className="sa-mono" style={{ fontSize: 12, paddingTop: 8 }}>{p.promptVersion}</div>
            </div>
          </div>
        </SaCard>
        <SaCard title="Pricing & limits">
          <div className="sa-grid-2" style={{ gap: 10 }}>
            <div>
              <span style={lbl}>Price multiplier (billed = raw ×)</span>
              <input className="sa-input" type="number" step="0.1" min={1} max={10} value={p.multiplier} onChange={(e) => set({ multiplier: Number(e.target.value) })} />
            </div>
            <div>
              <span style={lbl}>Default monthly cap (USD, 0 = none)</span>
              <input className="sa-input" type="number" min={0} value={p.defaultCapCents / 100} onChange={(e) => set({ defaultCapCents: Math.round(Number(e.target.value) * 100) })} />
            </div>
          </div>
          <p className="sa-faint" style={{ fontSize: 12, marginTop: 10 }}>
            The default cap is a hard ceiling for tenants without their own super-admin cap — tenants can only set something lower.
          </p>
        </SaCard>
      </div>
      <SaCard title="Models per tier">
        <div className="sa-table-wrap">
          <table className="sa-table">
            <thead>
              <tr><th>Provider</th><th>Tier</th><th>Model id</th><th>Price (in / out per MTok)</th><th>Default</th></tr>
            </thead>
            <tbody>
              {(['anthropic', 'openai'] as const).flatMap((prov) =>
                (['fast', 'smart'] as const).map((tier) => {
                  const pr = priceOf(p.models[prov][tier]);
                  return (
                    <tr key={`${prov}-${tier}`}>
                      <td>{prov}</td>
                      <td>{tier}</td>
                      <td>
                        <input className="sa-input" list={`models-${prov}`} value={p.models[prov][tier]} onChange={(e) => setModel(prov, tier, e.target.value)} />
                      </td>
                      <td className="sa-mono">{pr ? `$${pr.inUsdPerMTok} / $${pr.outUsdPerMTok}` : <span className="sa-pill warn">unknown → priced as default</span>}</td>
                      <td className="sa-mono sa-faint">{p.defaults[prov][tier]}</td>
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
          {(['anthropic', 'openai'] as const).map((prov) => (
            <datalist key={prov} id={`models-${prov}`}>
              {p.catalog.filter((c) => c.provider === prov).map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </datalist>
          ))}
        </div>
      </SaCard>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button type="button" className="sa-btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save platform settings'}</button>
        {saved && <span className="sa-pill good">saved · audit logged</span>}
      </div>
    </>
  );
}

function TenantsTab({ call }: { call: Call }) {
  const [rows, setRows] = useState<TenantRow[] | null>(null);
  const [q, setQ] = useState('');
  const load = useCallback(() => call<TenantRow[]>('/super-admin/ai/tenants').then((r) => r && setRows(r)), [call]);
  useEffect(() => {
    load();
  }, [load]);
  const patch = async (id: number, body: Record<string, unknown>) => {
    await call(`/super-admin/ai/tenants/${id}`, { method: 'PATCH', body });
    load();
  };
  const shown = useMemo(
    () => (rows ?? []).filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase())),
    [rows, q],
  );
  if (!rows) return <SaSpinner />;
  const total = rows.reduce((a, r) => ({ cost: a.cost + r.costUsd, billed: a.billed + r.billedUsd }), { cost: 0, billed: 0 });
  return (
    <SaCard
      title={`Tenants (${rows.length}) · this month ${money(total.cost)} cost / ${money(total.billed)} billed`}
      right={<input className="sa-input" placeholder="Search tenant" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />}
      bodyClassName=""
    >
      <div className="sa-table-wrap">
        <table className="sa-table">
          <thead>
            <tr>
              <th>Tenant</th><th>Industry</th><th>Engine</th><th>AI</th><th>Cost / billed</th>
              <th>Replies 30d</th><th>Handoff</th><th>👎</th><th>Tool fails</th><th>Admin cap ($)</th><th />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const on = r.planAi && r.tenantAi && !r.adminDisabled;
              return (
                <tr key={r.id}>
                  <td><b>{r.name}</b><div className="sa-faint" style={{ fontSize: 11 }}>{r.plan ?? '—'} · #{r.id}</div></td>
                  <td>
                    <select className="sa-select" value={r.industry} onChange={(e) => patch(r.id, { industry: e.target.value })}>
                      {PACKS.map((x) => <option key={x} value={x}>{x.replace('_', ' ')}</option>)}
                    </select>
                  </td>
                  <td>
                    <select className="sa-select" value={r.engine} onChange={(e) => patch(r.id, { engine: e.target.value })}>
                      <option value="v1">v1 (legacy)</option>
                      <option value="shadow">shadow</option>
                      <option value="v2">v2</option>
                    </select>
                  </td>
                  <td>
                    <span className={`sa-pill ${on ? 'good' : r.adminDisabled ? 'crit' : 'slate'}`}>
                      {r.adminDisabled ? 'admin off' : !r.planAi ? 'not in plan' : !r.tenantAi ? 'tenant off' : 'on'}
                    </span>
                    {r.premiumLocked && <span className="sa-pill warn" style={{ marginLeft: 4 }}>locked</span>}
                  </td>
                  <td className="sa-mono">{money(r.costUsd)} / {money(r.billedUsd)}</td>
                  <td className="sa-mono">{r.aiReplies30d}</td>
                  <td className="sa-mono">{r.handoffPct != null ? `${r.handoffPct}%` : '—'}</td>
                  <td className="sa-mono">{r.downPct != null ? `${r.downPct}%` : '—'}</td>
                  <td className="sa-mono">{r.toolFailures30d}</td>
                  <td>
                    <input
                      className="sa-input"
                      style={{ width: 80 }}
                      type="number"
                      min={0}
                      defaultValue={r.adminCapCents != null ? r.adminCapCents / 100 : ''}
                      placeholder={String(r.defaultCapCents / 100)}
                      onBlur={(e) =>
                        patch(r.id, { adminCapCents: e.target.value === '' ? null : Math.round(Number(e.target.value) * 100) })
                      }
                    />
                  </td>
                  <td>
                    <button type="button" className={`sa-btn ${r.adminDisabled ? '' : 'danger'}`} onClick={() => patch(r.id, { adminDisabled: !r.adminDisabled })}>
                      {r.adminDisabled ? 'Enable AI' : 'Pause AI'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SaCard>
  );
}

function CostsTab({ call }: { call: Call }) {
  const [months, setMonths] = useState(3);
  const [rows, setRows] = useState<CostRow[] | null>(null);
  const [group, setGroup] = useState<'company' | 'feature' | 'model'>('company');
  useEffect(() => {
    setRows(null);
    call<CostRow[]>(`/super-admin/ai/costs?months=${months}`).then((r) => r && setRows(r));
  }, [call, months]);
  const grouped = useMemo(() => {
    const m = new Map<string, { key: string; calls: number; cost: number; billed: number; byPeriod: Record<string, number> }>();
    for (const r of rows ?? []) {
      const key = group === 'company' ? r.company : group === 'feature' ? r.feature : r.model;
      const g = m.get(key) ?? { key, calls: 0, cost: 0, billed: 0, byPeriod: {} };
      g.calls += r.calls;
      g.cost += r.costUsd;
      g.billed += r.billedUsd;
      g.byPeriod[r.period] = (g.byPeriod[r.period] ?? 0) + r.costUsd;
      m.set(key, g);
    }
    return Array.from(m.values()).sort((a, b) => b.cost - a.cost);
  }, [rows, group]);
  const periods = useMemo(() => Array.from(new Set((rows ?? []).map((r) => r.period))).sort(), [rows]);
  const max = Math.max(0.0001, ...grouped.map((g) => g.cost));
  return (
    <SaCard
      title="Cost explorer"
      right={
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="sa-seg">
            {(['company', 'feature', 'model'] as const).map((g) => (
              <button key={g} type="button" className={group === g ? 'on' : ''} onClick={() => setGroup(g)}>by {g}</button>
            ))}
          </div>
          <select className="sa-select" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            <option value={1}>This month</option>
            <option value={3}>3 months</option>
            <option value={6}>6 months</option>
            <option value={12}>12 months</option>
          </select>
        </div>
      }
    >
      {!rows ? (
        <SaSpinner />
      ) : grouped.length === 0 ? (
        <p className="sa-faint">No AI usage in this period.</p>
      ) : (
        <div className="sa-table-wrap">
          <table className="sa-table">
            <thead>
              <tr><th>{group}</th><th style={{ width: '30%' }} />{periods.map((p) => <th key={p}>{p}</th>)}<th>Calls</th><th>Cost</th><th>Billed</th><th>Margin</th></tr>
            </thead>
            <tbody>
              {grouped.map((g) => (
                <tr key={g.key}>
                  <td><b>{g.key}</b></td>
                  <td><div style={{ height: 8, borderRadius: 4, background: 'var(--sa-accent)', width: `${(g.cost / max) * 100}%`, minWidth: 2 }} /></td>
                  {periods.map((p) => <td key={p} className="sa-mono">{g.byPeriod[p] ? money(g.byPeriod[p]) : '—'}</td>)}
                  <td className="sa-mono">{g.calls.toLocaleString()}</td>
                  <td className="sa-mono">{money(g.cost)}</td>
                  <td className="sa-mono">{money(g.billed)}</td>
                  <td className="sa-mono">{money(g.billed - g.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SaCard>
  );
}

interface Quality {
  ungrounded: Array<{ company?: string; companyId: number; count: number }>;
  toolFailures: Array<{ company?: string; companyId: number; count: number }>;
  shadow: Array<{ company?: string; companyId: number; shadowTurns: number; v2Replies: number }>;
  downvoted: Array<{ company?: string; conversationId: number; reason: string | null; comment: string | null; message: string; at: string }>;
  evals: Array<{ id: number; pack: string; promptVersion: string; model: string; cases: number; passed: number; at: string; costUsd: number }>;
}

function QualityTab({ call }: { call: Call }) {
  const [q, setQ] = useState<Quality | null>(null);
  const [shadowFor, setShadowFor] = useState<number | null>(null);
  const [samples, setSamples] = useState<Array<Record<string, unknown>> | null>(null);
  useEffect(() => {
    call<Quality>('/super-admin/ai/quality').then(setQ);
  }, [call]);
  useEffect(() => {
    if (shadowFor == null) return;
    setSamples(null);
    call<Array<Record<string, unknown>>>(`/super-admin/ai/tenants/${shadowFor}/shadow`).then(setSamples);
  }, [call, shadowFor]);
  if (!q) return <SaSpinner />;
  const list = (rows: Array<{ company?: string; count: number }>) =>
    rows.length === 0 ? <p className="sa-faint">None in 30 days 🎉</p> : (
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 13 }}>
        {rows.map((r, i) => <li key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}><span>{r.company}</span><b className="sa-mono">{r.count}</b></li>)}
      </ul>
    );
  return (
    <>
      <div className="sa-grid-3">
        <SaCard title="Ungrounded prices (30d)">{list(q.ungrounded)}</SaCard>
        <SaCard title="Tool failures (30d)">{list(q.toolFailures)}</SaCard>
        <SaCard title="Shadow mode (v1 live, v2 dry)">
          {q.shadow.length === 0 ? <p className="sa-faint">No tenant in shadow.</p> : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 13 }}>
              {q.shadow.map((s) => (
                <li key={s.companyId} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                  <button type="button" className="sa-btn" onClick={() => setShadowFor(s.companyId)}>{s.company}</button>
                  <span className="sa-mono">{s.shadowTurns} turns</span>
                </li>
              ))}
            </ul>
          )}
        </SaCard>
      </div>
      {shadowFor != null && (
        <SaCard title="Shadow comparison — what v1 sent vs what v2 would have sent" right={<button type="button" className="sa-btn" onClick={() => setShadowFor(null)}>Close</button>}>
          {!samples ? <SaSpinner /> : samples.length === 0 ? <p className="sa-faint">No shadow turns yet.</p> : (
            <div className="sa-table-wrap">
              <table className="sa-table">
                <thead><tr><th>Customer</th><th>v1 (sent)</th><th>v2 (would send)</th></tr></thead>
                <tbody>
                  {samples.map((s, i) => (
                    <tr key={i}>
                      <td style={{ whiteSpace: 'pre-wrap', maxWidth: 260 }}>{String(s.customer ?? '')}</td>
                      <td style={{ whiteSpace: 'pre-wrap', maxWidth: 320 }}>{String(s.v1 ?? '—')}</td>
                      <td style={{ whiteSpace: 'pre-wrap', maxWidth: 320 }}>{String(s.v2 ?? '—')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SaCard>
      )}
      <SaCard title="Thumbs-down from agents (30d)">
        {q.downvoted.length === 0 ? <p className="sa-faint">No negative feedback.</p> : (
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead><tr><th>Tenant</th><th>AI message</th><th>Reason</th><th>When</th></tr></thead>
              <tbody>
                {q.downvoted.map((d, i) => (
                  <tr key={i}>
                    <td>{d.company}</td>
                    <td style={{ maxWidth: 420, whiteSpace: 'pre-wrap' }}>{d.message}</td>
                    <td>{d.reason ?? d.comment ?? '—'}</td>
                    <td className="sa-mono">{new Date(d.at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SaCard>
    </>
  );
}

interface PromptRow {
  id: number;
  prompt_key: string;
  version: string;
  body: string;
  status: string;
  eval_pass: number | null;
  created_by: string | null;
  created_at: string;
}

function PromptsTab({ call }: { call: Call }) {
  const [data, setData] = useState<{ keys: string[]; rows: PromptRow[] } | null>(null);
  const [key, setKey] = useState('agent.core');
  const [body, setBody] = useState('');
  const load = useCallback(() => call<{ keys: string[]; rows: PromptRow[] }>('/super-admin/ai/prompts').then((r) => r && setData(r)), [call]);
  useEffect(() => {
    load();
  }, [load]);
  if (!data) return <SaSpinner />;
  const draft = async () => {
    if (!body.trim()) return;
    await call('/super-admin/ai/prompts', { method: 'POST', body: { key, body } });
    setBody('');
    load();
  };
  const status = async (id: number, s: string) => {
    await call(`/super-admin/ai/prompts/${id}/status`, { method: 'POST', body: { status: s } });
    load();
  };
  return (
    <>
      <SaCard title="New override (draft)">
        <p className="sa-faint" style={{ fontSize: 12, marginTop: -4 }}>
          <b>agent.core</b> replaces the core rules for every tenant; <b>pack.&lt;industry&gt;</b> replaces that industry&apos;s domain rules. Run the pack&apos;s evals before going live. Code defaults are used when nothing is live.
        </p>
        <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
          <select className="sa-select" value={key} onChange={(e) => setKey(e.target.value)}>
            {data.keys.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        <textarea className="sa-input" rows={8} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Prompt text…" style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} />
        <div style={{ marginTop: 10 }}><button type="button" className="sa-btn primary" onClick={draft}>Save draft</button></div>
      </SaCard>
      <SaCard title="Versions">
        {data.rows.length === 0 ? <p className="sa-faint">No overrides — every prompt uses the code default.</p> : (
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead><tr><th>Key</th><th>Version</th><th>Status</th><th>Preview</th><th>By</th><th /></tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="sa-mono">{r.prompt_key}</td>
                    <td className="sa-mono">{r.version}</td>
                    <td><span className={`sa-pill ${r.status === 'live' ? 'good' : r.status === 'draft' ? 'info' : 'slate'}`}>{r.status}</span></td>
                    <td style={{ maxWidth: 380 }} className="sa-faint">{r.body.slice(0, 140)}…</td>
                    <td>{r.created_by}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {r.status !== 'live' && <button type="button" className="sa-btn primary" onClick={() => status(r.id, 'live')}>Publish</button>}{' '}
                      {r.status === 'live' && <button type="button" className="sa-btn danger" onClick={() => status(r.id, 'retired')}>Roll back</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SaCard>
    </>
  );
}

function EvalsTab({ call }: { call: Call }) {
  const [pack, setPack] = useState('ecommerce');
  const [companyId, setCompanyId] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ pack: string; cases: number; passed: number; results: Array<{ id: string; ok: boolean; fails: string[]; tools: string[]; reply: string }> } | null>(null);
  const [history, setHistory] = useState<Quality['evals'] | null>(null);
  useEffect(() => {
    call<Quality>('/super-admin/ai/quality').then((q) => q && setHistory(q.evals));
  }, [call, result]);
  const run = async () => {
    if (!companyId) return;
    setRunning(true);
    setResult(null);
    const r = await call<typeof result>('/super-admin/ai/evals/run', { method: 'POST', body: { pack, companyId: Number(companyId) } });
    setResult(r);
    setRunning(false);
  };
  return (
    <>
      <SaCard title="Run golden conversations">
        <p className="sa-faint" style={{ fontSize: 12, marginTop: -4 }}>
          Runs a pack&apos;s test conversations through the real agent (dry run — nothing is sent or created) against a tenant&apos;s knowledge and catalogue. Cost is recorded on the run, not billed to the tenant.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div><span style={lbl}>Pack</span><select className="sa-select" value={pack} onChange={(e) => setPack(e.target.value)}>{PACKS.map((x) => <option key={x} value={x}>{x}</option>)}</select></div>
          <div><span style={lbl}>Tenant id (data source)</span><input className="sa-input" style={{ width: 120 }} value={companyId} onChange={(e) => setCompanyId(e.target.value.replace(/\D/g, ''))} placeholder="e.g. 3" /></div>
          <button type="button" className="sa-btn primary" disabled={running || !companyId} onClick={run}>{running ? 'Running…' : 'Run evals'}</button>
        </div>
      </SaCard>
      {result && (
        <SaCard title={`${result.pack}: ${result.passed}/${result.cases} passed`}>
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead><tr><th>Case</th><th>Result</th><th>Tools</th><th>Reply</th></tr></thead>
              <tbody>
                {result.results.map((r) => (
                  <tr key={r.id}>
                    <td className="sa-mono">{r.id}</td>
                    <td>{r.ok ? <span className="sa-pill good">pass</span> : <span className="sa-pill crit" title={r.fails.join('\n')}>fail · {r.fails[0]}</span>}</td>
                    <td className="sa-mono" style={{ fontSize: 11 }}>{r.tools.join(', ') || '—'}</td>
                    <td style={{ maxWidth: 380, whiteSpace: 'pre-wrap', fontSize: 12 }}>{r.reply}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SaCard>
      )}
      <SaCard title="Eval history">
        {!history ? <SaSpinner /> : history.length === 0 ? <p className="sa-faint">No runs yet.</p> : (
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead><tr><th>Pack</th><th>Pass</th><th>Prompt</th><th>Model</th><th>Cost</th><th>When</th></tr></thead>
              <tbody>
                {history.map((e) => (
                  <tr key={e.id}>
                    <td>{e.pack}</td>
                    <td className="sa-mono">{e.passed}/{e.cases} ({Math.round((e.passed / Math.max(1, e.cases)) * 100)}%)</td>
                    <td className="sa-mono">{e.promptVersion}</td>
                    <td className="sa-mono">{e.model}</td>
                    <td className="sa-mono">${e.costUsd.toFixed(3)}</td>
                    <td className="sa-mono">{new Date(e.at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SaCard>
    </>
  );
}
