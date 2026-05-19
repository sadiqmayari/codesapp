'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
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
    <div className="max-w-2xl">
      <h2 className="text-xl font-bold mb-1">Platform Settings</h2>
      <p className="text-gray-400 text-sm mb-6">
        Platform-wide defaults. A per-client override (set from a client&apos;s
        Details panel) always takes precedence over the value here.
      </p>

      {error && (
        <div className="mb-4 rounded-lg bg-red-900/40 border border-red-800 px-4 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-5">
        <h3 className="text-sm font-semibold text-gray-200 mb-1">
          Usage-limit behavior (default)
        </h3>
        <p className="text-gray-500 text-xs mb-4">
          What happens when a tenant reaches a plan limit (contacts /
          templates) and has no per-client override.
        </p>

        {loading ? (
          <p className="text-gray-500 text-sm py-4">Loading…</p>
        ) : (
          <div className="space-y-3">
            {OPTIONS.map((o) => (
              <label
                key={o.value}
                className={
                  'flex gap-3 rounded-lg border p-3 cursor-pointer transition-colors ' +
                  (value === o.value
                    ? 'border-green-600 bg-green-900/20'
                    : 'border-gray-700 hover:bg-gray-800/60')
                }
              >
                <input
                  type="radio"
                  name="usageLimitAction"
                  className="mt-1"
                  checked={value === o.value}
                  onChange={() => {
                    setValue(o.value);
                    setSaved(false);
                  }}
                />
                <div>
                  <div className="text-sm font-medium text-gray-100">
                    {o.title}
                  </div>
                  <div className="text-xs text-gray-400">{o.desc}</div>
                </div>
              </label>
            ))}

            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={save}
                disabled={saving}
                className="rounded-lg bg-green-600 hover:bg-green-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              {saved && (
                <span className="text-sm text-green-400">Saved.</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
