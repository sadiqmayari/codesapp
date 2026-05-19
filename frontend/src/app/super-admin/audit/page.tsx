'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
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
  }, [page, router]);

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
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <h2 className="text-xl font-bold mr-auto">Audit log</h2>
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter action / entity / user on this page…"
            className="bg-gray-800 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-sm w-full sm:w-80 focus:outline-none focus:ring-2 focus:ring-green-600"
          />
        </div>
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
              <th className="text-left px-4 py-3 font-medium">Time</th>
              <th className="text-left px-4 py-3 font-medium">User</th>
              <th className="text-left px-4 py-3 font-medium">Action</th>
              <th className="text-left px-4 py-3 font-medium">Entity</th>
              <th className="text-left px-4 py-3 font-medium">IP</th>
              <th className="text-left px-4 py-3 font-medium">Metadata</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                  Loading…
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                  No audit entries match.
                </td>
              </tr>
            ) : (
              visible.map((r) => (
                <tr key={r.id} className="hover:bg-gray-800/50 align-top">
                  <td className="px-4 py-3 text-gray-400 whitespace-nowrap">
                    {fmtDateTime(r.created_at)}
                  </td>
                  <td className="px-4 py-3 text-gray-300">
                    {r.user?.name ?? `User ${r.user_id}`}
                    {r.user?.email && (
                      <span className="block text-xs text-gray-600">
                        {r.user.email}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-green-300">
                    {r.action}
                  </td>
                  <td className="px-4 py-3 text-gray-400">
                    {r.entity}
                    {r.entity_id != null && (
                      <span className="text-gray-600"> #{r.entity_id}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500 font-mono text-xs">
                    {r.ip_address ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-500 max-w-xs">
                    {r.metadata ? (
                      <code className="block truncate text-xs">
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

      <div className="flex items-center justify-between mt-4 text-sm text-gray-400">
        <span>
          {total} total · page {page}/{totalPages}
        </span>
        <div className="flex gap-2">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="flex items-center gap-1 rounded-lg border border-gray-700 px-3 py-1.5 disabled:opacity-40 hover:bg-gray-800"
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="flex items-center gap-1 rounded-lg border border-gray-700 px-3 py-1.5 disabled:opacity-40 hover:bg-gray-800"
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
