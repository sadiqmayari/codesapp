'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { getGameConfig, updateGameConfig, type GameConfig } from '@/lib/gamification';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import { SaveBar } from '@/components/ui/save-bar';
import { FormField, Rows, SettingRow, SettingsCard, SettingsPage, SettingsSkeleton, inputCls } from './shared';

// ── Competition (gamification) config tab ────────────────────────────────
// Owner/admin only. Edits the point weights, speed thresholds, and badge
// thresholds that drive the Leaderboard. Feeds PATCH /gamification/settings.
export function CompetitionSection() {
  const toast = useToast();
  const [config, setConfig] = useState<GameConfig | null>(null);
  const [saved, setSaved] = useState<GameConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getGameConfig()
      .then((c) => {
        setConfig(c);
        setSaved(c);
      })
      .catch((e) =>
        toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load'),
      )
      .finally(() => setLoading(false));
  }, [toast]);

  const setPoint = (key: keyof GameConfig['points'], value: number) =>
    setConfig((c) => (c ? { ...c, points: { ...c.points, [key]: value } } : c));
  const setSpeed = (key: keyof GameConfig['speed'], value: number) =>
    setConfig((c) => (c ? { ...c, speed: { ...c.speed, [key]: value } } : c));
  const setBadge = (idx: number, patch: Partial<GameConfig['badges'][number]>) =>
    setConfig((c) =>
      c
        ? {
            ...c,
            badges: c.badges.map((b, i) => (i === idx ? { ...b, ...patch } : b)),
          }
        : c,
    );

  const save = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const next = await updateGameConfig(config);
      setConfig(next);
      setSaved(next);
      toast.success('Competition settings saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading || !config) return <SettingsSkeleton cards={3} />;
  const dirty = JSON.stringify(config) !== JSON.stringify(saved);

  const pointFields: Array<[keyof GameConfig['points'], string, string]> = [
    ['perOrder', 'Points per order', 'Awarded for each order an agent creates'],
    ['perRevenue1000', 'Points per 1,000 revenue', 'Scales with order value'],
    ['perChat', 'Points per chat handled', 'Rewards throughput'],
    ['perCartRecovered', 'Points per cart recovered', 'Assigned abandoned cart that converted'],
    ['conversionBonusMax', 'Max conversion bonus', '× the agent’s conversion rate'],
    ['speedBonusMax', 'Max speed bonus', 'Full when replies are fast (see below)'],
  ];

  const num = cn(inputCls, 'w-24 text-right tabular-nums');
  return (
    <SettingsPage
      title="Competition"
      description="How the leaderboard turns agent activity into points. Changes apply the next time the board loads."
    >
      <SettingsCard title="Point weights">
        <Rows>
          {pointFields.map(([key, label, hint]) => (
            <SettingRow key={key} title={label} description={hint}>
              <input
                type="number"
                min={0}
                aria-label={label}
                value={config.points[key]}
                onChange={(e) => setPoint(key, Number(e.target.value))}
                className={num}
              />
            </SettingRow>
          ))}
        </Rows>
      </SettingsCard>

      <SettingsCard
        title="Response-speed bonus"
        description="Full bonus at or under the fast threshold, tapering to zero at the slow threshold."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Fast threshold (seconds)" htmlFor="sp-fast">
            <input
              id="sp-fast"
              type="number"
              min={0}
              value={config.speed.fastSec}
              onChange={(e) => setSpeed('fastSec', Number(e.target.value))}
              className={inputCls}
            />
          </FormField>
          <FormField label="Slow threshold (seconds)" htmlFor="sp-slow">
            <input
              id="sp-slow"
              type="number"
              min={0}
              value={config.speed.slowSec}
              onChange={(e) => setSpeed('slowSec', Number(e.target.value))}
              className={inputCls}
            />
          </FormField>
        </div>
      </SettingsCard>

      <SettingsCard title="Badges" description="Each badge’s name and the threshold an agent must hit to earn it.">
        <Rows>
          {config.badges.map((b, i) => (
            <div key={b.id} className="flex flex-wrap items-center gap-2">
              <input
                value={b.label}
                aria-label="Badge name"
                onChange={(e) => setBadge(i, { label: e.target.value })}
                className={cn(inputCls, 'min-w-[160px] flex-1')}
              />
              <span className="whitespace-nowrap text-xs text-muted">
                {b.type === 'rank' ? 'rank in ' : ''}
                {b.metric} {b.op}
              </span>
              <input
                type="number"
                aria-label={`${b.label} threshold`}
                value={b.threshold}
                onChange={(e) => setBadge(i, { threshold: Number(e.target.value) })}
                className={num}
              />
            </div>
          ))}
        </Rows>
      </SettingsCard>

      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={() => setConfig(saved)} />
    </SettingsPage>
  );
}
