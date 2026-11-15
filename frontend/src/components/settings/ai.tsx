'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Lock } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  aiGetSettings,
  aiUpdateSettings,
  aiGetUsage,
  type AiSettings,
  type AiUsage,
} from '@/lib/ai';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { SaveBar } from '@/components/ui/save-bar';
import {
  Callout,
  FormField,
  Rows,
  SettingRow,
  SettingsCard,
  SettingsPage,
  SettingsSkeleton,
  inputCls,
} from './shared';

type Tier = 'default' | 'fast' | 'smart';
interface AiForm {
  enabled: boolean;
  autoReply: boolean;
  autoOrder: boolean;
  autoOrderAll: boolean;
  tone: string;
  lang: string;
  capDollars: string;
  tier: Tier;
  vision: boolean;
  voice: boolean;
}

function toForm(s: AiSettings): AiForm {
  return {
    enabled: s.aiEnabled,
    autoReply: s.autoReplyEnabled,
    autoOrder: s.autoOrderEnabled,
    autoOrderAll: s.autoOrderAllEnabled,
    tone: s.brandTone ?? '',
    lang: s.defaultLanguage ?? '',
    capDollars: s.monthlyCapCents != null ? (s.monthlyCapCents / 100).toString() : '',
    tier: s.aiTier ?? 'default',
    vision: s.visionEnabled,
    voice: s.voiceEnabled,
  };
}

/**
 * Settings → AI assistant (owner/admin). Workspace AI switches, automation,
 * quality, style and the monthly cap. The knowledge base is its own section
 * (agents can edit it; they never see these settings).
 */
