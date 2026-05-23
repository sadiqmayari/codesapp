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

export default function SuperAdminSettingsPage() {
  const router = useRouter();
  const [value, setValue] = useState<UsageLimitAction>('block');
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
  }, [router]);

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
        body: { usageLimitAction: value },
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

            <div className="flex items-center gap-3 pt-2">
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
          </div>
        )}
      </div>
    </div>
  );
}
