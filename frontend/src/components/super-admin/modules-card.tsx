'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';

interface ModuleRow {
  key: string;
  label: string;
  description: string;
  group: 'Commerce' | 'Growth' | 'Team' | 'Communication';
  parent: string | null;
  enabled: boolean;
  granted: boolean;
}

interface ModulesResponse {
  modules: ModuleRow[];
  callsMaxAgents: number | null;
}

const GROUPS: ModuleRow['group'][] = ['Commerce', 'Growth', 'Team', 'Communication'];

/**
 * Super-admin → Client → Modules. Registry-driven (the backend
 * MODULE_REGISTRY is the list): each switch grants a module to this workspace.
 * Changes are audited and reach the tenant's open tabs live.
 */
export function ModulesCard({ companyId }: { companyId: number }) {
  const toast = useToast();
  const [data, setData] = useState<ModulesResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [seats, setSeats] = useState('');

  const load = useCallback(() => {
    apiFetch<ModulesResponse>(`/super-admin/clients/${companyId}/modules`, { noOnboardingRedirect: true })
      .then((r) => {
        setData(r);
        setSeats(r.callsMaxAgents ? String(r.callsMaxAgents) : '');
      })
      .catch((e) => toast.error(e instanceof ApiError ? e.userMessage : 'Could not load modules'));
  }, [companyId, toast]);

  useEffect(() => load(), [load]);

  const save = async (key: string, value: unknown) => {
    setBusy(key);
    try {
      const r = await apiFetch<ModulesResponse>(`/super-admin/clients/${companyId}/module-access`, {
        method: 'PATCH',
        body: { [key]: value },
        noOnboardingRedirect: true,
      });
      setData(r);
      toast.success('Module access saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to save module access');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="text-base font-semibold text-gray-900">Modules</h2>
      <p className="mb-4 mt-1 text-xs text-gray-500">
        Switch modules on or off for this workspace. Off hides the module in the tenant&apos;s menu, the API
        answers &ldquo;not enabled&rdquo; and its background jobs stop. Data is kept. Every change is audited.
      </p>
      {!data ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {GROUPS.map((g) => {
            const rows = data.modules.filter((m) => m.group === g);
            if (!rows.length) return null;
            return (
              <div key={g} className="rounded-lg border border-gray-100 p-3">
                <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-gray-500">{g}</h3>
                <ul className="divide-y divide-gray-100">
                  {rows.map((m) => {
                    const parentOff = !!m.parent && !data.modules.find((p) => p.key === m.parent)?.enabled;
                    return (
                      <li key={m.key} className={`flex items-center justify-between gap-3 py-2 ${m.parent ? 'pl-4' : ''}`}>
                        <label htmlFor={`mod-${m.key}`} className="min-w-0 cursor-pointer">
                          <span className="block text-sm font-medium text-gray-900">
                            {m.parent ? '↳ ' : ''}
                            {m.label}
                          </span>
                          <span className="block text-xs text-gray-500">
                            {parentOff ? `Needs ${data.modules.find((p) => p.key === m.parent)?.label} on` : m.description}
                          </span>
                        </label>
                        <input
                          id={`mod-${m.key}`}
                          type="checkbox"
                          role="switch"
                          aria-checked={m.granted}
                          checked={m.granted}
                          disabled={busy !== null || parentOff}
                          onChange={(e) => void save(m.key, e.target.checked)}
                          className="h-4 w-4 shrink-0 rounded border-gray-300 text-green-600 focus:ring-green-500 disabled:opacity-40"
                        />
                      </li>
                    );
                  })}
                  {g === 'Communication' && (
                    <li className="flex items-center justify-between gap-3 py-2 pl-4">
                      <label htmlFor="mod-calls-seats" className="min-w-0">
                        <span className="block text-sm font-medium text-gray-900">↳ Max calling agents</span>
                        <span className="block text-xs text-gray-500">Blank = no cap</span>
                      </label>
                      <span className="flex items-center gap-2">
                        <input
                          id="mod-calls-seats"
                          inputMode="numeric"
                          value={seats}
                          onChange={(e) => setSeats(e.target.value.replace(/\D/g, ''))}
                          className="w-16 rounded-md border border-gray-300 px-2 py-1 text-right text-sm"
                        />
                        <button
                          type="button"
                          disabled={busy !== null || seats === (data.callsMaxAgents ? String(data.callsMaxAgents) : '')}
                          onClick={() => void save('calls_max_agents', seats === '' ? null : Number(seats))}
                          className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium disabled:opacity-40"
                        >
                          Save
                        </button>
                      </span>
                    </li>
                  )}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
