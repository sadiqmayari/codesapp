'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import type { PlatformSettings, UsageLimitAction } from '@/lib/crm-types';
import { SaCard, SaPageHeader, SaSpinner } from '../_components/sa-ui';

export const dynamic = 'force-dynamic';

const OPTIONS: Array<{ value: UsageLimitAction; title: string; desc: string }> = [
  { value: 'block', title: 'Block (hard limit)', desc: 'When a tenant hits a plan limit, the action is rejected (HTTP 403). This is the strict default.' },
  { value: 'warn_only', title: 'Warn only (soft limit)', desc: 'Tenants may exceed plan limits; the 80% warning webhook still fires. Use for trusted clients or grace periods.' },
];

type AiProvider = 'anthropic' | 'openai';
const PROVIDERS: Array<{ value: AiProvider; title: string; desc: string }> = [
  { value: 'anthropic', title: 'Anthropic (Claude)', desc: 'Haiku for fast tasks, Sonnet for summaries. Requires ANTHROPIC_API_KEY.' },
  { value: 'openai', title: 'OpenAI (GPT)', desc: 'GPT-4o mini for fast tasks, GPT-4o for summaries. Requires OPENAI_API_KEY.' },
];

type AiTier = 'fast' | 'smart';
const TIERS: Array<{ value: AiTier; title: string; desc: string }> = [
  { value: 'fast', title: 'Fast (cheaper)', desc: 'Haiku / GPT-4o-mini. Cheapest and quickest — good for high-volume auto-reply.' },
  { value: 'smart', title: 'Smart (higher quality)', desc: 'Sonnet / GPT-4o. Better judgment for auto-reply and auto-order at higher cost.' },
];

function RadioCard<T extends string>({
  name,
  option,
  selected,
  onSelect,
}: {
  name: string;
  option: { value: T; title: string; desc: string };
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      style={{
        display: 'flex',
        gap: 12,
        borderRadius: 9,
        padding: 12,
        cursor: 'pointer',
        border: `1px solid ${selected ? 'var(--sa-accent)' : 'var(--sa-border)'}`,
        background: selected ? 'var(--sa-accent-wash)' : 'transparent',
      }}
    >
      <input type="radio" name={name} style={{ marginTop: 3, accentColor: 'var(--sa-accent)' }} checked={selected} onChange={onSelect} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{option.title}</div>
        <div className="sa-faint" style={{ fontSize: 12, marginTop: 2 }}>{option.desc}</div>
      </div>
    </label>
  );
}

export default function SuperAdminSettingsPage() {
  const router = useRouter();
  const [value, setValue] = useState<UsageLimitAction>('block');
  const [provider, setProvider] = useState<AiProvider>('anthropic');
  const [tier, setTier] = useState<AiTier>('fast');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const s = await apiFetch<PlatformSettings>('/super-admin/settings', { noOnboardingRedirect: true });
      setValue(s.usageLimitAction);
      if (s.aiProvider === 'openai' || s.aiProvider === 'anthropic') setProvider(s.aiProvider);
      if (s.aiAutonomousTier === 'fast' || s.aiAutonomousTier === 'smart') setTier(s.aiAutonomousTier);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.replace('/super-admin/login');
        return;
      }
      setError(e instanceof ApiError ? e.userMessage : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
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
        body: { usageLimitAction: value, aiProvider: provider, aiAutonomousTier: tier },
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
    <div className="sa-content" style={{ maxWidth: 820 }}>
      <SaPageHeader
        title="Platform settings"
        subtitle="Platform-wide defaults. A per-client override (set from a client's profile) always takes precedence."
      />

      {error && <div className="sa-alert-error">{error}</div>}

      <SaCard title="Usage-limit behavior (default)">
        <p className="sa-faint" style={{ fontSize: 12, marginTop: -4, marginBottom: 14 }}>
          What happens when a tenant reaches a plan limit (contacts / templates) and has no per-client override.
        </p>
        {loading ? <SaSpinner pad={16} /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {OPTIONS.map((o) => (
              <RadioCard key={o.value} name="usageLimitAction" option={o} selected={value === o.value}
                onSelect={() => { setValue(o.value); setSaved(false); }} />
            ))}
          </div>
        )}
      </SaCard>

      <SaCard title="AI provider">
        <p className="sa-faint" style={{ fontSize: 12, marginTop: -4, marginBottom: 14 }}>
          Which LLM backend powers the AI Copilot + auto-responder platform-wide. The selected provider&apos;s API key must be set in the server env.
        </p>
        {loading ? <SaSpinner pad={16} /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {PROVIDERS.map((o) => (
              <RadioCard key={o.value} name="aiProvider" option={o} selected={provider === o.value}
                onSelect={() => { setProvider(o.value); setSaved(false); }} />
            ))}
          </div>
        )}
      </SaCard>

      <SaCard title="Default AI quality for new tenants">
        <p className="sa-faint" style={{ fontSize: 12, marginTop: -4, marginBottom: 14 }}>
          Fallback model for automated features (AI auto-reply &amp; auto-order), used only when a tenant hasn&apos;t chosen their own AI quality in Settings → AI.
        </p>
        {loading ? <SaSpinner pad={16} /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {TIERS.map((o) => (
              <RadioCard key={o.value} name="aiAutonomousTier" option={o} selected={tier === o.value}
                onSelect={() => { setTier(o.value); setSaved(false); }} />
            ))}
          </div>
        )}
      </SaCard>

      {!loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="sa-btn primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved && (
            <span style={{ fontSize: 13, color: 'var(--sa-good)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <CheckCircle2 size={14} /> Saved.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
