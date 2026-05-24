'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, Search, ScrollText } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/utils';
import type { AdminAuditLog, Paged } from '@/lib/crm-types';

export const dynamic = 'force-dynamic';

const LIMIT = 50;

export default function SuperAdminAuditPage() {
  const router = useRouter();
  const [rows, setRows] = useState<AdminAuditLog[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch<Paged<AdminAuditLog>>(
        '/super-admin/audit-logs',
        { params: { page, limit: LIMIT }, noOnboardingRedirect: true },
      );
      setRows(res.items);
      setTotal(res.meta.total);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.replace('/super-admin/login');
        return;
      }
      setError(
        e instanceof ApiError ? e.userMessage : 'Failed to load audit logs',
      );
    } finally {
      setLoading(false);
    }
    // `router` deliberately omitted (unstable identity in Next 14).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  // Server has no action filter — filter the current page client-side.
  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter(
      (r) =>
        r.action.toLowerCase().includes(s) ||
        r.entity.toLowerCase().includes(s) ||
        (r.user?.email ?? '').toLowerCase().includes(s),
    );
  }, [rows, q]);

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <span className="w-9 h-9 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center">
              <ScrollText size={18} />
            </span>
            Audit log
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Mutations recorded across the platform — immutable, append-only.
          </p>
        </div>
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter action / entity / user on this page…"
            className="bg-white border border-gray-200 rounded-lg pl-9 pr-3 py-2 text-sm w-full sm:w-80 text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-600 focus:border-transparent shadow-sm"
          />
        </div>
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
                <th className="text-left px-4 py-3 font-medium">Time</th>
                <th className="text-left px-4 py-3 font-medium">User</th>
                <th className="text-left px-4 py-3 font-medium">Action</th>
                <th className="text-left px-4 py-3 font-medium">Entity</th>
                <th className="text-left px-4 py-3 font-medium">IP</th>
                <th className="text-left px-4 py-3 font-medium">Metadata</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-gray-400">
                    Loading…
                  </td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-gray-400">
                    No audit entries match.
                  </td>
                </tr>
              ) : (
                visible.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50 transition-colors align-top">
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap text-xs">
                      {fmtDateTime(r.created_at)}
                    </td>
                    <td className="px-4 py-3 text-gray-800">
                      {r.user ? (
                        <>
                          <div className="font-medium">{r.user.name}</div>
                          <div className="text-xs text-gray-500">
                            {r.user.email}
                          </div>
                        </>
                      ) : r.user_id == null ? (
                        // user_id is NULL on the row — system / bot action.
                        // E.g. keyword bot executions, cron jobs (audit_logs
                        // user_id was made nullable so these can land without
                        // an FK violation; see migration
                        // 20260529000000_audit_log_user_nullable).
                        <span className="inline-block rounded-full bg-purple-50 text-purple-700 border border-purple-200 px-2 py-0.5 text-[11px] font-medium">
                          System / bot
                        </span>
                      ) : (
                        // user_id is set but the joined row is missing —
                        // the user was hard-deleted (super-admin client wipe).
                        <span className="text-xs text-gray-400 italic">
                          (deleted user #{r.user_id})
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <code className="inline-block rounded bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 font-mono text-xs">
                        {r.action}
                      </code>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {r.entity}
                      {r.entity_id != null && (
                        <span className="text-gray-400"> #{r.entity_id}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 font-mono text-xs">
                      {r.ip_address ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-500 max-w-xs">
                      {r.metadata ? (
                        <code className="block truncate text-xs bg-gray-50 border border-gray-200 rounded px-2 py-0.5">
                          {JSON.stringify(r.metadata)}
                        </code>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between text-sm text-gray-500">
        <span>
          {total} total · page {page}/{totalPages}
        </span>
        <div className="flex gap-2">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 disabled:opacity-40 hover:bg-gray-50"
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 disabled:opacity-40 hover:bg-gray-50"
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
