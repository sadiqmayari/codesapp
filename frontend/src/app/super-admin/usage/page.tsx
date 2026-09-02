'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity } from 'lucide-react';
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
  const pct =
    typeof limit === 'number' && limit > 0
      ? Math.min(100, Math.round((value / limit) * 100))
      : null;
  return (
    <td className="px-4 py-3 text-right tabular-nums">
      <div
        className={cn(
          'font-medium',
          over && 'text-red-700',
          near && 'text-amber-700',
          !over && !near && 'text-gray-800',
        )}
      >
        {value.toLocaleString()}
        {typeof limit === 'number' && limit > 0 && (
          <span className="text-gray-400 font-normal"> / {limit.toLocaleString()}</span>
        )}
      </div>
      {pct !== null && (
        <div className="mt-1 h-1 w-full bg-gray-100 rounded-full overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              over && 'bg-red-500',
              near && 'bg-amber-500',
              !over && !near && 'bg-green-500',
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
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
    // `router` deliberately omitted (unstable identity in Next 14).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <span className="w-9 h-9 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center">
              <Activity size={18} />
            </span>
            Platform usage
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Per-tenant metering for the current calendar month.{' '}
            <span className="text-amber-600">Amber ≥ 80%</span> ·{' '}
            <span className="text-red-600">Red at/over limit</span>.
          </p>
        </div>
        <span className="text-sm text-gray-500 bg-white border border-gray-200 rounded-lg px-3 py-1.5 shadow-sm">
          Period: <span className="text-gray-900 font-semibold">{period}</span>
        </span>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Company</th>
                <th className="text-left px-4 py-3 font-medium">Plan</th>
                <th className="text-right px-4 py-3 font-medium">Messages</th>
                <th className="text-right px-4 py-3 font-medium">
                  Contacts
                </th>
                <th className="text-right px-4 py-3 font-medium">
                  Templates
                </th>
                <th className="text-right px-4 py-3 font-medium">Webhooks</th>
                <th className="text-right px-4 py-3 font-medium">Convos</th>
                <th className="text-right px-4 py-3 font-medium">AI calls</th>
                <th className="text-right px-4 py-3 font-medium">
                  AI billed
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-gray-400">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-gray-400">
                    No usage recorded for this period yet.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const sub = r.company?.subscription ?? null;
                  return (
                    <tr key={r.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {r.company?.company_name ?? `Company ${r.company_id}`}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-block rounded-full bg-blue-50 text-blue-700 border border-blue-200 px-2.5 py-0.5 text-xs font-medium capitalize">
                          {sub?.plan_name ?? '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-800">
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
                      <td className="px-4 py-3 text-right tabular-nums text-gray-800">
                        {r.webhook_calls.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-800">
                        {r.conversations_opened.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-800">
                        {(r.ai_requests ?? 0).toLocaleString()}
                      </td>
                      <td
                        className={
                          'px-4 py-3 text-right tabular-nums font-medium ' +
                          ((r.ai_billed_cents ?? 0) > 0
                            ? 'text-violet-700'
                            : 'text-gray-400')
                        }
                        title={`Raw provider cost: $${(
                          (r.ai_cost_micros ?? 0) / 1_000_000
                        ).toFixed(4)}`}
                      >
                        ${((r.ai_billed_cents ?? 0) / 100).toFixed(2)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
