'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Settings, CheckCircle2 } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { PlatformSettings, UsageLimitAction } from '@/lib/crm-types';

export const dynamic = 'force-dynamic';

const OPTIONS: Array<{
  value: UsageLimitAction;
  title: string;
  desc: string;
}> = [
  {
    value: 'block',
    title: 'Block (hard limit)',
    desc: 'When a tenant hits a plan limit, the action is rejected (HTTP 403). This is the strict default.',
  },
  {
    value: 'warn_only',
    title: 'Warn only (soft limit)',
    desc: 'Tenants may exceed plan limits; the existing 80% warning webhook still fires. Use for trusted clients or grace periods.',
  },
];

type AiProvider = 'anthropic' | 'openai';

const PROVIDERS: Array<{ value: AiProvider; title: string; desc: string }> = [
  {
    value: 'anthropic',
    title: 'Anthropic (Claude)',
    desc: 'Haiku for fast tasks, Sonnet for summaries. Requires ANTHROPIC_API_KEY.',
  },
  {
    value: 'openai',
    title: 'OpenAI (GPT)',
    desc: 'GPT-4o mini for fast tasks, GPT-4o for summaries. Requires OPENAI_API_KEY.',
  },
];

type AiTier = 'fast' | 'smart';

const TIERS: Array<{ value: AiTier; title: string; desc: string }> = [
  {
    value: 'fast',
    title: 'Fast (cheaper)',
    desc: 'Haiku / GPT-4o-mini. Cheapest and quickest — good for high-volume auto-reply.',
  },
  {
    value: 'smart',
    title: 'Smart (higher quality)',
    desc: 'Sonnet / GPT-4o. Better judgment for auto-reply and auto-order at higher cost.',
  },
];

