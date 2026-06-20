'use client';

import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Power, Loader2 } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';

/**
 * Super-admin per-tenant hardening feature flags (#increment 11). Renders the
 * GET /super-admin/clients/:id/features grid and PATCHes a single override
 * ({ key, value: 'on'|'off'|null }). Two groups by semantics:
 *  - 'enable' guards: Inherit / On / Off (default OFF).
 *  - 'kill' switches: Inherit / Run / Killed (default ON; "Killed" is the brake).
 */

type Semantics = 'enable' | 'kill';
type Override = 'on' | 'off' | null;

interface FeatureFlag {
  key: string;
  label: string;
  description: string;
  semantics: Semantics;
  override: Override;
  platformDefaultOn: boolean;
  effectiveEnabled: boolean;
}

export function FeatureFlags({ clientId }: { clientId: number }) {
  const toast = useToast();
  const [flags, setFlags] = useState<FeatureFlag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ features: FeatureFlag[] }>(
        `/super-admin/clients/${clientId}/features`,
      );
      setFlags(res.features);
      setError(null);
    } catch (e) {
      setError(
        e instanceof ApiError ? e.userMessage : 'Failed to load feature flags',
      );
    }
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const setOverride = async (flag: FeatureFlag, value: Override) => {
    if (flag.override === value || busyKey) return;
    setBusyKey(flag.key);
    try {
      const res = await apiFetch<{ features: FeatureFlag[] }>(
        `/super-admin/clients/${clientId}/features`,
        { method: 'PATCH', body: { key: flag.key, value } },
      );
      setFlags(res.features);
      toast.success(`${flag.label} updated`);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to update flag',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const setBulk = async (group: 'guards' | 'kills', value: Override) => {
    if (busyKey) return;
    setBusyKey(`bulk:${group}`);
    try {
      const res = await apiFetch<{ features: FeatureFlag[] }>(
        `/super-admin/clients/${clientId}/features/bulk`,
        { method: 'PATCH', body: { group, value } },
      );
      setFlags(res.features);
      toast.success(`All ${group} updated`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Bulk update failed');
    } finally {
      setBusyKey(null);
    }
  };

  const guards = flags?.filter((f) => f.semantics === 'enable') ?? [];
  const kills = flags?.filter((f) => f.semantics === 'kill') ?? [];

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck className="h-4 w-4 text-emerald-600" />
        <h3 className="text-sm font-semibold text-gray-900">
          Hardening feature flags
        </h3>
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Per-tenant overrides for the safety guards and emergency kill switches.
        <span className="font-medium"> Inherit</span> follows the platform
        default; set <span className="font-medium">On/Off</span> to force this
        client. Kill switches take effect within ~30s.
      </p>

      {error && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
          {error}
        </div>
      )}
      {!flags && !error && (
        <div className="flex items-center gap-2 text-xs text-gray-400 py-4">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}

      {flags && (
        <div className="space-y-5">
          <FlagGroup
            heading="Safety guards"
            group="guards"
            icon={<ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />}
            flags={guards}
            busyKey={busyKey}
            onSet={setOverride}
            onBulk={setBulk}
          />
          <FlagGroup
            heading="Emergency kill switches"
            group="kills"
            icon={<Power className="h-3.5 w-3.5 text-red-600" />}
            flags={kills}
            busyKey={busyKey}
            onSet={setOverride}
            onBulk={setBulk}
          />
        </div>
      )}
    </div>
  );
}

function FlagGroup({
  heading,
  group,
  icon,
  flags,
  busyKey,
  onSet,
  onBulk,
}: {
  heading: string;
  group: 'guards' | 'kills';
  icon: React.ReactNode;
  flags: FeatureFlag[];
  busyKey: string | null;
  onSet: (flag: FeatureFlag, value: Override) => void;
  onBulk: (group: 'guards' | 'kills', value: Override) => void;
}) {
  if (flags.length === 0) return null;
  const isKill = group === 'kills';
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          {icon}
          {heading}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
          <span>All:</span>
          <div className="flex rounded-md border border-gray-200 overflow-hidden">
            <BulkBtn onClick={() => onBulk(group, null)} disabled={busyKey !== null} tone="neutral">
              Inherit
            </BulkBtn>
            <BulkBtn
              onClick={() => onBulk(group, 'on')}
              disabled={busyKey !== null}
              tone={isKill ? 'neutral' : 'good'}
            >
              {isKill ? 'Run' : 'On'}
            </BulkBtn>
            <BulkBtn
              onClick={() => onBulk(group, 'off')}
              disabled={busyKey !== null}
              tone={isKill ? 'bad' : 'neutral'}
            >
              {isKill ? 'Kill' : 'Off'}
            </BulkBtn>
          </div>
        </div>
      </div>
      <div className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
        {flags.map((f) => (
          <FlagRow
            key={f.key}
            flag={f}
            busy={busyKey === f.key}
            disabled={busyKey !== null}
            onSet={onSet}
          />
        ))}
      </div>
    </div>
  );
}

