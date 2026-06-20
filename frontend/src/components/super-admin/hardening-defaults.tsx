'use client';

import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Power, Loader2 } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';

/**
 * Platform-wide hardening defaults (#increment 11). Sets the default each tenant
 * inherits when it has no per-tenant override. GET/PATCH /super-admin/hardening-
 * defaults (+ /bulk). A guard default ON enables it for ALL tenants that don't
 * override; a kill default OFF kills that capability platform-wide.
 */

type Semantics = 'enable' | 'kill';

interface HardeningDefault {
  key: string;
  label: string;
  semantics: Semantics;
  platformOn: boolean;
}

export function HardeningDefaults() {
  const toast = useToast();
  const [defs, setDefs] = useState<HardeningDefault[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ defaults: HardeningDefault[] }>(
        '/super-admin/hardening-defaults',
      );
      setDefs(res.defaults);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Failed to load defaults');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setOne = async (d: HardeningDefault, on: boolean) => {
    if (busy || d.platformOn === on) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ defaults: HardeningDefault[] }>(
        '/super-admin/hardening-defaults',
        { method: 'PATCH', body: { key: d.key, on } },
      );
      setDefs(res.defaults);
      toast.success(`${d.label} default updated`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Update failed');
    } finally {
      setBusy(false);
    }
  };

  const setBulk = async (group: 'guards' | 'kills', on: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ defaults: HardeningDefault[] }>(
        '/super-admin/hardening-defaults/bulk',
        { method: 'PATCH', body: { group, on } },
      );
      setDefs(res.defaults);
      toast.success(`All ${group} defaults updated`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Bulk update failed');
    } finally {
      setBusy(false);
    }
  };

  const guards = defs?.filter((d) => d.semantics === 'enable') ?? [];
  const kills = defs?.filter((d) => d.semantics === 'kill') ?? [];

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck className="h-4 w-4 text-emerald-600" />
        <h3 className="text-sm font-semibold text-gray-900">
          Hardening platform defaults
        </h3>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
      </div>
      <p className="text-xs text-gray-500 mb-4">
        The default every tenant inherits when it has no per-tenant override.
        Enabling a guard here turns it on for <span className="font-medium">all</span>{' '}
        tenants; killing a switch here disables that capability platform-wide.
        Per-tenant overrides on a client page always win.
      </p>

      {error && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
          {error}
        </div>
      )}
      {!defs && !error && (
        <div className="flex items-center gap-2 text-xs text-gray-400 py-4">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}

      {defs && (
        <div className="space-y-5">
          <Group
            heading="Safety guards"
            icon={<ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />}
            defs={guards}
            isKill={false}
            busy={busy}
            onOne={setOne}
            onBulk={(on) => setBulk('guards', on)}
          />
          <Group
            heading="Emergency kill switches"
            icon={<Power className="h-3.5 w-3.5 text-red-600" />}
            defs={kills}
            isKill
            busy={busy}
            onOne={setOne}
            onBulk={(on) => setBulk('kills', on)}
          />
        </div>
      )}
    </div>
  );
}

function Group({
  heading,
  icon,
  defs,
  isKill,
  busy,
  onOne,
  onBulk,
}: {
  heading: string;
  icon: React.ReactNode;
  defs: HardeningDefault[];
  isKill: boolean;
  busy: boolean;
  onOne: (d: HardeningDefault, on: boolean) => void;
  onBulk: (on: boolean) => void;
}) {
  if (defs.length === 0) return null;
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          {icon}
          {heading}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
          <span>All:</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => onBulk(true)}
            className="px-2 py-0.5 rounded-md border border-gray-200 bg-white hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-50"
          >
            {isKill ? 'Run' : 'On'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onBulk(false)}
            className={cn(
              'px-2 py-0.5 rounded-md border border-gray-200 bg-white disabled:opacity-50',
              isKill ? 'hover:bg-red-50 hover:text-red-700' : 'hover:bg-gray-50',
            )}
          >
            {isKill ? 'Kill' : 'Off'}
          </button>
        </div>
      </div>
      <div className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
        {defs.map((d) => (
          <div key={d.key} className="flex items-center justify-between gap-4 px-3 py-2.5">
            <span className="text-sm text-gray-800">{d.label}</span>
            <button
              type="button"
              role="switch"
              aria-checked={d.platformOn}
              disabled={busy}
              onClick={() => onOne(d, !d.platformOn)}
              className={cn(
                'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
                d.platformOn
                  ? isKill
                    ? 'bg-gray-400'
                    : 'bg-emerald-600'
                  : isKill
                    ? 'bg-red-500'
                    : 'bg-gray-200',
              )}
            >
              <span
                className={cn(
                  'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                  d.platformOn ? 'translate-x-4' : 'translate-x-0.5',
                )}
              />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