export function AiSection() {
  const toast = useToast();
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [base, setBase] = useState<AiForm | null>(null);
  const [form, setForm] = useState<AiForm | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, u] = await Promise.all([aiGetSettings(), aiGetUsage().catch(() => null)]);
      setSettings(s);
      setBase(toForm(s));
      setForm(toForm(s));
      setUsage(u);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load AI settings');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <SettingsSkeleton cards={3} />;

  if (!settings || !form) {
    return (
      <SettingsPage title="AI assistant">
        <Callout tone="warn">Couldn’t load the AI settings. Refresh to try again.</Callout>
      </SettingsPage>
    );
  }

  if (!settings.planAiEnabled) {
    return (
      <SettingsPage title="AI assistant" description="Suggested replies, rewrites, summaries and auto-pilot.">
        <Callout tone="warn" icon={<Lock size={15} />}>
          <b>AI isn’t included in your current plan.</b> Contact your account manager to turn it on.
        </Callout>
      </SettingsPage>
    );
  }

  const set = (p: Partial<AiForm>) => setForm((f) => (f ? { ...f, ...p } : f));
  const dirty = JSON.stringify(form) !== JSON.stringify(base);
  const locked = !!settings.premiumLocked;

  const save = async () => {
    const capTrim = form.capDollars.trim();
    const monthlyCapCents = capTrim === '' ? null : Math.round(parseFloat(capTrim) * 100);
    if (monthlyCapCents != null && (isNaN(monthlyCapCents) || monthlyCapCents < 0)) {
      toast.error('Enter a valid monthly cap.');
      return;
    }
    setSaving(true);
    try {
      const updated = await aiUpdateSettings({
        aiEnabled: form.enabled,
        autoReplyEnabled: form.autoReply,
        autoOrderEnabled: form.autoOrder,
        autoOrderAllEnabled: form.autoOrderAll,
        brandTone: form.tone.trim() ? form.tone.trim() : null,
        defaultLanguage: form.lang.trim() ? form.lang.trim() : null,
        monthlyCapCents,
        aiTier: form.tier === 'default' ? null : form.tier,
        visionEnabled: form.vision,
        voiceEnabled: form.voice,
      });
      setSettings(updated);
      setBase(toForm(updated));
      setForm(toForm(updated));
      toast.success('AI settings saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const billed = usage ? usage.billedCents / 100 : 0;
  const capUsd = usage && usage.capCents > 0 ? usage.capCents / 100 : null;
  const pct = capUsd ? Math.min(100, Math.round((billed / capUsd) * 100)) : null;
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  const est = settings.estimates;

  const tiers: Array<{ value: Tier; title: string; note: string; cost?: string }> = [
    {
      value: 'fast',
      title: 'Standard',
      note: 'Best value — great for everyday replies and orders.',
      cost: `≈ $${est.standardPer1kRepliesUsd.toFixed(2)} / 1,000 replies`,
    },
    {
      value: 'smart',
      title: 'High-accuracy',
      note: 'Sharper on multi-product orders, tricky addresses and Roman Urdu.',
      cost: `≈ $${est.highAccuracyPer1kRepliesUsd.toFixed(2)} / 1,000 replies`,
    },
    { value: 'default', title: 'Recommended', note: 'Follow the platform’s default quality.' },
  ];

  return (
    <SettingsPage
      title="AI assistant"
      description="Suggested replies, rewrites, translations and summaries in the inbox — plus optional auto-pilot."
      actions={
        <>
          <span className="text-sm font-semibold text-muted">{form.enabled ? 'On' : 'Off'}</span>
          <Switch checked={form.enabled} onChange={(v) => set({ enabled: v })} label="AI for this workspace" />
        </>
      }
    >
      <SettingsCard title="This month" description="Usage resets on the 1st. Spend is what you’re billed.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['Requests', (usage?.requests ?? 0).toLocaleString()],
            ['Tokens', tokens.toLocaleString()],
            ['Spend', `$${billed.toFixed(2)}`],
            ['Cap', capUsd ? `$${capUsd.toFixed(2)}` : 'No cap'],
          ].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-line px-3.5 py-2.5">
              <p className="text-xs font-semibold text-muted">{k}</p>
              <p className="mt-0.5 text-lg font-extrabold tabular-nums text-ink">{v}</p>
            </div>
          ))}
        </div>
        {pct != null && (
          <div>
            <div className="h-2 overflow-hidden rounded-full bg-sunken" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Share of monthly cap used">
              <div
                className={cn('h-full rounded-full', pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-brand-600')}
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs text-muted">{pct}% of your monthly cap used</p>
          </div>
        )}
      </SettingsCard>

      <fieldset disabled={!form.enabled} className="flex flex-col gap-5 disabled:opacity-60">
        <SettingsCard title="Automation" description="What the AI may do on its own. Nothing is ever sent outside the 24-hour window.">
          <Rows>
            <SettingRow
              title="Auto-reply to customers"
              description="Answers chats no keyword bot handled and no agent is assigned to. It hands off to a human (pending + needs-human) whenever it’s unsure. Each chat can override this."
            >
              <Switch checked={form.autoReply} onChange={(v) => set({ autoReply: v })} label="Auto-reply to customers" disabled={!form.enabled} />
            </SettingRow>
            <SettingRow
              title="Let the AI create store orders"
              description="On auto-pilot chats, once the order is complete the AI sends a summary and creates it only after the customer confirms. One order per chat, tagged “AI auto-order”."
            >
              <Switch checked={form.autoOrder} onChange={(v) => set({ autoOrder: v })} label="Let the AI create store orders" disabled={!form.enabled} />
            </SettingRow>
            <SettingRow
              title="…on every auto-replied chat"
              description={
                form.autoReply && form.autoOrder
                  ? 'Not just chats you put on auto-pilot — any chat the AI auto-replies to can place an order.'
                  : 'Needs both switches above on.'
              }
            >
              <Switch
                checked={form.autoOrderAll}
                onChange={(v) => set({ autoOrderAll: v })}
                label="Auto-create orders on every auto-replied chat"
                disabled={!form.enabled || !form.autoReply}
              />
            </SettingRow>
          </Rows>
        </SettingsCard>

        <SettingsCard
          title="Quality"
          description="Used for auto-replies and order handling. You pay for what the AI uses."
          action={locked ? <Badge tone="warn">Premium restricted</Badge> : undefined}
        >
          {locked && (
            <Callout tone="warn" icon={<Lock size={15} />}>
              High-accuracy, photo reading and voice notes are restricted for your account. Contact support to lift this.
            </Callout>
          )}
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="AI quality">
            {tiers.map((t) => (
              <label
                key={t.value}
                className={cn(
                  'flex cursor-pointer flex-col gap-1 rounded-xl border p-3',
                  form.tier === t.value ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/30' : 'border-line hover:bg-sunken',
                  locked && 'pointer-events-none opacity-50',
                )}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="ai-tier"
                    checked={form.tier === t.value}
                    onChange={() => set({ tier: t.value })}
                    disabled={locked}
                    className="accent-brand-600"
                  />
                  <span className="text-sm font-bold text-ink">{t.title}</span>
                </span>
                <span className="text-xs text-muted">{t.note}</span>
                {t.cost && <span className="text-xs font-semibold text-violet-700 dark:text-violet-300">{t.cost}</span>}
              </label>
            ))}
          </div>
          <Rows>
            <SettingRow
              title="Read customer photos"
              description={`Matches product photos customers send · ≈ $${est.visionPer100PhotosUsd.toFixed(2)} per 100 photos`}
            >
              <Switch checked={form.vision} onChange={(v) => set({ vision: v })} label="Read customer photos" disabled={!form.enabled || locked} />
            </SettingRow>
            <SettingRow
              title="Understand voice notes"
              description={`Transcribes voice notes so the AI can act on them · ≈ $${est.voicePerMinuteUsd.toFixed(3)} per minute`}
            >
              <Switch checked={form.voice} onChange={(v) => set({ voice: v })} label="Understand voice notes" disabled={!form.enabled || locked} />
            </SettingRow>
          </Rows>
        </SettingsCard>

        <SettingsCard title="Style & limits">
          <FormField label="Brand voice" htmlFor="ai-tone" hint="Shapes how suggested replies and rewrites are written.">
            <textarea
              id="ai-tone"
              value={form.tone}
              onChange={(e) => set({ tone: e.target.value })}
              rows={3}
              maxLength={2000}
              placeholder="e.g. Friendly and concise. Use simple words. Always thank the customer."
              className={inputCls}
            />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Default reply language" htmlFor="ai-lang">
              <input
                id="ai-lang"
                value={form.lang}
                onChange={(e) => set({ lang: e.target.value })}
                placeholder="e.g. English, Urdu, Roman Urdu"
                className={inputCls}
              />
            </FormField>
            <FormField
              label="Monthly spend cap (USD)"
              htmlFor="ai-cap"
              hint="AI stops for the month when reached. Blank = platform default ($20); 0 = no cap."
            >
              <input
                id="ai-cap"
                value={form.capDollars}
                onChange={(e) => set({ capDollars: e.target.value })}
                inputMode="decimal"
                placeholder="20"
                className={cn(inputCls, 'tabular-nums')}
              />
            </FormField>
          </div>
        </SettingsCard>
      </fieldset>

      <p className="text-[13px] text-muted">
        What the AI knows about your products and policies lives in the{' '}
        <Link href="/settings/knowledge" className="font-semibold text-brand-700 hover:underline dark:text-brand-300">
          Knowledge base
        </Link>
        .
      </p>

      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={() => setForm(base)} />
    </SettingsPage>
  );
}