function FlagRow({
  flag,
  busy,
  disabled,
  onSet,
}: {
  flag: FeatureFlag;
  busy: boolean;
  disabled: boolean;
  onSet: (flag: FeatureFlag, value: Override) => void;
}) {
  const isKill = flag.semantics === 'kill';
  // For a kill switch the "on" state means "runs"; "off" means "killed" (brake).
  const onLabel = isKill ? 'Run' : 'On';
  const offLabel = isKill ? 'Killed' : 'Off';

  return (
    <div className="flex items-start justify-between gap-4 px-3 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-800">{flag.label}</span>
          <span
            className={cn(
              'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
              flag.effectiveEnabled
                ? isKill
                  ? 'bg-gray-100 text-gray-600'
                  : 'bg-emerald-50 text-emerald-700'
                : isKill
                  ? 'bg-red-50 text-red-700'
                  : 'bg-gray-100 text-gray-500',
            )}
          >
            {flag.effectiveEnabled ? (isKill ? 'Running' : 'Enabled') : isKill ? 'Killed' : 'Disabled'}
          </span>
          {busy && <Loader2 className="h-3 w-3 animate-spin text-gray-400" />}
        </div>
        <p className="text-[11px] text-gray-400 mt-0.5 line-clamp-2">
          {flag.description}
        </p>
        <p className="text-[10px] text-gray-400 mt-0.5">
          Platform default: {flag.platformDefaultOn ? (isKill ? 'Running' : 'On') : isKill ? 'Killed' : 'Off'}
        </p>
      </div>

      <div className="flex shrink-0 rounded-lg border border-gray-200 overflow-hidden text-xs">
        <Seg
          active={flag.override === null}
          onClick={() => onSet(flag, null)}
          disabled={disabled}
          tone="neutral"
        >
          Inherit
        </Seg>
        <Seg
          active={flag.override === 'on'}
          onClick={() => onSet(flag, 'on')}
          disabled={disabled}
          tone={isKill ? 'neutral' : 'good'}
        >
          {onLabel}
        </Seg>
        <Seg
          active={flag.override === 'off'}
          onClick={() => onSet(flag, 'off')}
          disabled={disabled}
          tone={isKill ? 'bad' : 'neutral'}
        >
          {offLabel}
        </Seg>
      </div>
    </div>
  );
}

function BulkBtn({
  onClick,
  disabled,
  tone,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  tone: 'neutral' | 'good' | 'bad';
  children: React.ReactNode;
}) {
  const hover =
    tone === 'good'
      ? 'hover:bg-emerald-50 hover:text-emerald-700'
      : tone === 'bad'
        ? 'hover:bg-red-50 hover:text-red-700'
        : 'hover:bg-gray-50';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'px-2 py-0.5 border-l first:border-l-0 border-gray-200 bg-white text-gray-600 transition-colors disabled:opacity-50',
        hover,
      )}
    >
      {children}
    </button>
  );
}

function Seg({
  active,
  onClick,
  disabled,
  tone,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled: boolean;
  tone: 'neutral' | 'good' | 'bad';
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'px-2.5 py-1 border-l first:border-l-0 border-gray-200 transition-colors disabled:opacity-50',
        active
          ? tone === 'good'
            ? 'bg-emerald-600 text-white'
            : tone === 'bad'
              ? 'bg-red-600 text-white'
              : 'bg-gray-800 text-white'
          : 'bg-white text-gray-600 hover:bg-gray-50',
      )}
    >
      {children}
    </button>
  );
}
