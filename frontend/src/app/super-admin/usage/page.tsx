'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { AdminUsageRow } from '@/lib/crm-types';

export const dynamic = 'force-dynamic';

function Cell({
  value,
  limit,
}: {
  value: number;
  limit?: number | null;
}) {
  const over = typeof limit === 'number' && limit > 0 && value >= limit;
  const near =
    !over && typeof limit === 'number' && limit > 0 && value >= limit * 0.8;
  return (
    <td
      className={cn(
        'px-4 py-3 text-right tabular-nums',
        over && 'text-red-300 font-semibold',
        near && 'text-yellow-300',
        !over && !near && 'text-gray-300',
      )}
    >
      {value.toLocaleString()}
      {typeof limit === 'number' && limit > 0 && (
        <span className="text-gray-600"> / {limit.toLocaleString()}</span>
      )}
    </td>
  );
}

export default function SuperAdminUsagePage() {
  const router = useRouter();
  const [rows, setRows] = useState<AdminUsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const period =
    rows[0]?.period ?? new Date().toISOString().slice(0, 7);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch<AdminUsageRow[]>('/super-admin/usage', {
        noOnboardingRedirect: true,
      });
      setRows(data);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.replace('/super-admin/login');
        return;
      }
      setError(e instanceof ApiError ? e.userMessage : 'Failed to load usage');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <h2 className="text-xl font-bold mr-auto">Platform usage</h2>
        <span className="text-sm text-gray-400">
          Current period: <span className="text-gray-200">{period}</span>
        </span>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-900/40 border border-red-800 px-4 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-gray-800">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-800 text-gray-400">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Company</th>
              <th className="text-left px-4 py-3 font-medium">Plan</th>
              <th className="text-right px-4 py-3 font-medium">Messages</th>
              <th className="text-right px-4 py-3 font-medium">
                Contacts (vs limit)
              </th>
              <th className="text-right px-4 py-3 font-medium">
                Templates (vs limit)
              </th>
              <th className="text-right px-4 py-3 font-medium">Webhooks</th>
              <th className="text-right px-4 py-3 font-medium">Convos</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-gray-500">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-gray-500">
                  No usage recorded for this period yet.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const sub = r.company?.subscription ?? null;
                return (
                  <tr key={r.id} className="hover:bg-gray-800/50">
                    <td className="px-4 py-3 font-medium text-white">
                      {r.company?.company_name ?? `Company ${r.company_id}`}
                    </td>
                    <td className="px-4 py-3 text-gray-300 capitalize">
                      {sub?.plan_name ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-300">
                      {r.messages_sent.toLocaleString()}
                    </td>
                    <Cell
                      value={r.contacts_stored}
                      limit={sub?.contact_limit}
                    />
                    <Cell
                      value={r.templates_used}
                      limit={sub?.template_limit}
                    />
                    <td className="px-4 py-3 text-right tabular-nums text-gray-300">
                      {r.webhook_calls.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-300">
                      {r.conversations_opened.toLocaleString()}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-gray-600">
        Current calendar-month metering only. Red = at/over plan limit,
        amber = ≥80%.
      </p>
    </div>
  );
}