export default function SuperAdminSettingsPage() {
  const router = useRouter();
  const [value, setValue] = useState<UsageLimitAction>('block');
  const [provider, setProvider] = useState<AiProvider>('anthropic');
  const [tier, setTier] = useState<AiTier>('fast');
  const [agentIds, setAgentIds] = useState('*');
  const [engagementIds, setEngagementIds] = useState('');
  const [engagementMode, setEngagementMode] = useState<'shadow' | 'on'>(
    'shadow',
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const s = await apiFetch<PlatformSettings>('/super-admin/settings', {
        noOnboardingRedirect: true,
      });
      setValue(s.usageLimitAction);
      if (s.aiProvider === 'openai' || s.aiProvider === 'anthropic') {
        setProvider(s.aiProvider);
      }
      if (s.aiAutonomousTier === 'fast' || s.aiAutonomousTier === 'smart') {
        setTier(s.aiAutonomousTier);
      }
      if (typeof s.aiAgentCompanyIds === 'string') {
        setAgentIds(s.aiAgentCompanyIds);
      }
      if (typeof s.engagementCompanyIds === 'string') {
        setEngagementIds(s.engagementCompanyIds);
      }
      if (s.engagementMode === 'on' || s.engagementMode === 'shadow') {
        setEngagementMode(s.engagementMode);
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.replace('/super-admin/login');
        return;
      }
      setError(
        e instanceof ApiError ? e.userMessage : 'Failed to load settings',
      );
    } finally {
      setLoading(false);
    }
    // `router` deliberately omitted (unstable identity in Next 14).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await apiFetch('/super-admin/settings', {
        method: 'PATCH',
        body: {
          usageLimitAction: value,
          aiProvider: provider,
          aiAutonomousTier: tier,
          aiAgentCompanyIds: agentIds.trim(),
          engagementCompanyIds: engagementIds.trim(),
          engagementMode,
        },
        noOnboardingRedirect: true,
      });
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <span className="w-9 h-9 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center">
            <Settings size={18} />
          </span>
          Platform settings
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Platform-wide defaults. A per-client override (set from a client&apos;s
          Details panel) always takes precedence over the value here.
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <h3 className="text-sm font-semibold text-gray-900">
          Usage-limit behavior (default)
        </h3>
        <p className="text-gray-500 text-xs mt-0.5 mb-4">
          What happens when a tenant reaches a plan limit (contacts /
          templates) and has no per-client override.
        </p>

        {loading ? (
          <p className="text-gray-400 text-sm py-4">Loading…</p>
        ) : (
          <div className="space-y-3">
            {OPTIONS.map((o) => {
              const selected = value === o.value;
              return (
                <label
                  key={o.value}
                  className={cn(
                    'flex gap-3 rounded-lg border p-3 cursor-pointer transition-colors',
                    selected
                      ? 'border-green-500 bg-green-50/40 ring-1 ring-green-500'
                      : 'border-gray-200 hover:bg-gray-50',
                  )}
                >
                  <input
                    type="radio"
                    name="usageLimitAction"
                    className="mt-1 accent-green-600"
                    checked={selected}
                    onChange={() => {
                      setValue(o.value);
                      setSaved(false);
                    }}
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-gray-900">
                      {o.title}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {o.desc}
                    </div>
                  </div>
                </label>
              );
            })}

          </div>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <h3 className="text-sm font-semibold text-gray-900">AI provider</h3>
        <p className="text-gray-500 text-xs mt-0.5 mb-4">
          Which LLM backend powers the AI Copilot + auto-responder platform-wide.
          The selected provider&apos;s API key must be set in the server env.
        </p>

        {loading ? (
          <p className="text-gray-400 text-sm py-4">Loading…</p>
        ) : (
          <div className="space-y-3">
            {PROVIDERS.map((o) => {
              const selected = provider === o.value;
              return (
                <label
                  key={o.value}
                  className={cn(
                    'flex gap-3 rounded-lg border p-3 cursor-pointer transition-colors',
                    selected
                      ? 'border-violet-500 bg-violet-50/40 ring-1 ring-violet-500'
                      : 'border-gray-200 hover:bg-gray-50',
                  )}
                >
                  <input
                    type="radio"
                    name="aiProvider"
                    className="mt-1 accent-violet-600"
                    checked={selected}
                    onChange={() => {
                      setProvider(o.value);
                      setSaved(false);
                    }}
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-gray-900">
                      {o.title}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">{o.desc}</div>
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <h3 className="text-sm font-semibold text-gray-900">
          Default AI quality for new tenants
        </h3>
        <p className="text-gray-500 text-xs mt-0.5 mb-4">
          The fallback model for the automated features (AI auto-reply &amp;
          auto-order) used ONLY when a tenant hasn&apos;t chosen their own AI
          quality in Settings → AI. Each tenant can now override this themselves
          (they pay for it); use a client&apos;s &ldquo;Restrict premium
          AI&rdquo; switch to force one back to Standard.
        </p>

        {loading ? (
          <p className="text-gray-400 text-sm py-4">Loading…</p>
        ) : (
          <div className="space-y-3">
            {TIERS.map((o) => {
              const selected = tier === o.value;
              return (
                <label
                  key={o.value}
                  className={cn(
                    'flex gap-3 rounded-lg border p-3 cursor-pointer transition-colors',
                    selected
                      ? 'border-violet-500 bg-violet-50/40 ring-1 ring-violet-500'
                      : 'border-gray-200 hover:bg-gray-50',
                  )}
                >
                  <input
                    type="radio"
                    name="aiAutonomousTier"
                    className="mt-1 accent-violet-600"
                    checked={selected}
                    onChange={() => {
                      setTier(o.value);
                      setSaved(false);
                    }}
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-gray-900">
                      {o.title}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">{o.desc}</div>
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <h3 className="text-sm font-semibold text-gray-900">
          AI Agent rollout
        </h3>
        <p className="text-gray-500 text-xs mt-0.5 mb-4">
          The tool-calling orchestrator that answers customer chats (triage +
          sales / order / logistics / resolution specialists). This is the only
          brain &mdash; there is no fallback, so a tenant left out of this list
          gets <span className="font-medium">no AI replies at all</span> even
          with their own AI toggles on. Use it as the platform-level brake.
        </p>

        {loading ? (
          <p className="text-gray-400 text-sm py-4">Loading&hellip;</p>
        ) : (
          <div>
            <label className="text-xs font-medium text-gray-700">
              Enabled for (company IDs)
            </label>
            <input
              type="text"
              value={agentIds}
              onChange={(e) => {
                setAgentIds(e.target.value);
                setSaved(false);
              }}
              placeholder="* = all (default) · blank = off everywhere · or 3,7,12"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-violet-500 focus:ring-1 focus:ring-violet-500 outline-none"
            />
            <p className="text-xs text-gray-400 mt-1.5">
              <code className="font-mono">*</code> = every tenant (the default)
              &middot; blank = AI replies off platform-wide &middot; or a
              comma-separated list of company IDs.
            </p>
            {agentIds.trim() === '' && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
                AI auto-replies are currently disabled for every tenant.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <h3 className="text-sm font-semibold text-gray-900">
          Engagement engine (experimental)
        </h3>
        <p className="text-gray-500 text-xs mt-0.5 mb-4">
          The new work-item conversation engine (per-message routing + isolated
          context). Default OFF for everyone. Enter tenant company IDs to enable
          it for, or <code className="font-mono">*</code> for all tenants; leave
          blank to disable everywhere.
        </p>

        {loading ? (
          <p className="text-gray-400 text-sm py-4">Loading…</p>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="text-xs font-medium text-gray-700">
                Enabled for (company IDs)
              </label>
              <input
                type="text"
                value={engagementIds}
                onChange={(e) => {
                  setEngagementIds(e.target.value);
                  setSaved(false);
                }}
                placeholder="blank = off · * = all · or 3,7,12"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-violet-500 focus:ring-1 focus:ring-violet-500 outline-none"
              />
            </div>

            <div>
              <div className="text-xs font-medium text-gray-700 mb-2">
                Mode (applies to the enabled tenants)
              </div>
              <div className="space-y-3">
                {[
                  {
                    value: 'shadow' as const,
                    title: 'Shadow (safe — observe only)',
                    desc: 'Runs the new engine in the background: builds work items and tags messages, but does NOT change any replies. Use this first to watch routing before going live.',
                  },
                  {
                    value: 'on' as const,
                    title: 'On (authoritative — changes live replies)',
                    desc: 'The work item drives the specialist + hard-scopes context. This changes how the AI replies for the enabled tenants. Only flip after Shadow looks correct.',
                  },
                ].map((o) => {
                  const selected = engagementMode === o.value;
                  return (
                    <label
                      key={o.value}
                      className={cn(
                        'flex gap-3 rounded-lg border p-3 cursor-pointer transition-colors',
                        selected
                          ? o.value === 'on'
                            ? 'border-amber-500 bg-amber-50/40 ring-1 ring-amber-500'
                            : 'border-violet-500 bg-violet-50/40 ring-1 ring-violet-500'
                          : 'border-gray-200 hover:bg-gray-50',
                      )}
                    >
                      <input
                        type="radio"
                        name="engagementMode"
                        className="mt-1 accent-violet-600"
                        checked={selected}
                        onChange={() => {
                          setEngagementMode(o.value);
                          setSaved(false);
                        }}
                      />
                      <div className="flex-1">
                        <div className="text-sm font-medium text-gray-900">
                          {o.title}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {o.desc}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {!loading && (
        <div className="flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-green-600 hover:bg-green-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 shadow-sm"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved && (
            <span className="text-sm text-green-700 flex items-center gap-1">
              <CheckCircle2 size={14} /> Saved.
            </span>
          )}
        </div>
      )}

      {/* Enterprise-hardening platform defaults (#increment 11) — auto-saves. */}
    </div>
  );
}
